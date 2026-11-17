import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-outreach-"));
const db = await import("../src/db.js");
const o = await import("../src/outreach.js");
const { saveProfile } = await import("../src/profile.js");

const JOB = "greenhouse:acme:1";
db.upsertJobs([{
  id: JOB, ats: "greenhouse", boardSlug: "acme", company: "Acme", title: "Product Manager",
  location: "New York", remote: false, description: "d", url: "https://x/1", applyUrl: "https://x/1",
}]);
const backdate = (id: number, days: number) =>
  db.getDb().prepare("UPDATE outreach SET last_touch_at = ? WHERE id = ?")
    .run(new Date(Date.now() - days * 86400e3).toISOString(), id);

test("log, list, update with events", () => {
  const a = o.logOutreach({ company: "Acme", jobId: JOB, person: "Dana", role: "recruiter", channel: "email", contact: "dana@acme.test", message: "hi" });
  assert.equal(a.status, "sent");
  assert.equal(a.followUps, 0);
  o.logOutreach({ company: "Other", person: "Sam", channel: "x" });
  assert.equal(o.listOutreach({ company: "acme" }).length, 1);
  assert.equal(o.listOutreach({ jobId: JOB })[0].person, "Dana");
  const r = o.updateOutreach(a.id, { status: "replied", notes: "booked" });
  assert.equal(r.status, "replied");
  assert.equal(r.notes, "booked");
  assert.equal(o.listOutreach({ status: "replied" }).length, 1);
  const kinds = db.listEvents(JOB).map(e => e.kind);
  assert.equal(kinds.filter(k => k === "outreach").length, 2);
  assert.throws(() => o.updateOutreach(9999, {}));
});

test("dueFollowUps: stale only, increments, auto no_reply", () => {
  const a = o.logOutreach({ company: "Due", person: "A", channel: "email" });
  const fresh = o.logOutreach({ company: "Due", person: "B", channel: "email" });
  backdate(a.id, 8);
  let due = o.dueFollowUps();
  assert.deepEqual(due.map(d => d.id), [a.id]);
  assert.ok(due[0].daysSinceTouch >= 8);
  assert.ok(due[0].suggestion.length > 20);
  assert.ok(!due.some(d => d.id === fresh.id));

  for (let i = 0; i < 3; i++) { o.updateOutreach(a.id, { followedUp: true }); backdate(a.id, 8); }
  assert.equal(o.listOutreach({ company: "Due" }).find(x => x.id === a.id)!.followUps, 3);
  due = o.dueFollowUps();
  assert.ok(!due.some(d => d.id === a.id));
  assert.equal(o.listOutreach({ company: "Due" }).find(x => x.id === a.id)!.status, "no_reply");
});

test("outreachBrief: rules, history, voice, no invented people", () => {
  let b = o.outreachBrief("Acme", JOB);
  assert.equal(b.job?.title, "Product Manager");
  assert.ok(b.history.length >= 1);
  assert.equal(b.existingContacts[0].person, "Dana");
  assert.ok(b.channels[0].includes("In person"));
  assert.ok(b.rules.some(r => r.includes("120 words")));
  assert.ok(b.rules.some(r => r.includes("voice samples")));
  assert.ok(!JSON.stringify(b).includes("—"));
  saveProfile({ firstName: "A", lastName: "B", email: "a@b.c", voiceSamples: ["hey, saw your launch, loved it"] });
  b = o.outreachBrief("Nobody");
  assert.ok(b.rules.some(r => r.includes("saw your launch")));
  assert.equal(b.existingContacts.length, 0);
});

test("a LinkedIn draft is a connection note: 300 characters max, other channels are not capped", () => {
  const long = "x".repeat(301);
  assert.throws(() => o.draftOutreach({ company: "Acme", person: "Lee", channel: "LinkedIn InMail", message: long }), /300 characters max, this one is 301/);
  assert.equal(o.draftOutreach({ company: "Acme", person: "Lee", channel: "linkedin", message: "x".repeat(300) }).status, "draft");
  assert.equal(o.draftOutreach({ company: "Acme", person: "Lee", channel: "email", message: long }).status, "draft");
});

