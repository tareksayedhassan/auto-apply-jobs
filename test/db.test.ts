import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-db-"));
const db = await import("../src/db.js");

const job = (id: string, title: string, extra: any = {}) => ({
  id: `greenhouse:acme:${id}`, ats: "greenhouse" as const, boardSlug: "acme", company: "Acme",
  title, location: "New York, NY", remote: false, description: "Build agents with TypeScript",
  url: "https://x", applyUrl: "https://x", ...extra,
});

test("upsert, search, close missing", () => {
  assert.equal(db.upsertJobs([job("1", "Forward Deployed Engineer"), job("2", "Account Executive", { remote: true })]), 2);
  assert.equal(db.upsertJobs([job("1", "Forward Deployed Engineer")]), 0);
  assert.equal(db.searchJobs({ query: "forward deployed" }).total, 1);
  assert.equal(db.searchJobs({ query: "typescript" }).total, 2);
  assert.equal(db.searchJobs({ remote: true }).jobs[0].title, "Account Executive");
  assert.equal(db.searchJobs({ query: 'a"b OR (' }).total >= 0, true);
  assert.equal(db.closeMissing("greenhouse", "acme", ["greenhouse:acme:1"]), 1);
  assert.equal(db.searchJobs({}).total, 1);
});

test("applications + events", () => {
  db.setApplication("greenhouse:acme:1", { status: "drafted" });
  db.setApplication("greenhouse:acme:1", { notes: "hi" });
  const a = db.getApplication("greenhouse:acme:1")!;
  assert.equal(a.status, "drafted");
  assert.equal(a.notes, "hi");
  assert.equal(db.listEvents("greenhouse:acme:1").length, 1);
  assert.equal(db.listApplications("drafted")[0].job?.title, "Forward Deployed Engineer");
});

test("searchJobs clamps limits and treats stopword-only queries as no match", () => {
  db.upsertJobs([job("clamp1", "Clamp Engineer"), job("clamp2", "Clamp Designer")]);
  const all = db.searchJobs({}).total;
  assert.ok(all >= 2);
  assert.equal(db.searchJobs({ query: "AND" }).total, 0);
  assert.equal(db.searchJobs({ query: "and or not" }).jobs.length, 0);
  assert.equal(db.searchJobs({ query: "   " }).total, all);
  assert.equal(db.searchJobs({ limit: -5 }).jobs.length, 1);
  assert.equal(db.searchJobs({ limit: 0 }).jobs.length, 1);
  assert.equal(db.searchJobs({ limit: 1e9 }).jobs.length, all);
  assert.equal(db.searchJobs({ limit: NaN }).jobs.length, Math.min(all, 20));
  assert.equal(db.searchJobs({ offset: -3 }).jobs[0].id, db.searchJobs({}).jobs[0].id);
  // postedWithinDays: negative / NaN / huge never crash or exclude everything wrongly
  assert.equal(db.searchJobs({ postedWithinDays: NaN }).total, all);
  assert.equal(db.searchJobs({ postedWithinDays: Infinity }).total, all);
  assert.equal(db.searchJobs({ postedWithinDays: 1e12 }).total, all);
  assert.equal(db.searchJobs({ postedWithinDays: -10 }).total, all); // clamps to 1 day; freshly seen jobs stay
});
