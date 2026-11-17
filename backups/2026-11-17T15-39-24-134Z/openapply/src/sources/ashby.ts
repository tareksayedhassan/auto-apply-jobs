import type { NormalizedJob } from "../types.js";
import { truncateWords, LIST_CHARS, detectRemote, parseSalary, salaryFromDescription, salaryProps, toIso, titleCase } from "../text.js";
import { expectArray, getJson, mapSafe, str } from "./http.js";

export async function fetchBoard(slug: string): Promise<NormalizedJob[]> {
  const data = await getJson<any>(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
  const company = str(data?.organizationName) || titleCase(slug);
  return mapSafe<any, NormalizedJob>(expectArray(data?.jobs), j => {
    if (j.isListed === false) return undefined;
    const names = [str(j.location), ...(Array.isArray(j.secondaryLocations) ? j.secondaryLocations.map((l: any) => str(l.location)) : [])];
    const location = [...new Set(names.filter(Boolean))].join("; ");
    const description = truncateWords(str(j.descriptionPlain), LIST_CHARS);
    const comp = j.compensation;
    const part = (Array.isArray(comp?.summaryComponents) ? comp.summaryComponents : [])
      .find((c: any) => c.compensationType === "Salary" && c.minValue && /year/i.test(str(c.interval)));
    const salary = part
      ? { min: part.minValue, max: part.maxValue ?? undefined, currency: str(part.currencyCode) || undefined }
      : parseSalary(str(comp?.compensationTierSummary)) ?? salaryFromDescription(description);
    return {
      id: `ashby:${slug}:${j.id}`, ats: "ashby", boardSlug: slug, company,
      title: str(j.title).trim(), location,
      remote: j.isRemote === true || str(j.workplaceType) === "Remote" || detectRemote(location, description),
      description, url: str(j.jobUrl), applyUrl: str(j.applyUrl) || str(j.jobUrl),
      department: str(j.department) || undefined, employmentType: str(j.employmentType) || undefined,
      ...salaryProps(salary), postedAt: toIso(j.publishedAt),
    };
  });
}
