import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { addEvent, getApplication, getJob, kvGet, kvSet } from "./db.js";
import { draftPrompt, whyUsPrompt } from "./draft-prompt.js";
import { home, pkgRoot } from "./paths.js";
import { loadProfile } from "./profile.js";
import { assertOwnResume, pickResume } from "./resume-track.js";
import { loadPack, seedCommitments, writePack } from "./tailor.js";
import type { FillResult, FormInspection, SubmitResult } from "./types.js";

/**
 * Dashboard-started background work on one job: a headless `claude -p` that drafts the pack, or an
 * in-process form fill, or the Submit press that follows the user's approval of that fill. State lives in kv
 * (`run:<jobId>`) so a reloaded dashboard still sees it. One run per job at a time.
 */
export type RunKind = "draft" | "whyus" | "fill" | "submit";
export type RunState = "queued" | "running" | "done" | "failed";
export interface Run {
  kind: RunKind;
  state: RunState;
  startedAt: string;
  endedAt?: string;
  error?: string;
  /** Child pid (draft) or server pid (fill): a running run whose owner is gone was interrupted. */
  pid?: number;
  /** Draft only: the base resume track it used (resume-track.ts). */
  track?: string;
  /** Draft only: that track's PDF, which the saved pack must upload. */
  pdf?: string;
  result?: { filled: number; missing: string[]; warnings: string[]; screenshot?: string };
}

export const CLAUDE_BIN = process.env.OPENAPPLY_CLAUDE_BIN || "claude";
export const DRAFT_TOOLS = ["get_tailoring_brief", "company_brief", "get_job", "get_profile", "save_application_pack", "draft_why_us"]
  .map(t => `mcp__openapply__${t}`);
/** The why-us run may only read its brief and save drafts. */
export const WHYUS_TOOLS = ["mcp__openapply__draft_why_us"];
export const DRAFTED_EVENT = "Pack drafted (base resume — needs tailored cut?)";

export interface RunDeps {
  spawn?: (cmd: string, args: string[], opts: object) => ChildProcess;
  inspect?: (jobId: string) => Promise<FormInspection>;
  fill?: (jobId: string) => Promise<FillResult>;
  submit?: (jobId: string) => Promise<SubmitResult>;
  /** Whether this process holds the job's approvable fill (engine.canSubmit). */
  hasPage?: (jobId: string) => boolean;
}

const key = (jobId: string) => `run:${jobId}`;
const alive = (pid?: number) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function put(jobId: string, run: Run): Run {
  kvSet(key(jobId), JSON.stringify(run));
  return run;
}

/** The job's latest run. A running run whose process died (server restart) is settled here. */
export function getRun(jobId: string): Run | undefined {
  const s = kvGet(key(jobId));
  if (!s) return undefined;
  let run: Run;
  try { run = JSON.parse(s) as Run; } catch { return undefined; }
  if ((run.state === "running" || run.state === "queued") && !alive(run.pid)) {
    if (run.kind === "draft") return finishDraft(jobId, run, null);
    if (run.kind === "whyus") return finishWhyUs(jobId, run, null);
    return put(jobId, { ...run, state: "failed", endedAt: new Date().toISOString(), error: "Interrupted (the dashboard server restarted)" });
  }
  return run;
}

function begin(jobId: string, kind: RunKind): Run {
  if (!getJob(jobId)) throw new Error(`Unknown job: ${jobId}`);
  const cur = getRun(jobId);
  if (cur && (cur.state === "queued" || cur.state === "running")) {
    throw new Error(`Busy: a ${cur.kind} run for this job is already ${cur.state}.`);
  }
  return put(jobId, { kind, state: "queued", startedAt: new Date().toISOString() });
}

