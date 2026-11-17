import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-match-"));
const db = await import("../src/db.js");
const m = await import("../src/match.js");
const profile = await import("../src/profile.js");

const job = (id: string, title: string, o: any = {}) => ({
  id: `greenhouse:x:${id}`, ats: "greenhouse" as const, boardSlug: "x", company: o.company ?? "Co", title,
  location: "New York, NY", remote: false, description: "We build things with TypeScript and React.", url: "u", applyUrl: "u",
  postedAt: new Date().toISOString(), ...o,
});
const full = (j: any) => ({ ...j, firstSeen: "", lastSeen: "", open: true });

test("scoring: title, keywords, location, exclusions, seniority, salary", () => {
  const p = { firstName: "J", lastName: "D", email: "e", targets: {
    titles: ["Forward Deployed Engineer"], keywords: ["typescript", "react"], locations: ["New York"], remoteOk: true,
    excludeCompanies: ["Evil"], excludeKeywords: ["clearance"], minSalary: 150000, seniority: ["senior"] } };
  const good = m.scoreJob(full(job("1", "Senior Forward Deployed Engineer", { salaryMax: 200000 })), p, undefined);
  const wrongTitle = m.scoreJob(full(job("2", "Account Executive")), p, undefined);
  assert.ok(good.score >= 85, String(good.score));
  assert.ok(good.score > wrongTitle.score + 30);
  assert.ok(good.reasons.some(r => /Title matches/.test(r)));
  assert.equal(m.scoreJob(full(job("3", "Forward Deployed Engineer", { company: "Evil Corp" })), p, undefined).score, 0);
  assert.equal(m.scoreJob(full(job("4", "Forward Deployed Engineer", { description: "Needs clearance" })), p, undefined).score, 0);
  const junior = m.scoreJob(full(job("5", "Junior Forward Deployed Engineer")), p, undefined);
  assert.ok(junior.reasons.some(r => /Seniority mismatch/.test(r)));
  const low = m.scoreJob(full(job("6", "Senior Forward Deployed Engineer", { salaryMax: 90000 })), p, undefined);
  assert.ok(low.score < good.score - 20 && low.reasons.some(r => /floor/.test(r)));
  const far = m.scoreJob(full(job("7", "Senior Forward Deployed Engineer", { location: "Berlin" })), p, undefined);
  assert.ok(far.score < good.score - 10);
});

test("listMatches searches per target title and sorts", () => {
  db.upsertJobs([job("a", "Forward Deployed Engineer"), job("b", "Solutions Engineer", { description: "Python only" }),
    job("c", "Office Manager", { description: "Run the office" })]);
  for (let i = 0; i < 300; i++) db.upsertJobs([job(`f${i}`, `Warehouse Associate ${i}`, { description: "boxes" })]);
  profile.saveProfile({ firstName: "J", lastName: "D", email: "e", targets: { titles: ["Forward Deployed Engineer", "Solutions Engineer"], keywords: ["typescript"] } });
  const r = m.listMatches({ limit: 5 });
  assert.equal(r[0].job.title, "Forward Deployed Engineer");
  assert.ok(r.some(x => x.job.title === "Solutions Engineer"));
  assert.ok(!r.some(x => x.job.title === "Office Manager"));
  assert.ok(r.length <= 5);
  assert.equal(m.listMatches({ query: "warehouse", minScore: 0, limit: 1 }).length, 1);
});

test("scoreJob is defensive about resumes and targets with missing arrays", () => {
  const j = full(job("def", "Engineer"));
  const sloppyResume: any = { name: "J", experience: [{ company: "A", title: "Engineer" }, { company: "B", title: "Dev", bullets: null }] };
  assert.doesNotThrow(() => m.scoreJob(j, { firstName: "J", lastName: "D", email: "e", targets: { titles: "PM" as any, keywords: null as any } }, sloppyResume));
  assert.doesNotThrow(() => m.scoreJob(j, undefined, { name: "J" } as any));
});

test("location: off-target cities and foreign-only remote sink; title words must be in order", () => {
  const prof = { firstName: "A", lastName: "B", email: "a@b.c",
    targets: { titles: ["Product Engineer"], locations: ["New York", "Remote"], remoteOk: true } } as any;
  const mk = (id: string, title: string, location: string, remote: boolean) => ({
    id, ats: "greenhouse", boardSlug: "x", company: "X", title, location, remote, description: "",
    url: "u", applyUrl: "u", firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), open: true,
    descriptionComplete: true,
  }) as any;
  const s = (j: any) => m.scoreJob(j, prof, undefined).score;
  const nyc = s(mk("1", "Product Engineer", "New York, NY", false));
  const usRemote = s(mk("2", "Product Engineer", "Remote (US)", true));
  const ukRemote = s(mk("3", "Product Engineer", "UK - Remote", true));
  const berlin = s(mk("4", "Product Engineer", "Berlin, Germany", false));
  const security = s(mk("5", "Product Security Engineer", "New York, NY", false));
  assert.ok(nyc >= usRemote && usRemote > ukRemote + 30, `${nyc} ${usRemote} ${ukRemote}`);
  assert.ok(nyc > berlin + 30, `${nyc} ${berlin}`);
  assert.ok(nyc > security, `${nyc} ${security}`);
});
