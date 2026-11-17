import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-src-"));
const { getJson, NotFoundError } = await import("../src/sources/http.js");
const { BOARD_SOURCES, FEED_SOURCES, loadBoards } = await import("../src/sources/index.js");
const { sync } = await import("../src/sync.js");
const { slugCandidates, addUserBoards } = await import("../src/discover.js");
const db = await import("../src/db.js");

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/sources/${name}.json`, import.meta.url), "utf8"));

/** Route URL substrings to fixtures (or a status code). Unmatched URLs 404. */
type Route = [string, unknown | number];
const realFetch = globalThis.fetch;
let calls: string[] = [];
function mock(routes: Route[]) {
  calls = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const hit = routes.find(([k]) => url.includes(k));
    const body = hit?.[1];
    if (!hit || body === 404) return new Response("Not Found", { status: 404 });
    if (typeof body === "number") return new Response("err", { status: body });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

function sane(jobs: any[], ats: string, slug: string) {
  assert.ok(jobs.length > 0);
  for (const j of jobs) {
    assert.ok(j.id.startsWith(`${ats}:${slug}:`), j.id);
    assert.equal(j.ats, ats);
    assert.equal(j.boardSlug, slug);
    assert.ok(j.title && j.company && j.url.startsWith("http") && j.applyUrl.startsWith("http"), JSON.stringify(j).slice(0, 200));
    assert.equal(typeof j.remote, "boolean");
  }
}

test("getJson: 404 throws NotFoundError, 5xx retries then succeeds, 4xx does not retry", async () => {
  let n = 0;
  globalThis.fetch = (async () => (++n < 3 ? new Response("x", { status: 503 }) : new Response('{"ok":1}'))) as typeof fetch;
  assert.deepEqual(await getJson("https://x.test/a", { retries: 3 }), { ok: 1 });
  assert.equal(n, 3);
  mock([]);
  await assert.rejects(getJson("https://x.test/missing"), NotFoundError);
  mock([["x.test", 403]]);
  await assert.rejects(getJson("https://x.test/a", { retries: 3 }), /403/);
  assert.equal(calls.length, 1);
});

test("greenhouse", async () => {
  mock([["/jobs?content=true", fx("greenhouse-jobs")], ["/boards/airbnb", fx("greenhouse-board")]]);
  const jobs = await BOARD_SOURCES.greenhouse!("airbnb");
  sane(jobs, "greenhouse", "airbnb");
  assert.equal(jobs[0].company, "Airbnb");
  assert.ok(jobs[0].description.length > 200 && !/[<>]|&lt;|&amp;/.test(jobs[0].description), jobs[0].description.slice(0, 200));
  assert.ok(jobs[0].postedAt?.startsWith("20"));
});

test("greenhouse: pay_input_ranges and missing board name", async () => {
  const data = fx("greenhouse-jobs");
  data.jobs = [{ ...data.jobs[0], pay_input_ranges: [{ min_cents: 15000000, max_cents: 19000000, currency_type: "USD" }] }];
  mock([["/jobs?content=true", data]]);
  const [j] = await BOARD_SOURCES.greenhouse!("airbnb");
  assert.deepEqual([j.salaryMin, j.salaryMax, j.salaryCurrency], [150000, 190000, "USD"]);
  assert.equal(j.company, data.jobs[0].company_name);
});

test("lever, with EU fallback", async () => {
  mock([["api.eu.lever.co", fx("lever")]]);
  const jobs = await BOARD_SOURCES.lever!("palantir");
  sane(jobs, "lever", "palantir");
  assert.ok(calls[0].includes("api.lever.co") && calls[1].includes("api.eu.lever.co"));
  assert.ok(jobs[0].description.length > 200 && jobs[0].location);
  mock([]);
  await assert.rejects(BOARD_SOURCES.lever!("nope"), NotFoundError);
});

test("ashby", async () => {
  mock([["ashbyhq.com", fx("ashby")]]);
  const jobs = await BOARD_SOURCES.ashby!("ramp");
  sane(jobs, "ashby", "ramp");
  assert.equal(jobs[0].company, "Ramp");
  assert.equal(jobs[0].salaryMin, 211400);
  assert.equal(jobs[0].salaryMax, 290600);
  assert.equal(jobs[0].remote, true);
});

test("workable (widget + detail)", async () => {
  mock([["/api/v2/accounts/", fx("workable-detail")], ["/widget/accounts/", fx("workable-widget")]]);
  const jobs = await BOARD_SOURCES.workable!("huggingface");
  sane(jobs, "workable", "huggingface");
  assert.equal(jobs[0].company, "Hugging Face");
  assert.ok(jobs[0].description.length > 100);
});

test("smartrecruiters", async () => {
  mock([["api.smartrecruiters.com", fx("smartrecruiters")]]);
  const jobs = await BOARD_SOURCES.smartrecruiters!("ServiceNow");
  sane(jobs, "smartrecruiters", "ServiceNow");
  assert.ok(jobs[0].url.startsWith("https://jobs.smartrecruiters.com/ServiceNow/"));
  assert.equal(calls.length, 1);
});

test("recruitee", async () => {
  mock([["recruitee.com/api/offers", fx("recruitee")]]);
  const jobs = await BOARD_SOURCES.recruitee!("bunq");
  sane(jobs, "recruitee", "bunq");
  assert.equal(jobs[0].postedAt, "2026-10-05T16:05:18.000Z");
});

test("feeds", async () => {
  const cases: Array<[string, string, Route[]]> = [
    ["remoteok", "remoteok", [["remoteok.com/api", fx("remoteok")]]],
    ["remotive", "remotive", [["remotive.com", fx("remotive")]]],
    ["arbeitnow", "arbeitnow", [["arbeitnow.com", { ...fx("arbeitnow"), links: {} }]]],
    ["himalayas", "himalayas", [["offset=0", fx("himalayas")], ["himalayas.app", { jobs: [] }]]],
    ["jobicy", "jobicy", [["jobicy.com", fx("jobicy")]]],
  ];
  for (const [name, slug, routes] of cases) {
    mock(routes);
    const jobs = await (FEED_SOURCES as any)[name]();
    sane(jobs, name, slug);
    assert.ok(jobs.every((j: any) => j.remote === true || name === "arbeitnow"));
  }
  mock([["remoteok.com/api", fx("remoteok")]]);
  assert.equal((await FEED_SOURCES.remoteok!()).length, 2, "legal notice element skipped");
});

test("arbeitnow follows links.next up to a limit", async () => {
  const page = fx("arbeitnow");
  mock([["arbeitnow.com", { ...page, links: { next: "https://www.arbeitnow.com/api/job-board-api?page=2" } }]]);
  const jobs = await FEED_SOURCES.arbeitnow!();
  assert.equal(calls.length, 5);
  assert.equal(jobs.length, 10);
});

test("hn who is hiring", async () => {
  mock([["/items/", fx("hn-item")], ["search_by_date", fx("hn-search")]]);
  const jobs = await FEED_SOURCES.hn!();
  assert.ok(jobs.length >= 3);
  const [first] = jobs;
  assert.ok(first.id.startsWith("hn:49922569:"));
  assert.equal(first.boardSlug, "hn");
  assert.ok(first.url.startsWith("https://news.ycombinator.com/item?id="));
  assert.ok(first.applyUrl.startsWith("http"));
  const sidekick = jobs.find(j => j.company === "Sidekick Labs");
  assert.ok(sidekick);
  assert.equal(sidekick.remote, true);
  assert.equal(sidekick.title, "Senior SWE, R&D Engineer, Intelligence Engineer");
  assert.equal(sidekick.salaryMin, 170000);
});

test("garbage payloads do not throw", async () => {
  mock([["greenhouse", { jobs: [null, 5, { id: 1 }, "x"] }]]);
  const jobs = await BOARD_SOURCES.greenhouse!("x");
  assert.ok(Array.isArray(jobs));
  mock([["ashbyhq", "nonsense"], ["remotive", { jobs: "no" }]]);
  await assert.rejects(BOARD_SOURCES.ashby!("x"), /unexpected response shape/); // boards must not look empty
  assert.deepEqual(await FEED_SOURCES.remotive!(), []);
});

test("loadBoards merges bundled and user boards, deduped", () => {
  writeFileSync(join(process.env.OPENAPPLY_HOME!, "boards.json"),
    JSON.stringify({ greenhouse: ["airbnb", { slug: "stripe", company: "Stripe Inc" }], bogus: ["x"], lever: ["palantir"] }));
  const boards = loadBoards();
  const keys = boards.map(b => `${b.ats}:${b.slug}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("greenhouse:airbnb") && keys.includes("lever:palantir"));
  assert.equal(boards.find(b => b.slug === "stripe")?.company, "Stripe Inc");
  assert.ok(!keys.some(k => k.startsWith("bogus")));
});

