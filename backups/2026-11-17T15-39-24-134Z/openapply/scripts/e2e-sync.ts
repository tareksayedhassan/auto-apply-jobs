import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-e2e-"));
const { sync } = await import("../src/sync.js");
const db = await import("../src/db.js");
const boards = [
  ["greenhouse","airbnb"],["greenhouse","stripe"],["greenhouse","anthropic"],["lever","palantir"],["lever","plaid"],
  ["ashby","ramp"],["ashby","notion"],["smartrecruiters","ServiceNow"],["recruitee","bunq"],["greenhouse","definitely-not-a-board-xyz"],
].map(([ats, slug]) => ({ ats: ats as any, slug }));
const r = await sync({ boards, onProgress: (d, t) => process.stdout.write(`\r${d}/${t}`) });
console.log("\n", JSON.stringify(r, null, 1));
const res = db.searchJobs({ query: "engineer", limit: 5 });
console.log("engineer total", res.total);
for (const j of res.jobs) console.log(" ", j.id, "|", j.company, "|", j.title, "|", j.location);
console.log(db.searchJobs({ query: "engineer", remote: true, minSalary: 150000, limit: 3 }).jobs.map(j => `${j.company}: ${j.title} ${j.salaryMin}-${j.salaryMax}`));
console.log(db.jobStats());
