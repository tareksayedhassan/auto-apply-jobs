import type { NormalizedJob } from "../types.js";
import { htmlToText, htmlSnippet, truncateWords, LIST_CHARS, detectRemote, salaryFromDescription, salaryProps, toIso } from "../text.js";
import { expectArray, getJson, mapSafe, pool, str } from "./http.js";

/** The widget feed has no descriptions; fetch the per-job detail for the first few dozen (cheap, small boards). */
const DETAIL_CAP = 50;

/** Detail text (description, requirements, benefits); `max` bounds the conversion work. */
export function workableText(d: any, max = Infinity): string {
  const parts: string[] = [];
  for (const x of [d.description, d.requirements, d.benefits]) {
    if (parts.join("\n\n").length >= max) break;
    const t = max === Infinity ? htmlToText(str(x)) : htmlSnippet(str(x), max);
    if (t) parts.push(t);
  }
  const text = parts.join("\n\n");
  return max === Infinity ? text : truncateWords(text, max);
}

export async function fetchBoard(slug: string): Promise<NormalizedJob[]> {
  const data = await getJson<any>(`https://apply.workable.com/api/v1/widget/accounts/${slug}`, { retries: 3 });
  const company = str(data?.name) || slug;
  const jobs = mapSafe<any, NormalizedJob>(expectArray(data?.jobs), j => {
    const location = [j.city, j.state, j.country].map(str).filter(Boolean).join(", ");
    const url = str(j.url) || `https://apply.workable.com/j/${j.shortcode}`;
    return {
      id: `workable:${slug}:${j.shortcode}`, ats: "workable", boardSlug: slug, company,
      title: str(j.title).trim(), location, remote: j.telecommuting === true || detectRemote(location),
      description: [j.function, j.industry, j.experience].map(str).filter(Boolean).join(". "),
      descriptionComplete: false, // the widget feed is a stub; the per-job detail has the posting
      url, applyUrl: str(j.application_url) || url,
      department: str(j.department) || undefined, employmentType: str(j.employment_type) || undefined,
      postedAt: toIso(j.published_on),
    };
  });
  await pool(jobs.slice(0, DETAIL_CAP), 6, async job => {
    try {
      const d = await getJson<any>(`https://apply.workable.com/api/v2/accounts/${slug}/jobs/${job.id.split(":")[2]}`, { retries: 1 });
      const description = workableText(d, LIST_CHARS);
      if (description) {
        job.description = description;
        job.descriptionComplete = undefined;
        job.remote = job.remote || detectRemote(job.location, description);
        Object.assign(job, salaryProps(salaryFromDescription(description)));
      }
    } catch { /* keep the short description */ }
  });
  return jobs;
}
