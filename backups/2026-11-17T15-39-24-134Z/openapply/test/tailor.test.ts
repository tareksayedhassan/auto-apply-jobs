import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./offline.js";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-tailor-"));
const db = await import("../src/db.js");
const profile = await import("../src/profile.js");
const imp = await import("../src/resume-import.js");
const tailor = await import("../src/tailor.js");
const { closePdfBrowser } = await import("../src/pdf.js");
after(() => closePdfBrowser());

const JOB = "greenhouse:globex:1";
db.upsertJobs([{ id: JOB, ats: "greenhouse", boardSlug: "globex", company: "Globex", title: "Forward Deployed Engineer",
  location: "NYC", remote: false, description: "Help customers integrate. React, TypeScript.", url: "u", applyUrl: "u" }]);
profile.saveProfile({ firstName: "Jane", lastName: "Doe", email: "jane.doe@example.com", phone: "(212) 555-0142", voiceSamples: ["I like short sentences. I say what I mean."] , savedAnswers: { "Salary expectations": "$140K-$180K base" } });
const master = await imp.importResume(fileURLToPath(new URL("./fixtures/resume/jane.txt", import.meta.url)));

test("brief carries rules, voice samples and user-input questions", async () => {
  const b = await tailor.tailoringBrief(JOB);
  assert.equal(b.job.company, "Globex");
  assert.equal(b.master.name, "Jane Doe");
  assert.ok(b.rules.some(r => /never invent/i.test(r)));
  assert.ok(b.rules.some(r => /match this voice/i.test(r)));
  assert.ok(b.rules.every(r => !r.includes("—")));
  assert.equal(b.voiceSamples.length, 1);
  assert.ok(b.needsUserInput.length >= 1);
  assert.ok(b.questionsHint.some(q => /Globex/.test(q)));
  await assert.rejects(tailor.tailoringBrief("nope"));
});

test("savePack renders one-page PDFs, warns on invention, sets drafted", async () => {
  const tailored = structuredClone(master);
  tailored.experience[0].bullets[1] = "Cut API p95 latency by 99% with caching";
  const letter = "Globex needs someone who can sit with customers and fix integrations. At Acme Robotics I built a React dashboard used by 120 operators.\n\nI am passionate about leveraging synergy.\n\nI have not run Go in production and would close that gap quickly.\n\nJane Doe";
  const pack = await tailor.savePack(JOB, { resume: tailored, coverLetter: letter, answers: { "Why Globex?": "Because." } });
  assert.ok(existsSync(pack.resumePdf!) && existsSync(pack.coverLetterPdf!));
  assert.ok(pack.warnings.some(w => w.includes('"99%"')));
  assert.ok(pack.warnings.some(w => w.startsWith("Voice:")));
  assert.ok(!pack.warnings.some(w => /pages/.test(w)));
  assert.equal(db.getApplication(JOB)?.status, "drafted");
  assert.ok(db.listEvents(JOB).some(e => e.kind === "pack"));
  assert.equal(tailor.loadPack(JOB)?.createdAt, pack.createdAt);
  assert.match(readFileSync(pack.resumePdf!).subarray(0, 5).toString(), /%PDF/);

  const { htmlToPdf } = await import("../src/pdf.js");
  const { pages } = await htmlToPdf("<p>x</p>".repeat(200), join(process.env.OPENAPPLY_HOME!, "long.pdf"));
  assert.ok(pages > 1);
});

test("savePack voids a filled or approved form and never downgrades a later status", async () => {
  db.setApplication(JOB, { status: "approved", confirmationCode: "ABC234" });
  await tailor.savePack(JOB, { resume: master });
  assert.equal(db.getApplication(JOB)?.status, "drafted"); // the open form no longer matches the pack
  assert.equal(db.getApplication(JOB)?.confirmationCode, undefined);
  db.setApplication(JOB, { status: "submitted" });
  await tailor.savePack(JOB, { resume: master });
  assert.equal(db.getApplication(JOB)?.status, "submitted");
  assert.equal(tailor.loadPack("greenhouse:globex:zzz"), undefined);
  const { paths } = await import("../src/paths.js");
  assert.equal(existsSync(join(paths.packs, "greenhouse_globex_zzz")), false); // reading never creates a folder
});

