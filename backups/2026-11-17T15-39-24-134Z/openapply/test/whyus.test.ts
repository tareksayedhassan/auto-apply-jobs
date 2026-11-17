import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./offline.js";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-whyus-"));
const db = await import("../src/db.js");
const profile = await import("../src/profile.js");
const imp = await import("../src/resume-import.js");
const tailor = await import("../src/tailor.js");
const { isWhyUs, whyUsCheck, avoidedClaims } = await import("../src/whyus-check.js");
const whyus = await import("../src/whyus.js");
const runs = await import("../src/runs.js");
const { closePdfBrowser } = await import("../src/pdf.js");
const { startServer } = await import("../src/server/http.js");
const srv = await startServer(0, { uiDir: mkdtempSync(join(tmpdir(), "oa-whyus-ui-")) });
after(async () => { await srv.close(); await closePdfBrowser(); });

const POSTING = "Globex builds monitoring for checkout flows. Our customers are online stores that lose sales when a payment page breaks. "
  + "We are hiring a product engineer to own the synthetic checks that catch those breaks before shoppers do. You will work with customers directly, write the checks yourself, and decide what the product watches next.";
const JOB = "greenhouse:globex:1";
const THIN = "greenhouse:globex:2";
const OTHER = "greenhouse:initech:1";
db.upsertJobs([
  { id: JOB, ats: "greenhouse", boardSlug: "globex", company: "Globex", title: "Product Engineer", location: "NYC", remote: false, description: POSTING, url: "u", applyUrl: "u" },
  { id: THIN, ats: "greenhouse", boardSlug: "globex", company: "Globex", title: "Solutions Engineer", location: "NYC", remote: false, description: "Join us.", url: "u", applyUrl: "u" },
  { id: OTHER, ats: "greenhouse", boardSlug: "initech", company: "Initech", title: "Engineer", location: "NYC", remote: false, description: "x", url: "u", applyUrl: "u" },
]);
profile.saveProfile({ firstName: "Jane", lastName: "Doe", email: "jane.doe@example.com", avoidClaims: ["$300K", "4+ hours"], proofPoints: ["Got ChatGPT and Claude to describe me accurately by fixing every page they read about me."] });
const master = await imp.importResume(fileURLToPath(new URL("./fixtures/resume/jane.txt", import.meta.url)));
const Q = "Why do you want to work at Globex?";
const FIT = "Why are you a good fit for this role?";
await tailor.savePack(JOB, { resume: master, answers: { [Q]: "TODO (you): one specific, true reason.", [FIT]: "I build things." } });
await tailor.savePack(THIN, { resume: master, answers: { "Why Globex?": "TODO (you): one specific, true reason." } });
await tailor.savePack(OTHER, { resume: master, answers: { "Why Initech?": "TODO (you): one specific, true reason." } });

/** 80 words, names Globex, one link, no numbers. */
const GOOD = "Globex says its customers lose sales when a payment page breaks, and the product engineer owns the checks that catch it first. "
  + "That is the part I want. At Acme Robotics I built the React dashboard operators used to spot failures before customers called, "
  + "so I have watched what a silent break costs and what it takes to make a check people trust. "
  + "I would like to do that work on checkout flows at Globex, where a missed break is lost money.";

test("detects why-us questions and leaves the rest alone", () => {
  for (const q of [Q, "What interests you in Globex?", "Why are you interested in joining Globex?", "Why this role?", "Why Globex?", "What excites you about working here?", "Why do you want to join us?", "Why us?"]) {
    assert.ok(isWhyUs(q, "Globex"), q);
  }
  for (const q of [FIT, "Why should we hire you?", "Why Rust?", "What are your salary expectations?", "Why are you leaving your current job?", "Tell us about a project"]) {
    assert.ok(!isWhyUs(q, "Globex"), q);
  }
});