test("draft waits, then 'sent' starts the follow-up clock", () => {
  assert.throws(() => o.draftOutreach({ company: "Acme", person: "Lee", channel: "linkedin", message: " " }));
  const d = o.draftOutreach({ company: "Acme", jobId: JOB, person: "Lee", channel: "linkedin", message: "hello" });
  assert.equal(d.status, "draft");
  backdate(d.id, 30);
  const asDue = o.dueFollowUps().find(f => f.id === d.id);
  assert.equal(asDue?.kind, "send_or_close", "an old draft nags to be sent or closed, never as a follow-up");
  const s = o.updateOutreach(d.id, { status: "sent" });
  assert.equal(s.status, "sent");
  assert.ok(Date.now() - Date.parse(s.sentAt) < 5000, "sent_at is reset to the send time");
  assert.ok(!o.dueFollowUps().some(f => f.id === d.id), "fresh send is not due");
  const details = db.listEvents(JOB).map(e => e.detail);
  assert.ok(details.some(x => x?.startsWith("draft ready: linkedin to Lee")));
  assert.ok(details.includes("linkedin to Lee at Acme"));
});

test("dueFollowUps: an unsent draft nags after draftDays, first, and names its age", () => {
  const old = o.draftOutreach({ company: "Nag", person: "Old", channel: "email", message: "hi" });
  const young = o.draftOutreach({ company: "Nag", person: "Young", channel: "email", message: "hi" });
  const sent = o.logOutreach({ company: "Nag", person: "Sent", channel: "email" });
  backdate(old.id, 3); backdate(young.id, 1); backdate(sent.id, 9);
  const due = o.dueFollowUps().filter(d => d.company === "Nag");
  assert.deepEqual(due.map(d => d.id), [old.id, sent.id], "3-day draft in and first, 1-day draft out");
  assert.equal(due[0].kind, "send_or_close");
  assert.equal(due[0].daysSinceTouch, 3);
  assert.match(due[0].suggestion, /3 days/);
  assert.equal(due[1].kind, "follow_up");
  assert.ok(!o.dueFollowUps({ draftDays: 4 }).some(d => d.id === old.id), "draftDays moves the cutoff");
  for (const id of [old.id, young.id, sent.id]) o.updateOutreach(id, { status: "closed" });
});

test("dueFollowUps: a draft is never auto-closed, even past max follow-ups", () => {
  const d = o.draftOutreach({ company: "Keep", person: "K", channel: "email", message: "hi" });
  db.getDb().prepare("UPDATE outreach SET follow_ups = 4 WHERE id = ?").run(d.id);
  backdate(d.id, 30);
  const due = o.dueFollowUps({ maxFollowUps: 3 });
  assert.equal(due.find(x => x.id === d.id)?.kind, "send_or_close");
  assert.equal(o.listOutreach({ company: "Keep" })[0].status, "draft");
  o.updateOutreach(d.id, { status: "closed" });
});

test("a draft waits on submit while the application is pre-submit, then says send now", () => {
  const job = "greenhouse:wait:1";
  db.upsertJobs([{ id: job, ats: "greenhouse", boardSlug: "wait", company: "Wait", title: "PM",
    location: "NYC", remote: false, description: "d", url: "https://x/w", applyUrl: "https://x/w" }]);
  db.setApplication(job, { status: "drafted" });
  const d = o.draftOutreach({ company: "Wait", jobId: job, person: "W", channel: "email", message: "just applied" });
  backdate(d.id, 5);
  let row = o.dueFollowUps().find(x => x.id === d.id)!;
  assert.equal(row.applicationStatus, "drafted");
  assert.equal(row.waitingOn, "submit");
  assert.match(row.suggestion, /hold/i);
  assert.equal(o.listOutreach({ jobId: job })[0].applicationStatus, "drafted", "listOutreach carries the application status");

  db.setApplication(job, { status: "submitted" });
  row = o.dueFollowUps().find(x => x.id === d.id)!;
  assert.equal(row.applicationStatus, "submitted");
  assert.equal(row.waitingOn, undefined);
  assert.match(row.suggestion, /send now/i);
  o.updateOutreach(d.id, { status: "closed" });
});

