import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-lean-"));
const db = await import("../src/db.js");
const { htmlSnippet, truncateWords, htmlToText, escapedHtmlToText } = await import("../src/text.js");
const { fetchFullDescription, getJobFull, clearDetailCache } = await import("../src/details.js");
const { BOARD_SOURCES } = await import("../src/sources/index.js");

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/sources/${name}.json`, import.meta.url), "utf8"));
const words = (n: number, w = "alpha") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
const job = (id: string, description: string, extra: any = {}) => ({
  id: `greenhouse:acme:${id}`, ats: "greenhouse" as const, boardSlug: "acme", company: "Acme", title: `Role ${id}`,
  location: "NYC", remote: false, description, url: "https://x", applyUrl: "https://x", ...extra,
});

// ---- snippet storage ----

test("long descriptions are stored as word-boundary snippets, short ones whole", () => {
  const long = words(400);
  db.upsertJobs([job("long", long), job("short", "Build agents."), job("edge", "x ".repeat(350).trim())]);
  const l = db.getJob("greenhouse:acme:long")!;
  assert.equal(db.SNIPPET_CHARS, 700);
  assert.equal(l.descriptionComplete, false);
  assert.ok(l.description.length <= db.SNIPPET_CHARS + 3 && l.description.endsWith("..."), String(l.description.length));
  assert.ok(long.startsWith(l.description.slice(0, -3)), "snippet is a prefix of the text");
  assert.match(l.description.slice(0, -3), /alpha\d+$/, "cut at a word boundary");
  const s = db.getJob("greenhouse:acme:short")!;
  assert.equal(s.description, "Build agents.");
  assert.equal(s.descriptionComplete, true);
  assert.equal(db.getJob("greenhouse:acme:edge")!.descriptionComplete, true); // exactly 699 chars: fits
});

test("a source can flag a stub description as incomplete", () => {
  db.upsertJobs([job("stub", "Short stub.", { descriptionComplete: false })]);
  const j = db.getJob("greenhouse:acme:stub")!;
  assert.equal(j.description, "Short stub.");
  assert.equal(j.descriptionComplete, false);
});

test("a hydrated description survives re-sync snippets, but yields to a new complete one", () => {
  const long = words(400);
  db.upsertJobs([job("h", long)]);
  const full = words(900, "beta");
  db.setFullDescription("greenhouse:acme:h", full);
  assert.equal(db.getJob("greenhouse:acme:h")!.descriptionComplete, true);
  db.upsertJobs([job("h", long, { title: "Renamed" })]); // sync sees the snippet again
  const j = db.getJob("greenhouse:acme:h")!;
  assert.equal(j.description, full);
  assert.equal(j.descriptionComplete, true);
  assert.equal(j.title, "Renamed");
  db.upsertJobs([job("h", "Now it is short.")]); // the posting really became short: take it
  assert.equal(db.getJob("greenhouse:acme:h")!.description, "Now it is short.");
});

test("FTS indexes the stored text: head words match, hydrated text becomes searchable", () => {
  db.upsertJobs([job("fts", words(300, "zulu") + " " + words(300, "yankee"))]);
  assert.equal(db.searchJobs({ query: "zulu5" }).total, 1);
  assert.equal(db.searchJobs({ query: "yankee250" }).total, 0); // beyond the snippet
  db.setFullDescription("greenhouse:acme:fts", words(300, "zulu") + " " + words(300, "yankee"));
  assert.equal(db.searchJobs({ query: "yankee250" }).total, 1);
  db.upsertJobs([job("fts", words(300, "zulu") + " " + words(300, "yankee"))]); // unchanged re-sync keeps FTS consistent
  assert.equal(db.searchJobs({ query: "yankee250" }).total, 1);
  assert.equal(db.searchJobs({ query: "zulu5" }).total, 1);
});

test("closeMissing closes only unseen open jobs", () => {
  db.upsertJobs([job("c1", "a"), job("c2", "b"), job("c3", "c")]);
  db.closeJob("greenhouse:acme:c3");
  assert.equal(db.closeMissing("greenhouse", "acme", ["greenhouse:acme:c1"].concat(["long", "short", "edge", "stub", "h", "fts"].map(x => `greenhouse:acme:${x}`))), 1);
  assert.equal(db.getJob("greenhouse:acme:c2")!.open, false);
  assert.equal(db.getJob("greenhouse:acme:c1")!.open, true);
});

// ---- htmlSnippet ----

test("htmlSnippet: bounded output, correct text, same as full conversion for short input", () => {
  const para = "<p>Hello &amp; welcome to <b>Acme</b>. We build things.</p>";
  assert.equal(htmlSnippet(para, 1000), htmlToText(para));
  const esc = "&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;one&lt;/li&gt;&lt;/ul&gt;";
  assert.equal(htmlSnippet(esc, 1000, true), escapedHtmlToText(esc));
  assert.equal(htmlSnippet("", 100), "");
  const big = "<div><p>" + words(20000) + "</p></div>";
  const t0 = performance.now();
  const s = htmlSnippet(big, 500);
  assert.ok(performance.now() - t0 < 50);
  assert.ok(s.length <= 503 && s.endsWith("..."), String(s.length));
  assert.ok(s.startsWith("alpha0 alpha1"));
  assert.ok(!/<|&lt;/.test(s));
});

test("htmlSnippet: a cut mid-tag or mid-entity leaves no debris, and tag-heavy input still yields maxChars", () => {
  const html = ("<p class=\"a\"><span style=\"x:y\">word &amp; </span></p>").repeat(600);
  const s = htmlSnippet(html, 300);
  assert.ok(s.length >= 280 && s.length <= 303, String(s.length));
  assert.ok(!/[<>]|&amp|class=/.test(s), s);
  const markup = "<div>".repeat(2000) + "<p>deep text starts here and goes on for a while</p>" + "x ".repeat(2000);
  assert.ok(htmlSnippet(markup, 200).includes("deep text starts here")); // grows the prefix instead of returning almost nothing
  assert.equal(htmlSnippet("<p>tiny</p>", 200), "tiny");
  assert.equal(truncateWords("short", 10), "short");
  assert.equal(truncateWords("alpha beta gamma delta", 14), "alpha beta...");
});

test("sources keep their stored text small but the salary and remote signals work", async () => {
  const gh = fx("greenhouse-jobs");
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: any) => new Response(JSON.stringify(String(u).includes("content=true") ? gh : fx("greenhouse-board")))) as typeof fetch;
  try {
    const jobs = await BOARD_SOURCES.greenhouse!("airbnb");
    assert.ok(jobs.length > 0 && jobs.every(j => j.description.length <= 1003));
  } finally { globalThis.fetch = orig; }
});

// ---- details.ts ----

const realFetch = globalThis.fetch;
let calls: string[] = [];
function mock(routes: Array<[string, unknown | number]>) {
  calls = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const hit = routes.find(([k]) => url.includes(k));
    if (!hit || hit[1] === 404) return new Response("nf", { status: 404 });
    if (typeof hit[1] === "number") return new Response("err", { status: hit[1] });
    return new Response(JSON.stringify(hit[1]), { status: 200 });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; clearDetailCache(); });

const stubJob = (ats: string, slug: string, native: string, extra: any = {}) => ({
  ...job("x", words(300), extra), id: `${ats}:${slug}:${native}`, ats: ats as any, boardSlug: slug, url: "https://x",
});
const hydrate = (j: any) => { db.upsertJobs([j]); return db.getJob(j.id)!; };

test("fetchFullDescription: greenhouse single posting (escaped HTML)", async () => {
  mock([["/v1/boards/airbnb/jobs/8184174", fx("greenhouse-job-detail")]]);
  const text = await fetchFullDescription(hydrate(stubJob("greenhouse", "airbnb", "8184174")));
  assert.deepEqual(calls, ["https://boards-api.greenhouse.io/v1/boards/airbnb/jobs/8184174"]);
  assert.ok(text && text.length > 2000 && !/[<>]|&lt;|&amp;/.test(text), text?.slice(0, 120));
});

test("fetchFullDescription: lever posting, falls back to the EU host", async () => {
  mock([["api.lever.co/v0/postings/actian/4b29", 404], ["api.eu.lever.co/v0/postings/actian/4b29", fx("lever-job-detail")]]);
  const j = hydrate(stubJob("lever", "actian", "4b29635b-649a-4b62-9cf9-e2448807cf3f"));
  const text = await fetchFullDescription(j);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].startsWith("https://api.eu.lever.co/"));
  assert.ok(text && text.length > 1200);
  mock([]); // both hosts 404: the posting is gone
  await assert.rejects(fetchFullDescription(j), /404/);
});

test("fetchFullDescription: ashby refetches the board once (memoized) and finds the posting", async () => {
  mock([["posting-api/job-board/openai", fx("ashby-board-detail")]]);
  const a = hydrate(stubJob("ashby", "openai", "8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3"));
  const b = hydrate(stubJob("ashby", "openai", "240d459b-696d-43eb-8497-fab3e56ecd9b"));
  const ta = await fetchFullDescription(a);
  const tb = await fetchFullDescription(b);
  assert.equal(calls.length, 1);
  assert.ok(ta!.length > 6000 && tb!.length > 3500 && ta !== tb);
  await assert.rejects(fetchFullDescription(stubJob("ashby", "openai", "nope") as any), /not on board/);
  clearDetailCache();
  await fetchFullDescription(a);
  assert.equal(calls.length, 2); // cache cleared, refetched
});

test("fetchFullDescription: workable, recruitee (detail + list fallback), smartrecruiters", async () => {
  mock([["/api/v2/accounts/mito/jobs/ABC123", fx("workable-detail")]]);
  const w = await fetchFullDescription(stubJob("workable", "mito", "ABC123") as any);
  assert.ok(w!.length > 2000 && !/</.test(w!));

  const offer = fx("recruitee-offer-detail");
  mock([["bunq.recruitee.com/api/offers/2771751", offer]]);
  const r = await fetchFullDescription(stubJob("recruitee", "bunq", "2771751") as any);
  assert.ok(r!.length > 2500 && !/<[a-z]/.test(r!));
  mock([["bunq.recruitee.com/api/offers/2771751", 404], ["bunq.recruitee.com/api/offers/", { offers: [offer.offer] }]]);
  assert.equal(await fetchFullDescription(stubJob("recruitee", "bunq", "2771751") as any), r);
  mock([["bunq.recruitee.com/api/offers/2771751", 404], ["bunq.recruitee.com/api/offers/", { offers: [] }]]);
  await assert.rejects(fetchFullDescription(stubJob("recruitee", "bunq", "2771751") as any), /not on/);

  mock([["/v1/companies/wise/postings/744000154880709", fx("smartrecruiters-posting-detail")]]);
  const s = await fetchFullDescription(stubJob("smartrecruiters", "wise", "744000154880709") as any);
  assert.ok(s!.length > 4000 && !/<[a-z]/.test(s!));
  assert.match(s!, /Qualifications|Job Description/i);
});

test("getJobFull: hydrates once, stores it, and reports complete", async () => {
  const j = hydrate(stubJob("greenhouse", "airbnb", "8184174"));
  assert.equal(j.descriptionComplete, false);
  mock([["/v1/boards/airbnb/jobs/8184174", fx("greenhouse-job-detail")]]);
  const full = await getJobFull(j.id);
  assert.equal(full!.descriptionComplete, true);
  assert.ok(full!.description.length > 2000);
  assert.equal(db.getJob(j.id)!.description, full!.description);
  assert.equal(db.getJob(j.id)!.descriptionComplete, true);
  const again = await getJobFull(j.id);
  assert.equal(calls.length, 1, "second call is local");
  assert.equal(again!.description, full!.description);
  assert.equal(await getJobFull("nope:x:1"), undefined);
});

test("getJobFull: 404 closes the job, network errors return the snippet, never throw", async () => {
  const gone = hydrate(stubJob("greenhouse", "airbnb", "gone1"));
  mock([]);
  const r = await getJobFull(gone.id);
  assert.equal(r!.descriptionComplete, false);
  assert.equal(r!.open, false);
  assert.equal(db.getJob(gone.id)!.open, false);

  const flaky = hydrate(stubJob("greenhouse", "airbnb", "flaky1"));
  globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as typeof fetch;
  const f = await getJobFull(flaky.id);
  assert.equal(f!.descriptionComplete, false);
  assert.equal(f!.description, flaky.description);
  assert.equal(db.getJob(flaky.id)!.open, true);
  mock([["airbnb/jobs/flaky1", 403]]);
  assert.equal((await getJobFull(flaky.id))!.descriptionComplete, false);

  // jobs that are already whole, and feed jobs, never touch the network
  mock([]);
  db.upsertJobs([job("whole", "Complete text."), job("feed1", words(300), { id: "remoteok:remoteok:1", ats: "remoteok", boardSlug: "remoteok" })]);
  assert.equal((await getJobFull("greenhouse:acme:whole"))!.description, "Complete text.");
  assert.equal((await getJobFull("remoteok:remoteok:1"))!.descriptionComplete, false);
  assert.equal(calls.length, 0);
});