/** Settle a draft run from what it left behind: a pack newer than the run means it worked. */
function finishDraft(jobId: string, run: Run, code: number | null, err?: string): Run {
  try {
    const cur = JSON.parse(kvGet(key(jobId)) ?? "null") as Run | null;
    if (cur && cur.startedAt === run.startedAt && (cur.state === "done" || cur.state === "failed")) return cur; // settled already
  } catch { /* settle below */ }
  const pack = loadPack(jobId);
  const ended = new Date().toISOString();
  if (pack && pack.createdAt >= run.startedAt) {
    if (run.pdf && basename(pack.resumePdf ?? "") !== basename(run.pdf)) {
      const error = `The pack uploads ${pack.resumePdf ? basename(pack.resumePdf) : "no resume"}, not the ${run.track} resume ${basename(run.pdf)}: redraft it`;
      addEvent(jobId, "draft", `Draft failed: ${error}`);
      return put(jobId, { ...run, state: "failed", endedAt: ended, error });
    }
    writePack(jobId, { ...pack, needsTailoredCut: true });
    seedCommitments(jobId);
    addEvent(jobId, "draft", run.track ? `${DRAFTED_EVENT}: ${run.track} resume` : DRAFTED_EVENT);
    return put(jobId, { ...run, state: "done", endedAt: ended, error: undefined });
  }
  const error = err || (code ? `claude exited with code ${code} without saving a pack` : "The run ended without saving a pack");
  addEvent(jobId, "draft", `Draft failed: ${error}`);
  return put(jobId, { ...run, state: "failed", endedAt: ended, error });
}

/**
 * Spawn a detached `claude -p` (Sonnet) that may only call `tools` on the OpenApply MCP server. Output and stderr go to
 * ~/.openapply/runs/<job>.<tag>; `settle` gets the exit code and any error claude reported.
 */
function spawnClaude(jobId: string, tag: string, prompt: string, tools: string[], deps: RunDeps,
  settle: (code: number | null, err?: string) => void): ChildProcess {
  const dir = join(home(), "runs");
  mkdirSync(dir, { recursive: true });
  const safe = jobId.replace(/[^a-zA-Z0-9._-]/g, "_") + tag;
  const mcpConfig = join(dir, `${safe}.mcp.json`);
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { openapply: { command: "node", args: [join(pkgRoot, "dist", "mcp.js")] } } }));
  const args = [
    "-p", prompt,
    "--model", "sonnet",
    "--strict-mcp-config", "--mcp-config", mcpConfig,
    "--allowedTools", tools.join(","),
    "--output-format", "json",
  ];
  const out = openSync(join(dir, `${safe}.out.json`), "w");
  const errFd = openSync(join(dir, `${safe}.err.log`), "w");
  const child = (deps.spawn ?? nodeSpawn)(CLAUDE_BIN, args, { detached: true, stdio: ["ignore", out, errFd], env: process.env, cwd: dir });
  child.on("error", e => settle(null, e.message));
  child.on("exit", code => {
    let err: string | undefined;
    try {
      const r = JSON.parse(readFileSync(join(dir, `${safe}.out.json`), "utf8"));
      if (r?.is_error) err = String(r.result || r.subtype || "claude reported an error");
    } catch { /* no JSON: fall back to the exit code */ }
    settle(code, err);
  });
  child.unref();
  return child;
}

/** Start a detached `claude -p` that writes the pack through the OpenApply MCP tools. */
export function startDraft(jobId: string, deps: RunDeps = {}): Run {
  let run = begin(jobId, "draft");
  try {
    const pick = pickResume(loadProfile(), getJob(jobId)!);
    if (!pick) throw new Error("Set profile.resumePdf (or profile.resumes and defaultResume) to your base resume PDF first.");
    if (!existsSync(pick.pdf)) throw new Error(`Resume PDF for the ${pick.track} track not found: ${pick.pdf}`);
    run = { ...run, track: pick.track, pdf: pick.pdf };
    const r = run;
    const child = spawnClaude(jobId, "", draftPrompt(jobId, pick.pdf, pick.track, pick.reason), DRAFT_TOOLS, deps, (code, err) => finishDraft(jobId, r, code, err));
    return put(jobId, { ...run, state: "running", pid: child.pid });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    addEvent(jobId, "draft", `Draft failed: ${error}`);
    return put(jobId, { ...run, state: "failed", endedAt: new Date().toISOString(), error });
  }
}

/** Settle a why-us run: a draft saved after the run started means it worked. */
function finishWhyUs(jobId: string, run: Run, code: number | null, err?: string): Run {
  try {
    const cur = JSON.parse(kvGet(key(jobId)) ?? "null") as Run | null;
    if (cur && cur.startedAt === run.startedAt && (cur.state === "done" || cur.state === "failed")) return cur;
  } catch { /* settle below */ }
  const ended = new Date().toISOString();
  const fresh = Object.values(loadPack(jobId)?.drafted ?? {}).some(d => d.at >= run.startedAt);
  if (fresh) return put(jobId, { ...run, state: "done", endedAt: ended, error: undefined });
  const error = err || (code ? `claude exited with code ${code} without saving a draft` : "The run ended without saving a draft");
  addEvent(jobId, "draft", `Why-us draft failed: ${error}`);
  return put(jobId, { ...run, state: "failed", endedAt: ended, error });
}

