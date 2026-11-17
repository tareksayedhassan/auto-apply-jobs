import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { getJobFull } from "../details.js";
import { getApplication, getJob, jobStats, kvGet, kvSet, listApplications, listEvents, searchJobs } from "../db.js";
import { packPath, paths, pkgRoot } from "../paths.js";
import { approve, currentFill, describeEvent, pipeline, saveJob, updateStatus, voidFill } from "../track.js";
import { getRun, startDraft, startFill, startSubmit, startWhyUs, type RunDeps } from "../runs.js";
import { whyUsQuestions } from "../whyus-check.js";
import { exclusive } from "../lock.js";
import { autoSyncRunning } from "../autosync.js";
import { packTodos } from "../tailor.js";
import { appliedRows, assertNotDuplicate, DuplicateApplicationError, priorFields } from "../prior.js";
import { companyWebsite } from "../website.js";
import type { ApplicationStatus, Job, JobFilters } from "../types.js";

export interface ServerOptions {
  /** Static dashboard directory (default: <pkgRoot>/ui). */
  uiDir?: string;
  /** Module loader, overridable in tests to simulate missing modules. */
  importer?: (name: string) => Promise<any>;
  /** Spawn and engine stand-ins for the draft/fill runs (tests). */
  runDeps?: RunDeps;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const notReady = () => new HttpError(503, "module not ready");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const PACK_FILES = new Set(["resume.pdf", "cover-letter.pdf", "pack.json"]);
const MAX_BODY = 1_000_000;

let syncing = false;
let lastReport: unknown;
let lastSyncError: string | undefined;

const trunc = (j: Job): Job => ({ ...j, description: j.description.length > 400 ? j.description.slice(0, 400) : j.description });

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Body must be valid JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
  return body;
}

