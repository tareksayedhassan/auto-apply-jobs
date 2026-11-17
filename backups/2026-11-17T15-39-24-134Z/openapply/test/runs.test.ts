import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import "./offline.js";

const home = mkdtempSync(join(tmpdir(), "oa-runs-"));
process.env.OPENAPPLY_HOME = home;
const db = await import("../src/db.js");
const { packDir } = await import("../src/paths.js");
const { saveProfile } = await import("../src/profile.js");
const runs = await import("../src/runs.js");
const { packTodos } = await import("../src/tailor.js");
const { startServer } = await import("../src/server/http.js");

const job = (n: string) => ({
  id: `greenhouse:acme:${n}`, ats: "greenhouse" as const, boardSlug: "acme", company: "Acme",
  title: `Engineer ${n}`, location: "NYC", remote: false, description: "x", url: "https://x", applyUrl: "https://x",
});
db.upsertJobs(["1", "2", "3", "4"].map(job));
const pdf = join(home, "base.pdf");
writeFileSync(pdf, "%PDF-fake");
saveProfile({ resumePdf: pdf });

/** A fake child process: records the call; the test decides when it "exits". */
function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let child: EventEmitter & { pid?: number; unref(): void };
  const spawn = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} }); // alive pid
    return child as any;
  };
  return { spawn, calls, exit: (code: number) => child.emit("exit", code) };
}
/** A pack as save_application_pack leaves it: the resume_pdf it was given is copied into the pack dir. */
const writePack = (id: string, resumePdf = pdf) => writeFileSync(join(packDir(id), "pack.json"),
  JSON.stringify({ jobId: id, resume: {}, answers: { "Why us?": "TODO" }, resumePdf: join(packDir(id), basename(resumePdf)), warnings: [], createdAt: new Date().toISOString() }));

test("draft: queued -> running -> done, flags the pack, logs the event, one run at a time", () => {
  const id = "greenhouse:acme:1";
  const f = fakeSpawn();
  const r = runs.startDraft(id, { spawn: f.spawn });
  assert.equal(r.state, "running");
  assert.equal(f.calls.length, 1);
  const args = f.calls[0].args;
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.deepEqual(args[args.indexOf("--allowedTools") + 1].split(","), runs.DRAFT_TOOLS);
  const cfg = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
  assert.deepEqual(Object.keys(cfg.mcpServers), ["openapply"]);
  assert.match(args[args.indexOf("-p") + 1], new RegExp(pdf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.throws(() => runs.startDraft(id, { spawn: f.spawn }), /Busy/);
  assert.equal(runs.getRun(id)?.state, "running"); // pid alive: still running after a reload

  writePack(id);
  f.exit(0);
  const done = runs.getRun(id)!;
  assert.equal(done.state, "done");
  assert.equal(JSON.parse(readFileSync(join(packDir(id), "pack.json"), "utf8")).needsTailoredCut, true);
  assert.equal(done.track, "base", "no resume tracks: profile.resumePdf, as before");
  assert.ok(db.listEvents(id).some(e => e.detail?.startsWith(runs.DRAFTED_EVENT) && /base/.test(e.detail)));
});

test("draft: exit without a pack fails with a logged reason; a new run may start", () => {
  const id = "greenhouse:acme:2";
  const f = fakeSpawn();
  runs.startDraft(id, { spawn: f.spawn });
  f.exit(1);
  const r = runs.getRun(id)!;
  assert.equal(r.state, "failed");
  assert.match(r.error!, /code 1/);
  assert.ok(db.listEvents(id).some(e => e.detail?.startsWith("Draft failed")));
  assert.equal(runs.startDraft(id, { spawn: fakeSpawn().spawn }).state, "running");
});

test("draft: a running run whose process is gone settles on read", () => {
  const id = "greenhouse:acme:3";
  db.kvSet(`run:${id}`, JSON.stringify({ kind: "draft", state: "running", startedAt: new Date().toISOString(), pid: 2 ** 22 + 7 }));
  assert.equal(runs.getRun(id)?.state, "failed");
});

test("draft: the drafter's answers to relocation and office questions go back to TODO unless a saved answer covers that city", () => {
  const SF = { ...job("sf"), location: "San Francisco" };
  const NYC = job("nyc");
  db.upsertJobs([SF, NYC]);
  const NY = "I'm based in New York, so no relocation needed.";
  saveProfile({ savedAnswers: { "Willing to relocate": NY } });
  const OFFICE = "Are you willing to work from our office in San Francisco, California full-time, 3+ days a week?";
  const RELOCATE = "Are you willing to relocate?";
  const HEAR = "How did you hear about this role?";
  const draft = (id: string, answers: Record<string, string>) => {
    const f = fakeSpawn();
    runs.startDraft(id, { spawn: f.spawn });
    writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ jobId: id, resume: {}, answers, resumePdf: join(packDir(id), basename(pdf)), warnings: [], createdAt: new Date().toISOString() }));
    f.exit(0);
    assert.equal(runs.getRun(id)?.state, "done");
    return { prompt: f.calls[0].args[f.calls[0].args.indexOf("-p") + 1], pack: JSON.parse(readFileSync(join(packDir(id), "pack.json"), "utf8")) };
  };
  const sf = draft(SF.id, { [OFFICE]: "yes", [RELOCATE]: NY, [HEAR]: "Company careers page" });
  assert.match(sf.prompt, /relocat[\s\S]*TODO \(you\)/i, "the prompt tells the drafter too");
  assert.match(sf.pack.answers[OFFICE], /^TODO \(you\)/);
  assert.match(sf.pack.answers[RELOCATE], /^TODO \(you\)/, "a New York answer does not answer a San Francisco job");
  assert.equal(sf.pack.answers[HEAR], "Company careers page");
  assert.equal(sf.pack.needsTailoredCut, true);
  assert.deepEqual(packTodos(sf.pack).sort(), [OFFICE, RELOCATE].sort(), "Fill stays blocked until the user answers");
  assert.ok(db.listEvents(SF.id).some(e => /2 .*TODO/.test(e.detail ?? "")));
  // the saved New York answer covers a New York job
  assert.equal(draft(NYC.id, { [RELOCATE]: NY }).pack.answers[RELOCATE], NY);
});

