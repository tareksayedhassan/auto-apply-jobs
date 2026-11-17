import type { NormalizedJob } from "../types.js";
import { htmlToText, salaryFromDescription, salaryProps, toIso } from "../text.js";
import { getJson, mapSafe, str } from "./http.js";

export async function fetchFeed(): Promise<NormalizedJob[]> {
  const data = await getJson<any>("https://jobicy.com/api/v2/remote-jobs?count=100");
  return mapSafe<any, NormalizedJob>(data?.jobs, j => {
    const description = htmlToText(str(j.jobDescription)) || str(j.jobExcerpt);
    const salary = j.salaryMin || j.annualSalaryMin
      ? { min: Number(j.salaryMin ?? j.annualSalaryMin), max: Number(j.salaryMax ?? j.annualSalaryMax) || undefined,
          currency: str(j.salaryCurrency) || undefined }
      : salaryFromDescription(description);
    return {
      id: `jobicy:jobicy:${j.id}`, ats: "jobicy", boardSlug: "jobicy", company: str(j.companyName),
      title: str(j.jobTitle).trim(), location: str(j.jobGeo) || "Remote", remote: true, description,
      url: str(j.url), applyUrl: str(j.url), department: str(j.jobIndustry?.[0]) || undefined,
      employmentType: str(j.jobType?.[0]) || undefined, ...salaryProps(salary), postedAt: toIso(j.pubDate),
    };
  });
}
