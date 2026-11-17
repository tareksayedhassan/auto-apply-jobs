import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-workday-"));
process.env.OPENAPPLY_WORKDAY_GAP_MS = "0"; // recorded fixtures: no politeness pause needed
const wd = await import("../src/sources/workday.js");
const { NotFoundError } = await import("../src/sources/http.js");
const { BOARD_SOURCES, loadBoards } = await import("../src/sources/index.js");
const { sync } = await import("../src/sync.js");
const { fetchFullDescription, getJobFull } = await import("../src/details.js");
const { discoverCompany, workdayBoardsFromIndex } = await import("../src/discover.js");
const engine = await import("../src/apply/engine.js");
const db = await import("../src/db.js");

/** Recorded from nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite on 2026-11-02 (facets and similarJobs dropped). */
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/sources/${name}.json`, import.meta.url), "utf8"));
const SLUG = "nvidia.wd5/NVIDIAExternalCareerSite";
const CXS = "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; process.env.OPENAPPLY_WORKDAY_GAP_MS = "0"; });

type Call = { url: string; method: string; body?: any; at: number };
let calls: Call[] = [];
/** pages(offset) answers each list POST; detail(url) answers GETs. A number is an HTTP status. */
function mock(pages: (offset: number, body: any) => unknown, detail: (url: string) => unknown = () => 404) {
  calls = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, at: Date.now() });
    const out = body ? pages(Number(body.offset), body) : detail(url);
    if (typeof out === "number") return new Response(JSON.stringify({ errorCode: "x", httpStatus: out }), { status: out });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** Two recorded pages; `total` overrides the first page's count (Workday sends total only on offset 0). */
const twoPages = (total = 40) => (offset: number) =>
  offset === 0 ? { ...fx("workday-jobs"), total } : offset === 20 ? fx("workday-jobs-page2") : { total: 0, jobPostings: [] };

test("parseWorkdayUrl: career site, locale, job and CXS URLs give tenant.host/site; anything else is undefined", () => {
  const cases: Array<[string, string | undefined]> = [
    ["https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite", SLUG],
    ["https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/X_JR1", SLUG],
    ["https://NVIDIA.WD5.myworkdayjobs.com/NVIDIAExternalCareerSite/details/X_JR1?q=1", SLUG],
    ["https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs", SLUG],
    ["nvidia.wd5.myworkdayjobs.com/fr-CA/NVIDIAExternalCareerSite", SLUG],
    ["https://salesforce.wd12.myworkdayjobs.com/External_Career_Site", "salesforce.wd12/External_Career_Site"],
    ["https://acme.myworkdayjobs.com/Careers", "acme/Careers"],
    ["https://nvidia.wd5.myworkdayjobs.com/", undefined],
    ["https://nvidia.wd5.myworkdayjobs.com/en-US", undefined],
    ["https://boards.greenhouse.io/stripe", undefined],
    ["https://evil.com/nvidia.wd5.myworkdayjobs.com/X", undefined],
    ["not a url", undefined],
  ];
  for (const [url, slug] of cases) assert.equal(wd.parseWorkdayUrl(url), slug, url);
  assert.deepEqual(wd.workdayParts(SLUG), { host: "nvidia.wd5.myworkdayjobs.com", tenant: "nvidia", site: "NVIDIAExternalCareerSite" });
  assert.equal(wd.workdayParts("no-slash"), undefined);
});

test("workdaySlugsIn: every distinct tenant/site named in free text, first company label wins", () => {
  const text = `Apply at https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/A_JR1 or
    NVIDIA | https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
    "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/B" and https://jobs.lever.co/plaid`;
  assert.deepEqual(wd.workdaySlugsIn(text), [SLUG, "salesforce.wd12/External_Career_Site"]);
});

test("postedOnToIso: Workday's relative posted labels become dates", () => {
  const now = new Date("2026-11-02T15:00:00Z");
  assert.equal(wd.postedOnToIso("Posted Today", now)?.slice(0, 10), "2026-11-02");
  assert.equal(wd.postedOnToIso("Posted Yesterday", now)?.slice(0, 10), "2026-11-01");
  assert.equal(wd.postedOnToIso("Posted 5 Days Ago", now)?.slice(0, 10), "2026-10-28");
  assert.equal(wd.postedOnToIso("Posted 30+ Days Ago", now)?.slice(0, 10), "2026-10-03");
  assert.equal(wd.postedOnToIso("", now), undefined);
  assert.equal(wd.postedOnToIso("Recently", now), undefined);
});