let srv: Awaited<ReturnType<typeof startServer>>;
let filled = 0;
let inspected = 0;
const submitted: string[] = [];
before(async () => {
  srv = await startServer(0, {
    uiDir: home,
    runDeps: {
      inspect: async (jobId) => { inspected++; return { jobId, adapter: "greenhouse", url: "https://x", fields: [], missing: [], captchaDetected: false }; },
      fill: async (jobId) => {
        filled++;
        db.setApplication(jobId, { status: "filled", confirmationCode: "ABC234" });
        return { jobId, filled: [{ key: "a", label: "A", value: "x" }], skipped: [{ key: "b", label: "Why us?", reason: "required, no answer: ask the user" }], blanks: ["Why us?"], failed: [], confirmationCode: "ABC234", captchaDetected: false };
      },
      hasPage: (jobId) => jobId === "greenhouse:acme:3",
      submit: async (jobId) => { submitted.push(jobId); return { jobId, outcome: "submitted", detail: "Submitted via greenhouse" }; },
    },
  });
});
after(() => srv.close());

test("fill route: header guard, needs a drafted pack, fills once, never submits", async () => {
  const id = "greenhouse:acme:4";
  const url = `${srv.url}/api/jobs/${encodeURIComponent(id)}/fill`;
  const H = { "x-openapply": "1", "content-type": "application/json" };
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers: { ...H, origin: "http://evil.example" }, body: "{}" })).status, 403);
  assert.equal(filled, 0);

  assert.equal((await fetch(url, { method: "POST", headers: H, body: "{}" })).status, 400); // no pack
  writePack(id);
  db.setApplication(id, { status: "drafted" });
  const r = await fetch(url, { method: "POST", headers: H, body: "{}" });
  assert.equal(r.status, 202);
  let run: any;
  for (let i = 0; i < 50 && run?.state !== "done"; i++) {
    run = (await (await fetch(`${srv.url}/api/jobs/${encodeURIComponent(id)}/run`)).json() as any).run;
    await new Promise(ok => setTimeout(ok, 10));
  }
  assert.equal(run.state, "done");
  assert.deepEqual(run.result, { filled: 1, missing: ["Why us?"], warnings: [] });
  assert.equal(db.getApplication(id)?.status, "filled");
  assert.equal(filled, 1);
  // status is now filled: a second fill is refused until it is drafted again
  assert.equal((await fetch(url, { method: "POST", headers: H, body: "{}" })).status, 400);
});

