import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-outcomes-"));
const db = await import("../src/db.js");
const { applyOutcomes, ageOutProposals } = await import("../src/outcomes.js");
const outreach = await import("../src/outreach.js");

const job = (id: string, company: string, title: string) => ({
  id, ats: "greenhouse" as const, boardSlug: company.toLowerCase(), company, title, location: "New York, NY", remote: false,
  description: "d", url: `https://jobs.example/${id}`, applyUrl: `https://jobs.example/${id}`,
});
const CYBERDYNE = "greenhouse:cyberdyne:1", EF = "greenhouse:ef:1", HOOLI = "ashby:hooli:1", ACME = "greenhouse:acme:1";
const GLOBEX_A = "greenhouse:globex:1", GLOBEX_B = "greenhouse:globex:2", INITECH = "greenhouse:initech:1";
const OLD = "greenhouse:old:1", OLDISH = "greenhouse:oldish:1", FRESH = "greenhouse:fresh:1", OLD_REJECTED = "greenhouse:oldrej:1";
db.upsertJobs([
  job(CYBERDYNE, "Cyberdyne", "Solutions Engineer"),
  job(EF, "Example Foundation", "Product Engineer"),
  job(HOOLI, "Hooli", "Forward Deployed Engineer"),
  job(ACME, "Acme", "Product Manager"),
  job(GLOBEX_A, "Globex", "Forward Deployed Engineer"),
  job(GLOBEX_B, "Globex", "Senior Forward Deployed Engineer"),
  job(INITECH, "Initech", "Solutions Engineer"),
  job(OLD, "Old Co", "Engineer"),
  job(OLDISH, "Oldish Co", "Engineer"),
  job(FRESH, "Fresh Co", "Engineer"),
  job(OLD_REJECTED, "Old Rejected Co", "Engineer"),
]);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400e3).toISOString();
/** A mail date after the default submission (10 days ago), so these tests do not depend on the day they run. */
const MAIL = daysAgo(2).slice(0, 10);
const submitted = (id: string, days = 10) => db.setApplication(id, { status: "submitted", submittedAt: daysAgo(days) });
for (const id of [CYBERDYNE, EF, HOOLI, GLOBEX_A, GLOBEX_B, INITECH]) submitted(id);
db.setApplication(ACME, { status: "drafted" });
submitted(OLD, 60); submitted(OLDISH, 46); submitted(FRESH, 44);
db.setApplication(OLD_REJECTED, { status: "rejected", submittedAt: daysAgo(90) });

const status = (id: string) => db.getApplication(id)!.status;

test("a rejection moves submitted to rejected and leaves a dated note", () => {
  const r = applyOutcomes([{ company: "Cyberdyne", kind: "rejected", date: MAIL, source_id: "mail-cyberdyne-1", snippet: "We decided to move forward with other candidates" }]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].jobId, CYBERDYNE);
  assert.equal(r.applied[0].from, "submitted");
  assert.equal(r.applied[0].to, "rejected");
  assert.equal(status(CYBERDYNE), "rejected");
  assert.match(db.getApplication(CYBERDYNE)!.notes!, /rejected/i);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.ambiguous, []);
});

test("replaying the same source_id is a no-op", () => {
  const before = db.listEvents(CYBERDYNE).length;
  const r = applyOutcomes([{ company: "Cyberdyne", kind: "rejected", date: MAIL, source_id: "mail-cyberdyne-1" }]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].source_id, "mail-cyberdyne-1");
  assert.match(r.skipped[0].reason, /already/i);
  assert.equal(db.listEvents(CYBERDYNE).length, before);
  assert.equal(status(CYBERDYNE), "rejected");
});

test("an interview on a rejected row is skipped, never moved back", () => {
  const before = db.listEvents(CYBERDYNE).length;
  const r = applyOutcomes([{ company: "Cyberdyne", kind: "interview", date: "2026-11-05", source_id: "mail-cyberdyne-2" }]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /rejected/);
  assert.equal(status(CYBERDYNE), "rejected");
  assert.equal(db.listEvents(CYBERDYNE).length, before);
  assert.equal(db.kvGet("outcome:mail-cyberdyne-2"), undefined, "a skip records nothing, so a later fix can replay it");
});

