import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-profile-"));
const profile = await import("../src/profile.js");
const imp = await import("../src/resume-import.js");
const fixture = fileURLToPath(new URL("./fixtures/resume/jane.txt", import.meta.url));

test("saveProfile deep-merges nested objects and profileStatus lists gaps", () => {
  assert.equal(profile.profileStatus().hasProfile, false);
  profile.saveProfile({ firstName: "Jane", lastName: "Doe", email: "j@x.com", targets: { titles: ["Engineer"], remoteOk: true } });
  const p = profile.saveProfile({ targets: { keywords: ["react"] }, savedAnswers: { a: "1" } });
  profile.saveProfile({ savedAnswers: { b: "2" }, eeo: { gender: "Decline" } });
  const cur = profile.loadProfile()!;
  assert.deepEqual(cur.targets, { titles: ["Engineer"], remoteOk: true, keywords: ["react"] });
  assert.deepEqual(cur.savedAnswers, { a: "1", b: "2" });
  assert.equal(p.firstName, "Jane");
  const st = profile.profileStatus();
  assert.deepEqual(st.missing, ["phone", "resume", "workAuthorizedUS", "needsSponsorship"]);
  profile.saveProfile({ phone: "1", workAuthorizedUS: true, needsSponsorship: false });
  assert.deepEqual(profile.profileStatus().missing, ["resume"]);
});

test("parseResumeText reads a plain text resume", async () => {
  const r = await imp.importResume(fixture);
  assert.equal(r.name, "Jane Doe");
  assert.equal(r.contact.email, "jane.doe@example.com");
  assert.equal(r.contact.phone, "(212) 555-0142");
  assert.equal(r.contact.location, "Brooklyn, NY");
  assert.ok(r.contact.links?.includes("github.com/janedoe"));
  assert.match(r.summary ?? "", /Full-stack engineer/);
  assert.deepEqual(r.experience.map(e => [e.company, e.title, e.start, e.end]), [
    ["Acme Robotics", "Senior Software Engineer", "March 2021", "Present"],
    ["Beta Labs", "Software Engineer", "June 2018", "February 2021"],
  ]);
  assert.equal(r.experience[0].bullets.length, 3);
  assert.equal(r.experience[0].location, "San Francisco, CA");
  assert.equal(r.education[0].school, "State University");
  assert.equal(r.education[0].degree, "B.S. in Computer Science");
  assert.equal(r.education[0].end, "2018");
  assert.equal(r.projects?.[0].name, "Tidepool");
  assert.deepEqual(r.skills?.slice(0, 3), ["TypeScript", "Python", "Go"]);
  assert.equal(profile.loadResume()?.name, "Jane Doe");
  assert.match(readFileSync(join(process.env.OPENAPPLY_HOME!, "resume-source.txt"), "utf8"), /Beta Labs/);
});

test("tex macros become text; escapes survive", () => {
  const t = imp.texToText(String.raw`\documentclass{article}\begin{document}
\section{Experience}
\resumeSubheading{Acme}{NYC}{Engineer}{May 2020 -- Present}
\resumeItem{Grew revenue \textbf{\$3M} (\href{https://a.com}{a.com}) 100\% }
\end{document}`);
  assert.match(t, /Acme\tNYC\nEngineer\tMay 2020 – Present/);
  assert.match(t, /- Grew revenue \$3M \(a\.com\) 100%/);
});

test("docx and JSON Resume imports", async () => {
  // build a minimal stored zip with word/document.xml
  const xml = `<w:document><w:body><w:p><w:r><w:t>Jane Doe</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Built &amp; shipped</w:t></w:r></w:p></w:body></w:document>`;
  const name = Buffer.from("word/document.xml"), data = Buffer.from(xml), comp = deflateRawSync(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, name, comp]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(body.length, 16);
  const f = join(process.env.OPENAPPLY_HOME!, "t.docx");
  writeFileSync(f, Buffer.concat([body, cd, name, eocd]));
  assert.equal(await imp.extractText(f), "Jane Doe\n- Built & shipped\n");

  const j = join(process.env.OPENAPPLY_HOME!, "r.json");
  writeFileSync(j, JSON.stringify({ basics: { name: "Al Smith", email: "a@b.co", location: { city: "Austin", region: "TX" } },
    work: [{ name: "Foo", position: "Dev", startDate: "2020-03-01", highlights: ["Did x"] }], education: [{ institution: "MIT", studyType: "BS", area: "CS", endDate: "2019" }], skills: [{ name: "L", keywords: ["Go"] }] }));
  const r = await imp.importResume(j);
  assert.equal(r.experience[0].start, "Mar 2020");
  assert.equal(r.experience[0].end, "Present");
  assert.equal(r.education[0].degree, "BS in CS");
  assert.deepEqual(r.skills, ["Go"]);
});