test("fill route: a pack with TODO (you) answers is refused before the form is touched", async () => {
  const id = "greenhouse:acme:5";
  db.upsertJobs([job("5")]);
  writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ jobId: id, resume: {},
    coverLetter: "Dear team, TODO (you): one specific reason.",
    answers: { "Why us?": "todo (sam): your real reason", "Start date": "Two weeks", "Visa?": "No" },
    warnings: [], createdAt: new Date().toISOString() }));
  db.setApplication(id, { status: "drafted" });
  const url = `${srv.url}/api/jobs/${encodeURIComponent(id)}/fill`;
  const H = { "x-openapply": "1", "content-type": "application/json" };
  const [inspectedBefore, filledBefore] = [inspected, filled];
  const r = await fetch(url, { method: "POST", headers: H, body: "{}" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "Pack has TODOs to finish first: Why us?, Cover letter" });
  assert.equal(inspected, inspectedBefore); // the form was never inspected
  assert.equal(filled, filledBefore);
  assert.equal(runs.getRun(id), undefined); // no run was started
  assert.equal(db.getApplication(id)?.status, "drafted");
});

test("fill route: a blank answer counts as unfinished too", async () => {
  const id = "greenhouse:acme:7";
  db.upsertJobs([job("7")]);
  writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ jobId: id, resume: {},
    answers: { "Why us?": "   ", "Start date": "Two weeks" }, warnings: [], createdAt: new Date().toISOString() }));
  db.setApplication(id, { status: "drafted" });
  const [inspectedBefore, filledBefore] = [inspected, filled];
  const r = await fetch(`${srv.url}/api/jobs/${encodeURIComponent(id)}/fill`, { method: "POST", headers: { "x-openapply": "1", "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "Pack has TODOs to finish first: Why us?" });
  assert.equal(inspected, inspectedBefore);
  assert.equal(filled, filledBefore);
  assert.equal(runs.getRun(id), undefined);
});

/** Hold the job lock while a pack edit is "still being written"; the edit lands when release() is called. */
async function pendingEdit(id: string, answers: Record<string, string>) {
  const { exclusive } = await import("../src/lock.js");
  let release!: () => void;
  const gate = new Promise<void>(ok => { release = ok; });
  const done = exclusive(id, async () => {
    await gate;
    writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ jobId: id, resume: {}, answers, warnings: [], createdAt: new Date().toISOString() }));
  });
  return { release, done };
}
/** Like the engine: merge caller overrides over the pack it reads under the job lock. */
async function engineLikeFill(seen: Record<string, string>[]) {
  const { exclusive } = await import("../src/lock.js");
  const { loadPack } = await import("../src/tailor.js");
  return (jobId: string, overrides: Record<string, string> = {}) => exclusive(jobId, async () => {
    seen.push({ ...(loadPack(jobId)?.answers ?? {}), ...overrides });
    return { jobId, filled: [], skipped: [], blanks: [], failed: [], confirmationCode: "ABC234", captchaDetected: false };
  });
}

test("fill: an edit still being written when the fill starts is what the form gets", async () => {
  const id = "greenhouse:acme:8";
  db.upsertJobs([job("8")]);
  writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ jobId: id, resume: {}, answers: { "Why us?": "OLD answer" }, warnings: [], createdAt: new Date().toISOString() }));
  db.setApplication(id, { status: "drafted" });
  const edit = await pendingEdit(id, { "Why us?": "NEW answer" });
  const seen: Record<string, string>[] = [];
  const { settled } = runs.startFill(id, { inspect: async j => ({ jobId: j, adapter: "greenhouse", url: "https://x", fields: [], missing: [], captchaDetected: false }), fill: await engineLikeFill(seen) });
  edit.release();
  assert.equal((await settled).state, "done");
  assert.deepEqual(seen, [{ "Why us?": "NEW answer" }]);
});