test("an interview moves submitted to interview and records a dated interview event", () => {
  const r = applyOutcomes([{ company: "Hooli", title: "FDE", kind: "interview", date: "2026-11-06T10:00", source_id: "mail-hooli-1", snippet: "Interview Fri Nov 6 10:00" }]);
  assert.equal(r.applied.length, 1);
  assert.equal(status(HOOLI), "interview");
  const ev = db.listEvents(HOOLI).find(e => e.kind === "interview");
  assert.ok(ev, "interview event");
  assert.match(ev!.detail!, /2026-11-06T10:00/);
  assert.match(ev!.detail!, /Interview Fri Nov 6/);
  // a second round on a row already at interview: no status move, a new dated event
  const r2 = applyOutcomes([{ company: "Hooli", kind: "interview", date: "2026-11-12", source_id: "mail-hooli-2" }]);
  assert.equal(r2.applied.length, 1);
  assert.equal(r2.applied[0].to, "interview");
  assert.equal(db.listEvents(HOOLI).filter(e => e.kind === "interview").length, 2);
  assert.equal(JSON.parse(db.listEvents(HOOLI).find(e => e.detail?.includes("mail-hooli-2"))!.detail!).date_source, undefined, "no date_source sent, none written");
});

test("an interview keeps the sweep's date_source and mail_date in its event", () => {
  const r = applyOutcomes([
    { company: "Hooli", kind: "interview", date: "2026-11-20T14:00", date_source: "invite", mail_date: "2026-11-13", source_id: "mail-hooli-3" },
    { company: "Hooli", kind: "interview", date: "2026-11-14", date_source: "mail", source_id: "mail-hooli-4" },
  ]);
  assert.equal(r.applied.length, 2);
  const detail = (id: string) => JSON.parse(db.listEvents(HOOLI).find(e => e.detail?.includes(id))!.detail!);
  assert.deepEqual(detail("mail-hooli-3"), { summary: "2026-11-20T14:00", date: "2026-11-20T14:00", source_id: "mail-hooli-3", date_source: "invite", mail_date: "2026-11-13" });
  assert.deepEqual([detail("mail-hooli-4").date_source, detail("mail-hooli-4").mail_date], ["mail", undefined]);
});

test("an interview keeps rescheduled_from when the outcome carries it", () => {
  const r = applyOutcomes([{ company: "Hooli", kind: "interview", date: "2026-11-12T10:00", date_source: "invite", rescheduled_from: "2026-11-06T10:00", source_id: "mail-hooli-5" }]);
  assert.equal(r.applied.length, 1);
  const detail = JSON.parse(db.listEvents(HOOLI).find(e => e.detail?.includes("mail-hooli-5"))!.detail!);
  assert.equal(detail.rescheduled_from, "2026-11-06T10:00");
  assert.equal(JSON.parse(db.listEvents(HOOLI).find(e => e.detail?.includes("mail-hooli-3"))!.detail!).rescheduled_from, undefined, "none sent, none written");
});

test("two matching rows give ambiguous with no write", () => {
  const before = [db.listEvents(GLOBEX_A).length, db.listEvents(GLOBEX_B).length];
  const r = applyOutcomes([{ company: "Globex", kind: "rejected", date: MAIL, source_id: "mail-globex-1" }]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.ambiguous.length, 1);
  assert.equal(r.ambiguous[0].source_id, "mail-globex-1");
  assert.deepEqual(r.ambiguous[0].candidates.map((c: { jobId: string }) => c.jobId).sort(), [GLOBEX_A, GLOBEX_B]);
  assert.equal(status(GLOBEX_A), "submitted");
  assert.equal(status(GLOBEX_B), "submitted");
  assert.deepEqual([db.listEvents(GLOBEX_A).length, db.listEvents(GLOBEX_B).length], before);
  assert.equal(db.kvGet("outcome:mail-globex-1"), undefined);
});

