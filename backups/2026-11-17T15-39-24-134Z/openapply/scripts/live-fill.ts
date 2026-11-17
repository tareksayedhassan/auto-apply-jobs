/**
 * Live FILL-ONLY smoke test against a real application form. It NEVER submits:
 * submitForm is not imported and no submit button is ever clicked.
 *
 *   OPENAPPLY_HEADLESS=1 npx tsx scripts/live-fill.ts <applyUrl>
 *
 * Uses a throwaway OPENAPPLY_HOME and a fictional profile ("Test Person", test@example.com).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
if (!url) { console.error("usage: tsx scripts/live-fill.ts <applyUrl>"); process.exit(1); }
process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-live-"));

const db = await import("../src/db.js");
const { paths, packDir } = await import("../src/paths.js");
const { inspectForm, fillForm, closeBrowser } = await import("../src/apply/engine.js");

const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
writeFileSync(paths.profile, JSON.stringify({
  firstName: "Test", lastName: "Person", email: "test@example.com", phone: "+1 555 010 0000",
  location: "Brooklyn, NY", linkedin: "https://www.linkedin.com/in/test-person", github: "https://github.com/test-person",
  website: "https://example.com", workAuthorizedUS: true, needsSponsorship: false, willingToRelocate: true,
}));
writeFileSync(paths.resume, JSON.stringify({
  name: "Test Person", contact: { email: "test@example.com" }, education: [],
  experience: [{ company: "Example Corp", title: "Solutions Engineer", bullets: [] }],
}));
const id = `other:live:${Date.now()}`;
db.upsertJobs([{ id, ats: "other", boardSlug: "live", company: "Live", title: "Smoke test", location: "",
  remote: false, description: "", url, applyUrl: url }]);
const dir = packDir(id);
writeFileSync(join(dir, "resume.pdf"), PDF);
writeFileSync(join(dir, "pack.json"), JSON.stringify({ jobId: id, resume: { name: "Test Person", contact: {}, experience: [], education: [] },
  answers: {}, resumePdf: join(dir, "resume.pdf"), warnings: [], createdAt: new Date().toISOString() }));

try {
  const ins = await inspectForm(id);
  console.log(`adapter=${ins.adapter} fields=${ins.fields.length} captcha=${ins.captchaDetected}`);
  for (const f of ins.fields) {
    console.log(`  ${f.required ? "*" : " "} [${f.type}] ${f.label.slice(0, 70)}${f.options ? ` (${f.options.length} opts)` : ""} => ${f.suggested ?? "-"}${f.source ? ` [${f.source}]` : ""}`);
  }
  console.log(`missing (agent must answer): ${ins.missing.length}`);
  const res = await fillForm(id);
  const failed = res.skipped.filter(s => s.reason.startsWith("fill failed"));
  const required = ins.fields.filter(f => f.required);
  const reqFilled = required.filter(f => res.filled.some(x => x.key === f.key)).length;
  console.log(`filled ${res.filled.length}/${ins.fields.length} fields; required ${reqFilled}/${required.length}; fill errors ${failed.length}`);
  for (const s of failed) console.log(`  fill failed: ${s.label}: ${s.reason}`);
  console.log(`screenshot: ${res.screenshot}`);
  console.log("NOT submitted (fill-only smoke).");
} finally {
  await closeBrowser();
}