test("a rejected application proposes closing its outreach and never closes it itself", () => {
  const job = "greenhouse:nope:1";
  db.upsertJobs([{ id: job, ats: "greenhouse", boardSlug: "nope", company: "Nope", title: "PM",
    location: "NYC", remote: false, description: "d", url: "https://x/n", applyUrl: "https://x/n" }]);
  db.setApplication(job, { status: "rejected" });
  const s = o.logOutreach({ company: "Nope", jobId: job, person: "N", channel: "email" });
  for (let i = 0; i < 3; i++) o.updateOutreach(s.id, { followedUp: true });
  backdate(s.id, 9);
  const d = o.draftOutreach({ company: "Nope", jobId: job, person: "M", channel: "email", message: "hi" });
  const due = o.dueFollowUps({ maxFollowUps: 3 }).filter(x => x.company === "Nope");
  assert.deepEqual(due.map(x => [x.id, x.kind]), [[s.id, "propose_close"], [d.id, "propose_close"]], "any age, oldest first");
  assert.equal(due[0].applicationStatus, "rejected");
  assert.match(due[0].suggestion, /rejected/);
  assert.deepEqual(o.listOutreach({ company: "Nope" }).map(x => x.status).sort(), ["draft", "sent"], "status unchanged");

  db.setApplication(job, { status: "withdrawn" });
  assert.ok(o.dueFollowUps().some(x => x.id === s.id && x.kind === "propose_close"));
});

test("a follow-up cannot be logged on an unsent draft", () => {
  const job = "greenhouse:guard:1";
  db.upsertJobs([{ id: job, ats: "greenhouse", boardSlug: "guard", company: "Guard", title: "PM",
    location: "NYC", remote: false, description: "d", url: "https://x/g", applyUrl: "https://x/g" }]);
  const d = o.draftOutreach({ company: "Guard", jobId: job, person: "G", channel: "email", message: "hi" });
  backdate(d.id, 5);
  const before = o.listOutreach({ jobId: job })[0];
  assert.throws(() => o.updateOutreach(d.id, { followedUp: true }), /Cannot follow up on an unsent draft/);
  const after = o.listOutreach({ jobId: job })[0];
  assert.equal(after.followUps, 0);
  assert.equal(after.lastTouchAt, before.lastTouchAt, "the nag clock is not reset");
  assert.ok(!db.listEvents(job).some(e => e.detail?.startsWith("follow-up")), "no follow-up event on the timeline");
  o.updateOutreach(d.id, { status: "sent" });
  assert.equal(o.updateOutreach(d.id, { followedUp: true }).followUps, 1, "once sent, follow-ups count");
  o.updateOutreach(d.id, { status: "closed" });
});

test("a draft whose application moved past submitted still says re-read before sending", () => {
  for (const status of ["interview", "offer", "ghosted"] as const) {
    const job = `greenhouse:past:${status}`;
    db.upsertJobs([{ id: job, ats: "greenhouse", boardSlug: "past", company: "Past", title: status,
      location: "NYC", remote: false, description: "d", url: "https://x/p", applyUrl: "https://x/p" }]);
    db.setApplication(job, { status });
    const d = o.draftOutreach({ company: "Past", jobId: job, person: "P", channel: "email", message: "just applied" });
    backdate(d.id, 4);
    const row = o.dueFollowUps().find(x => x.id === d.id)!;
    assert.equal(row.kind, "send_or_close", status);
    assert.equal(row.applicationStatus, status);
    assert.equal(row.waitingOn, undefined, status);
    assert.match(row.suggestion, /re-read/i, status);
    assert.match(row.suggestion, new RegExp(`application is ${status}`), status);
    o.updateOutreach(d.id, { status: "closed" });
  }
});