test("a drafted row is untouched", () => {
  const before = db.getApplication(ACME)!;
  const r = applyOutcomes([{ company: "Acme", kind: "rejected", date: "2026-10-30", source_id: "mail-acme-1" }]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /drafted/);
  assert.deepEqual(db.getApplication(ACME), before);
});

test("a rejection on a company with open outreach proposes closing it and leaves it unchanged", () => {
  const sent = outreach.logOutreach({ company: "Example Foundation", person: "Sam", channel: "email" });
  const draft = outreach.draftOutreach({ company: "example foundation", person: "Kim", channel: "email", message: "Hi Kim" });
  const replied = outreach.logOutreach({ company: "Example Foundation", person: "Lee", channel: "email" });
  outreach.updateOutreach(replied.id, { status: "replied" });
  const r = applyOutcomes([{ company: "Example Foundation", kind: "rejected", date: MAIL, source_id: "mail-ef-1" }]);
  assert.equal(status(EF), "rejected");
  const ids = r.proposals.map((p: { outreachId: number; action: string }) => { assert.equal(p.action, "close"); return p.outreachId; }).sort();
  assert.deepEqual(ids, [sent.id, draft.id].sort());
  const list = outreach.listOutreach({ company: "Example Foundation" });
  assert.equal(list.find(o => o.id === sent.id)!.status, "sent");
  assert.equal(outreach.listOutreach().find(o => o.id === draft.id)!.status, "draft");
});

test("bad items and unknown companies are skipped, the rest of the batch still applies", () => {
  const r = applyOutcomes([
    { company: "Nobody Inc", kind: "rejected", date: MAIL, source_id: "mail-x-1" },
    { company: "Initech", kind: "bogus" as any, date: MAIL, source_id: "mail-x-2" },
    { company: "Initech", kind: "rejected", date: "not a date", source_id: "mail-x-3" },
    { company: "Initech", kind: "ack", date: MAIL, source_id: "mail-x-4" },
    { company: "Initech", kind: "rejected", date: MAIL, source_id: "mail-x-5" },
  ]);
  assert.deepEqual(r.skipped.map((s: { source_id: string }) => s.source_id), ["mail-x-1", "mail-x-2", "mail-x-3", "mail-x-4"]);
  assert.match(r.skipped[3].reason, /already submitted/);
  assert.equal(r.applied.length, 1);
  assert.equal(status(INITECH), "rejected");
});

test("ageOut lists only submitted rows older than 45 days and never moves them", () => {
  const rows = ageOutProposals();
  assert.deepEqual(rows.map(r => r.jobId), [OLD, OLDISH]);
  assert.equal(rows[0].propose, "ghosted");
  assert.equal(rows[0].company, "Old Co");
  assert.equal(rows[0].title, "Engineer");
  assert.equal(rows[0].daysSince, 60);
  assert.equal(status(OLD), "submitted");
  assert.deepEqual(ageOutProposals(50).map(r => r.jobId), [OLD]);
});

// ---- review fixes ----

const { logAppliedOffsite } = await import("../src/history.js");
const REPLAY = "greenhouse:replay:1", LATER = "greenhouse:later:1", OFFER = "greenhouse:offerco:1", OFFER_B = "greenhouse:offerco:2";
const TWO_OLD = "greenhouse:twoco:1", TWO_NEW = "greenhouse:twoco:2", MULTI_E = "greenhouse:multi:1", MULTI_D = "greenhouse:multi:2";
const CAPTCHA = "ashby:captcha:1", GHOST_I = "greenhouse:ghosti:1", GHOST_R = "greenhouse:ghostr:1", TITLED = "greenhouse:titled:1";
const LINK = "greenhouse:linkco:1", DATED = "greenhouse:dated:1";
db.upsertJobs([
  job(REPLAY, "Replay Co", "Engineer"), job(LATER, "Later Co", "Engineer"),
  job(OFFER, "OfferCo", "Engineer"), job(OFFER_B, "OfferCo", "Designer"),
  job(TWO_OLD, "TwoCo", "Engineer"), job(TWO_NEW, "TwoCo", "Engineer II"),
  job(MULTI_E, "Multi", "Engineer"), job(MULTI_D, "Multi", "Designer"),
  job(CAPTCHA, "Captcha Co", "Engineer"), job(GHOST_I, "Ghost Interview Co", "Engineer"), job(GHOST_R, "Ghost Reject Co", "Engineer"),
  job(TITLED, "Titled Co", "Product Designer"), job(LINK, "LinkCo", "Solutions Engineer"), job(DATED, "Dated Co", "Engineer"),
]);

