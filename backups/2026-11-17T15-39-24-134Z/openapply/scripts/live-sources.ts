/** Live check: one board per ATS plus every feed. Run: npx tsx scripts/live-sources.ts */
import { BOARD_SOURCES, FEED_SOURCES } from "../src/sources/index.js";
import type { NormalizedJob } from "../src/types.js";

const BOARDS: Array<[string, string]> = [
  ["greenhouse", "airbnb"], ["lever", "palantir"], ["ashby", "ramp"],
  ["workable", "huggingface"], ["smartrecruiters", "ServiceNow"], ["recruitee", "bunq"], ["workday", "zoom.wd5/Zoom"],
];

function report(label: string, jobs: NormalizedJob[], ms: number) {
  const withDesc = jobs.filter(j => j.description.length > 50).length;
  const withSalary = jobs.filter(j => j.salaryMin).length;
  const s = jobs[0];
  console.log(`${label.padEnd(24)} ${String(jobs.length).padStart(5)} jobs  desc ${withDesc}  salary ${withSalary}  ${ms}ms`);
  if (s) console.log(`   e.g. ${s.id} | ${s.company} | ${s.title} | ${s.location} | remote=${s.remote} | ${s.url}`);
}

let bad = 0;
await Promise.all([
  ...BOARDS.map(async ([ats, slug]) => {
    const t = Date.now();
    try { const jobs = await (BOARD_SOURCES as any)[ats](slug); report(`${ats}/${slug}`, jobs, Date.now() - t); if (!jobs.length) bad++; }
    catch (e) { bad++; console.log(`${ats}/${slug} FAILED: ${e}`); }
  }),
  ...Object.entries(FEED_SOURCES).map(async ([name, fn]) => {
    const t = Date.now();
    try { const jobs = await fn!(); report(`feed ${name}`, jobs, Date.now() - t); if (!jobs.length) bad++; }
    catch (e) { bad++; console.log(`feed ${name} FAILED: ${e}`); }
  }),
]);
process.exit(bad ? 1 : 0);