test("savePack fact-checks application answers and normalizes a sloppy resume", async () => {
  const pack = await tailor.savePack(JOB, { resume: master, answers: { "Why Globex?": "I grew Acme revenue by 777% last year.", "What are your salary expectations?": "$140K-$180K base" } });
  assert.ok(!pack.warnings.some(w => w.includes("$140K")), "a saved profile answer is the user's own fact");
  assert.ok(pack.warnings.some(w => w.includes('"777%"') && w.includes("Why Globex?")), pack.warnings.join("\n"));
  const sloppy: any = { name: "Jane Doe", contact: { email: "jane.doe@example.com" }, experience: [{ company: "Acme Robotics", title: "Senior Software Engineer", bullets: "oops" }] };
  const p2 = await tailor.savePack(JOB, { resume: sloppy });
  assert.deepEqual(p2.resume.education, []);
  await assert.rejects(tailor.savePack(JOB, { resume: {} as any }), (e: any) => e instanceof Error && !(e instanceof TypeError) && /name/.test(e.message));
});

test("savePack uploads the user's own resume_pdf as is and rejects a missing one", async () => {
  const own = join(process.env.OPENAPPLY_HOME!, "Jane_Doe_Globex.pdf");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(own, "%PDF-1.5 user build");
  const pack = await tailor.savePack(JOB, { resume: master, resumePdf: own });
  assert.equal(pack.resumePdf?.endsWith("Jane_Doe_Globex.pdf"), true);
  assert.equal(readFileSync(pack.resumePdf!, "utf8"), "%PDF-1.5 user build");
  await assert.rejects(tailor.savePack(JOB, { resume: master, resumePdf: join(process.env.OPENAPPLY_HOME!, "nope.pdf") }));
  const b = await tailor.tailoringBrief(JOB);
  assert.ok(b.rules.some(r => /newest first/.test(r)) && b.rules.some(r => /resume_pdf/.test(r)));
});

test("updatePack merges dashboard edits, keeps the resume file and flags, re-checks, re-renders only a changed letter", async () => {
  const id = "greenhouse:globex:2";
  db.upsertJobs([{ id, ats: "greenhouse", boardSlug: "globex", company: "Globex", title: "Solutions Engineer",
    location: "NYC", remote: false, description: "x", url: "u", applyUrl: "u" }]);
  const { writeFileSync } = await import("node:fs");
  const { packDir } = await import("../src/paths.js");
  const own = join(process.env.OPENAPPLY_HOME!, "Jane_Doe_Edit.pdf");
  writeFileSync(own, "%PDF-1.5 own build");
  const first = await tailor.savePack(id, { resume: master, resumePdf: own, coverLetter: "Dear Globex,\n\nShort and true.\n\nJane Doe",
    answers: { "Why Globex?": "TODO (you): one specific, true reason.", "Start date?": "Two weeks" } });
  writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ ...first, needsTailoredCut: true })); // as a dashboard draft leaves it
  writeFileSync(first.coverLetterPdf!, "sentinel"); // proves whether the letter was re-rendered

  const p = await tailor.updatePack(id, { answers: { "Why Globex?": "I grew Acme revenue by 777% last year." } });
  assert.equal(p.answers["Start date?"], "Two weeks");
  assert.equal(p.answers["Why Globex?"], "I grew Acme revenue by 777% last year.");
  assert.equal(p.resumePdf, first.resumePdf);
  assert.equal(readFileSync(p.resumePdf!, "utf8"), "%PDF-1.5 own build");
  assert.equal(p.needsTailoredCut, true);
  assert.equal(p.createdAt, first.createdAt);
  assert.ok(p.updatedAt);
  assert.ok(p.warnings.some(w => w.includes('"777%"')), p.warnings.join("\n"));
  assert.equal(readFileSync(first.coverLetterPdf!, "utf8"), "sentinel"); // letter untouched: no re-render
  assert.deepEqual(tailor.loadPack(id), p);
  assert.ok(db.listEvents(id).some(e => e.kind === "pack" && /Edited in dashboard: 1 answer/.test(e.detail ?? "")));

  const p2 = await tailor.updatePack(id, { coverLetter: "Dear Globex,\n\nA new, still true letter.\n\nJane Doe", answers: { "Why Globex?": "" } });
  assert.match(readFileSync(p2.coverLetterPdf!).subarray(0, 5).toString(), /%PDF/);
  assert.equal(p2.coverLetter, "Dear Globex,\n\nA new, still true letter.\n\nJane Doe");
  assert.equal(p2.answers["Why Globex?"], "");                  // cleared, key kept
  assert.ok(!p2.warnings.some(w => w.includes('"777%"')));     // re-checked on the merged content
  assert.ok(db.listEvents(id).some(e => /cover letter/.test(e.detail ?? "") && /Edited in dashboard/.test(e.detail ?? "")));
});