test("fill route: the TODO check waits for an edit still being written", async () => {
  const id = "greenhouse:acme:9";
  db.upsertJobs([job("9")]);
  writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ jobId: id, resume: {}, answers: { "Why us?": "TODO (you): your reason" }, warnings: [], createdAt: new Date().toISOString() }));
  db.setApplication(id, { status: "drafted" });
  const seen: Record<string, string>[] = [];
  const s2 = await startServer(0, { uiDir: home, runDeps: { inspect: async j => ({ jobId: j, adapter: "greenhouse", url: "https://x", fields: [], missing: [], captchaDetected: false }), fill: await engineLikeFill(seen) } });
  try {
    const edit = await pendingEdit(id, { "Why us?": "My real reason" });
    const r = fetch(`${s2.url}/api/jobs/${encodeURIComponent(id)}/fill`, { method: "POST", headers: { "x-openapply": "1", "content-type": "application/json" }, body: "{}" });
    await new Promise(ok => setTimeout(ok, 50));
    edit.release();
    assert.equal((await r).status, 202);
    for (let i = 0; i < 50 && runs.getRun(id)?.state !== "done"; i++) await new Promise(ok => setTimeout(ok, 10));
    assert.deepEqual(seen, [{ "Why us?": "My real reason" }]);
  } finally { s2.close(); }
});

test("submit: only when this process holds the filled form; settles with the outcome", async () => {
  const id = "greenhouse:acme:3";
  assert.equal(await runs.startSubmit(id, { hasPage: () => false, submit: async () => { throw new Error("must not submit"); } }), undefined);
  const ok = await runs.startSubmit(id, { hasPage: () => true, submit: async j => ({ jobId: j, outcome: "submitted", detail: "Submitted via ashby" }) });
  assert.equal(ok?.run.kind, "submit");
  const done = await ok!.settled;
  assert.equal(done.state, "done");
  assert.equal(runs.getRun(id)?.state, "done");
  const captcha = await runs.startSubmit(id, { hasPage: () => true, submit: async j => ({ jobId: j, outcome: "needs_human", detail: "CAPTCHA on the page" }) });
  const held = await captcha!.settled; // not submitted: the engine's explanation is the error
  assert.equal(held.state, "failed");
  assert.equal(held.error, "CAPTCHA on the page");
  const bad = await runs.startSubmit(id, { hasPage: () => true, submit: async () => { throw new Error("Submit refused: no approval"); } });
  assert.match((await bad!.settled).error!, /Submit refused/);
});

test("approve route presses Submit when this server holds the form, and only records the yes otherwise", async () => {
  const H = { "x-openapply": "1", "content-type": "application/json" };
  const approve = (id: string) => fetch(`${srv.url}/api/jobs/${encodeURIComponent(id)}/approve`, { method: "POST", headers: H, body: JSON.stringify({ code: "APP234" }) });
  for (const id of ["greenhouse:acme:3", "greenhouse:acme:1"]) db.setApplication(id, { status: "filled", confirmationCode: "APP234" });
  const held = await (await approve("greenhouse:acme:3")).json() as any;
  assert.equal(held.status, "approved", JSON.stringify(held));
  assert.equal(held.run?.kind, "submit");
  for (let i = 0; i < 50 && !submitted.length; i++) await new Promise(ok => setTimeout(ok, 10));
  assert.deepEqual(submitted, ["greenhouse:acme:3"]);
  const elsewhere = await (await approve("greenhouse:acme:1")).json() as any; // filled by an agent in its own process
  assert.equal(elsewhere.status, "approved");
  assert.equal(elsewhere.run, undefined);
  assert.deepEqual(submitted, ["greenhouse:acme:3"]);
});


