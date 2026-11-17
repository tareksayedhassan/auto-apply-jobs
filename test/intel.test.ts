import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-intel-"));
const db = await import("../src/db.js");
const intel = await import("../src/intel.js");

const job = (id: string, title: string, extra: any = {}) => ({
  id: `greenhouse:acme:${id}`, ats: "greenhouse" as const, boardSlug: "acme", company: "Acme",
  title, location: "New York, NY", remote: false, description: "We build payments tools.",
  url: "https://x", applyUrl: "https://x", ...extra,
});
const days = (n: number) => new Date(Date.now() - n * 86400e3).toISOString();

db.upsertJobs([
  job("1", "Senior Software Engineer", { department: "Engineering", salaryMin: 150000, salaryMax: 200000, salaryCurrency: "USD" }),
  job("2", "Staff Engineer", { department: "Engineering", remote: true }),
  job("3", "Backend Engineer", { department: "Engineering", location: "Remote", remote: true }),
  job("4", "Founding Product Manager", { description: "You will be our first PM and build the function from scratch. We scale fast.", location: "San Francisco" }),
  job("5", "Account Executive"),
  job("6", "Old Role"),
  job("7", "Ancient Role"),
]);
const d = db.getDb();
d.prepare("UPDATE jobs SET open = 0, last_seen = ? WHERE id = ?").run(days(5), "greenhouse:acme:6");
d.prepare("UPDATE jobs SET open = 0, last_seen = ? WHERE id = ?").run(days(90), "greenhouse:acme:7");
d.prepare("UPDATE jobs SET first_seen = ?, posted_at = ? WHERE id = ?").run(days(60), days(60), "greenhouse:acme:5");

test("hiringSignals", () => {
  const s = intel.hiringSignals("ACME");
  assert.equal(s.openRoles, 5);
  assert.equal(s.newLast30d, 4);
  assert.equal(s.closedLast30d, 1);
  assert.equal(s.byDepartment.Engineering, 3);
  assert.equal(s.byDepartment.Product, 1);
  assert.equal(s.byLocation[0].location, "New York, NY");
  assert.equal(s.remoteShare, 0.4);
  assert.equal(s.seniorityMix["staff+"], 1);
  assert.equal(s.seniorityMix.senior, 1);
  assert.deepEqual(s.salaryRange, { min: 150000, max: 200000, currency: "USD" });
  assert.deepEqual(s.boards, [{ ats: "greenhouse", slug: "acme" }]);
  assert.equal(s.sampleTitles.length, 5);
  assert.ok(s.notes.some(n => n.includes("3 new engineering roles")));
});

test("hiringSignals: unknown company and slug match", () => {
  assert.equal(intel.hiringSignals("Nope Inc").openRoles, 0);
  assert.ok(intel.hiringSignals("Nope Inc").notes[0].includes("No open roles"));
  assert.equal(intel.hiringSignals("Acme Corp Ltd").openRoles, 0);
});

test("seniorityOf", () => {
  assert.equal(intel.seniorityOf("Software Engineering Intern"), "intern");
  assert.equal(intel.seniorityOf("VP of Sales"), "director+");
  assert.equal(intel.seniorityOf("Engineering Manager"), "manager");
  assert.equal(intel.seniorityOf("Associate Designer"), "junior");
});

test("companyBrief", async () => {
  const b = await intel.companyBrief("greenhouse:acme:4");
  assert.equal(b.signals.company, "Acme");
  assert.ok(b.whyNow.every(w => w.startsWith("Inference:")));
  assert.ok(b.whyNow.some(w => w.includes("new function")));
  assert.ok(b.proofOfWorkIdeas.length >= 3 && b.proofOfWorkIdeas.length <= 5);
  assert.ok(b.proofOfWorkIdeas[0].includes("Acme"));
  assert.ok(b.questionsToAsk.some(q => q.includes("90 days")));
  assert.ok(b.researchChecklist.length >= 6);
  assert.ok(b.focusCheck.includes("2 of 4"));
  assert.ok((await intel.companyBrief("greenhouse:acme:1")).proofOfWorkIdeas[0].includes("API"));
  await assert.rejects(intel.companyBrief("nope"));
  assert.ok(!JSON.stringify(b).includes("—"));
});
