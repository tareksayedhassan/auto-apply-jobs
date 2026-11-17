import type { NormalizedJob } from "../types.js";
import { htmlToText, htmlSnippet, truncateWords, LIST_CHARS, detectRemote, salaryFromDescription, salaryProps, toIso, titleCase } from "../text.js";
import { expectArray, getJson, mapSafe, NotFoundError, str } from "./http.js";

const HOSTS = ["https://api.lever.co", "https://api.eu.lever.co"];

/**
 * Posting text from a Lever posting object: intro, then the lists (responsibilities, requirements), then the
 * closing note. `max` stops the conversion once enough text is in (omit for the whole posting).
 */
export function leverText(j: any, max = Infinity): string {
  const parts: string[] = [];
  let len = 0;
  const add = (t: string) => { if (t) { parts.push(t); len += t.length + 2; } };
  add(str(j.descriptionPlain) || (max === Infinity ? htmlToText(str(j.description)) : htmlSnippet(str(j.description), max)));
  for (const l of Array.isArray(j.lists) ? j.lists : []) {
    if (len >= max) break;
    add(`${str(l.text)}\n${max === Infinity ? htmlToText(str(l.content)) : htmlSnippet(str(l.content), max)}`);
  }
  if (len < max) add(str(j.additionalPlain));
  const text = parts.join("\n\n");
  return max === Infinity ? text : truncateWords(text, max);
}

export async function fetchBoard(slug: string): Promise<NormalizedJob[]> {
  let data: unknown;
  for (const host of HOSTS) {
    try { data = await getJson(`${host}/v0/postings/${slug}?mode=json`); break; }
    catch (e) { if (!(e instanceof NotFoundError) || host === HOSTS.at(-1)) throw e; }
  }
  return mapSafe<any, NormalizedJob>(expectArray(data), j => {
    const cats = j.categories ?? {};
    const location = str(cats.location) || (Array.isArray(cats.allLocations) ? cats.allLocations.join("; ") : "");
    const description = leverText(j, LIST_CHARS);
    const sr = j.salaryRange;
    const salary = sr && /year/i.test(str(sr.interval)) && sr.min
      ? { min: sr.min, max: sr.max, currency: str(sr.currency) || undefined }
      : salaryFromDescription(description);
    return {
      id: `lever:${slug}:${j.id}`, ats: "lever", boardSlug: slug, company: titleCase(slug),
      title: str(j.text).trim(), location,
      remote: str(j.workplaceType) === "remote" || detectRemote(location, description),
      description, url: str(j.hostedUrl), applyUrl: str(j.applyUrl) || `${str(j.hostedUrl)}/apply`,
      department: str(cats.team) || undefined, employmentType: str(cats.commitment) || undefined,
      ...salaryProps(salary), postedAt: toIso(j.createdAt),
    };
  });
}
