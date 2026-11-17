import type { NormalizedJob } from "../types.js";
import { decodeEntities, htmlToText, detectRemote, salaryFromDescription, salaryProps, toIso } from "../text.js";
import { getJson, mapSafe, str } from "./http.js";

const ROLE = /engineer|developer|designer|manager|scientist|director|lead\b|sre\b|devops|analyst|product|founding|researcher|architect|head of|recruiter|sales|marketing|support|intern|cto\b|swe\b|\bml\b|\bai\b|full[- ]?stack|backend|frontend/i;
const PLACE = /remote|onsite|on-site|hybrid|\b[A-Z][a-z]+(?: [A-Z][a-z]+)?, ?[A-Z]{2}\b|\b(?:usa?|uk|eu|europe|canada|germany|berlin|london|paris|nyc|new york|sf|san francisco|bay area|seattle|boston|austin|toronto|amsterdam|zurich)\b/i;

export async function fetchFeed(): Promise<NormalizedJob[]> {
  const search = await getJson<any>("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=who%20is%20hiring");
  const thread = (search?.hits ?? []).find((h: any) => /who is hiring/i.test(str(h.title)));
  if (!thread) return [];
  const item = await getJson<any>(`https://hn.algolia.com/api/v1/items/${thread.objectID}`, { timeoutMs: 45_000 });
  return mapSafe<any, NormalizedJob>(item?.children, c => {
    const html = str(c.text);
    if (!c.id || html.length < 40) return undefined;
    const description = htmlToText(html);
    const first = htmlToText(html.split(/<p>/i)[0]).split("\n")[0];
    const parts = first.split(/\s*\|\s*/).length > 1 ? first.split(/\s*\|\s*/) : first.split(/\s+[—–-]\s+/);
    const company = parts[0].replace(/\s*\(.*?\)\s*$/, "").trim();
    if (!company) return undefined;
    const rest = parts.slice(1).map(p => p.trim()).filter(Boolean);
    const title = rest.find(p => ROLE.test(p) && p.length < 120) ?? "See posting";
    const location = rest.find(p => p !== title && PLACE.test(p) && p.length < 80) ?? "";
    const href = html.match(/href="([^"]+)"/i)?.[1];
    const url = `https://news.ycombinator.com/item?id=${c.id}`;
    return {
      id: `hn:${thread.objectID}:${c.id}`, ats: "hn", boardSlug: "hn", company, title, location,
      remote: detectRemote(`${location} ${first}`), description, url,
      applyUrl: href ? decodeEntities(href) : url, ...salaryProps(salaryFromDescription(first) ?? salaryFromDescription(description)),
      postedAt: toIso(c.created_at),
    };
  });
}
