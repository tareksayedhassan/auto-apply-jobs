import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import "./offline.js";

const home = mkdtempSync(join(tmpdir(), "oa-hsurf-"));
process.env.OPENAPPLY_HOME = home;
const db = await import("../src/db.js");
const { startServer } = await import("../src/server/http.js");

const VANDELAY_FDE = "ashby:Vandelay:75576a88-de08-5792-a34c-3f1667bd8f1f";
const SOYLENT2 = "lever:soylent:9";
const job = (id: string, company: string, title: string) => ({
  id, ats: "greenhouse" as const, boardSlug: "b", company, title, location: "NYC", remote: false,
  description: "forward deployed work", url: `https://jobs.example/${id}`, applyUrl: `https://jobs.example/${id}`,
});
db.upsertJobs([job(VANDELAY_FDE, "Vandelay", "Forward Deployed Engineer"), job(SOYLENT2, "Soylent", "Forward Deployed Engineer"), job("greenhouse:soylent:1", "Soylent", "Forward Deployed Engineer")]);

const recordsFile = join(home, "history.json");
writeFileSync(recordsFile, JSON.stringify({ records: [
  { company: "Vandelay", title: "Delivery Strategist", appliedAt: "2026-08-28", status: "submitted" },
  { company: "Soylent", title: "Forward Deployed Engineer", appliedAt: "2026-09-01", status: "submitted", url: "https://jobs.example/greenhouse:soylent:1" },
] }));
const cliEnv = { ...process.env, OPENAPPLY_HOME: home } as Record<string, string>;
const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env: cliEnv, encoding: "utf8" });

test("CLI import-history takes {records} or a bare array, reports counts, and is idempotent", () => {
  const a = cli("import-history", recordsFile);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /created 1, attached 1, unchanged 0/);
  const bare = join(home, "bare.json");
  writeFileSync(bare, JSON.stringify(JSON.parse(readFileSync(recordsFile, "utf8")).records));
  const b = cli("import-history", bare);
  assert.match(b.stdout, /created 0, attached 0, unchanged 2/);
  assert.notEqual(cli("import-history", join(home, "missing.json")).status, 0);
});

const H = { "x-openapply": "1", "content-type": "application/json" };
let srv: Awaited<ReturnType<typeof startServer>>;
const drafts: string[] = [], fills: string[] = [];
before(async () => {
  db.closeDb(); // the CLI wrote the same file; reopen cleanly
  srv = await startServer(0, { uiDir: home, runDeps: {
    spawn: ((_c: string, args: string[]) => { drafts.push(args[1]); throw new Error("spawn stub"); }) as any,
    inspect: async (jobId) => ({ jobId, adapter: "greenhouse", url: "https://x", fields: [], missing: [], captchaDetected: false }),
    fill: async (jobId) => { fills.push(jobId); db.setApplication(jobId, { status: "filled", confirmationCode: "ABC234" }); return { jobId, filled: [], skipped: [], blanks: [], failed: [], confirmationCode: "ABC234", captchaDetected: false }; },
  } });
});
after(() => srv.close());
const j = async (path: string, init?: RequestInit) => { const r = await fetch(srv.url + path, init); return { status: r.status, body: await r.json() as any }; };
const enc = encodeURIComponent;

test("API: job detail, job list, matches and pipeline carry priorApplications and a warning", async () => {
  const d = await j(`/api/jobs/${enc(VANDELAY_FDE)}`);
  assert.equal(d.body.warning, "Already applied to Vandelay · Delivery Strategist on 2026-08-28");
  assert.equal(d.body.priorApplications[0].similarTitle, false);
  assert.equal(d.body.priorApplications[0].imported, true);
  const list = await j("/api/jobs?company=Vandelay");
  assert.equal(list.body.jobs[0].priorApplications.length, 1);
  const pipe = await j("/api/pipeline");
  const stub = pipe.body.items.find((i: any) => i.jobId === "history:vandelay:delivery-strategist");
  assert.equal(stub.source, "history");
  assert.deepEqual(stub.priorApplications, []); // its own application is not its prior
  assert.equal(stub.job.company, "Vandelay");
});

test("draft and fill routes: 409 on a similar-title duplicate, force:true goes through, a different title only warns", async () => {
  const post = (id: string, what: string, body: object = {}) => j(`/api/jobs/${enc(id)}/${what}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const r = await post(SOYLENT2, "draft");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Already applied to Soylent · Forward Deployed Engineer on 2026-09-01/);
  assert.equal(r.body.priorApplications[0].jobId, "greenhouse:soylent:1");
  assert.equal((await post(SOYLENT2, "fill")).status, 409);
  assert.equal(fills.length, 0);

  // forced fill gets past the guard (this stub job has no pack, so the next check, not the guard, refuses)
  const forced = await post(SOYLENT2, "fill", { force: true });
  assert.equal(forced.status, 400);
  assert.match(forced.body.error, /No pack|TODO|pack/i);

  // Vandelay FDE: only a different-title prior, so the guard lets draft through to its own checks
  const t = await post(VANDELAY_FDE, "draft");
  assert.notEqual(t.status, 409);
});

test("MCP: import_history, priorApplications on get_job / search_jobs, fill_application refuses a duplicate", async () => {
  const client = new Client({ name: "test", version: "0" });
  db.closeDb();
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", "src/mcp.ts"], env: cliEnv,
  }));
  try {
    const call = async (name: string, args: object = {}) => {
      const r: any = await client.callTool({ name, arguments: args as Record<string, unknown> });
      return { isError: !!r.isError, text: r.content[0].text as string };
    };
    const imp = await call("import_history", { records: [{ company: "Vandelay", title: "Delivery Strategist", appliedAt: "2026-08-28", status: "submitted" }] });
    assert.equal(imp.isError, false, imp.text);
    assert.deepEqual(JSON.parse(imp.text), { created: 0, attached: 0, unchanged: 1 });
    const gj = JSON.parse((await call("get_job", { job_id: VANDELAY_FDE })).text);
    assert.equal(gj.warning, "Already applied to Vandelay · Delivery Strategist on 2026-08-28");
    assert.equal(gj.priorApplications[0].status, "submitted");
    const sj = JSON.parse((await call("search_jobs", { company: "Vandelay" })).text);
    assert.equal(sj.jobs[0].priorApplications.length, 1);
    const sv = JSON.parse((await call("save_job", { job_id: VANDELAY_FDE })).text);
    assert.equal(sv.warning, "Already applied to Vandelay · Delivery Strategist on 2026-08-28");
    const f = await call("fill_application", { job_id: SOYLENT2 });
    assert.equal(f.isError, true);
    assert.match(f.text, /Already applied to Soylent/);
  } finally { await client.close(); }
});