test("upsert: a Workday posted date only moves earlier, so \"30+ Days Ago\" never drags a known date forward", () => {
  const row = (postedAt: string) => ({ id: "workday:acme.wd1/Careers:PM_R1", ats: "workday" as const, boardSlug: "acme.wd1/Careers",
    company: "Acme", title: "PM", location: "NYC", remote: false, description: "PM.", url: "https://acme.wd1.myworkdayjobs.com/Careers/job/NYC/PM_R1",
    applyUrl: "https://acme.wd1.myworkdayjobs.com/Careers/job/NYC/PM_R1", postedAt });
  const today = wd.postedOnToIso("Posted Today", new Date("2026-11-02T15:00:00Z"))!;
  db.upsertJobs([row(today)]);
  db.upsertJobs([row(wd.postedOnToIso("Posted 30+ Days Ago", new Date("2026-12-05T15:00:00Z"))!)]); // 2026-11-05
  assert.equal(db.getJob(row(today).id)!.postedAt?.slice(0, 10), "2026-11-02");
  const old = { ...row(wd.postedOnToIso("Posted 30+ Days Ago", new Date("2026-11-02T15:00:00Z"))!), id: "workday:acme.wd1/Careers:Old_R2" };
  db.upsertJobs([old]);
  db.upsertJobs([{ ...old, postedAt: wd.postedOnToIso("Posted 30+ Days Ago", new Date("2026-11-03T15:00:00Z"))! }]);
  assert.equal(db.getJob(old.id)!.postedAt?.slice(0, 10), "2026-10-03", "a year-old role does not stay exactly 30 days old");
  db.upsertJobs([{ ...old, postedAt: undefined as any }]);
  assert.equal(db.getJob(old.id)!.postedAt?.slice(0, 10), "2026-10-03");
});

test("fetchBoard: pages the CXS list 20 at a time with POST bodies and normalizes the rows", async () => {
  mock(twoPages(40));
  const jobs = await BOARD_SOURCES.workday!(SLUG);
  assert.equal(jobs.length, 40);
  assert.deepEqual(calls.map(c => [c.method, c.url, c.body.limit, c.body.offset]),
    [["POST", `${CXS}/jobs`, 20, 0], ["POST", `${CXS}/jobs`, 20, 20]]);
  assert.equal((jobs as any).truncated, undefined);
  for (const j of jobs) {
    assert.ok(j.id.startsWith(`workday:${SLUG}:`), j.id);
    assert.equal(j.ats, "workday"); assert.equal(j.boardSlug, SLUG);
    assert.ok(j.url.startsWith("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/"), j.url);
    assert.equal(j.applyUrl, j.url);
    assert.equal(j.descriptionComplete, false); // the list has no posting text
    assert.ok(j.title && j.location && j.postedAt);
  }
  const first = jobs[0];
  assert.equal(first.id, `workday:${SLUG}:Senior-System-Software-Engineer--CUDA-Driver-for-Windows_JR2022474`);
  assert.equal(first.title, "Senior System Software Engineer, CUDA Driver for Windows");
  assert.equal(first.company, "Nvidia"); // no company on the list: tenant name until the board entry's name replaces it
  assert.match(first.location, /US CA Santa Clara/); // "3 Locations" says nothing: the path names the main one
  assert.match(first.location, /2 more/);
  assert.match(first.description, /^Senior System Software Engineer, CUDA Driver for Windows\. /);
  assert.doesNotMatch(first.description, /Nvidia/, "the tenant label is not the company: no stub text names it");
  assert.match(first.description, /JR2022474/);
  const remote = jobs.find(j => j.location === "Vietnam, Remote")!;
  assert.equal(remote.remote, true);
  assert.equal(jobs.find(j => j.location === "US, TX, Austin")!.remote, false);
});

