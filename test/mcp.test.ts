import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = mkdtempSync(join(tmpdir(), "oa-mcp-"));
process.env.OPENAPPLY_HOME = home;
const db = await import("../src/db.js");

const JOB = "greenhouse:acme:1";
db.upsertJobs([{
  id: JOB, ats: "greenhouse", boardSlug: "acme", company: "Acme", title: "Forward Deployed Engineer",
  location: "New York, NY", remote: false, url: "https://example.com/1", applyUrl: "https://example.com/1",
  description: "Acme is hiring its first forward deployed engineer to ship TypeScript integrations with customers.",
}]);
db.closeDb();

const resumeTxt = join(home, "jane.txt");
writeFileSync(resumeTxt, `Jane Doe
jane@example.com | 555-010-0000 | Brooklyn, NY

Experience
Globex | Software Engineer | 2021 - 2024
- Built TypeScript integrations for 12 enterprise customers
- Cut onboarding time by 30%

Education
State University | B.S. Computer Science | 2017 - 2021

Skills
TypeScript, React, SQL
`);

const client = new Client({ name: "test", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: ["--import", "tsx", "src/mcp.ts"],
  env: { ...process.env, OPENAPPLY_HOME: home } as Record<string, string>,
}));
after(() => client.close());

const call = async (name: string, args: object = {}) => {
  const r: any = await client.callTool({ name, arguments: args as Record<string, unknown> });
  const text = r.content[0].text as string;
  assert.ok(!r.isError, `${name} failed: ${text}`);
  return JSON.parse(text);
};

test("lists the full toolset and instructions", async () => {
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  for (const t of ["get_started", "search_jobs", "list_matches", "save_application_pack", "fill_application",
    "submit_application", "company_brief", "log_outreach", "due_follow_ups", "apply_outcomes", "log_applied_offsite", "strategy_scoreboard"]) assert.ok(names.includes(t), t);
  const score = tools.find(t => t.name === "strategy_scoreboard")!;
  assert.equal(score.annotations?.readOnlyHint, true);
  assert.match(score.description!, /never artifacts made/);
  assert.ok(client.getInstructions()?.includes("apply_outcomes"));
  const outcomes = tools.find(t => t.name === "apply_outcomes")!;
  assert.notEqual(outcomes.annotations?.readOnlyHint, true);
  assert.match(outcomes.description!, /never invent outcomes/);
  assert.ok(client.getInstructions()?.includes("explicit yes"));
  const submit = tools.find(t => t.name === "submit_application")!;
  assert.equal(submit.annotations?.destructiveHint, true);
  const due = tools.find(t => t.name === "due_follow_ups")!;
  for (const k of ["send_or_close", "propose_close", "follow_up", "waitingOn", "never close it without their yes"]) {
    assert.ok(due.description!.includes(k), `due_follow_ups description names ${k}`);
  }
  assert.ok((due.inputSchema.properties as Record<string, unknown>).draft_days, "draft_days is a tool input");
});

test("setup -> search -> brief -> pack -> track", async () => {
  const start = await call("get_started");
  assert.equal(start.profile.hasResume, false);

  const imp = await call("import_resume", { path: resumeTxt });
  assert.equal(imp.resume.experience[0].company, "Globex");
  await call("update_profile", { patch: { firstName: "Jane", lastName: "Doe", email: "jane@example.com",
    targets: { titles: ["Forward Deployed Engineer"] } } });

  const s = await call("search_jobs", { query: "forward deployed" });
  assert.equal(s.total, 1);
  const m = await call("list_matches", {});
  assert.equal(m[0].id, JOB);

  const brief = await call("company_brief", { job_id: JOB });
  assert.ok(brief.whyNow.length > 0);
  const tb = await call("get_tailoring_brief", { job_id: JOB });
  assert.ok(tb.rules.length > 3);

  const tailored = { ...imp.resume, summary: "Engineer who builds TypeScript integrations with customers." };
  tailored.experience[0].bullets = ["Built TypeScript integrations for 40 enterprise customers"];
  const pack = await call("save_application_pack", { job_id: JOB, resume: tailored,
    cover_letter: "I am thrilled to apply.\n\nAt Globex I built integrations." });
  assert.ok(pack.warnings.some((w: string) => w.includes("40")), "truth guard catches invented number");
  assert.ok(pack.warnings.some((w: string) => w.startsWith("Voice:")), "voice guard catches cliche");
  assert.ok(existsSync(pack.resumePdf));

  const blocked: any = await client.callTool({ name: "submit_application", arguments: { job_id: JOB, confirmation_code: "WRONG" } });
  assert.equal(blocked.isError, true, "submit refuses without a filled form and valid code");

  const o = await call("log_outreach", { company: "Acme", person: "Sam Recruiter", channel: "email", job_id: JOB });
  assert.equal(o.status, "sent");
  const p = await call("pipeline_summary");
  assert.equal(p.counts.drafted, 1);
});

