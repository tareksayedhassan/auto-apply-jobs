import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-history-"));
const db = await import("../src/db.js");
const track = await import("../src/track.js");
const { importHistory } = await import("../src/history.js");
const prior = await import("../src/prior.js");
const { listMatches } = await import("../src/match.js");

const VANDELAY_FDE = "ashby:Vandelay:75576a88-de08-5792-a34c-3f1667bd8f1f";
const WAYNE = "greenhouse:wayne:4411220033";
const job = (id: string, company: string, title: string, extra: object = {}) => ({
  id, ats: "greenhouse" as const, boardSlug: company.toLowerCase(), company, title, location: "New York, NY", remote: false,
  description: "Deploy AI for customers.", url: `https://jobs.example/${id}`, applyUrl: `https://jobs.example/${id}/apply`, ...extra,
});
db.upsertJobs([
  job(VANDELAY_FDE, "Vandelay", "Forward Deployed Engineer"),
  job("ashby:Vandelayx:1", "Vandelayx", "Forward Deployed Engineer"),
  job(WAYNE, "Wayne", "AI Strategist"),
  job("greenhouse:soylent:1", "Soylent", "Forward Deployed Engineer"),
  job("greenhouse:globex:1", "Globex", "Founding GTM Engineer"),
  job("greenhouse:acme:1", "Acme", "Product Manager"),
  job("greenhouse:acme:2", "Acme", "Senior Product Manager"),
  job("greenhouse:acme:3", "Acme", "Product Designer"),
]);

test("companies compare by normalized name, aliases and 'formerly'", () => {
  const same = (a: string, b: string) => prior.sameCompany(a, b);
  assert.ok(same("Globex Ai", "Globex"));
  assert.ok(same("Wayne, Inc.", "wayne"));
  assert.ok(same("Acme Labs", "ACME HQ"));
  assert.ok(same("Foo Technologies LLC", "Foo"));
  assert.ok(same("Soylent (formerly askSoylent)", "askSoylent"));
  assert.ok(same("Soylent (formerly askSoylent)", "Soylent"));
  assert.ok(same("askSoylent", "Soylent"));
  assert.ok(!same("Vandelay", "Vandelayx"));
  assert.ok(!same("Vandela", "Vandelay"));
  assert.ok(!same("AI", "Labs")); // a name that is only a suffix stays itself
});

test("titles: token overlap ignoring level words; FDE vs Delivery Strategist is not the same job", () => {
  const sim = (a: string, b: string) => prior.titlesSimilar(a, b);
  assert.ok(sim("Forward Deployed Engineer", "forward-deployed engineer"));
  assert.ok(sim("Senior Forward Deployed Engineer", "Forward Deployed Engineer (NYC)"));
  assert.ok(sim("FDE", "Forward Deployed Engineer"));
  assert.ok(sim("Solutions Engineer", "Solution Engineer"));
  assert.ok(!sim("Forward Deployed Engineer", "Delivery Strategist"));
  assert.ok(!sim("AI Strategist", "Customer Engineer"));
  assert.ok(!sim("Product Manager", "Product Designer"));
});

test("import_history: attaches by url and by company + title, stubs the rest, never touches search", () => {
  const r = importHistory([
    { company: "Vandelay", title: "Delivery Strategist", appliedAt: "2026-08-28", status: "submitted" },
    { company: "Wayne AI", title: "Customer Engineer", appliedAt: "2026-08-23", status: "rejected", url: "https://boards.example/wayne/ce" },
    { company: "Soylent (formerly askSoylent)", title: "Forward Deployed Engineer", appliedAt: "2026-09-01", status: "submitted" },
    { company: "Globex", title: "Whatever", appliedAt: "2026-09-02", status: "submitted", url: "https://jobs.example/greenhouse:globex:1/" },
  ]);
  assert.deepEqual({ created: r.created, attached: r.attached, unchanged: r.unchanged }, { created: 2, attached: 2, unchanged: 0 });

  const vandelay = db.getJob("history:vandelay:delivery-strategist")!;
  assert.equal(vandelay.open, false);
  assert.equal(vandelay.company, "Vandelay");
  const app = db.getApplication(vandelay.id)!;
  assert.equal(app.status, "submitted");
  assert.equal(app.submittedAt, "2026-08-28");
  assert.equal(app.source, "history");
  assert.ok(db.listEvents(vandelay.id).some(e => e.kind === "imported" && e.detail === "Imported from history"));
  assert.ok(db.getJob("history:wayne:customer-engineer"));

  // company + title match: the real Soylent posting got the application
  const soylent = db.getApplication("greenhouse:soylent:1")!;
  assert.equal(soylent.submittedAt, "2026-09-01");
  assert.equal(db.getJob("history:soylent:forward-deployed-engineer"), undefined);
  // url match (trailing slash tolerated)
  assert.equal(db.getApplication("greenhouse:globex:1")?.status, "submitted");

  // invisible to search, matches, stats and the closing pass of a sync
  assert.equal(db.searchJobs({ query: "Delivery Strategist" }).total, 0);
  assert.equal(db.searchJobs({ company: "Vandelay" }).jobs.some(j => j.id.startsWith("history:")), false);
  assert.equal(listMatches({ query: "Delivery Strategist", minScore: 0 }).length, 0);
  assert.equal(db.closeMissing("other", "history", []), 0);
});