test("fetchBoard: Workday's total ceiling and the page cap flag the list as truncated, duplicates are dropped", async () => {
  const page = fx("workday-jobs");
  mock(offset => ({ total: offset === 0 ? 2000 : 0, jobPostings: page.jobPostings.map((j: any, i: number) => ({ ...j, externalPath: `/job/X/Role_${offset + i}` })) }));
  const jobs = await BOARD_SOURCES.workday!(SLUG);
  assert.equal(calls.length, wd.MAX_PAGES);
  assert.equal(jobs.length, wd.MAX_PAGES * 20);
  assert.equal((jobs as any).truncated, true);
  assert.equal(Object.keys(jobs).includes("truncated"), false);

  // a short tenant whose pages overlap (a new posting shifted the order): one row per posting
  mock(offset => offset === 0 ? { ...page, total: 25 } : { total: 0, jobPostings: page.jobPostings.slice(0, 5) });
  const dedup = await BOARD_SOURCES.workday!(SLUG);
  assert.equal(dedup.length, 20);
  assert.equal((dedup as any).truncated, true); // saw 20 of the 25 Workday counted

  // no total at all: page until a short page, never stop after the first
  mock(twoPages(0));
  const untold = await BOARD_SOURCES.workday!(SLUG);
  assert.equal(calls.length, 3);
  assert.equal(untold.length, 40);
  assert.equal((untold as any).truncated, undefined);
  mock(offset => ({ jobPostings: page.jobPostings.map((j: any, i: number) => ({ ...j, externalPath: `/job/X/Role_${offset + i}` })) }));
  assert.equal(((await BOARD_SOURCES.workday!(SLUG)) as any).truncated, true, "untold and stopped by the page cap");
});

test("fetchBoard: wrong site (404) and wrong host or tenant (422) are not-found, a bad shape throws", async () => {
  mock(() => 404);
  await assert.rejects(BOARD_SOURCES.workday!(SLUG), NotFoundError);
  mock(() => 422);
  await assert.rejects(BOARD_SOURCES.workday!(SLUG), NotFoundError);
  assert.equal(calls.length, 1, "a 422 is not retried");
  mock(() => ({ errorCode: "maintenance" }));
  await assert.rejects(BOARD_SOURCES.workday!(SLUG), /unexpected response shape/);
  mock(() => ({ total: 0, jobPostings: [] }));
  assert.deepEqual(await BOARD_SOURCES.workday!(SLUG), []);
  await assert.rejects(BOARD_SOURCES.workday!("not-a-workday-slug"), /workday slug/);
});

test("fetchBoard: a 429 is retried after a pause, requests are spaced by the politeness gap", async () => {
  let n = 0;
  mock(offset => (offset === 0 && n++ === 0 ? 429 : twoPages(40)(offset)));
  const jobs = await BOARD_SOURCES.workday!(SLUG);
  assert.equal(jobs.length, 40);
  assert.equal(calls.length, 3);

  process.env.OPENAPPLY_WORKDAY_GAP_MS = "60";
  mock(twoPages(40));
  await Promise.all([BOARD_SOURCES.workday!(SLUG), BOARD_SOURCES.workday!(SLUG)]); // two boards in one sync share the gate
  const at = calls.map(c => c.at).sort((a, b) => a - b);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 50, `gap ${at[i] - at[i - 1]}ms`);
});

test("sync: a Workday board takes the board entry's company name and closes postings that left", async () => {
  mock(twoPages(40));
  const r = await sync({ boards: [{ ats: "workday", slug: SLUG, company: "NVIDIA" }], feeds: false });
  assert.equal(r.ok, 1); assert.equal(r.jobsSeen, 40); assert.equal(r.newJobs, 40);
  assert.equal(db.searchJobs({ company: "NVIDIA" }).total, 40);
  assert.equal(db.searchJobs({ query: "CUDA", ats: "workday" }).total > 0, true);

  mock(offset => (offset === 0 ? { ...fx("workday-jobs"), total: 20 } : { total: 0, jobPostings: [] }));
  const r2 = await sync({ boards: [{ ats: "workday", slug: SLUG, company: "NVIDIA" }], feeds: false });
  assert.equal(r2.closed, 20);
  assert.equal(db.searchJobs({ company: "NVIDIA" }).total, 20);
});

