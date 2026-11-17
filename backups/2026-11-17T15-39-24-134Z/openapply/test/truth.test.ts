import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-truth-"));
const { truthCheck, voiceCheck } = await import("../src/truth.js");
const { parseResumeText } = await import("../src/resume-import.js");
const { readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");

const source = readFileSync(fileURLToPath(new URL("./fixtures/resume/jane.txt", import.meta.url)), "utf8");
const master = parseResumeText(source);
const clone = () => structuredClone(master);

test("faithful reordering and trimming is clean", () => {
  const t = clone();
  t.experience.reverse();
  t.experience[1].bullets = t.experience[1].bullets.slice(0, 2);
  t.experience[1].title = "Software Engineer";
  t.experience[0].title = "Software Engineer";
  t.education[0].start = undefined;
  assert.deepEqual(truthCheck(master, source, t, "I cut API latency by 38% at Acme Robotics."), []);
});

test("flags invented numbers, employers, titles, dates, schools, skills", () => {
  const t = clone();
  t.experience[0].bullets[1] = "Cut API latency by 52% for 3000 users";
  t.experience[1].title = "CTO";
  t.experience[1].start = "June 2016";
  t.experience.push({ company: "Globex", title: "Engineer", bullets: ["Did things"] });
  t.education[0].school = "Harvard";
  t.skills = ["TypeScript", "Rust"];
  const w = truthCheck(master, source, t, "Revenue grew 400% — wow");
  const has = (s: string) => assert.ok(w.some(x => x.includes(s)), `${s} in\n${w.join("\n")}`);
  has('New number "52%" in Acme Robotics bullet 2');
  has('New number "3000"');
  has('New number "400%" in the cover letter');
  has('Title "CTO" at Beta Labs');
  has('Date "June 2016"');
  has('Employer "Globex"');
  has('School "Harvard"');
  has('New skill "Rust"');
  has("em dash in the cover letter");
  assert.ok(!w.some(x => x.includes('"38%"')));
});

test("a number the question itself asks about is not a new number in the answer", () => {
  const w = truthCheck(master, source, clone(), undefined, {
    "This is a 5-days in office role. Does that fit?": "Yes, 5 days works",
    "When could you start?": "In 23 days",
  });
  assert.ok(!w.some(x => x.includes('"5"')), w.join("\n"));
  assert.ok(w.some(x => x.includes('New number "23"')), w.join("\n")); // a number the question does not mention still counts
  const years = truthCheck(master, source, clone(), undefined, { "Do you have 10+ years of experience managing teams?": "Yes, 10 years" });
  assert.ok(years.some(x => x.includes('New number "10"')), "an echoed experience threshold is still a claim");
});

test("saved profile answers are known for form answers only, never for the resume or letter", () => {
  const t = clone();
  t.experience[0].bullets[0] = "Led 47 engineers";
  const w = truthCheck(master, source, t, "I led 47 engineers.", { "Team size you led?": "47 engineers" }, "Team size: 47");
  assert.ok(w.some(x => x.includes('"47"') && x.includes("bullet 1")), w.join("\n"));
  assert.ok(w.some(x => x.includes('"47"') && x.includes("cover letter")), w.join("\n"));
  assert.ok(!w.some(x => x.includes('"47"') && x.includes("Team size you led?")), w.join("\n"));
});

test("voiceCheck catches cliches and generic letters", () => {
  const bad = "I am thrilled to apply. I am passionate about leveraging synergy in a fast-paced environment.\n\nI have a proven track record.\n\nI would be a great fit.";
  const w = voiceCheck(bad, "Globex");
  for (const s of ["thrilled", "passionate about", "leverage", "synergy", "fast-paced", "proven track record", "great fit"]) {
    assert.ok(w.some(x => x.startsWith("Voice:") && x.includes(s)), s);
  }
  assert.ok(voiceCheck("one two three four five six\n\nsix five four three two one\n\nalpha beta gamma delta eps zeta").some(x => x.includes("about the same length")));
  const plain = "Globex runs its billing on a system you describe as brittle. At Beta Labs I rebuilt one like it and cut CI from 40 minutes to 9, so I know where those fail.\n\nOne gap: I have not run Go in production. I would close it by porting a small service in my first month.\n\nI would like to talk.";
  assert.deepEqual(voiceCheck(plain, "Globex"), []);
  assert.ok(voiceCheck("word ".repeat(80), "Globex").some(x => x.includes("never mentions Globex")));
  // Lever's company is the title-cased board slug: "Initrodesystems 2" is named "Initrode" in a letter, never by the slug
  const named = "Initrode reads checks for banks, and I built the intake side of the same problem at Beta Labs. ".repeat(6);
  assert.deepEqual(voiceCheck(named, "Initrodesystems 2"), []);
  assert.deepEqual(voiceCheck(named, "Initrode Systems"), []);
  assert.ok(voiceCheck("word ".repeat(80), "Initrodesystems 2").some(x => x.includes("never mentions Initrodesystems 2")));
  assert.ok(voiceCheck(("At Init Labs I built checks for banks. ").repeat(12), "Initrodesystems 2").some(x => x.includes("never mentions")), "a four-letter prefix is not a mention");
  assert.ok(voiceCheck(("I read the systems side of banks. ").repeat(12), "Initrodesystems 2").some(x => x.includes("never mentions")), "a word that merely appears inside the slug is not a mention");
  assert.ok(voiceCheck("We spearheaded x. They spearheaded y.").some(x => x.includes("spearheaded")));
  assert.ok(voiceCheck("We use react, redux, and sagas. Also go, rust, and zig. Plus a, b, and c.").some(x => x.includes("three-item")));
});

// ---- whole-word name matching
const mini = (company: string, title: string, degree = "BA Economics"): any => ({
  name: "Jane Doe", contact: {}, skills: [],
  experience: [{ company, title, start: "2020", end: "2022", bullets: [] }],
  education: [{ school: "State University", degree }],
});
const flags = (m: any, t: any, re: RegExp) => truthCheck(m, "", t).some(x => re.test(x));

test("names match by whole words: no substring or extended-name passes", () => {
  const base = mini("Metabase", "Engineer");
  assert.ok(flags(base, mini("Meta", "Engineer"), /Employer "Meta"/));
  assert.ok(flags(mini("Dunder", "Engineer"), mini("Dunder and Vehement", "Engineer"), /Employer "Dunder and Vehement"/));
  assert.ok(flags(base, mini("Metabase", "Senior Staff Engineer"), /Title "Senior Staff Engineer"/));
  assert.ok(flags(mini("A", "Product Manager"), mini("A", "Senior Product Manager"), /Title/));
  assert.ok(flags(base, mini("Metabase", "Engineer", "MBA, BA Economics"), /Degree "MBA, BA Economics"/));
  // dropping words is still fine
  assert.deepEqual(truthCheck(mini("Metabase Inc", "Senior Staff Engineer", "MBA, BA Economics"), "", mini("Metabase", "Engineer", "BA Economics")), []);
});

test("parenthetical like (acquired by X) is allowed only when X is in the master or source", () => {
  const m = mini("Wonka", "Engineer");
  const t = mini("Wonka (acquired by Initech)", "Engineer");
  assert.ok(flags(m, t, /Employer "Wonka \(acquired by Initech\)"/));
  assert.deepEqual(truthCheck(m, "Wonka was acquired by Initech in 2024", t), []);
  assert.deepEqual(truthCheck(mini("Wonka (acquired by Initech)", "Engineer"), "", mini("Wonka", "Engineer")), []);
});

test("names that normalize to nothing never match; non-Latin names still work", () => {
  assert.ok(flags(mini("株式会社テスト", "Engineer"), mini("Globex", "Engineer"), /Employer "Globex"/));
  assert.ok(flags(mini("Acme", "Engineer"), mini("???", "Engineer"), /Employer "\?\?\?"/));
  assert.ok(flags(mini("???", "Engineer"), mini("Acme", "Engineer"), /Employer "Acme"/));
  assert.ok(flags(mini("株式会社テスト", "Engineer"), mini("株式会社別", "Engineer"), /Employer/));
  assert.deepEqual(truthCheck(mini("株式会社テスト", "Engineer"), "", mini("株式会社テスト", "Engineer")), []);
});

test("application answers are fact-checked like free text", () => {
  const w = truthCheck(master, source, clone(), undefined, { "Why us?": "I grew revenue 900% — fast" });
  assert.ok(w.some(x => x.includes('New number "900%"') && x.includes("Why us?")), w.join("\n"));
  assert.ok(w.some(x => /em dash/.test(x) && x.includes("Why us?")));
  assert.deepEqual(truthCheck(master, source, clone(), undefined, { q: "I cut latency by 38%" }), []);
});

test("truthCheck does not crash on missing arrays", () => {
  const t: any = { name: "Jane Doe", contact: {} };
  assert.doesNotThrow(() => truthCheck(master, source, t));
  assert.doesNotThrow(() => truthCheck({ name: "x" } as any, "", clone()));
});