test("a row with no job id is never propose_close, even when its company had a rejected application", () => {
  const job = "greenhouse:gone:1";
  db.upsertJobs([{ id: job, ats: "greenhouse", boardSlug: "gone", company: "Gone", title: "PM",
    location: "NYC", remote: false, description: "d", url: "https://x/z", applyUrl: "https://x/z" }]);
  db.setApplication(job, { status: "rejected" });
  const s = o.logOutreach({ company: "Gone", person: "Friend", channel: "email" });
  const d = o.draftOutreach({ company: "Gone", person: "Other", channel: "email", message: "hi" });
  backdate(s.id, 9); backdate(d.id, 3);
  const due = o.dueFollowUps().filter(x => x.company === "Gone");
  assert.deepEqual(due.map(x => [x.id, x.kind]).sort(), [[s.id, "follow_up"], [d.id, "send_or_close"]].sort());
  for (const x of due) assert.equal(x.applicationStatus, undefined);
  assert.ok(o.listOutreach({ company: "Gone" }).every(x => x.applicationStatus === undefined));
  for (const id of [s.id, d.id]) o.updateOutreach(id, { status: "closed" });
});

// ---- editing a draft's message (update_outreach message, 2026-11-02) ----

test("editing a draft: new text saved, voice check rerun, event recorded, still a draft, age kept", () => {
  const d = o.draftOutreach({ company: "Acme", jobId: JOB, person: "Edie", channel: "email", message: "Hi Edie, I saw Acme ship X." });
  assert.deepEqual(d.warnings, [], "a plain draft has no voice notes");
  backdate(d.id, 3);
  const before = o.listOutreach({ company: "Acme" }).find(x => x.id === d.id)!;
  const r = o.updateOutreach(d.id, { message: "Hi Edie, I am passionate about Acme and want to leverage my work." });
  assert.equal(r.message, "Hi Edie, I am passionate about Acme and want to leverage my work.");
  assert.equal(r.status, "draft");
  assert.equal(r.sentAt, before.sentAt);
  assert.equal(r.lastTouchAt, before.lastTouchAt, "an edit is not a touch: the unsent age stays");
  assert.ok(r.warnings?.some(w => /passionate about/.test(w)), "voice check reruns on the new text");
  assert.ok(r.warnings?.some(w => /leverage/.test(w)));
  assert.equal(o.listOutreach({ company: "Acme" }).find(x => x.id === d.id)!.message, r.message, "list shows the edited text");
  assert.equal(o.dueFollowUps().find(x => x.id === d.id)?.message, r.message, "the send_or_close row carries the edited text");
  const ev = db.listEvents(JOB).filter(e => e.kind === "outreach").map(e => e.detail ?? "");
  assert.ok(ev.some(x => /draft edited/.test(x) && x.includes("Edie")), `edit event recorded: ${ev.join(" | ")}`);

  // edit and send in one call: the edited text is what went out
  const s = o.updateOutreach(d.id, { message: "Hi Edie, one more try.", status: "sent" });
  assert.equal(s.status, "sent");
  assert.equal(s.message, "Hi Edie, one more try.");
  o.updateOutreach(d.id, { status: "closed" });
});

test("editing a draft keeps the draft rules: text required, LinkedIn note limit", () => {
  const d = o.draftOutreach({ company: "Acme", person: "Lin", channel: "LinkedIn", message: "Hi Lin. Would love to connect." });
  assert.throws(() => o.updateOutreach(d.id, { message: "   " }), /needs the message text/);
  assert.throws(() => o.updateOutreach(d.id, { message: "x".repeat(301) }), /300 characters/);
  assert.equal(o.listOutreach({ company: "Acme" }).find(x => x.id === d.id)!.message, "Hi Lin. Would love to connect.", "a refused edit changes nothing");
  o.updateOutreach(d.id, { status: "closed" });
});