test("normalizeResume coerces sloppy agent input and rejects the unusable", () => {
  const r = profile.normalizeResume({
    name: " Jane Doe ", contact: null, summary: null,
    experience: [{ company: "Acme", title: "Eng", bullets: [1, "two", null] }, { company: "B", title: "C" }],
    projects: [{ name: "P" }],
  });
  assert.equal(r.name, "Jane Doe");
  assert.deepEqual(r.contact, {});
  assert.equal(r.summary, undefined);
  assert.deepEqual(r.education, []);
  assert.deepEqual(r.experience[0].bullets, ["1", "two", "null"]);
  assert.deepEqual(r.experience[1].bullets, []);
  assert.deepEqual(r.projects, [{ name: "P", description: undefined, link: undefined, bullets: [] }]);
  assert.deepEqual(profile.normalizeResume({ name: "A", skills: "a, b" }).skills, ["a", "b"]);
  assert.throws(() => profile.normalizeResume({ experience: [] }), (e: any) => e instanceof Error && !(e instanceof TypeError) && /name/.test(e.message));
  assert.throws(() => profile.normalizeResume({ name: "A", experience: [{ company: null, title: "x" }] }), (e: any) => !(e instanceof TypeError) && /company/.test(e.message));
  assert.throws(() => profile.normalizeResume({ name: "A", experience: [{ company: "x" }] }), /title/);
  assert.throws(() => profile.normalizeResume("nope"), /object/);
  assert.throws(() => profile.normalizeResume(null), /object/);
});

test("saveResume normalizes before writing", () => {
  profile.saveResume({ name: "Sloppy", experience: [{ company: "X", title: "Y", bullets: 5 }] } as any);
  const r = profile.loadResume()!;
  assert.deepEqual([r.contact, r.education, r.experience[0].bullets], [{}, [], []]);
});

test("saveProfile turns plain-string target lists into arrays", () => {
  const p = profile.saveProfile({ targets: { titles: "PM" as any, keywords: "ai, agents ,  ", locations: ["NYC"], seniority: "senior" as any } });
  assert.deepEqual(p.targets?.titles, ["PM"]);
  assert.deepEqual(p.targets?.keywords, ["ai", "agents"]);
  assert.deepEqual(p.targets?.locations, ["NYC"]);
  assert.deepEqual(p.targets?.seniority, ["senior"]);
});

test("saveProfile validates education and keeps it as typed entries", () => {
  const p = profile.saveProfile({ education: [{ school: " Riverside University ", degree: "Bachelor's Degree", discipline: "Information Science", endYear: "2023" as unknown as number }] });
  assert.deepEqual(p.education, [{ school: "Riverside University", degree: "Bachelor's Degree", discipline: "Information Science", endYear: 2023 }]);
  assert.deepEqual(profile.loadProfile()!.education, p.education);
  assert.equal(profile.saveProfile({ phone: "2" }).education?.length, 1, "other patches leave education alone");
  assert.throws(() => profile.saveProfile({ education: [{ school: "" }] }), /education\[0\] needs a school/);
  assert.throws(() => profile.saveProfile({ education: [{ school: "X", endYear: 23 }] }), /endYear must be a four-digit year/);
  assert.throws(() => profile.saveProfile({ education: "Riverside" as never }), /education must be a list/);
  assert.equal(profile.loadProfile()!.education?.[0].school, "Riverside University", "a rejected patch changes nothing");
});
