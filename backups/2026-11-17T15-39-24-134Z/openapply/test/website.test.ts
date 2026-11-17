import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./offline.js";

const home = mkdtempSync(join(tmpdir(), "oa-site-"));
process.env.OPENAPPLY_HOME = home;
const db = await import("../src/db.js");
const { companyWebsite, websiteFromPosting } = await import("../src/website.js");
const { startServer } = await import("../src/server/http.js");

const job = (o: Record<string, any>) => ({
  id: `${o.ats}:${o.boardSlug}:1`, location: "NYC", remote: false, url: `https://job-boards.greenhouse.io/${o.boardSlug}/jobs/1`,
  applyUrl: `https://job-boards.greenhouse.io/${o.boardSlug}/jobs/1`, description: "", ...o,
}) as any;

test("websiteFromPosting: a domain named for the company or its board, never a guess", () => {
  assert.equal(websiteFromPosting(job({ ats: "greenhouse", boardSlug: "acme", company: "Acme", description: "Learn more at www.acme.ai or write jobs@acme.ai" })), "https://acme.ai");
  assert.equal(websiteFromPosting(job({ ats: "greenhouse", boardSlug: "gohooli", company: "Hooli", description: "See gohooli.com/careers" })), "https://gohooli.com");
  assert.equal(websiteFromPosting(job({ ats: "ashby", boardSlug: "soylent", company: "Soylent (formerly askSoylent)", description: "We use Node.js. Visit careers.soylent.ai" })), "https://soylent.ai");
  // the posting's own URL counts when it is on the company's site
  assert.equal(websiteFromPosting(job({ ats: "greenhouse", boardSlug: "natera", company: "Natera", url: "https://www.natera.com/careers?gh_jid=1" })), "https://natera.com");
  // the ATS host, other companies' domains and a feed's own name are not the company's site
  assert.equal(websiteFromPosting(job({ ats: "greenhouse", boardSlug: "initech", company: "Initech", description: "Integrates with quickbooks.com and Node.js" })), undefined);
  assert.equal(websiteFromPosting(job({ ats: "remoteok", boardSlug: "remoteok", company: "Pebble", url: "https://remoteok.com/remote-jobs/1" })), undefined);
});

test("companyWebsite: Ashby's publicWebsite is asked once per board and kept; a failed call is not", async () => {
  const real = globalThis.fetch;
  let calls = 0, fail = true;
  globalThis.fetch = (async (_u: any, init: any) => {
    calls++;
    if (fail) throw new TypeError("fetch failed");
    assert.equal(JSON.parse(init.body).variables.organizationHostedJobsPageName, "soylent");
    return new Response(JSON.stringify({ data: { organization: { publicWebsite: "https://www.soylent.ai/" } } }));
  }) as typeof fetch;
  try {
    const soylent = job({ ats: "ashby", boardSlug: "soylent", company: "Soylent" });
    assert.equal(await companyWebsite(soylent), undefined); // offline, nothing in the posting
    fail = false;
    assert.equal(await companyWebsite(soylent), "https://www.soylent.ai");
    assert.equal(await companyWebsite(soylent), "https://www.soylent.ai");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = real; }
});

test("GET /api/jobs/:id carries website, and none when unknown", async () => {
  db.upsertJobs([
    job({ id: "greenhouse:acme:9", ats: "greenhouse", boardSlug: "acme", company: "Acme", title: "AI Strategist", description: "About Acme: acme.ai" }),
    job({ id: "greenhouse:initech:9", ats: "greenhouse", boardSlug: "initech", company: "Initech", title: "Solutions Engineer" }),
  ]);
  const srv = await startServer(0, { uiDir: home });
  after(() => srv.close());
  const get = async (id: string) => (await (await fetch(`${srv.url}/api/jobs/${encodeURIComponent(id)}`)).json()) as any;
  assert.equal((await get("greenhouse:acme:9")).website, "https://acme.ai");
  assert.equal("website" in (await get("greenhouse:initech:9")), false);
});
