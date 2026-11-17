import type { NormalizedJob } from "../types.js";
import { htmlToText, parseSalary, salaryFromDescription, salaryProps, toIso } from "../text.js";
import { getJson, mapSafe, str } from "./http.js";

export async function fetchFeed(): Promise<NormalizedJob[]> {
  const data = await getJson<any>("https://remotive.com/api/remote-jobs");
  return mapSafe<any, NormalizedJob>(data?.jobs, j => {
    const description = htmlToText(str(j.description));
    return {
      id: `remotive:remotive:${j.id}`, ats: "remotive", boardSlug: "remotive", company: str(j.company_name),
      title: str(j.title).trim(), location: str(j.candidate_required_location) || "Remote", remote: true,
      description, url: str(j.url), applyUrl: str(j.url), department: str(j.category) || undefined,
      employmentType: str(j.job_type) || undefined,
      ...salaryProps(parseSalary(str(j.salary)) ?? salaryFromDescription(description)),
      postedAt: toIso(str(j.publication_date) + "Z"),
    };
  });
}