test("an old mail replayed after a newer application went in never closes it", () => {
  db.setApplication(REPLAY, { status: "drafted" });
  const first = applyOutcomes([{ company: "Replay Co", kind: "rejected", date: "2026-10-01", source_id: "m1" }]);
  assert.match(first.skipped[0].reason, /drafted/);
  db.setApplication(REPLAY, { status: "submitted", submittedAt: "2026-11-01T14:00:00.000Z" });
  const replay = applyOutcomes([
    { company: "Replay Co", kind: "rejected", date: "2026-10-01", source_id: "m1" },
    { company: "Replay Co", kind: "ack", date: "2026-10-01T09:00", source_id: "m1-ack" },
  ]);
  assert.equal(replay.applied.length, 0);
  for (const s of replay.skipped) assert.match(s.reason, /predates/);
  assert.equal(status(REPLAY), "submitted");
  // a "no application at X" skip replayed after a later application to X
  assert.match(applyOutcomes([{ company: "Later Co", kind: "rejected", date: "2026-10-02", source_id: "m2" }]).skipped[0].reason, /no application/);
  db.setApplication(LATER, { status: "submitted", submittedAt: "2026-11-01" });
  assert.match(applyOutcomes([{ company: "Later Co", kind: "rejected", date: "2026-10-02", source_id: "m2" }]).skipped[0].reason, /predates/);
  assert.equal(status(LATER), "submitted");
  // the same day still applies
  assert.equal(applyOutcomes([{ company: "Later Co", kind: "rejected", date: "2026-11-01", source_id: "m3" }]).applied.length, 1);
});

test("an offer is final here: a rejection skips it, and ghost is not a kind", () => {
  db.setApplication(OFFER, { status: "offer", submittedAt: "2026-09-01" });
  const r = applyOutcomes([
    { company: "OfferCo", kind: "rejected", date: "2026-10-30", source_id: "o1" },
    { company: "OfferCo", kind: "ghost" as any, date: "2026-10-30", source_id: "o2" },
  ]);
  assert.equal(r.applied.length, 0);
  assert.match(r.skipped[0].reason, /offer/);
  assert.match(r.skipped[1].reason, /kind must be one of rejected, interview, ack/);
  assert.equal(status(OFFER), "offer");
  assert.equal(db.getApplication(OFFER_B), undefined);
});

test("a date without a year is refused rather than stored as 2001", () => {
  db.setApplication(DATED, { status: "needs_human" });
  const r = applyOutcomes([
    { company: "Dated Co", kind: "ack", date: "Oct 30", source_id: "d1" },
    { company: "Dated Co", kind: "interview", date: "Fri Nov 6 10:00", source_id: "d2" },
  ]);
  assert.equal(r.applied.length, 0);
  for (const s of r.skipped) assert.match(s.reason, /YYYY-MM-DD/);
  assert.equal(status(DATED), "needs_human");
  assert.equal(db.getApplication(DATED)!.submittedAt, undefined);
  assert.throws(() => logAppliedOffsite({ company: "Dated Co", title: "Engineer", date: "Oct 30" }), /YYYY-MM-DD/);
});

test("an ack moves needs_human to submitted and dates it from the mail", () => {
  db.setApplication(CAPTCHA, { status: "needs_human" });
  const r = applyOutcomes([{ company: "Captcha Co", kind: "ack", date: "2026-10-28T08:15", source_id: "c1" }]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].from, "needs_human");
  assert.equal(status(CAPTCHA), "submitted");
  assert.equal(db.getApplication(CAPTCHA)!.submittedAt, "2026-10-28T08:15");
});

