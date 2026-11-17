import type { NormalizedJob } from "../types.js";
import { detectRemote, toIso } from "../text.js";
import { expectArray, getJson, mapSafe, markTruncated, str } from "./http.js";

const PAGE = 100;
/** Big employers list thousands; cap the pages so one board cannot dominate a sync. */
const MAX_PAGES = 30;

export async function fetchBoard(slug: string): Promise<NormalizedJob[]> {
  const out: NormalizedJob[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson<any>(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${PAGE}&offset=${page * PAGE}`);
    const items = expectArray(data?.content);
    out.push(...mapSafe<any, NormalizedJob>(items, j => {
      const loc = j.location ?? {};
      const location = str(loc.fullLocation) || [loc.city, loc.region, loc.country].map(str).filter(Boolean).join(", ");
      const company = str(j.company?.name) || slug;
      const department = str(j.department?.label);
      const url = `https://jobs.smartrecruiters.com/${slug}/${j.id}`;
      return {
        id: `smartrecruiters:${slug}:${j.id}`, ats: "smartrecruiters", boardSlug: slug, company,
        title: str(j.name).trim(), location, remote: loc.remote === true || detectRemote(location),
        description: [`${str(j.name)} at ${company}.`, department && `Department: ${department}.`,
          location && `Location: ${location}.`, str(j.function?.label) && `Function: ${str(j.function?.label)}.`]
          .filter(Boolean).join(" "),
        descriptionComplete: false, // list entries carry no posting text; details.ts fetches it
        url, applyUrl: url, department: department || undefined,
        employmentType: str(j.typeOfEmployment?.label) || undefined, postedAt: toIso(j.releasedDate),
      };
    }));
    if (items.length < PAGE || (page + 1) * PAGE >= (data?.totalFound ?? 0)) break;
    if (page === MAX_PAGES - 1) markTruncated(out);
  }
  return out;
}