test("without a TeX engine the cover letter falls back to the HTML renderer with a warning, on save and on edit", async () => {
  const id = "greenhouse:globex:4";
  db.upsertJobs([{ id, ats: "greenhouse", boardSlug: "globex", company: "Globex", title: "T", location: "NYC", remote: false, description: "x", url: "u", applyUrl: "u" }]);
  process.env.OPENAPPLY_TEX = "off";
  try {
    const pack = await tailor.savePack(id, { resume: master, coverLetter: "Dear Globex,\n\nShort and true.\n\nJane Doe", answers: { "Start date?": "Two weeks" } });
    assert.match(readFileSync(pack.coverLetterPdf!).subarray(0, 5).toString(), /%PDF/);
    assert.ok(pack.warnings.some(w => /without LaTeX/.test(w)), pack.warnings.join("\n"));
    const kept = await tailor.updatePack(id, { answers: { "Start date?": "Now" } });
    assert.ok(kept.warnings.some(w => /without LaTeX/.test(w)), "letter unchanged: its render note stays");
    process.env.OPENAPPLY_TEX = "/nonexistent/tectonic";
    const edited = await tailor.updatePack(id, { coverLetter: "Dear Globex,\n\nStill short.\n\nJane Doe" });
    assert.equal(edited.warnings.filter(w => /without LaTeX/.test(w)).length, 1, edited.warnings.join("\n"));
  } finally { delete process.env.OPENAPPLY_TEX; }
});

test("a letter with a glyph Latin Modern lacks falls back to the HTML renderer with a warning naming it", async () => {
  const id = "greenhouse:globex:7";
  db.upsertJobs([{ id, ats: "greenhouse", boardSlug: "globex", company: "Globex", title: "T", location: "NYC", remote: false, description: "x", url: "u", applyUrl: "u" }]);
  const pack = await tailor.savePack(id, { resume: master, coverLetter: "Dear Globex,\n\nShipped it \u{1F680} on time.\n\nJane Doe" });
  assert.match(readFileSync(pack.coverLetterPdf!).subarray(0, 5).toString(), /%PDF/);
  assert.ok(pack.warnings.some(w => /without LaTeX/.test(w) && w.includes("\u{1F680} U+1F680")), pack.warnings.join("\n"));
});

test("updatePack refuses once submitted or later, voids a filled form, and refuses questions the pack does not have", async () => {
  const id = "greenhouse:globex:2";
  db.setApplication(id, { status: "drafted" });
  await assert.rejects(tailor.updatePack(id, { answers: { "Start date?": "Now", "Invented question?": "x" } }), /Cannot edit .*not a question in this pack: Invented question\?/);
  for (const s of ["submitted", "withdrawn"] as const) {
    db.setApplication(id, { status: s });
    await assert.rejects(tailor.updatePack(id, { answers: { "Start date?": "Now" } }), new RegExp(`Cannot edit .*${s}`));
  }
  assert.equal(tailor.loadPack(id)?.answers["Start date?"], "Two weeks");
  for (const s of ["filled", "approved"] as const) { // the open form no longer matches the pack: back to drafted, code gone
    db.setApplication(id, { status: s, confirmationCode: "ABC234" });
    await tailor.updatePack(id, { answers: { "Start date?": `Now ${s}` } });
    assert.equal(tailor.loadPack(id)?.answers["Start date?"], `Now ${s}`);
    assert.equal(db.getApplication(id)?.status, "drafted");
    assert.equal(db.getApplication(id)?.confirmationCode, undefined);
  }
  await tailor.updatePack(id, { answers: { "Start date?": "Two weeks" } });
  assert.ok(!("Invented question?" in tailor.loadPack(id)!.answers));
  await assert.rejects(tailor.updatePack("greenhouse:globex:1x", { answers: {} }), /Unknown job/);
  db.upsertJobs([{ id: "greenhouse:globex:3", ats: "greenhouse", boardSlug: "globex", company: "Globex", title: "T", location: "NYC", remote: false, description: "x", url: "u", applyUrl: "u" }]);
  await assert.rejects(tailor.updatePack("greenhouse:globex:3", { answers: {} }), /No pack for/);
});