test("check: length, company named, dashes, honestly, three-item lists, avoid list", () => {
  assert.deepEqual(whyUsCheck(GOOD, { question: Q, company: "Globex" }), []);
  const bad = whyUsCheck("Honestly I like speed, craft, and care — and I ran $300K+ in deals and saved 4+ hours a week.", { question: Q, company: "Globex", avoid: ["$300K", "4+ hours"] });
  for (const re of [/words; aim for 60 to 110/, /never names Globex/, /dash/, /"honestly"/, /three-item list/, /"\$300K" .* avoid list/, /"4\+ hours" .* avoid list/]) {
    assert.ok(bad.some(w => re.test(w)), `${re}: ${bad.join(" | ")}`);
  }
  assert.ok(bad.every(w => w.includes(`the answer to "${Q}"`) || /^Why-us: dash/.test(w)));
  assert.deepEqual(avoidedClaims("a 300k pipeline", ["$300K"]), ["$300K"]); // same figure, other spelling
  assert.deepEqual(avoidedClaims("3000 users", ["$300K", "300"]), []);
});

test("brief: questions with state, posting, evidence from resume and proof points, avoid list, thin flag", async () => {
  const b = await whyus.whyUsBrief(JOB);
  assert.deepEqual(b.questions.map(q => [q.question, q.state]), [[Q, "todo"]]);
  assert.ok(b.companyFacts.posting.includes("payment page breaks"));
  assert.equal(b.companyFacts.thin, false);
  assert.ok(b.evidence.some(e => e.from.startsWith("Acme Robotics")));
  assert.ok(b.evidence.some(e => e.from === "profile.proofPoints"));
  assert.deepEqual(b.avoid, ["$300K", "4+ hours"]);
  assert.ok(b.rules.some(r => /no_link/.test(r)));
  assert.ok(b.rules.every(r => !r.includes("—")));
  assert.equal((await whyus.whyUsBrief(THIN)).companyFacts.thin, true);
});

test("a saved draft awaits review: fill stays locked until the user edits or keeps it", async () => {
  const r = await whyus.saveWhyUs(JOB, { question: Q, answer: GOOD, link: "checkout breaks -> exp1.1" });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.todos, [Q]); // drafted counts as unfinished
  let pack = tailor.loadPack(JOB)!;
  assert.equal(pack.answers[Q], GOOD);
  assert.equal(pack.drafted?.[Q]?.link, "checkout breaks -> exp1.1");
  assert.equal((await whyus.whyUsBrief(JOB)).questions[0].state, "drafted");

  // saving the pack again with the same text keeps the flag; it never passes as finished
  await tailor.savePack(JOB, { resume: master, answers: pack.answers });
  assert.ok(tailor.loadPack(JOB)!.drafted?.[Q]);

  pack = await tailor.updatePack(JOB, { reviewed: [Q] }); // "Keep it"
  assert.equal(pack.drafted, undefined);
  assert.deepEqual(tailor.packTodos(pack), []);

  // a kept draft is the user's answer now: redrafting it takes replace
  await assert.rejects(whyus.saveWhyUs(JOB, { question: Q, answer: GOOD }), /already has your own answer/);
  await whyus.saveWhyUs(JOB, { question: Q, answer: GOOD, replace: true }); // drafted again, then edited: the edit is the review
  pack = await tailor.updatePack(JOB, { answers: { [Q]: GOOD.replace("That is the part I want.", "That is the job I want.") } });
  assert.equal(pack.drafted, undefined);
  assert.ok(db.listEvents(JOB).some(e => /Why-us drafted for your review/.test(e.detail ?? "")));
});

test("guards on save: why-us only, never over the user's own answer, never once sent, warnings returned", async () => {
  await assert.rejects(whyus.saveWhyUs(JOB, { question: FIT, answer: GOOD }), /Not a why-us question/);
  await assert.rejects(whyus.saveWhyUs(JOB, { question: "Why Globex now?", answer: GOOD }), /Not a question in this pack/);
  await assert.rejects(whyus.saveWhyUs(JOB, { question: Q, answer: GOOD }), /already has your own answer/); // the user edited it above
  await assert.rejects(whyus.saveWhyUs(JOB, { question: Q, answer: "TODO (you): x", replace: true }), /cannot be a TODO/);

  const r = await whyus.saveWhyUs(OTHER, { question: "Why Initech?", answer: `${GOOD} Globex too.` });
  assert.ok(r.warnings.some(w => /names Globex, another company in your pipeline/.test(w)), r.warnings.join(" | "));
  assert.ok(r.warnings.some(w => /words; aim for/.test(w)) || r.warnings.some(w => /never names Initech/.test(w)));

  const short = await whyus.saveWhyUs(OTHER, { question: "Why Initech?", answer: "Initech pays $300K for synergy — honestly." });
  for (const re of [/avoid list/, /dash/, /"honestly"/]) assert.ok(short.warnings.some(w => re.test(w)), `${re}`);
  assert.ok(tailor.loadPack(OTHER)!.warnings.some(w => /^Why-us:/.test(w))); // the pack's Checks tab shows them too

  db.setApplication(OTHER, { status: "submitted" });
  await assert.rejects(whyus.saveWhyUs(OTHER, { question: "Why Initech?", answer: GOOD }), /already submitted/);
  db.setApplication(OTHER, { status: "drafted" });
});