test("addUserBoards merges without duplicates", () => {
  addUserBoards([{ ats: "ashby", slug: "ramp", company: "Ramp" }, { ats: "ashby", slug: "ramp" }, { ats: "lever", slug: "plaid" }]);
  const data = JSON.parse(readFileSync(join(process.env.OPENAPPLY_HOME!, "boards.json"), "utf8"));
  assert.deepEqual(data.ashby, [{ slug: "ramp", company: "Ramp" }]);
  assert.ok(data.lever.includes("plaid") && data.lever.includes("palantir"));
});

test("slugCandidates", () => {
  const c = slugCandidates("Acme Labs, Inc.");
  assert.ok(c.includes("acmelabsinc") && c.includes("acme") && c.includes("acme-labs-inc"));
  assert.ok(c.length <= 6);
});

test("sync: per-board failure isolation, closeMissing, feeds", async () => {
  mock([
    ["/boards/good/jobs", fx("greenhouse-jobs")], ["/boards/good", fx("greenhouse-board")],
    ["/boards/gone", 404], ["/boards/flaky", 400],
    ["remotive.com", fx("remotive")], ["remoteok.com", 500], ["jobicy", { jobs: "garbage" }],
  ]);
  const boards = [
    { ats: "greenhouse" as const, slug: "good", company: "Good Co" },
    { ats: "greenhouse" as const, slug: "gone" },
    { ats: "greenhouse" as const, slug: "flaky" },
  ];
  const r = await sync({ boards, concurrency: 2 });
  assert.equal(r.ok, 1); assert.equal(r.failed, 2);
  assert.deepEqual(r.notFound, ["greenhouse:gone"]);
  assert.equal(r.jobsSeen, 2 + 2);
  assert.equal(r.feeds.remotive, 2);
  assert.match(String(r.feeds.remoteok), /^error/);
  assert.equal(r.feeds.jobicy, 0);
  assert.equal(db.searchJobs({ company: "Good Co" }).total, 2);

  // second sync: the board lost one job -> it is closed, not deleted
  const fewer = fx("greenhouse-jobs"); fewer.jobs = fewer.jobs.slice(0, 1);
  mock([["/boards/good/jobs", fewer], ["/boards/good", fx("greenhouse-board")]]);
  const r2 = await sync({ boards: boards.slice(0, 1), feeds: false });
  assert.equal(r2.closed, 1);
  assert.equal(db.searchJobs({ company: "Good Co" }).total, 1);
});