function num(q: URLSearchParams, key: string): number | undefined {
  const v = q.get(key);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${key} must be a non-negative integer`);
  return n;
}

/** RFC 6266: an ASCII-safe filename plus the exact name as RFC 5987 UTF-8, so any name is a valid header. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * The file a /files/packs request may read: the fixed names plus the PDFs pack.json points to (a pack saved
 * with resume_pdf keeps the user's file name). Plain names only, never '.', '..' or a path, and inside the folder.
 */
export async function packFile(jobId: string, name: string): Promise<string | undefined> {
  const dir = resolve(packPath(jobId));
  const allowed = new Set(PACK_FILES);
  try {
    const pack = JSON.parse(await readFile(join(dir, "pack.json"), "utf8"));
    for (const p of [pack.resumePdf, pack.coverLetterPdf]) if (typeof p === "string" && p) allowed.add(basename(p));
  } catch { /* no pack.json: fixed names only */ }
  if (!name || !allowed.has(name) || name === "." || name === ".." || /[/\\\0]/.test(name)) return undefined;
  const file = resolve(dir, name);
  return file.startsWith(dir + sep) ? file : undefined;
}

async function sendFile(res: ServerResponse, file: string, disposition = false): Promise<void> {
  if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Not found");
  const headers: Record<string, string> = {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  };
  if (disposition) headers["content-disposition"] = contentDisposition(basename(file));
  res.writeHead(200, headers);
  res.end(await readFile(file));
}

export async function startServer(
  port = 4646, opts: ServerOptions = {},
): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const uiDir = resolve(opts.uiDir ?? join(pkgRoot, "ui"));
  const load = opts.importer ?? ((name: string) => import(name));
  let actualPort = port;

  /** Dynamic import of a sibling module; any failure means "not ready". */
  async function mod(name: string): Promise<any> {
    try { return await load(`../${name}.js`); } catch { throw notReady(); }
  }
  async function fn<T extends (...a: any[]) => any>(name: string, exp: string): Promise<T> {
    const f = (await mod(name))?.[exp];
    if (typeof f !== "function") throw notReady();
    return f as T;
  }

  /**
   * Whether this process holds the job's filled form, so an Approve here presses Submit (engine.canSubmit). A submit
   * running here counts as held: its ticket is spent but this process is pressing Submit. An engine (or playwright)
   * that won't load holds nothing, and job detail and pipeline still answer.
   */
  async function holds(): Promise<(jobId: string) => boolean> {
    let has = opts.runDeps?.hasPage;
    if (!has) {
      try { has = (await load("../apply/engine.js")).canSubmit; } catch { /* no engine: nothing held */ }
    }
    const page = typeof has === "function" ? has : () => false;
    return jobId => { const r = getRun(jobId); return (r?.kind === "submit" && (r.state === "queued" || r.state === "running")) || page(jobId); };
  }

  /** The fill browser's DevTools port answers (fills and held forms live there). One probe per 10 s at most. */
  let browserProbe: { at: number; result: Promise<{ up: boolean; port: number }> } | undefined;
  function fillBrowser(): Promise<{ up: boolean; port: number }> {
    if (browserProbe && Date.now() - browserProbe.at < 10_000) return browserProbe.result;
    const port = Number(process.env.OPENAPPLY_CDP_PORT) || 9333;
    const result = fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      .then(r => { r.body?.cancel().catch(() => {}); return { up: r.ok, port }; }, () => ({ up: false, port }));
    browserProbe = { at: Date.now(), result };
    return result;
  }

  const allowedHosts = () => [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];

  function guard(req: IncomingMessage, mutating: boolean): void {
    const host = req.headers.host;
    if (host && !allowedHosts().includes(host)) throw new HttpError(403, "Bad Host header");
    if (!mutating) return;
    const origin = req.headers.origin;
    if (origin && !allowedHosts().some(h => origin === `http://${h}`)) throw new HttpError(403, "Cross-origin request blocked");
    if (req.headers["x-openapply"] !== "1") throw new HttpError(403, "Missing X-OpenApply header");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const mutating = method !== "GET" && method !== "HEAD";
    guard(req, mutating);

    let segs: string[];
    try { segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "Malformed URL encoding"); }
    const q = url.searchParams;
    const [a, b, c, d] = segs;

    if (a === "api") {
      // ---- stats / pipeline ----
      if (method === "GET" && b === "stats" && !c) {
        let profile: unknown = null;
        try { profile = (await fn("profile", "profileStatus"))(); } catch { /* module not ready: stats still work */ }
        return send(res, 200, { jobs: jobStats(), profile, pipeline: pipeline().counts });
      }
      if (method === "GET" && b === "pipeline" && !c) {
        const p = pipeline();
        const rows = appliedRows();
        const held = await holds();
        return send(res, 200, { ...p, items: p.items.map(a => ({ ...a, run: getRun(a.jobId), held: held(a.jobId), ...(a.job ? priorFields(a.job, rows) : {}) })) });
      }
      if (method === "GET" && b === "browser" && !c) return send(res, 200, await fillBrowser());
      // Every question the user still has to answer before a saved or drafted pack can be filled, one entry per
      // question text across packs. Answers are saved through PUT /api/jobs/:id/pack, so the checks run again.
      if (method === "GET" && b === "todos" && !c) {
        const loadPack = await fn<(id: string) => any>("tailor", "loadPack");
        const groups = new Map<string, { question: string; cover?: true; jobs: Array<{ jobId: string; company: string; title: string; current: string; drafted?: "review" | "rewrite" }> }>();
        for (const a of listApplications(["saved", "drafted"])) {
          const pack = loadPack(a.jobId);
          if (!pack) continue;
          for (const question of packTodos(pack)) {
            const cover = question === "Cover letter" && !Object.hasOwn(pack.answers ?? {}, question);
            if (!groups.has(question)) groups.set(question, { question, ...(cover ? { cover: true as const } : {}), jobs: [] });
            groups.get(question)!.jobs.push({ jobId: a.jobId, company: a.job?.company ?? "", title: a.job?.title ?? a.jobId,
              current: String((cover ? pack.coverLetter : pack.answers[question]) ?? ""),
              ...(pack.drafted?.[question] ? { drafted: pack.drafted[question].noLink ? "rewrite" as const : "review" as const } : {}) });
          }
        }
        return send(res, 200, [...groups.values()].sort((x, y) => y.jobs.length - x.jobs.length || x.question.localeCompare(y.question)));
      }

      // ---- jobs ----
      if (method === "GET" && b === "jobs" && !c) {
        const f: JobFilters = {
          query: q.get("q") || undefined, location: q.get("location") || undefined,
          company: q.get("company") || undefined, remote: q.get("remote") === "1" ? true : undefined,
          postedWithinDays: num(q, "days"), limit: num(q, "limit"), offset: num(q, "offset"),
        };
        const r = searchJobs(f);
        const rows = appliedRows();
        return send(res, 200, { total: r.total, jobs: r.jobs.map(j => ({ ...trunc(j), ...priorFields(j, rows) })) });
      }
      if (b === "jobs" && c) {
        if (!getJob(c)) throw new HttpError(404, `Unknown job: ${c}`);
        if (method === "GET" && !d) {
          const job = (await getJobFull(c))!; // the full posting text, fetched once and kept
          let pack: unknown;
          try { pack = (await fn("tailor", "loadPack"))(c); } catch { /* no pack module yet */ }
          const events = listEvents(c);
          // Newest screenshot no older than the latest fill, so a fill that saved none never shows an earlier one.
          const fill = events.findIndex(e => e.kind === "filled");
          const shot = events.slice(0, fill < 0 ? undefined : fill + 1)
            .map(e => e.detail?.match(/[^\s"'/]+\.png/)?.[0])
            .find(n => n && statSync(join(paths.screenshots, n), { throwIfNoEntry: false })?.size);
          // What the latest fill put on the form and left blank, only while that fill is the one awaiting approval.
          const application = getApplication(c);
          const { code: _code, ...form } = currentFill(c, application) ?? {};
          return send(res, 200, { job, application, pack, whyUs: whyUsQuestions((pack as { answers?: Record<string, string> } | undefined)?.answers, job.company), events: events.map(e => ({ ...e, text: describeEvent(e) })), screenshot: shot, run: getRun(c), held: (await holds())(c), fill: "filled" in form ? form : undefined, website: await companyWebsite(job), ...priorFields(job) });
        }
        if (method === "POST" && d === "save") {
          const body = await readBody(req);
          if (body.notes !== undefined && typeof body.notes !== "string") throw new HttpError(400, "notes must be a string");
          return send(res, 200, saveJob(c, body.notes));
        }
        if (method === "POST" && d === "status") {
          const body = await readBody(req);
          if (typeof body.status !== "string") throw new HttpError(400, "status is required");
          if (body.note !== undefined && typeof body.note !== "string") throw new HttpError(400, "note must be a string");
          const app = updateStatus(c, body.status as ApplicationStatus, body.note);
          // The user finished it in the browser (e.g. after a CAPTCHA): its tab is done too.
          if (app.status === "submitted") {
            try { await (await fn<(id: string) => Promise<void>>("apply/browser", "closePage"))(c); } catch { /* no browser module, nothing open */ }
          }
          return send(res, 200, app);
        }
        if (method === "GET" && d === "run") return send(res, 200, { run: getRun(c) ?? null, status: getApplication(c)?.status ?? null });
        // Draft runs a background `claude -p`; fill runs the form filler in-process. Neither submits: approve does.
        // The same role already submitted under another job id answers 409 unless the body carries force:true.
        if (method === "POST" && d === "draft") {
          assertNotDuplicate(c, (await readBody(req)).force === true);
          return send(res, 202, { run: startDraft(c, opts.runDeps) });
        }
        // Draft the pack's why-us answers (or one, by question) in a background `claude -p`; they land as drafts to review.
        if (method === "POST" && d === "why-us") {
          const { question } = await readBody(req);
          if (question !== undefined && (typeof question !== "string" || question.length > 2000)) throw new HttpError(400, "question must be a string");
          try { return send(res, 202, { run: startWhyUs(c, question, opts.runDeps) }); }
          catch (e) { throw new HttpError(/^Busy/.test((e as Error).message) ? 409 : 400, (e as Error).message); }
        }
        if (method === "POST" && d === "fill") {
          const force = (await readBody(req)).force === true;
          assertNotDuplicate(c, force);
          const cur = getRun(c);
          if (cur && (cur.state === "queued" || cur.state === "running")) throw new HttpError(409, `Busy: a ${cur.kind} run is ${cur.state} for this job`);
          // Required form questions nobody answered become TODOs first, so they refuse the fill below.
          await (await fn<(id: string) => Promise<string[]>>("tailor", "alignPack"))(c);
          // Read under the job lock so a pack edit still being written is the one checked.
          const load = await fn<(id: string) => any>("tailor", "loadPack");
          const todos = packTodos(await exclusive(c, async () => load(c)));
          if (todos.length) throw new HttpError(400, `Pack has TODOs to finish first: ${todos.join(", ")}`);
          const { run, settled } = startFill(c, opts.runDeps, force);
          settled.catch(() => {});
          return send(res, 202, { run });
        }
        // The user's own edits to the pack (answers to its own questions, cover letter text) before the form is
        // filled; returns what is still TODO. updatePack refuses unknown questions and filled-or-later statuses.
        if (method === "PUT" && d === "pack") {
          const { answers, coverLetter, reviewed } = await readBody(req);
          const okAnswers = answers === undefined || (answers && typeof answers === "object" && !Array.isArray(answers)
            && Object.entries(answers).every(([k, v]) => k.trim() && k.length <= 2000 && typeof v === "string" && v.length <= 20_000));
          if (!okAnswers) throw new HttpError(400, "answers must map question text to answer text");
          if (coverLetter !== undefined && (typeof coverLetter !== "string" || coverLetter.length > 20_000)) throw new HttpError(400, "coverLetter must be a string");
          if (reviewed !== undefined && !(Array.isArray(reviewed) && reviewed.every(q => typeof q === "string" && q.length <= 2000))) throw new HttpError(400, "reviewed must be a list of questions");
          if (answers === undefined && coverLetter === undefined && reviewed === undefined) throw new HttpError(400, "Send answers, coverLetter and/or reviewed");
          const run = getRun(c);
          if (run && (run.state === "queued" || run.state === "running")) throw new HttpError(409, `Busy: a ${run.kind} run is ${run.state} for this job`);
          const pack = await (await fn("tailor", "updatePack"))(c, { answers, coverLetter, reviewed });
          return send(res, 200, { pack, todos: packTodos(pack), status: getApplication(c)?.status ?? null });
        }
        // Open a filled (or approved) form again because no process holds it: void that fill so it can be filled
        // anew. Refused past approved, so a submitted application never goes back to drafted and gets sent twice.
        if (method === "POST" && d === "refill") {
          const app = await exclusive(c, async () => {
            const run = getRun(c);
            if (run && (run.state === "queued" || run.state === "running")) throw new HttpError(409, `Busy: a ${run.kind} run is ${run.state} for this job`);
            const status = getApplication(c)?.status;
            if (status !== "filled" && status !== "approved") {
              throw new HttpError(409, `Cannot re-fill ${c}: status is ${status ? `"${status}"` : "none"}, expected "filled" or "approved".`);
            }
            voidFill(c);
            return getApplication(c);
          });
          return send(res, 200, app);
        }
        if (method === "POST" && d === "approve") {
          const body = await readBody(req);
          const app = approve(c, typeof body.code === "string" ? body.code : undefined);
          // A form this dashboard filled is still open here: the approval is the user's yes, so press Submit now.
          // held:false means no submit started here: only an agent holding the form in its own process can submit it.
          const started = await startSubmit(c, opts.runDeps);
          started?.settled.catch(() => {});
          return send(res, 200, { ...app, run: started?.run, held: started !== undefined });
        }
      }

      // ---- matches ----
      if (method === "GET" && b === "matches" && !c) {
        const listMatches = await fn<(o: object) => any[]>("match", "listMatches");
        const r = listMatches({ limit: num(q, "limit"), postedWithinDays: num(q, "days"), query: q.get("q") || undefined });
        const rows = appliedRows();
        return send(res, 200, r.map(m => ({ ...m, job: trunc(m.job), ...priorFields(m.job, rows) })));
      }

      // ---- profile ----
      if (b === "profile" && !c) {
        if (method === "GET") {
          const m = await mod("profile");
          if (typeof m.loadProfile !== "function") throw notReady();
          return send(res, 200, { profile: m.loadProfile() ?? null, resume: m.loadResume?.() ?? null, status: m.profileStatus?.() ?? null });
        }
        if (method === "PUT") {
          const body = await readBody(req);
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
          return send(res, 200, (await fn("profile", "saveProfile"))(body));
        }
      }

      // ---- sync ----
      if (b === "sync" && !c) {
        if (method === "GET") {
          if (lastReport === undefined) { try { const s = kvGet("lastSyncReport"); if (s) lastReport = JSON.parse(s); } catch { /* ignore */ } }
          return send(res, 200, { running: syncing || autoSyncRunning(), lastReport, ...(lastSyncError ? { lastError: lastSyncError } : {}) });
        }
        if (method === "POST") {
          const sync = await fn<() => Promise<unknown>>("sync", "sync");
          // an auto-sync child counts too: two full syncs double the load and draw Greenhouse 403s
          if (syncing || autoSyncRunning()) return send(res, 200, { started: false, running: true });
          syncing = true;
          lastSyncError = undefined;
          sync().then(r => { lastReport = r; kvSet("lastSyncReport", JSON.stringify(r)); })
            .catch(e => { lastSyncError = e instanceof Error ? e.message : String(e); })
            .finally(() => { syncing = false; });
          return send(res, 200, { started: true });
        }
      }
      // ---- outreach + intel ----
      if (method === "GET" && b === "outreach" && !c) return send(res, 200, (await fn("outreach", "listOutreach"))());
      if (method === "POST" && b === "outreach" && c && !d) {
        const body = await readBody(req);
        if (!/^\d+$/.test(c)) throw new HttpError(400, "Outreach id must be a number");
        return send(res, 200, (await fn("outreach", "updateOutreach"))(Number(c), body));
      }
      if (method === "GET" && b === "followups" && !c) return send(res, 200, (await fn("outreach", "dueFollowUps"))());
      if (method === "GET" && b === "scoreboard" && !c) return send(res, 200, (await fn("scoreboard", "strategyScoreboard"))());
      if (method === "GET" && b === "intel" && c && !d) {
        if (!getJob(c)) throw new HttpError(404, `Unknown job: ${c}`);
        const brief = await (await fn("intel", "companyBrief"))(c);
        return send(res, 200, { ...brief, job: brief.job ? trunc(brief.job) : undefined });
      }
      throw new HttpError(404, "Not found");
    }

    if (method !== "GET" && method !== "HEAD") throw new HttpError(404, "Not found");

    // ---- generated files ----
    if (a === "files" && b === "packs" && c && d && segs.length === 4) {
      const file = await packFile(c, d);
      if (!file) throw new HttpError(404, "Not found");
      return sendFile(res, file, true);
    }
    if (a === "files" && b === "screenshots" && c && segs.length === 3) {
      if (basename(c) !== c || extname(c).toLowerCase() !== ".png") throw new HttpError(404, "Not found");
      return sendFile(res, join(paths.screenshots, c));
    }

    // ---- static dashboard ----
    if (url.pathname.includes("\0") || segs.some(s => s === ".." || s.includes("/") || s.includes("\\") || s.includes("\0"))) {
      throw new HttpError(404, "Not found");
    }
    let file = resolve(uiDir, ...segs);
    if (file !== uiDir && !file.startsWith(uiDir + sep)) throw new HttpError(404, "Not found");
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    return sendFile(res, file);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(e => {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof DuplicateApplicationError) return send(res, 409, { error: e.message, priorApplications: e.priors });
      // Errors thrown by track/db on bad input are the caller's fault; anything else is ours.
      const msg = e instanceof Error ? e.message : String(e);
      const status = /^(Unknown (job|status)|Cannot (approve|fill|edit|keep|draft|follow up)|No pack for|Busy:|A (draft needs|LinkedIn draft))/.test(msg) ? 400 : 500;
      send(res, status, { error: msg });
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok());
  });
  actualPort = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () => new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections(); }),
  };
}