test("no honest link: a short true stub is saved for the user to rewrite, and cannot be kept as is", async () => {
  const r = await whyus.saveWhyUs(THIN, { question: "Why Globex?", noLink: true });
  assert.equal(r.noLink, true);
  assert.equal(r.answer, whyus.noLinkStub("Globex", "Solutions Engineer"));
  assert.ok(!/\btodo \([^()\n]{1,30}\)/i.test(r.answer));
  assert.deepEqual(r.todos, ["Why Globex?"]);
  assert.equal(tailor.loadPack(THIN)!.drafted?.["Why Globex?"]?.noLink, true);
  await assert.rejects(tailor.updatePack(THIN, { reviewed: ["Why Globex?"] }), /rewrite it in your own words/);
  const done = await tailor.updatePack(THIN, { answers: { "Why Globex?": "My own reason, in my own words, about Globex." } });
  assert.deepEqual(tailor.packTodos(done), []);
});

test("dashboard run: spawns a draft_why_us-only claude, settles done on a fresh draft", async () => {
  await tailor.updatePack(JOB, { answers: { [Q]: "TODO (you): one specific, true reason." } });
  let child!: EventEmitter & { pid: number; unref(): void };
  const calls: string[][] = [];
  const spawn = (_: string, args: string[]) => { calls.push(args); child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} }); return child as any; };
  const run = runs.startWhyUs(JOB, Q, { spawn });
  assert.equal(run.kind, "whyus");
  assert.equal(run.state, "running");
  const args = calls[0];
  assert.deepEqual(args[args.indexOf("--allowedTools") + 1].split(","), ["mcp__openapply__draft_why_us"]);
  assert.match(args[args.indexOf("-p") + 1], /draft only this one/);
  assert.throws(() => runs.startWhyUs(JOB, Q, { spawn }), /Busy/);
  child.emit("exit", 0);
  assert.equal(runs.getRun(JOB)?.state, "failed"); // exited without saving a draft

  runs.startWhyUs(JOB, undefined, { spawn });
  await whyus.saveWhyUs(JOB, { question: Q, answer: GOOD });
  child.emit("exit", 0);
  assert.equal(runs.getRun(JOB)?.state, "done");
  assert.ok(runs.DRAFT_TOOLS.includes("mcp__openapply__draft_why_us")); // the pack drafter drafts why-us too
  assert.throws(() => runs.startWhyUs(JOB, "Not here?", { spawn }), /Not a question/);
  writeFileSync(join(process.env.OPENAPPLY_HOME!, "noop"), "");
});

test("HTTP: the job lists its why-us questions, Keep it clears the review, bad bodies get 400", async () => {
  const H = { "x-openapply": "1", "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(srv.url + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const p = `/api/jobs/${encodeURIComponent(JOB)}`;
  assert.deepEqual((await call("GET", p)).body.whyUs, [Q]);
  assert.equal(tailor.loadPack(JOB)!.drafted?.[Q] !== undefined, true); // drafted by the run test
  assert.equal((await call("PUT", `${p}/pack`, { reviewed: "nope" })).status, 400);
  const kept = await call("PUT", `${p}/pack`, { reviewed: [Q] });
  assert.equal(kept.status, 200);
  assert.ok(!kept.body.todos.includes(Q));
  const stub = await whyus.saveWhyUs(JOB, { question: Q, noLink: true, replace: true });
  assert.ok(stub.noLink);
  assert.equal((await call("PUT", `${p}/pack`, { reviewed: [Q] })).status, 400); // a stub is rewritten, never kept
  assert.equal((await call("POST", `${p}/why-us`, { question: 7 })).status, 400);
  assert.equal((await call("POST", `${p}/why-us`, { question: "Not here?" })).status, 400);
});