test("import_history is idempotent and never downgrades a status", () => {
  const records = [
    { company: "Vandelay", title: "Delivery Strategist", appliedAt: "2026-08-28", status: "submitted" as const },
    { company: "Wayne AI", title: "Customer Engineer", appliedAt: "2026-08-23", status: "rejected" as const, url: "https://boards.example/wayne/ce" },
    { company: "Soylent", title: "Forward Deployed Engineer", appliedAt: "2026-09-01", status: "submitted" as const },
  ];
  const again = importHistory(records);
  assert.deepEqual({ created: again.created, attached: again.attached, unchanged: again.unchanged }, { created: 0, attached: 0, unchanged: 3 });
  assert.equal(db.listEvents("history:vandelay:delivery-strategist").filter(e => e.kind === "imported").length, 1);

  // an interview stays an interview when history says submitted; a saved bookmark is upgraded
  track.saveJob("greenhouse:acme:1"); track.updateStatus("greenhouse:acme:1", "submitted"); track.updateStatus("greenhouse:acme:1", "interview");
  track.saveJob("greenhouse:acme:2");
  const r = importHistory([
    { company: "Acme", title: "Product Manager", appliedAt: "2026-07-01", status: "submitted" },
    { company: "Acme", title: "Senior Product Manager", appliedAt: "2026-07-02", status: "submitted" },
  ]);
  assert.equal(r.attached, 1);
  assert.equal(r.unchanged, 1);
  assert.equal(db.getApplication("greenhouse:acme:1")!.status, "interview");
  assert.equal(db.getApplication("greenhouse:acme:2")!.status, "submitted");
  assert.equal(db.getApplication("greenhouse:acme:2")!.submittedAt, "2026-07-02");
  assert.equal(db.getApplication("greenhouse:acme:2")!.source, undefined, "an application OpenApply already had is not relabelled");
});

test("import_history rejects bad records before writing anything", () => {
  assert.throws(() => importHistory([{ company: "X", title: "Y", appliedAt: "yesterday-ish", status: "submitted" }]), /appliedAt/);
  assert.throws(() => importHistory([{ company: "X", title: "Y", appliedAt: "2026-01-01", status: "bogus" as any }]), /status/);
  assert.throws(() => importHistory([{ company: "X", title: "Y", appliedAt: "2026-01-01", status: "approved" as any }]), /status/);
  assert.throws(() => importHistory([{ company: "", title: "Y", appliedAt: "2026-01-01", status: "submitted" }]), /company/);
  assert.equal(db.getJob("history:x:y"), undefined);
});

test("priorApplications: same company, any title; similar title marks a duplicate", () => {
  const vandelay = prior.priorApplications("Vandelay", "Forward Deployed Engineer");
  assert.equal(vandelay.length, 1);
  assert.deepEqual(vandelay[0], {
    jobId: "history:vandelay:delivery-strategist", company: "Vandelay", title: "Delivery Strategist",
    status: "submitted", appliedAt: "2026-08-28", similarTitle: false, imported: true,
  });
  assert.equal(prior.priorWarning(vandelay), "Already applied to Vandelay · Delivery Strategist on 2026-08-28");
  assert.deepEqual(prior.priorApplications("Vandelayx"), [], "a shared prefix is not the same company");
  assert.deepEqual(prior.priorApplications("Vandelay Inc.", undefined).map(p => p.similarTitle), [false]);
  assert.deepEqual(prior.priorApplications("Globex Ai").map(p => p.jobId), ["greenhouse:globex:1"]);
  assert.equal(prior.priorApplications("Soylent (formerly askSoylent)")[0].jobId, "greenhouse:soylent:1");

  const soylent = prior.priorApplications("Soylent", "Senior Forward Deployed Engineer");
  assert.equal(soylent[0].similarTitle, true);
  // a job's own application never counts as its own prior
  assert.deepEqual(prior.priorApplications("Soylent", "Forward Deployed Engineer", "greenhouse:soylent:1"), []);
});

test("priorApplications counts submitted-or-later only, not bookmarks, drafts or a CAPTCHA stop", () => {
  track.saveJob("greenhouse:acme:3");
  assert.equal(prior.priorApplications("Acme").some(p => p.jobId === "greenhouse:acme:3"), false);
  track.updateStatus("greenhouse:acme:3", "needs_human");
  assert.equal(prior.priorApplications("Acme").some(p => p.jobId === "greenhouse:acme:3"), false);
  track.updateStatus("greenhouse:acme:3", "submitted");
  assert.equal(prior.priorApplications("Acme").some(p => p.jobId === "greenhouse:acme:3" && !p.imported), true);
});

test("fixtures: Vandelay FDE is warned (different title), Wayne AI Strategist is warned, both may proceed", () => {
  const f = (id: string) => prior.priorFields(db.getJob(id)!);
  assert.equal(f(VANDELAY_FDE).warning, "Already applied to Vandelay · Delivery Strategist on 2026-08-28");
  assert.equal(f(WAYNE).warning, "Already applied to Wayne AI · Customer Engineer on 2026-08-23");
  assert.doesNotThrow(() => prior.assertNotDuplicate(VANDELAY_FDE));
  assert.doesNotThrow(() => prior.assertNotDuplicate(WAYNE));
  assert.deepEqual(prior.priorFields(db.getJob("ashby:Vandelayx:1")!), { priorApplications: [] });
});

test("assertNotDuplicate refuses the same company + similar title under another job id, unless forced", () => {
  // Soylent FDE as another posting of the role already applied to
  db.upsertJobs([job("lever:soylent:9", "Soylent", "Forward Deployed Engineer, Customers")]);
  assert.throws(() => prior.assertNotDuplicate("lever:soylent:9"), (e: any) =>
    e instanceof prior.DuplicateApplicationError && /Already applied to Soylent · Forward Deployed Engineer on 2026-09-01/.test(e.message) && /force/.test(e.message));
  assert.doesNotThrow(() => prior.assertNotDuplicate("lever:soylent:9", true));
  // its own application is not a reason to refuse
  assert.doesNotThrow(() => prior.assertNotDuplicate("greenhouse:soylent:1"));
});