test("concurrent updatePack calls are serialized: an answer saved during a letter render is not lost", async () => {
  const id = "greenhouse:globex:5";
  db.upsertJobs([{ id, ats: "greenhouse", boardSlug: "globex", company: "Globex", title: "T", location: "NYC", remote: false, description: "x", url: "u", applyUrl: "u" }]);
  await tailor.savePack(id, { resume: master, coverLetter: "Dear Globex,\n\nShort and true.\n\nJane Doe", answers: { "Start date?": "Two weeks", "Why Globex?": "TODO (you): reason" } });
  const [a, b] = await Promise.all([
    tailor.updatePack(id, { coverLetter: "Dear Globex,\n\nA newer, still true letter.\n\nJane Doe" }), // slow: renders a PDF
    tailor.updatePack(id, { answers: { "Why Globex?": "I use your API every week." } }),
  ]);
  const saved = tailor.loadPack(id)!;
  assert.equal(saved.coverLetter, "Dear Globex,\n\nA newer, still true letter.\n\nJane Doe");
  assert.equal(saved.answers["Why Globex?"], "I use your API every week.");
  assert.equal(b.coverLetter, a.coverLetter, "the second edit was read after the first was written");
});

test("an answer or letter naming another pipeline company is flagged; this company and past employers are not", async () => {
  db.upsertJobs([{ id: "greenhouse:initech:1", ats: "greenhouse", boardSlug: "initech", company: "Initech", title: "FDE",
    location: "NYC", remote: false, description: "x", url: "u", applyUrl: "u" }]);
  db.setApplication("greenhouse:initech:1", { status: "drafted" });
  const id = "greenhouse:globex:4";
  db.upsertJobs([{ id, ats: "greenhouse", boardSlug: "globex", company: "Globex", title: "FDE", location: "NYC", remote: false, description: "x", url: "u", applyUrl: "u" }]);
  const pack = await tailor.savePack(id, { resume: master, answers: { "What do you know about us?": "I have used Initech's API for two years.", "Start date?": "Two weeks" } });
  assert.ok(pack.warnings.some(w => /^Answer to "What do you know about us\?" names Initech, another company in your pipeline: rewrite it for Globex/.test(w)), pack.warnings.join("\n"));
  const fixed = await tailor.updatePack(id, { answers: { "What do you know about us?": "I have used Globex's API at Acme Robotics; initech-style naming is fine." } });
  assert.ok(!fixed.warnings.some(w => /another company in your pipeline/.test(w)), fixed.warnings.join("\n"));
});

test("packTodos: TODO placeholders and blank answers are unfinished", () => {
  assert.deepEqual(tailor.packTodos({ answers: { a: "todo (sam): x", b: "", c: "  \n ", d: "Done" }, coverLetter: "Hi TODO (you)" }), ["a", "b", "c", "Cover letter"]);
  assert.deepEqual(tailor.packTodos({ answers: { d: "Done" } }), []);
  assert.deepEqual(tailor.packTodos(undefined), []);
});

test("savePack warns at save time when the user keeps their own resume PDF and resume_pdf was left out", async () => {
  const { writeFileSync } = await import("node:fs");
  const own = join(process.env.OPENAPPLY_HOME!, "Jane_Doe.pdf");
  writeFileSync(own, "%PDF-1.5 user build");
  const NO_PDF = /No resume_pdf: .*fill refuses it/;
  assert.ok(!(await tailor.savePack(JOB, { resume: master })).warnings.some(w => NO_PDF.test(w)), "no PDF of their own: the rendered one is fine");
  profile.saveProfile({ resumePdf: own });
  assert.ok((await tailor.savePack(JOB, { resume: master })).warnings.some(w => NO_PDF.test(w)));
  assert.ok(!(await tailor.savePack(JOB, { resume: master, resumePdf: own })).warnings.some(w => NO_PDF.test(w)));
});

test("packTodos: a marker naming someone other than \"you\" (older packs) still counts as unfinished", () => {
  assert.deepEqual(tailor.packTodos({ answers: { a: "TODO (Jane): reason", b: "todo (jane): x", c: "Done" }, coverLetter: "Dear team, TODO (Jane): why us" }), ["a", "b", "Cover letter"]);
  assert.deepEqual(tailor.packTodos({ answers: { a: "TODO list: ship it", b: "I will (todo) it" } }), []);
});