test("a real interview or rejection replaces ghosted", () => {
  db.setApplication(GHOST_I, { status: "ghosted", submittedAt: "2026-08-01" });
  db.setApplication(GHOST_R, { status: "ghosted", submittedAt: "2026-08-01" });
  const r = applyOutcomes([
    { company: "Ghost Interview Co", kind: "interview", date: "2026-11-09", source_id: "g1" },
    { company: "Ghost Reject Co", kind: "rejected", date: "2026-10-30", source_id: "g2" },
  ]);
  assert.equal(r.applied.length, 2);
  assert.equal(status(GHOST_I), "interview");
  assert.equal(status(GHOST_R), "rejected");
});

test("a title that fits no application at the company is ambiguous, with no write", () => {
  submitted(TITLED);
  const r = applyOutcomes([{ company: "Titled Co", title: "Data Scientist", kind: "rejected", date: MAIL, source_id: "t1" }]);
  assert.equal(r.applied.length, 0);
  assert.deepEqual(r.ambiguous[0].candidates.map((c: { jobId: string }) => c.jobId), [TITLED]);
  assert.equal(status(TITLED), "submitted");
});

test("a closed row at the company does not make a later application ambiguous", () => {
  db.setApplication(TWO_OLD, { status: "rejected", submittedAt: "2026-08-01" });
  db.setApplication(TWO_NEW, { status: "submitted", submittedAt: "2026-10-20" });
  const r = applyOutcomes([{ company: "TwoCo", kind: "interview", date: "2026-11-04", source_id: "two1" }]);
  assert.deepEqual(r.ambiguous, []);
  assert.equal(r.applied[0].jobId, TWO_NEW);
  assert.equal(status(TWO_NEW), "interview");
  assert.equal(status(TWO_OLD), "rejected");
});

test("one mail that names two roles moves both, and replays as a no-op", () => {
  submitted(MULTI_E); submitted(MULTI_D);
  const items = [
    { company: "Multi", title: "Engineer", kind: "rejected" as const, date: MAIL, source_id: "m5" },
    { company: "Multi", title: "Designer", kind: "rejected" as const, date: MAIL, source_id: "m5" },
  ];
  const r = applyOutcomes(items);
  assert.deepEqual(r.applied.map((a: { jobId: string }) => a.jobId), [MULTI_E, MULTI_D]);
  assert.equal(status(MULTI_D), "rejected");
  const again = applyOutcomes(items);
  assert.equal(again.applied.length, 0);
  for (const s of again.skipped) assert.match(s.reason, /already recorded/);
});

test("log_applied_offsite with a LinkedIn url attaches to the indexed posting by company and title", () => {
  db.setApplication(LINK, { status: "saved" });
  const r = logAppliedOffsite({ company: "LinkCo", title: "Solutions Engineer", url: "https://www.linkedin.com/jobs/view/123", date: "2026-11-02" });
  assert.deepEqual(r, { created: 0, attached: 1, unchanged: 0 });
  assert.equal(status(LINK), "submitted");
  assert.equal(db.getApplication(LINK)!.submittedAt, "2026-11-02");
  assert.equal(db.getJob("history:linkco:solutions-engineer"), undefined);
  // the posting's own url still attaches; an unknown url and title still gets a placeholder that keeps the url
  assert.equal(logAppliedOffsite({ company: "Fresh Co", title: "Engineer", url: `https://jobs.example/${FRESH}`, date: "2026-11-02" }).unchanged, 1);
  const stub = logAppliedOffsite({ company: "LinkCo", title: "Account Executive", url: "https://www.linkedin.com/jobs/view/456", date: "2026-11-02" });
  assert.equal(stub.created, 1);
  assert.equal(db.getJob("history:linkco:account-executive")!.url, "https://www.linkedin.com/jobs/view/456");
});