test("fill_application refuses a pack with TODO answers before any browser opens", async () => {
  await call("save_application_pack", { job_id: JOB, resume: await call("get_resume"),
    answers: { "Why Acme?": "TODO (you): your real reason" } });
  const r: any = await client.callTool({ name: "fill_application", arguments: { job_id: JOB } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unfinished.*Why Acme\?/);
  const blank: any = await client.callTool({ name: "fill_application", arguments: { job_id: JOB, answers: { "Why Acme?": " " } } });
  assert.equal(blank.isError, true);
  assert.equal((await call("pipeline_summary")).counts.drafted, 1);
});

test("log_applied_offsite records a submitted row; apply_outcomes moves it; pipeline_summary carries ageOut", async () => {
  const logged = await call("log_applied_offsite", { company: "Initech", title: "Solutions Engineer", date: "2026-09-01" });
  assert.equal(logged.created, 1);
  const again = await call("log_applied_offsite", { company: "Initech", title: "Solutions Engineer", date: "2026-09-01" });
  assert.equal(again.unchanged, 1, "history guard: a second log changes nothing");
  const p = await call("pipeline_summary");
  assert.ok(Array.isArray(p.ageOut));
  assert.ok(p.ageOut.some((r: any) => r.company === "Initech" && r.propose === "ghosted"));
  const r = await call("apply_outcomes", { items: [{ company: "Initech", kind: "rejected", date: "2026-10-30", source_id: "mcp-1" }] });
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].to, "rejected");
  const replay = await call("apply_outcomes", { items: [{ company: "Initech", kind: "rejected", date: "2026-10-30", source_id: "mcp-1" }] });
  assert.equal(replay.applied.length, 0);
  assert.equal((await call("pipeline_summary")).counts.rejected, 1);
});

test("due_follow_ups passes draft_days through; update_outreach refuses a follow-up on an unsent draft", async () => {
  const d = await call("draft_outreach", { company: "Acme", person: "Dee Draft", channel: "email", message: "hi", job_id: JOB });
  assert.ok(!(await call("due_follow_ups")).some((r: any) => r.id === d.id), "a fresh draft is not due at the default 2 days");
  const due = (await call("due_follow_ups", { draft_days: 0 })).find((r: any) => r.id === d.id);
  assert.equal(due?.kind, "send_or_close");
  const r: any = await client.callTool({ name: "update_outreach", arguments: { id: d.id, followed_up: true } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unsent draft/);
  assert.equal((await call("list_outreach", { company: "Acme" })).find((x: any) => x.id === d.id).followUps, 0);
});

test("update_outreach message edits a draft (voice notes back) and refuses a sent row", async () => {
  const d = await call("draft_outreach", { company: "Acme", person: "Ed Draft", channel: "email", message: "v1", job_id: JOB });
  const e = await call("update_outreach", { id: d.id, message: "We are a dynamic team, v2" });
  assert.equal(e.message, "We are a dynamic team, v2");
  assert.equal(e.status, "draft");
  assert.ok(e.warnings.some((w: string) => /dynamic/.test(w)), "voice check reruns");
  assert.equal((await call("list_outreach", { company: "Acme" })).find((x: any) => x.id === d.id).message, "We are a dynamic team, v2");
  await call("update_outreach", { id: d.id, status: "sent" });
  const r: any = await client.callTool({ name: "update_outreach", arguments: { id: d.id, message: "v3" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /already sent/);
  assert.equal((await call("list_outreach", { company: "Acme" })).find((x: any) => x.id === d.id).message, "We are a dynamic team, v2");
});

test("strategy_scoreboard returns the scoreboard JSON and never writes strategy.json", async () => {
  const s = await call("strategy_scoreboard");
  assert.deepEqual(s.week.targets, { warmAsks: 4, applications: 5 });
  assert.deepEqual(s.companies, [], "no strategy.json: the generic defaults name no companies");
  assert.ok(["hold", "widen"].includes(s.gate.verdict));
  assert.ok(Array.isArray(s.personFlags) && Array.isArray(s.followUpsDue));
  assert.equal(existsSync(join(home, "strategy.json")), false, "a read-only tool leaves no file behind");
});

test("sync_jobs stands down while the dashboard's auto-sync runs", async () => {
  db.kvSetJson("autosync:running", { startedAt: new Date().toISOString(), pid: 1 });
  try {
    const r = await call("sync_jobs");
    assert.equal(r.started, false);
    assert.equal(r.running, true);
  } finally { db.kvSetJson("autosync:running", null); db.closeDb(); }
});
