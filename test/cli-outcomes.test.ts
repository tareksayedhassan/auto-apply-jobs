import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CLI runs in a child process against the same state dir, the way the inbox sweep calls it.
const home = mkdtempSync(join(tmpdir(), "oa-cli-outcomes-"));
process.env.OPENAPPLY_HOME = home;
const db = await import("../src/db.js");
const { pkgRoot } = await import("../src/paths.js");

const job = (id: string, company: string, title: string) => ({
  id, ats: "greenhouse" as const, boardSlug: company.toLowerCase(), company, title, location: "New York, NY", remote: false,
  description: "d", url: `https://jobs.example/${id}`, applyUrl: `https://jobs.example/${id}`,
});
const CYBERDYNE = "greenhouse:cyberdyne:1", HOOLI = "ashby:hooli:1";
db.upsertJobs([job(CYBERDYNE, "Cyberdyne", "Solutions Engineer"), job(HOOLI, "Hooli", "Forward Deployed Engineer")]);
const tenDaysAgo = new Date(Date.now() - 10 * 86400e3).toISOString();
for (const id of [CYBERDYNE, HOOLI]) db.setApplication(id, { status: "submitted", submittedAt: tenDaysAgo });
const today = new Date().toISOString().slice(0, 10);

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(pkgRoot, "src", "cli.ts"), ...args],
    { cwd: pkgRoot, env: { ...process.env, OPENAPPLY_HOME: home }, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const file = (name: string, data: unknown) => {
  const p = join(home, name);
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
  return p;
};

test("outcomes --json <file> applies the items and prints the report as JSON", () => {
  const p = file("batch.json", [
    { company: "Cyberdyne", kind: "rejected", date: today, source_id: "mail-1", snippet: "We went with other candidates" },
    { company: "Nobody Inc", kind: "ack", date: today, source_id: "mail-2" },
  ]);
  const r = cli("outcomes", "--json", p);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.applied.length, 1);
  assert.equal(report.applied[0].jobId, CYBERDYNE);
  assert.equal(report.applied[0].to, "rejected");
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].source_id, "mail-2");
  assert.equal(db.getApplication(CYBERDYNE)!.status, "rejected");
});

test("a replay of the same file changes nothing", () => {
  const p = file("batch.json", [{ company: "Cyberdyne", kind: "rejected", date: today, source_id: "mail-1" }]);
  const report = JSON.parse(cli("outcomes", "--json", p).stdout);
  assert.equal(report.applied.length, 0);
  assert.match(report.skipped[0].reason, /already/);
});

test("an {items: [...]} wrapper is read too", () => {
  const p = file("wrapped.json", { generated: today, items: [{ company: "Hooli", kind: "interview", date: today, source_id: "mail-3" }] });
  const r = cli("outcomes", "--json", p);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).applied[0].jobId, HOOLI);
  assert.equal(db.getApplication(HOOLI)!.status, "interview");
});

test("a missing file argument or a file that is not an item list exits 1 with a message and writes nothing", () => {
  const none = cli("outcomes");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Usage: openapply outcomes --json <file>/);
  const bad = cli("outcomes", "--json", file("bad.json", { nothing: true }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /array/);
  const broken = cli("outcomes", "--json", file("broken.json", "{not json"));
  assert.equal(broken.status, 1);
});

test("help lists the outcomes command", () => {
  assert.match(cli().stdout, /openapply outcomes --json <file>/);
});

test("scoreboard prints the text scoreboard; --json prints the same data as JSON; --init-config writes strategy.json once", () => {
  // its own rows: an interview at the lead company, so the test does not lean on earlier tests
  db.upsertJobs([job("ashby:hooli:sb", "Hooli", "Solutions Architect")]);
  db.setApplication("ashby:hooli:sb", { status: "interview", submittedAt: tenDaysAgo });
  const strategy = join(home, "strategy.json");
  assert.equal(existsSync(strategy), false);
  assert.equal(cli("scoreboard", "--json").status, 0);
  assert.equal(existsSync(strategy), false, "reading the scoreboard writes nothing");
  const init = cli("scoreboard", "--init-config", join(pkgRoot, "strategy", "example.json"));
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /wrote .*strategy\.json from /);
  const again = cli("scoreboard", "--init-config");
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  const text = cli("scoreboard");
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Scoreboard, \d{4}-\d{2}-\d{2} \(week \d+/);
  assert.match(text.stdout, /48-hour rule \(\d+ flagged\)/);
  const json = cli("scoreboard", "--json");
  assert.equal(json.status, 0, json.stderr);
  const sb = JSON.parse(json.stdout);
  assert.ok(Array.isArray(sb.personFlags));
  const hooli = sb.companies.find((c: any) => c.company === "Hooli");
  assert.equal(hooli.applied, true, "the Hooli application counts for the lead company");
  assert.equal(hooli.applicationStatus, "interview");
  assert.match(cli().stdout, /openapply scoreboard \[--json\]/);
});
