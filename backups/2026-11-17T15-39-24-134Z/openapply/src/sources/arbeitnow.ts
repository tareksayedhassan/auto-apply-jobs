import type { NormalizedJob } from "../types.js";
import { htmlToText, detectRemote, salaryFromDescription, salaryProps, toIso } from "../text.js";
import { getJson, mapSafe, str } from "./http.js";

const MAX_PAGES = 5;

export async function fetchFeed(): Promise<NormalizedJob[]> {
  const out: NormalizedJob[] = [];
  let url: string | undefined = "https://www.arbeitnow.com/api/job-board-api";
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const data: any = await getJson<any>(url);
    out.push(...mapSafe<any, NormalizedJob>(data?.data, j => {
      const location = str(j.location);
      const description = htmlToText(str(j.description));
      return {
        id: `arbeitnow:arbeitnow:${j.slug}`, ats: "arbeitnow", boardSlug: "arbeitnow", company: str(j.company_name),
        title: str(j.title).trim(), location, remote: j.remote === true || detectRemote(location),
        description, url: str(j.url), applyUrl: str(j.url),
        employmentType: str(j.job_types?.[0]) || undefined,
        ...salaryProps(salaryFromDescription(description)), postedAt: toIso(j.created_at),
      };
    }));
    url = str(data?.links?.next) || undefined;
  }
  return out;
}