test("sync: a truncated Workday list closes only rows no sync has seen for a week", async () => {
  const slug = "big.wd1/Careers";
  const page = fx("workday-jobs");
  const capped = () => mock(offset => ({ total: offset === 0 ? 2000 : 0, jobPostings: page.jobPostings.map((j: any, i: number) => ({ ...j, externalPath: `/job/X/Role_${offset + i}` })) }));
  capped();
  const r = await sync({ boards: [{ ats: "workday", slug, company: "Big" }], feeds: false });
  assert.equal(r.jobsSeen, wd.MAX_PAGES * 20);
  const stale = `workday:${slug}:Filled_R1`, recent = `workday:${slug}:Recent_R2`;
  const row = (id: string) => ({ id, ats: "workday" as const, boardSlug: slug, company: "Big", title: "Eng", location: "NYC",
    remote: false, description: "Eng.", url: `https://big.wd1.myworkdayjobs.com/Careers/job/NYC/${id}`, applyUrl: "" });
  db.upsertJobs([row(stale), row(recent)]);
  db.getDb().prepare("UPDATE jobs SET last_seen = ? WHERE id = ?").run(new Date(Date.now() - 8 * 86_400_000).toISOString(), stale);
  db.getDb().prepare("UPDATE jobs SET last_seen = ? WHERE id = ?").run(new Date(Date.now() - 2 * 86_400_000).toISOString(), recent);

  capped();
  const r2 = await sync({ boards: [{ ats: "workday", slug, company: "Big" }], feeds: false });
  assert.equal(r2.closed, 1);
  assert.equal(db.getJob(stale)!.open, false, "filled a week ago and never seen since: closed");
  assert.equal(db.getJob(recent)!.open, true, "may sit past the 1,000-role cap: kept");
  assert.equal(db.searchJobs({ company: "Big" }).total, wd.MAX_PAGES * 20 + 1);
});

test("fetchFullDescription and getJobFull: one CXS posting GET, plain text, stored; a 404 closes the job", async () => {
  mock(twoPages(40));
  await sync({ boards: [{ ats: "workday", slug: SLUG, company: "NVIDIA" }], feeds: false });
  const id = `workday:${SLUG}:Senior-System-Software-Engineer--CUDA-Driver-for-Windows_JR2022474`;
  const job = db.getJob(id)!;
  assert.equal(job.descriptionComplete, false);

  // the detail GET uses the posting's own path (location segment included), exactly what the career site requests
  const detailUrl = `${CXS}/job/US-CA-Santa-Clara/Senior-System-Software-Engineer--CUDA-Driver-for-Windows_JR2022474`;
  mock(() => 500, url => (url === detailUrl ? fx("workday-job-detail") : 404));
  const text = await fetchFullDescription(job);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [["GET", detailUrl]]);
  assert.ok(text!.length > 3000 && !/<[a-z]|&#39;|&amp;/.test(text!), text!.slice(0, 200));
  assert.match(text!, /What you.ll be doing/);
  assert.match(text!, /Locations: US, CA, Santa Clara; US, TX, Austin; US, Remote/);
  assert.match(text!, /Time type: Full time/);

  const full = await getJobFull(id);
  assert.equal(full!.descriptionComplete, true);
  assert.equal(db.getJob(id)!.descriptionComplete, true);

  const gone = `workday:${SLUG}:DSX-Energy-Engineer_JR2028854`;
  assert.ok(db.getJob(gone), "fixture row present");
  mock(() => 500, () => 404);
  const g = await getJobFull(gone);
  assert.equal(g!.open, false);
  assert.equal(db.getJob(gone)!.open, false);
});

test("loadBoards reads a workday list from the user's boards.json", () => {
  writeFileSync(join(process.env.OPENAPPLY_HOME!, "boards.json"), JSON.stringify({ workday: [{ slug: SLUG, company: "NVIDIA" }] }));
  assert.ok(loadBoards().some(b => b.ats === "workday" && b.slug === SLUG && b.company === "NVIDIA"));
});

