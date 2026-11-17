/**
 * On-demand full postings. The index keeps only a snippet per job (see db.SNIPPET_CHARS); anything that needs
 * the whole text (tailoring, company brief, get_job, the dashboard detail view) goes through getJobFull(),
 * which fetches the single posting from its ATS, stores it, and returns it.
 */
import { closeJob, getJob, setFullDescription } from "./db.js";
import { BOARD_SOURCES } from "./sources/index.js";
import { getJson, NotFoundError, str } from "./sources/http.js";
import { leverText } from "./sources/lever.js";
import { recruiteeText } from "./sources/recruitee.js";
import { workableText } from "./sources/workable.js";
import { workdayPostingText } from "./sources/workday.js";
import { escapedHtmlToText, htmlToText } from "./text.js";
import type { Job } from "./types.js";

const ASHBY_TTL_MS = 10 * 60_000;
const ashbyBoards = new Map<string, { at: number; data: Promise<any> }>();

/** Tests: forget memoized Ashby board responses. */
export function clearDetailCache(): void { ashbyBoards.clear(); }

/** Ashby has no single-posting endpoint: one board fetch serves every posting of that board for a while. */
function ashbyBoard(slug: string): Promise<any> {
  const hit = ashbyBoards.get(slug);
  if (hit && Date.now() - hit.at < ASHBY_TTL_MS) return hit.data;
  const data = getJson<any>(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  ashbyBoards.set(slug, { at: Date.now(), data });
  data.catch(() => ashbyBoards.delete(slug)); // never memoize a failure
  return data;
}

const LEVER_HOSTS = ["https://api.lever.co", "https://api.eu.lever.co"];

async function leverPosting(slug: string, id: string): Promise<any> {
  for (const host of LEVER_HOSTS) {
    try { return await getJson<any>(`${host}/v0/postings/${slug}/${id}`); }
    catch (e) { if (!(e instanceof NotFoundError) || host === LEVER_HOSTS.at(-1)) throw e; }
  }
}

/** The ATS's own posting id inside an OpenApply job id (`<ats>:<board>:<posting id>`). */
export function postingId(job: Job): string {
  const prefix = `${job.ats}:${job.boardSlug}:`;
  return job.id.startsWith(prefix) ? job.id.slice(prefix.length) : job.id.split(":").slice(2).join(":");
}

/**
 * The complete description of one board posting, from its ATS's public per-posting endpoint.
 * Resolves undefined when the ATS has no per-posting text (feeds). Throws NotFoundError when the posting
 * is gone, and the usual network errors otherwise: getJobFull is the caller that swallows them.
 */
export async function fetchFullDescription(job: Job): Promise<string | undefined> {
  const id = postingId(job);
  const slug = job.boardSlug;
  const enc = encodeURIComponent(id);
  switch (job.ats) {
    case "greenhouse": {
      const d = await getJson<any>(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${enc}`);
      return escapedHtmlToText(str(d?.content)) || undefined;
    }
    case "lever":
      return leverText(await leverPosting(slug, enc)) || undefined;
    case "ashby": {
      const data = await ashbyBoard(slug);
      const j = (Array.isArray(data?.jobs) ? data.jobs : []).find((x: any) => str(x.id) === id && x.isListed !== false);
      if (!j) throw new NotFoundError(`ashby posting ${id} not on board ${slug}`);
      return str(j.descriptionPlain) || htmlToText(str(j.descriptionHtml)) || undefined;
    }
    case "workable": {
      const d = await getJson<any>(`https://apply.workable.com/api/v2/accounts/${slug}/jobs/${enc}`);
      return workableText(d) || undefined;
    }
    case "recruitee": {
      let offer: any;
      try { offer = (await getJson<any>(`https://${slug}.recruitee.com/api/offers/${enc}`))?.offer; }
      catch (e) { if (!(e instanceof NotFoundError)) throw e; }
      if (!offer) { // detail endpoint missing for this account: the list carries the same text
        const list = await getJson<any>(`https://${slug}.recruitee.com/api/offers/`);
        offer = (Array.isArray(list?.offers) ? list.offers : []).find((o: any) => str(o.id) === id);
        if (!offer) throw new NotFoundError(`recruitee offer ${id} not on ${slug}`);
      }
      return recruiteeText(offer) || undefined;
    }
    case "smartrecruiters": {
      const d = await getJson<any>(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${enc}`);
      const sections = d?.jobAd?.sections ?? {};
      return ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
        .map(k => {
          const body = htmlToText(str(sections[k]?.text));
          return body ? `${str(sections[k]?.title)}\n${body}`.trim() : "";
        }).filter(Boolean).join("\n\n") || undefined;
    }
    case "workday":
      return workdayPostingText(slug, id, job.url);
    default:
      return undefined;
  }
}

/**
 * The job with its complete description. A snippet-only board job is fetched, stored (so the next call is
 * local) and returned with descriptionComplete true. A 404 closes the job; any failure returns the snippet
 * version with descriptionComplete false. Never throws for network errors.
 */
export async function getJobFull(id: string): Promise<Job | undefined> {
  const job = getJob(id);
  if (!job || job.descriptionComplete || !(job.ats in BOARD_SOURCES)) return job;
  try {
    const text = await fetchFullDescription(job);
    if (!text) return job;
    setFullDescription(id, text);
    return { ...job, description: text, descriptionComplete: true };
  } catch (e) {
    if (e instanceof NotFoundError) { closeJob(id); return { ...job, open: false }; }
    return job;
  }
}