test("a sent message is the record: editing it is refused and nothing changes", () => {
  const s = o.logOutreach({ company: "Acme", jobId: JOB, person: "Sent Sam", channel: "email", message: "what went out" });
  const events = db.listEvents(JOB).length;
  assert.throws(() => o.updateOutreach(s.id, { message: "rewritten" }), /already sent|only a draft/i);
  assert.throws(() => o.updateOutreach(s.id, { message: "rewritten", status: "replied", notes: "n" }), /already sent|only a draft/i);
  const after = o.listOutreach({ company: "Acme" }).find(x => x.id === s.id)!;
  assert.equal(after.message, "what went out");
  assert.equal(after.status, "sent", "a refused call writes nothing, not even the status");
  assert.equal(after.notes, undefined);
  assert.equal(db.listEvents(JOB).length, events, "no event for a refused edit");

  // a draft that went out is sent too, and a closed draft is not a draft any more
  const d = o.draftOutreach({ company: "Acme", person: "Later", channel: "email", message: "v1" });
  o.updateOutreach(d.id, { status: "sent" });
  assert.throws(() => o.updateOutreach(d.id, { message: "v2" }), /already sent|only a draft/i);
  const c = o.draftOutreach({ company: "Acme", person: "Closed", channel: "email", message: "v1" });
  o.updateOutreach(c.id, { status: "closed" });
  assert.throws(() => o.updateOutreach(c.id, { message: "v2" }), /only a draft/i);
  for (const id of [s.id, d.id]) o.updateOutreach(id, { status: "closed" });
});

test("status only takes known values and never goes back to draft, so a sent message cannot be reopened and rewritten", () => {
  const s = o.logOutreach({ company: "Acme", jobId: JOB, person: "Reopen", channel: "email", message: "what went out" });
  assert.throws(() => o.updateOutreach(s.id, { status: "draft" }), /^Error: Cannot edit outreach \d+ .*back to a draft/);
  assert.throws(() => o.updateOutreach(s.id, { message: "rewritten" }), /already sent/, "still sent, so the text is still the record");
  let after = o.listOutreach({ company: "Acme" }).find(x => x.id === s.id)!;
  assert.equal(after.status, "sent");
  assert.equal(after.message, "what went out");

  // an unknown status is refused before any write, even with a message edit in the same call
  const d = o.draftOutreach({ company: "Acme", jobId: JOB, person: "Bogus", channel: "email", message: "v1" });
  const events = db.listEvents(JOB).length;
  assert.throws(() => o.updateOutreach(d.id, { message: "v2", status: "bogus" as any }), /^Error: Unknown status "bogus"/);
  after = o.listOutreach({ company: "Acme" }).find(x => x.id === d.id)!;
  assert.equal(after.status, "draft");
  assert.equal(after.message, "v1", "a refused call writes nothing");
  assert.equal(db.listEvents(JOB).length, events, "and records nothing");
  assert.equal(o.updateOutreach(d.id, { status: "draft" }).status, "draft", "draft to draft is a no-op, not an error");
  for (const id of [s.id, d.id]) o.updateOutreach(id, { status: "closed" });
});

test("a message that is not a string is refused as a draft-rule error, and the same text records no edit", () => {
  const d = o.draftOutreach({ company: "Acme", jobId: JOB, person: "Same", channel: "email", message: "Hi Same, I am passionate about Acme." });
  assert.throws(() => o.updateOutreach(d.id, { message: 5 as any }), /^Error: A draft needs the message text/);
  const events = db.listEvents(JOB).length;
  const r = o.updateOutreach(d.id, { message: "Hi Same, I am passionate about Acme." });
  assert.equal(r.message, "Hi Same, I am passionate about Acme.");
  assert.ok(r.warnings?.some(w => /passionate about/.test(w)), "the voice notes still come back");
  assert.equal(db.listEvents(JOB).length, events, "no 'draft edited' event when nothing changed");
  o.updateOutreach(d.id, { status: "closed" });
});
