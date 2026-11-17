/**
 * Re-render saved cover letters from their pack.json text (no LLM), e.g. after a renderer change.
 * The old PDF is kept once as cover-letter.html-render.pdf. Run: npx tsx scripts/rerender-cover-letters.ts [jobId ...]
 * With no ids it does every pack that has a cover letter.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getJob } from "../src/db.js";
import { packDir, paths } from "../src/paths.js";
import { closePdfBrowser } from "../src/pdf.js";
import { loadProfile } from "../src/profile.js";
import { loadPack, renderCoverLetter } from "../src/tailor.js";
import type { Job } from "../src/types.js";

const ids = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(paths.packs).map(d => join(paths.packs, d, "pack.json")).filter(existsSync)
    .map(f => JSON.parse(readFileSync(f, "utf8"))).filter(p => p.coverLetter).map(p => p.jobId as string);

const profile = loadProfile();
for (const id of ids) {
  const pack = loadPack(id);
  if (!pack?.coverLetter) { console.log(`skip ${id}: no cover letter`); continue; }
  const dir = packDir(id);
  const old = join(dir, "cover-letter.pdf"), backup = join(dir, "cover-letter.html-render.pdf");
  if (existsSync(old) && !existsSync(backup)) copyFileSync(old, backup);
  const job = getJob(id) ?? ({ company: "" } as Job);
  const r = await renderCoverLetter(pack.coverLetter, profile, job, dir);
  const warnings = [...pack.warnings.filter(w => !/^Cover letter render/.test(w)), ...r.warnings];
  if (JSON.stringify(warnings) !== JSON.stringify(pack.warnings) || pack.coverLetterPdf !== r.pdf)
    writeFileSync(join(dir, "pack.json"), JSON.stringify({ ...pack, warnings, coverLetterPdf: r.pdf }, null, 2) + "\n");
  console.log(`${id}: ${r.warnings.length ? r.warnings.join("; ") : "LaTeX, 1 page"}`);
}
await closePdfBrowser();
