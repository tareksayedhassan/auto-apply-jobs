import type { NormalizedJob } from "../types.js";
import { htmlToText, htmlSnippet, truncateWords, LIST_CHARS, detectRemote, salaryFromDescription, salaryProps, toIso, titleCase } from "../text.js";
import { expectArray, getJson, mapSafe, str } from "./http.js";

/** Offer text (description + requirements); `max` bounds the conversion work, omit for the whole text. */
export function recruiteeText(o: any, max = Infinity): string {
  const conv = (h: unknown) => (max === Infinity ? htmlToText(str(h)) : htmlSnippet(str(h), max));
  const first = conv(o.description);
  const text = [first, first.length >= max ? "" : conv(o.requirements)].filter(Boolean).join("\n\n");
  return max === Infinity ? text : truncateWords(text, max);
}

export async function fetchBoard(slug: string): Promise<NormalizedJob[]> {
  const data = await getJson<any>(`https://${slug}.recruitee.com/api/offers/`);
  return mapSafe<any, NormalizedJob>(expectArray(data?.offers), o => {
    if (o.status && o.status !== "published") return undefined;
    const location = str(o.location) || [o.city, o.country].map(str).filter(Boolean).join(", ");
    const description = recruiteeText(o, LIST_CHARS);
    const s = o.salary;
    const salary = s?.min && /year/i.test(str(s.period))
      ? { min: Number(s.min), max: s.max ? Number(s.max) : undefined, currency: str(s.currency) || undefined }
      : salaryFromDescription(description);
    const url = str(o.careers_url);
    return {
      id: `recruitee:${slug}:${o.id}`, ats: "recruitee", boardSlug: slug,
      company: str(o.company_name) || titleCase(slug), title: str(o.title).trim(), location,
      remote: o.remote === true || detectRemote(location, description), description,
      url, applyUrl: str(o.careers_apply_url) || url,
      department: str(o.department) || undefined, employmentType: str(o.employment_type_code) || undefined,
      ...salaryProps(salary), postedAt: toIso(o.published_at),
    };
  });
}
