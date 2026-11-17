import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-hreview-"));
const db = await import("../src/db.js");
const track = await import("../src/track.js");
const prior = await import("../src/prior.js");
const { importHistory } = await import("../src/history.js");
const { hiringSignals } = await import("../src/intel.js");
const { websiteFromPosting } = await import("../src/website.js");

const job = (id: string, company: string, title: string, extra: object = {}) => ({
  id, ats: "greenhouse" as const, boardSlug: company.toLowerCase().replace(/\W/g, ""), company, title, location: "New York, NY", remote: false,
  description: "Deploy AI for customers.", url: `https://jobs.example/${id}`, applyUrl: `https://jobs.example/${id}/apply`, ...extra,
});
const appOf = (id: string) => db.getApplication(id)!;

test("a role withdrawn before it was submitted is not an application, so a twin posting is not blocked", () => {
  db.upsertJobs([job("g:acme:1", "Acme", "Solutions Engineer"), job("a:acme:2", "Acme", "Solutions Engineer")]);
  track.saveJob("g:acme:1");
  track.updateStatus("g:acme:1", "withdrawn");
  assert.doesNotThrow(() => prior.assertNotDuplicate("a:acme:2"));
  assert.deepEqual(prior.priorApplications("Acme"), []);
  // withdrawn after it went in still counts
  track.updateStatus("g:acme:1", "submitted");
  track.updateStatus("g:acme:1", "withdrawn");
  assert.throws(() => prior.assertNotDuplicate("a:acme:2"), prior.DuplicateApplicationError);
});

test("a record with its own URL that matches no posting gets its own stub; the live posting is left alone", () => {
  db.upsertJobs([job("g:soylent:new", "Soylent", "Forward Deployed Engineer")]);
  track.saveJob("g:soylent:new");
  track.updateStatus("g:soylent:new", "drafted");
  const r = importHistory([{ company: "Soylent", title: "Forward Deployed Engineer", appliedAt: "2026-08-01", status: "submitted", url: "https://old.example/soylent-fde" }]);
  assert.deepEqual(r, { created: 1, attached: 0, unchanged: 0 });
  assert.equal(appOf("g:soylent:new").status, "drafted");
  // and the guard now has something to warn about
  assert.throws(() => prior.assertNotDuplicate("g:soylent:new"), prior.DuplicateApplicationError);
});

test("titles that differ in a parenthetical qualifier are different roles; a location in parentheses is not", () => {
  assert.ok(!prior.titlesSimilar("Software Engineer (Frontend)", "Software Engineer (Backend)"));
  assert.ok(!prior.titlesSimilar("Account Executive (EMEA)", "Account Executive (US)"));
  assert.ok(prior.titlesSimilar("Forward Deployed Engineer (NYC)", "Forward Deployed Engineer"));
});

test("import only attaches by URL or by the same title; a merely similar title gets its own stub", () => {
  db.upsertJobs([
    job("greenhouse:cb:1", "Coinbase", "Product Manager II, Growth - Notifications"),
    job("greenhouse:cr:1", "Wayne", "Customer Engineer, APAC"),
    job("greenhouse:cr:2", "Wayne", "Customer Engineer"),
  ]);
  const r = importHistory([
    { company: "Coinbase", title: "Product Manager II, Growth Activation", appliedAt: "2026-08-02", status: "ghosted" },
    { company: "Wayne", title: "Customer Engineer", appliedAt: "2026-08-23", status: "submitted" },
  ]);
  assert.deepEqual(r, { created: 1, attached: 1, unchanged: 0 });
  assert.equal(db.getApplication("greenhouse:cb:1"), undefined);
  assert.ok(db.getJob("history:coinbase:product-manager-ii-growth-activation"));
  assert.equal(appOf("greenhouse:cr:2").status, "submitted");
  assert.equal(db.getApplication("greenhouse:cr:1"), undefined);
});

test("two similar applications arriving in separate imports each get a row", () => {
  const a = importHistory([{ company: "LinkedIn", title: "Principal Product Manager, AI", appliedAt: "2026-07-01", status: "rejected" }]);
  const b = importHistory([{ company: "LinkedIn", title: "Product Manager, Email Content AI", appliedAt: "2026-07-02", status: "rejected" }]);
  assert.equal(a.created, 1);
  assert.deepEqual(b, { created: 1, attached: 0, unchanged: 0 });
});

