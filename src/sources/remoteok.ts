import type { NormalizedJob } from "../types.js";
import { htmlToText, salaryFromDescription, salaryProps, toIso } from "../text.js";
import { getJson, mapSafe, str } from "./http.js";

/** The first array element is a legal notice, not a job: only entries with an id are postings. */
export async function fetchFeed(): Promise<NormalizedJob[]> {
  const data = await getJson<any[]>("https://remoteok.com/api");
  return mapSafe<any, NormalizedJob>(data, j => {
    if (!j?.id || !j.position) return undefined;
    const description = htmlToText(str(j.description));
    const salary = j.salary_min > 0
      ? { min: j.salary_min, max: j.salary_max > 0 ? j.salary_max : undefined, currency: "USD" }
      : salaryFromDescription(description);
    const url = str(j.url) || str(j.apply_url);
    return {
      id: `remoteok:remoteok:${j.id}`, ats: "remoteok", boardSlug: "remoteok", company: str(j.company),
      title: str(j.position).trim(), location: str(j.location) || "Remote", remote: true, description,
      url, applyUrl: str(j.apply_url) || url, department: str(j.tags?.[0]) || undefined,
      ...salaryProps(salary), postedAt: toIso(j.date) ?? toIso(j.epoch),
    };
  });
}