test("bundled data/boards.json: every Workday entry loads with the curated company name", () => {
  const wdBoards = loadBoards().filter(b => b.ats === "workday");
  assert.ok(wdBoards.length >= 27, `expected the 27 probed tenants, got ${wdBoards.length}`);
  const seen = new Set<string>();
  for (const b of wdBoards) {
    assert.ok(!seen.has(b.slug), `duplicate ${b.slug}`);
    seen.add(b.slug);
    assert.ok(wd.parseWorkdayUrl(`https://${b.slug.split("/")[0]}.myworkdayjobs.com/${b.slug.split("/").slice(1).join("/")}`) === b.slug, `${b.slug} is a valid <tenant>.<wdN>/<site> slug`);
    assert.ok(b.company && b.company.trim() === b.company, `${b.slug} has a company name`);
  }
  // the names agree with the curated "Company | URL" candidate list the entries were probed from
  const names = new Map<string, string>();
  for (const line of readFileSync(new URL("../scripts/seed-candidates/workday.txt", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^(.+?) \| (\S+)$/);
    const slug = m && wd.parseWorkdayUrl(m[2]);
    if (m && slug) names.set(slug, m[1]);
  }
  for (const b of wdBoards) assert.equal(b.company, names.get(b.slug), `${b.slug} is named in workday.txt`);
});

test("discoverCompany: a Workday career-site URL costs one request; the curated company name, never the tenant label", async () => {
  mock(twoPages(40));
  const hits = await discoverCompany("https://fmr.wd1.myworkdayjobs.com/FidelityCareers");
  assert.deepEqual(hits.map(h => [h.ats, h.slug, h.company, h.jobCount]), [["workday", "fmr.wd1/FidelityCareers", "Fidelity Investments", 40]]);
  assert.equal(calls.length, 1, "the count comes from the first page's total; sync pages the board afterwards");
  assert.ok(calls[0].url.startsWith("https://fmr.wd1.myworkdayjobs.com/wday/cxs/fmr/FidelityCareers/jobs"), "no other ATS probed");

  mock(twoPages(40));
  const [unknown] = await discoverCompany("https://acme.wd1.myworkdayjobs.com/en-US/AcmeCareers");
  assert.equal(unknown.company, undefined, "no curated name: none, so addUserBoards writes a bare slug and overrides nothing");

  mock(() => 422);
  assert.deepEqual(await discoverCompany("https://nobody.wd5.myworkdayjobs.com/External"), []);
  mock(() => ({ errorCode: "maintenance" })); // anything but not-found surfaces instead of "no board"
  await assert.rejects(discoverCompany("https://fmr.wd1.myworkdayjobs.com/FidelityCareers"), /unexpected response shape/);
});

test("workdayBoardsFromIndex: tenants named in indexed postings' links or text, minus boards already listed", () => {
  const base = { location: "NYC", remote: false, description: "d" };
  db.upsertJobs([
    { ...base, id: "remotive:remotive:wd1", ats: "remotive", boardSlug: "remotive", company: "Acme Corp", title: "PM",
      url: "https://remotive.com/x", applyUrl: "https://acme.wd1.myworkdayjobs.com/en-US/AcmeCareers/job/NYC/PM_R1" },
    { ...base, id: "hn:hn:wd2", ats: "hn", boardSlug: "hn", company: "Globex", title: "Eng", url: "https://news.ycombinator.com/item?id=1",
      applyUrl: "https://news.ycombinator.com/item?id=1", description: "Apply: https://globex.wd3.myworkdayjobs.com/Globex_External/job/x" },
    { ...base, id: "remotive:remotive:wd3", ats: "remotive", boardSlug: "remotive", company: "NVIDIA", title: "SWE",
      url: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/X_JR9", applyUrl: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/X_JR9" },
  ]);
  const asked = new Set(["acme.wd1/AcmeCareers", "globex.wd3/Globex_External", SLUG]); // other tests sync boards of their own
  const found = workdayBoardsFromIndex().filter(b => asked.has(b.slug));
  assert.deepEqual(found.map(b => [b.ats, b.slug, b.company]).sort(), [
    ["workday", "acme.wd1/AcmeCareers", "Acme Corp"],
    ["workday", "globex.wd3/Globex_External", "Globex"],
  ]); // NVIDIA is already in the user's boards.json
});

test("Workday forms are refused before any browser opens: inspect and fill say apply in your own browser", async () => {
  const base = { company: "Acme", title: "PM", location: "NYC", remote: false, description: "PM." };
  const url = "https://acme.wd1.myworkdayjobs.com/en-US/AcmeCareers/job/NYC/PM_R7";
  const ids = ["workday:acme.wd1/AcmeCareers:PM_R7", "remotive:remotive:wdjobs", "remotive:remotive:wdsite"];
  db.upsertJobs([
    { ...base, id: ids[0], ats: "workday", boardSlug: "acme.wd1/AcmeCareers", url, applyUrl: url },
    // feed roles whose apply link is a Workday form: refused on the URL, not the ats
    { ...base, id: ids[1], ats: "remotive", boardSlug: "remotive", url: "https://remotive.com/x", applyUrl: url },
    { ...base, id: ids[2], ats: "remotive", boardSlug: "remotive", url: "https://remotive.com/y", applyUrl: "https://wd3.myworkdaysite.com/recruiting/acme/External/job/NYC/PM_R8" },
  ]);
  for (const id of ids) {
    await assert.rejects(engine.inspectForm(id), /does not fill Workday forms/, id);
    await assert.rejects(engine.fillForm(id), /does not fill Workday forms/, id);
    assert.equal(engine.canSubmit(id), false);
  }
});