test("history never overrides an application that already went in; re-running changes nothing", () => {
  db.upsertJobs([job("greenhouse:z:1", "Zeta", "Product Manager"), job("greenhouse:z:2", "Zeta", "Data Scientist"), job("greenhouse:z:3", "Zeta", "Designer")]);
  const rec = (title: string, status: any) => ({ company: "Zeta", title, appliedAt: "2026-08-02", status });
  importHistory([rec("Product Manager", "ghosted")]);
  track.updateStatus("greenhouse:z:1", "interview");
  const again = importHistory([rec("Product Manager", "ghosted")]);
  assert.equal(again.unchanged, 1);
  assert.equal(appOf("greenhouse:z:1").status, "interview");
  assert.equal(db.listEvents("greenhouse:z:1").filter(e => e.kind === "imported").length, 1);

  // an offer stays an offer under a stale rejection
  track.saveJob("greenhouse:z:2"); track.updateStatus("greenhouse:z:2", "submitted"); track.updateStatus("greenhouse:z:2", "offer");
  importHistory([rec("Data Scientist", "rejected")]);
  assert.equal(appOf("greenhouse:z:2").status, "offer");

  // OpenApply's own submission keeps its status and confirmation code
  track.saveJob("greenhouse:z:3"); track.updateStatus("greenhouse:z:3", "submitted");
  db.setApplication("greenhouse:z:3", { confirmationCode: "ZHFLVK" });
  importHistory([rec("Designer", "ghosted")]);
  assert.equal(appOf("greenhouse:z:3").status, "submitted");
  assert.equal(appOf("greenhouse:z:3").confirmationCode, "ZHFLVK");
});

test("history stubs are not hiring signals and not in the job total", () => {
  const before = db.jobStats().total;
  importHistory([{ company: "Yarrow", title: "Analyst", appliedAt: "2026-08-01", status: "submitted" }]);
  db.upsertJobs([job("greenhouse:yarrow:1", "Yarrow", "Engineer")]);
  const s = hiringSignals("Yarrow");
  assert.equal(s.closedLast30d, 0);
  assert.deepEqual(s.boards, [{ ats: "greenhouse", slug: "yarrow" }]);
  assert.equal(db.jobStats().total, before + 1);
});

test("appliedAt is stored as a date even when written another way", () => {
  importHistory([
    { company: "Wren", title: "One", appliedAt: "Aug 28, 2026", status: "submitted" },
    { company: "Wren", title: "Two", appliedAt: "2026-9-3", status: "submitted" },
    { company: "Wren", title: "Three", appliedAt: "2026-10-01T09:30:00Z", status: "submitted" },
  ]);
  assert.equal(appOf("history:wren:one").submittedAt, "2026-08-28");
  assert.equal(appOf("history:wren:two").submittedAt, "2026-09-03");
  assert.equal(appOf("history:wren:three").submittedAt, "2026-10-01T09:30:00Z");
  assert.equal(prior.priorWarning(prior.priorApplications("Wren", "One").slice(0, 1)), "Already applied to Wren · One on 2026-08-28");
});

test("non-Latin company and role names import", () => {
  const r = importHistory([{ company: "Яндекс", title: "Менеджер", appliedAt: "2026-08-01", status: "submitted" }]);
  assert.equal(r.created, 1);
  assert.equal(prior.priorApplications("Яндекс").length, 1);
});

test("pipeline Activity is not drowned by a history import", () => {
  track.saveJob("g:acme:1", "a real note");
  importHistory(Array.from({ length: 15 }, (_, i) => ({ company: `Bulk${i}`, title: "Role", appliedAt: "2026-08-01", status: "submitted" as const })));
  const recent = track.pipeline().recent;
  assert.ok(recent.some(e => e.kind === "note"), "the real note is still in the feed");
  assert.equal(recent.some(e => e.kind === "imported"), false);
  assert.equal(recent.some(e => e.kind === "status" && e.jobId.startsWith("history:bulk")), false);
});

test("an ATS tenant host is not the company's website", () => {
  const p = (o: Record<string, any>) => websiteFromPosting({ ats: "recruitee", boardSlug: "climeworks", company: "Climeworks", url: "", applyUrl: "", description: "", ...o });
  assert.equal(p({ url: "https://climeworks.recruitee.com/o/x", applyUrl: "https://climeworks.recruitee.com/o/x" }), undefined);
  assert.equal(p({ ats: "greenhouse", boardSlug: "axmed", company: "Axmed", applyUrl: "https://axmed.teamtailor.com/jobs/1" }), undefined);
  assert.equal(p({ description: "Visit climeworks.com" }), "https://climeworks.com");
});