test("board sources: a 200 without the expected array throws, an explicit empty array is fine", async () => {
  const cases: Array<[string, string, string, unknown, unknown]> = [
    ["greenhouse", "gh", "/jobs?content=true", { nojobs: 1 }, { jobs: [] }],
    ["lever", "lv", "api.lever.co", { error: "x" }, []],
    ["ashby", "ab", "api.ashbyhq.com", {}, { jobs: [] }],
    ["workable", "wk", "apply.workable.com", {}, { jobs: [] }],
    ["smartrecruiters", "sr", "api.smartrecruiters.com", {}, { content: [], totalFound: 0 }],
    ["recruitee", "rc", "recruitee.com", {}, { offers: [] }],
  ];
  for (const [ats, slug, key, bad, empty] of cases) {
    const fetchBoard = (BOARD_SOURCES as any)[ats];
    mock([[key, bad]]);
    await assert.rejects(fetchBoard(slug), /unexpected response shape/, ats);
    mock([[key, empty]]);
    assert.deepEqual(await fetchBoard(slug), [], ats);
  }
});

test("sync: a board answering 200 with the wrong shape fails and does not close its jobs", async () => {
  db.upsertJobs([{ id: "ashby:shaky:1", ats: "ashby", boardSlug: "shaky", company: "Shaky", title: "Engineer",
    location: "NYC", remote: false, description: "d", url: "https://x", applyUrl: "https://x" }]);
  mock([["api.ashbyhq.com", { message: "maintenance" }]]);
  const r = await sync({ boards: [{ ats: "ashby", slug: "shaky" }], feeds: false });
  assert.equal(r.failed, 1); assert.equal(r.closed, 0);
  assert.equal(db.searchJobs({ company: "Shaky" }).total, 1);
});

test("smartrecruiters: hitting the page cap flags truncation and sync does not close past it", async () => {
  const content = (offset: number) => Array.from({ length: 100 }, (_, i) => ({
    id: String(offset + i), name: `Role ${offset + i}`, company: { name: "Big" }, location: { city: "X" },
  }));
  globalThis.fetch = (async (input: any) => {
    const offset = Number(new URL(String(input)).searchParams.get("offset"));
    return new Response(JSON.stringify({ totalFound: 5000, content: content(offset) }), { status: 200 });
  }) as typeof fetch;
  const jobs = await BOARD_SOURCES.smartrecruiters!("big");
  assert.equal(jobs.length, 3000);
  assert.equal((jobs as any).truncated, true);
  assert.equal(Object.keys(jobs).includes("truncated"), false);

  db.upsertJobs([{ id: "smartrecruiters:big:late", ats: "smartrecruiters", boardSlug: "big", company: "Big", title: "Late page job",
    location: "NYC", remote: false, description: "d", url: "https://x", applyUrl: "https://x" }]);
  const r = await sync({ boards: [{ ats: "smartrecruiters", slug: "big" }], feeds: false });
  assert.equal(r.ok, 1); assert.equal(r.closed, 0);
  assert.equal(db.getJob("smartrecruiters:big:late")?.open, true);
});
