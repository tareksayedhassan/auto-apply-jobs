import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-track-"));
const db = await import("../src/db.js");
const track = await import("../src/track.js");

const job = (id: string) => ({
  id: `greenhouse:acme:${id}`, ats: "greenhouse" as const, boardSlug: "acme", company: "Acme",
  title: `Role ${id}`, location: "NYC", remote: false, description: "d", url: "https://x", applyUrl: "https://x",
});
db.upsertJobs([job("1"), job("2"), job("3")]);
const [j1, j2, j3] = ["1", "2", "3"].map(i => `greenhouse:acme:${i}`);

test("saveJob creates, keeps status, appends dated notes", () => {
  const a = track.saveJob(j1);
  assert.equal(a.status, "saved");
  assert.equal(a.notes, undefined);
  const b = track.saveJob(j1, "referral from Sam");
  assert.match(b.notes!, /^\d{4}-\d{2}-\d{2}: referral from Sam$/);
  track.updateStatus(j1, "drafted");
  assert.equal(track.saveJob(j1, "second").status, "drafted");
  assert.equal(db.getApplication(j1)!.notes!.split("\n").length, 2);
  assert.ok(db.listEvents(j1).some(e => e.kind === "note" && e.detail === "second"));
  assert.throws(() => track.saveJob("nope:x:1"), /Unknown job/);
});

test("updateStatus validates, stamps submittedAt, logs notes", () => {
  assert.throws(() => track.updateStatus(j2, "bogus" as any), /Unknown status/);
  assert.throws(() => track.updateStatus("nope:x:1", "saved"), /Unknown job/);
  const s = track.updateStatus(j2, "submitted", "sent via form");
  assert.ok(s.submittedAt);
  assert.match(s.notes!, /sent via form/);
  const first = s.submittedAt;
  assert.equal(track.updateStatus(j2, "interview").submittedAt, first);
  const kinds = db.listEvents(j2).map(e => e.kind);
  assert.ok(kinds.includes("status") && kinds.includes("note"));
});

test("approve only a filled form, with the code the user saw", async () => {
  assert.throws(() => track.approve(j3, "X"), /Cannot approve/);          // no application
  track.saveJob(j3);
  assert.throws(() => track.approve(j3, "X"), /status is "saved"/);
  track.updateStatus(j3, "drafted");
  assert.throws(() => track.approve(j3, "X"), /status is "drafted"/);    // a pack alone is not a filled form
  assert.throws(() => track.updateStatus(j3, "approved"), /Cannot approve/); // no back door through status
  db.setApplication(j3, { status: "filled", confirmationCode: "ABC234" }); // what a fill leaves behind
  assert.throws(() => track.approve(j3, "OLD999"), /filled again/);       // stale code from an earlier fill
  assert.throws(() => track.approve(j3, undefined), /filled again/);
  assert.equal(track.approve(j3, "abc234").status, "approved");
  assert.throws(() => track.approve(j3, "ABC234"), /status is "approved"/);
});

test("approve refuses while the stored fill has required blanks; a stale fill does not count", () => {
  const id = "greenhouse:acme:2";
  const fill = (code: string, blanks: string[]) => track.saveFill(id, {
    at: new Date().toISOString(), code, filled: [{ key: "f", label: "First Name", value: "Test" }], blanks, failed: [],
  });
  db.setApplication(id, { status: "filled", confirmationCode: "BLK234" });
  fill("BLK234", ["Country", "SQL, APIs or scripting?"]);
  assert.deepEqual(track.currentFill(id)?.blanks, ["Country", "SQL, APIs or scripting?"]);
  assert.throws(() => track.approve(id, "BLK234"), /Cannot approve greenhouse:acme:2: required fields are blank on the form: Country, SQL, APIs or scripting\?/);
  db.setApplication(id, { status: "filled", confirmationCode: "NEW234" }); // filled again, nothing stored for it
  assert.equal(track.currentFill(id), undefined);
  fill("NEW234", []);
  assert.equal(track.approve(id, "NEW234").status, "approved");
  assert.deepEqual(track.currentFill(id)?.blanks, []);
  db.setApplication(id, { status: "filled", confirmationCode: "FLD234" }); // answered, but the filler could not enter it
  track.saveFill(id, { at: new Date().toISOString(), code: "FLD234", filled: [], blanks: [], failed: ["Location"] });
  assert.equal(track.approve(id, "FLD234").status, "approved"); // the user finishes it by hand in the open window
  db.setApplication(id, { status: "interview" }); // back where the pipeline test expects it
  assert.equal(track.currentFill(id), undefined);
});

test("pipeline counts every status", () => {
  const p = track.pipeline();
  assert.equal(Object.keys(p.counts).length, 11);
  assert.equal(p.counts.drafted, 1);
  assert.equal(p.counts.interview, 1);
  assert.equal(p.counts.approved, 1);
  assert.equal(p.counts.offer, 0);
  assert.equal(p.items.length, 3);
  assert.ok(p.items.every(i => i.job));
  assert.ok(p.recent.length > 0 && p.recent.length <= 20);
});

const jn = (id: string, over: object = {}) => ({ ...job(id), ...over });
db.upsertJobs([jn("10"), jn("11"), jn("12", { title: "Dup Role" }), jn("13", { title: "Dup Role", url: "https://y" })]);

test("notes: a pre-stamped note is not stamped twice", () => {
  const id = "greenhouse:acme:10";
  const a = track.saveJob(id, "2026-10-12: chose not to send");
  assert.match(a.notes!, /^\d{4}-\d{2}-\d{2}: chose not to send$/);
  const b = track.saveJob(id, "plain");
  assert.match(b.notes!.split("\n")[1], /^\d{4}-\d{2}-\d{2}: plain$/);
});

test("notes: a note already contained in the last note is not appended again", () => {
  const id = "greenhouse:acme:11";
  track.saveJob(id, "Earlier FDE pick: FDE");
  track.saveJob(id, "FDE");
  assert.equal(db.getApplication(id)!.notes!.split("\n").length, 1);
  assert.equal(db.listEvents(id).filter(e => e.kind === "note").length, 1);
});

test("saveJob never downgrades an existing status", () => {
  const id = "greenhouse:acme:11";
  track.updateStatus(id, "drafted");
  assert.equal(track.saveJob(id).status, "drafted");
  assert.equal(track.saveJob(id, "again").status, "drafted");
  assert.equal(db.getApplication(id)!.status, "drafted");
});

test("pipeline collapses two postings of the same role", () => {
  track.saveJob("greenhouse:acme:12");
  track.saveJob("greenhouse:acme:13");
  const p = track.pipeline();
  const dups = p.items.filter(a => a.job?.title === "Dup Role");
  assert.equal(dups.length, 1);
  assert.equal(p.counts.saved, p.items.filter(a => a.status === "saved").length);
});

test("event text is readable, never raw JSON", () => {
  const e = (kind: string, detail: string) => ({ id: 1, jobId: "x", at: "t", kind, detail });
  assert.equal(track.describeEvent(e("filled", JSON.stringify({ summary: "12 filled, 0 required missing via ashby", screenshot: "a.png" }))),
    "Form filled: 12 filled, 0 required missing via ashby");
  assert.equal(track.describeEvent(e("submitted", JSON.stringify({ summary: "Submitted" }))), "Submitted: Submitted");
  assert.equal(track.describeEvent(e("weird", JSON.stringify({ a: 1, b: "x" }))), "Weird: a: 1, b: x");
  assert.equal(track.describeEvent(e("status", "drafted")), "Moved to drafted");
});
