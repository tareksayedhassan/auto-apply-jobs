import type { NormalizedJob } from "../types.js";
import { htmlToText, salaryFromDescription, salaryProps, toIso } from "../text.js";
import { getJson, mapSafe, str } from "./http.js";

const PAGE = 20; // the API caps a page at 20 whatever limit asks for
const MAX_PAGES = 10;

export async function fetchFeed(): Promise<NormalizedJob[]> {
  const out: NormalizedJob[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson<any>(`https://himalayas.app/jobs/api?limit=${PAGE}&offset=${page * PAGE}`);
    const items: any[] = Array.isArray(data?.jobs) ? data.jobs : [];
    out.push(...mapSafe<any, NormalizedJob>(items, j => {
      const url = str(j.applicationLink) || str(j.guid);
      const key = str(j.guid).replace(/^https?:\/\/himalayas\.app\/companies\//, "") || url;
      const description = htmlToText(str(j.description));
      const salary = j.minSalary && /year|annual/i.test(str(j.salaryPeriod) || "annual")
        ? { min: j.minSalary, max: j.maxSalary || undefined, currency: str(j.currency) || undefined }
        : salaryFromDescription(description);
      return {
        id: `himalayas:himalayas:${key}`, ats: "himalayas", boardSlug: "himalayas", company: str(j.companyName),
        title: str(j.title).trim(), remote: true,
        location: Array.isArray(j.locationRestrictions) && j.locationRestrictions.length
          ? j.locationRestrictions.map(str).join(", ") : "Worldwide",
        description, url, applyUrl: url, department: str(j.parentCategories?.[0] ?? j.categories?.[0]) || undefined,
        employmentType: str(j.employmentType) || undefined, ...salaryProps(salary), postedAt: toIso(j.pubDate),
      };
    }));
    if (items.length < PAGE) break;
  }
  return out;
}