test("draft: the resume track is picked from the job, named in the prompt, the run and the event", () => {
  const cryptoPdf = join(home, "crypto.pdf");
  writeFileSync(cryptoPdf, "%PDF-fake");
  saveProfile({ resumes: { product: { pdf, useFor: ["forward deployed"] }, crypto: { pdf: cryptoPdf, useFor: ["crypto", "defi"] } }, defaultResume: "product" });
  const DEFI = { ...job("defi"), title: "Protocol Engineer, DeFi" };
  const FDE = { ...job("fde"), title: "Forward Deployed Engineer" };
  db.upsertJobs([DEFI, FDE]);
  const draft = (id: string) => {
    const f = fakeSpawn();
    const r = runs.startDraft(id, { spawn: f.spawn });
    const prompt = f.calls[0].args[f.calls[0].args.indexOf("-p") + 1];
    writePack(id, r.pdf);
    f.exit(0);
    return { r, prompt, done: runs.getRun(id)! };
  };
  const d = draft(DEFI.id);
  assert.equal(d.r.track, "crypto");
  assert.ok(d.prompt.includes(`resume_pdf: ${cryptoPdf}`), "the picked PDF is the one the drafter saves");
  assert.match(d.prompt, /Resume track: crypto \(title matches "defi"\)/);
  assert.equal(d.done.track, "crypto");
  assert.ok(db.listEvents(DEFI.id).some(e => e.kind === "draft" && /crypto/.test(e.detail ?? "")));

  const p = draft(FDE.id);
  assert.equal(p.done.track, "product");
  assert.ok(p.prompt.includes(`resume_pdf: ${pdf}`));

  // the picked track's PDF must exist
  const MISSING = { ...job("gone"), title: "DeFi Engineer" };
  db.upsertJobs([MISSING]);
  saveProfile({ resumes: { product: { pdf, useFor: [] }, crypto: { pdf: join(home, "nope.pdf"), useFor: ["defi"] } } });
  const f = fakeSpawn();
  const failed = runs.startDraft(MISSING.id, { spawn: f.spawn });
  assert.equal(failed.state, "failed");
  assert.match(failed.error!, /crypto.*not found/);
  assert.equal(f.calls.length, 0, "nothing was spawned");
});

test("draft: a pack that does not upload the picked track's PDF settles failed, not done", () => {
  const cryptoPdf = join(home, "crypto.pdf");
  writeFileSync(cryptoPdf, "%PDF-fake");
  saveProfile({ resumes: { product: { pdf, useFor: [] }, crypto: { pdf: cryptoPdf, useFor: ["defi"] } }, defaultResume: "product" });
  const SWAP = { ...job("swap"), title: "DeFi Engineer" };
  const NONE = { ...job("none"), title: "DeFi Analyst" };
  db.upsertJobs([SWAP, NONE]);

  const f = fakeSpawn();
  assert.equal(runs.startDraft(SWAP.id, { spawn: f.spawn }).pdf, cryptoPdf);
  writePack(SWAP.id, pdf); // the drafter saved the product PDF instead
  f.exit(0);
  const swapped = runs.getRun(SWAP.id)!;
  assert.equal(swapped.state, "failed");
  assert.match(swapped.error!, /base\.pdf, not the crypto resume crypto\.pdf/);
  assert.ok(db.listEvents(SWAP.id).some(e => /^Draft failed: .*crypto/.test(e.detail ?? "")));
  assert.ok(!db.listEvents(SWAP.id).some(e => e.detail?.startsWith(runs.DRAFTED_EVENT)), "no 'Pack drafted' event");

  const g = fakeSpawn();
  runs.startDraft(NONE.id, { spawn: g.spawn });
  writeFileSync(join(packDir(NONE.id), "pack.json"), JSON.stringify({ jobId: NONE.id, resume: {}, answers: {}, warnings: [], createdAt: new Date().toISOString() }));
  g.exit(0); // saved without resume_pdf
  assert.equal(runs.getRun(NONE.id)!.state, "failed");
  assert.match(runs.getRun(NONE.id)!.error!, /uploads no resume/);
});

test("fill run: a pack on OpenApply's rendered resume fails before the form is inspected", async () => {
  const id = "greenhouse:acme:rendered";
  db.upsertJobs([job("rendered")]);
  saveProfile({ resumePdf: pdf });
  writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({
    jobId: id, resume: {}, answers: {}, resumePdf: join(packDir(id), "resume.pdf"), warnings: [], createdAt: new Date().toISOString(),
  }));
  db.setApplication(id, { status: "drafted" });
  let opened = 0;
  const { settled } = runs.startFill(id, {
    inspect: async j => { opened++; return { jobId: j, adapter: "greenhouse", url: "https://x", fields: [], missing: [], captchaDetected: false }; },
    fill: async () => { opened++; throw new Error("fill should not run"); },
  });
  const r = await settled;
  assert.equal(r.state, "failed");
  assert.match(r.error!, /Fill refused: this pack uses OpenApply's rendered resume/);
  assert.equal(opened, 0, "inspect (the browser) never ran");
  assert.equal(db.getApplication(id)?.status, "drafted");
});
