import type { NormalizedJob } from "../types.js";
import { htmlSnippet, LIST_CHARS, detectRemote, salaryFromDescription, salaryProps, toIso, titleCase } from "../text.js";
import { expectArray, getJson, mapSafe, str } from "./http.js";

const API = "https://boards-api.greenhouse.io/v1/boards";

export async function fetchBoard(slug: string): Promise<NormalizedJob[]> {
  const [data, board] = await Promise.all([
    getJson<any>(`${API}/${slug}/jobs?content=true`),
    getJson<any>(`${API}/${slug}`).catch(() => undefined),
  ]);
  const boardName = str(board?.name);
  return mapSafe<any, NormalizedJob>(expectArray(data?.jobs), j => {
    const location = str(j.location?.name);
    const description = htmlSnippet(str(j.content), LIST_CHARS, true);
    const workplace = (Array.isArray(j.metadata) ? j.metadata : []).find((m: any) => /workplace/i.test(str(m?.name)));
    const range = (Array.isArray(j.pay_input_ranges) ? j.pay_input_ranges : []).find((r: any) => r?.min_cents);
    const salary = range
      ? { min: range.min_cents / 100, max: range.max_cents ? range.max_cents / 100 : undefined, currency: str(range.currency_type) || undefined }
      : salaryFromDescription(description);
    return {
      id: `greenhouse:${slug}:${j.id}`, ats: "greenhouse", boardSlug: slug,
      company: boardName || str(j.company_name) || titleCase(slug),
      title: str(j.title).trim(), location,
      remote: /^remote$/i.test(str(workplace?.value)) || detectRemote(location, description),
      description, url: str(j.absolute_url), applyUrl: str(j.absolute_url),
      department: str(j.departments?.[0]?.name) || undefined,
      ...salaryProps(salary), postedAt: toIso(j.first_published) ?? toIso(j.updated_at),
    };
  });
}