/**
 * Draft the pack's why-us answers (or just `question`) with a detached `claude -p` that may only call draft_why_us.
 * The drafts land as answers awaiting the user's review; nothing is filled or sent.
 */
export function startWhyUs(jobId: string, question?: string, deps: RunDeps = {}): Run {
  const pack = loadPack(jobId);
  if (!pack) throw new Error(`No pack for ${jobId}: draft the pack first.`);
  const status = getApplication(jobId)?.status;
  if (status !== "saved" && status !== "drafted") throw new Error(`Cannot draft for ${jobId}: status is ${status ? `"${status}"` : "none"}, expected "drafted".`);
  if (question !== undefined && !Object.hasOwn(pack.answers, question)) throw new Error(`Not a question in this pack: ${question}`);
  const run = begin(jobId, "whyus");
  try {
    const child = spawnClaude(jobId, ".whyus", whyUsPrompt(jobId, question), WHYUS_TOOLS, deps, (code, err) => finishWhyUs(jobId, run, code, err));
    return put(jobId, { ...run, state: "running", pid: child.pid });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    addEvent(jobId, "draft", `Why-us draft failed: ${error}`);
    return put(jobId, { ...run, state: "failed", endedAt: new Date().toISOString(), error });
  }
}

/** Inspect, then fill the form in-process with the pack's answers. Never submits. Resolves when settled. */
export function startFill(jobId: string, deps: RunDeps = {}, force = false): { run: Run; settled: Promise<Run> } {
  if (!loadPack(jobId)) throw new Error(`No pack for ${jobId}: draft one first.`);
  const status = getApplication(jobId)?.status;
  if (status !== "drafted") throw new Error(`Cannot fill ${jobId}: status is ${status ? `"${status}"` : "none"}, expected "drafted".`);
  const run = put(jobId, { ...begin(jobId, "fill"), state: "running", pid: process.pid });
  const settled = (async () => {
    const engine = deps.inspect && deps.fill ? null : await import("./apply/engine.js");
    const inspect = deps.inspect ?? engine!.inspectForm;
    // No answer overrides: the engine reads the pack under the job lock, after any edit still being written.
    const fill = deps.fill ?? ((id: string) => engine!.fillForm(id, {}, false, force));
    try {
      assertOwnResume(jobId); // before the browser opens the employer's form
      const ins = await inspect(jobId);
      const r = await fill(jobId);
      const missing = r.blanks;
      const warnings = [
        ...r.skipped.filter(s => s.reason.startsWith("fill failed") || s.key === "captcha").map(s => `${s.label}: ${s.reason}`),
        ...(r.captchaDetected || ins.captchaDetected ? ["CAPTCHA on the form: finish it yourself in the browser window"] : []),
      ];
      return put(jobId, { ...run, state: "done", endedAt: new Date().toISOString(), result: { filled: r.filled.length, missing, warnings, screenshot: r.screenshot } });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      addEvent(jobId, "fill", `Fill failed: ${error}`);
      return put(jobId, { ...run, state: "failed", endedAt: new Date().toISOString(), error });
    }
  })();
  return { run, settled };
}

/**
 * Press Submit on an approved form this server filled (the user's approval is the yes). Undefined when the fill is
 * not held in this process: an agent that filled it in its own process submits it there. Done only when the employer
 * confirmed the submission; a CAPTCHA or a form error settles as failed with the engine's explanation.
 */
export async function startSubmit(jobId: string, deps: RunDeps = {}): Promise<{ run: Run; settled: Promise<Run> } | undefined> {
  const hasPage = deps.hasPage ?? (await import("./apply/engine.js")).canSubmit;
  if (!hasPage(jobId)) return undefined;
  const run = put(jobId, { ...begin(jobId, "submit"), state: "running", pid: process.pid });
  const settled = (async () => {
    try {
      const r = await (deps.submit ?? (await import("./apply/engine.js")).submitForm)(jobId);
      const ended = new Date().toISOString();
      return put(jobId, r.outcome === "submitted" ? { ...run, state: "done", endedAt: ended } : { ...run, state: "failed", endedAt: ended, error: r.detail });
    } catch (e) {
      return put(jobId, { ...run, state: "failed", endedAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return { run, settled };
}
