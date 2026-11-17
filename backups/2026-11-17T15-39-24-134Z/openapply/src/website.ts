/**
 * The company's own website, for the dashboard's job detail. Only from data that names it: Ashby's public
 * organization record (one call per board, kept in kv), else a domain in the posting's URLs or text whose name is
 * the company's (or its board slug's), other than a hiring platform's. Undefined when nothing fits; a domain is never made up from the name.
 */
import { kvGet, kvSet } from "./db.js";
import { companyKeys } from "./prior.js";
import { getJson, str } from "./sources/http.js";
import type { Job } from "./types.js";

const ASHBY_ORG = "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiOrganizationFromHostedJobsPageName";
const ASHBY_QUERY = `query ApiOrganizationFromHostedJobsPageName($organizationHostedJobsPageName: String!) {
  organization: organizationFromHostedJobsPageName(organizationHostedJobsPageName: $organizationHostedJobsPageName, searchContext: JobBoard) { publicWebsite }
}`;

const origin = (u: string): string | undefined => {
  try { const url = new URL(u); return /^https?:$/.test(url.protocol) ? url.origin : undefined; } catch { return undefined; }
};

/** Ashby's publicWebsite for a board. A clean answer (even "none") is kept; a network failure is retried next time. */
async function ashbyWebsite(slug: string): Promise<string | undefined> {
  const key = `website:ashby:${slug}`;
  const kept = kvGet(key);
  if (kept !== undefined) return kept || undefined;
  try {
    const d = await getJson<any>(ASHBY_ORG, {
      body: { operationName: "ApiOrganizationFromHostedJobsPageName", variables: { organizationHostedJobsPageName: slug }, query: ASHBY_QUERY },
      timeoutMs: 5000, retries: 0,
    });
    if (!d?.data) return undefined;
    const site = origin(str(d.data.organization?.publicWebsite));
    kvSet(key, site ?? "");
    return site;
  } catch { return undefined; }
}

/** Hiring platforms that give each employer its own subdomain: <company>.recruitee.com is the job board, not the company. */
const HIRING_HOSTS = new Set(["greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com", "recruitee.com", "teamtailor.com", "applytojob.com", "breezy.hr", "bamboohr.com", "jobvite.com", "myworkdayjobs.com", "icims.com"]);

const DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;

/** A domain in the posting (URL, apply URL, text) with a label equal to the company's name or its board slug. */
export function websiteFromPosting(job: Pick<Job, "ats" | "boardSlug" | "company" | "url" | "applyUrl" | "description">): string | undefined {
  const names = new Set(companyKeys(job.company));
  if (job.boardSlug !== job.ats) names.add(job.boardSlug.toLowerCase().replace(/[^a-z0-9]/g, "")); // feeds use their own name as the slug
  for (const [domain] of `${job.url} ${job.applyUrl} ${job.description}`.matchAll(DOMAIN)) {
    const labels = domain.toLowerCase().split(".");
    if (HIRING_HOSTS.has(labels.slice(-2).join("."))) continue;
    const i = labels.findIndex((l, k) => k < labels.length - 1 && names.has(l.replace(/-/g, "")));
    if (i >= 0) return `https://${labels.slice(i).join(".")}`;
  }
  return undefined;
}

export async function companyWebsite(job: Job): Promise<string | undefined> {
  return (job.ats === "ashby" ? await ashbyWebsite(job.boardSlug) : undefined) ?? websiteFromPosting(job);
}
