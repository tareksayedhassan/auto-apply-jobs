/**
 * Workday career sites through their public CXS JSON API (the endpoints the career site itself calls).
 * A board slug is `<tenant>.<wdN>/<site>`, the career site's host label and site id:
 * https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite -> "nvidia.wd5/NVIDIAExternalCareerSite".
 * The list (POST .../jobs, 20 per page) carries no posting text; details.ts fetches one posting on demand.
 */
import type { NormalizedJob } from "../types.js";
import { detectRemote, htmlToText, titleCase } from "../text.js";
import { expectArray, getJson, HttpError, mapSafe, markTruncated, NotFoundError, str } from "./http.js";

/** Workday's CXS list refuses pages above 20. */
const PAGE = 20;
/** 1,000 roles per tenant: the newest come first, and one giant employer must not dominate a sync. */
export const MAX_PAGES = 50;
/** Many tenants report exactly this total however many roles they hold, so a board that says 2000 may hold more. */
const TOTAL_CEILING = 2000;
const HOST_RE = /^([a-z0-9-]+)((?:\.wd\d+)?)\.myworkdayjobs\.com$/;
const LOCALE_RE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;
const SITE_RE = /^[A-Za-z0-9_-]+$/;

/** Workday tenants share infrastructure: every Workday request in this process waits its turn (default 400 ms apart). */
let nextAt = 0;
async function politely(): Promise<void> {
  const gap = Number(process.env.OPENAPPLY_WORKDAY_GAP_MS ?? 400) || 0;
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + gap;
  if (at > now) await new Promise(r => setTimeout(r, at - now));
}

/** The board slug a myworkdayjobs.com URL points at (career site, locale page, posting or CXS URL), else undefined. */
export function parseWorkdayUrl(raw: string): string | undefined {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return undefined; }
  const host = HOST_RE.exec(u.hostname.toLowerCase());
  if (!host) return undefined;
  let parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] === "wday" && parts[1] === "cxs") parts = parts.slice(3); // /wday/cxs/<tenant>/<site>/...
  else if (parts[0] && LOCALE_RE.test(parts[0])) parts = parts.slice(1);
  const site = parts[0];
  return site && SITE_RE.test(site) ? `${host[1]}${host[2]}/${site}` : undefined;
}

/** Host, tenant and site of a Workday board slug, or undefined when it is not one. */
export function workdayParts(slug: string): { host: string; tenant: string; site: string } | undefined {
  const m = /^([a-z0-9-]+)((?:\.wd\d+)?)\/([A-Za-z0-9_-]+)$/.exec(slug);
  return m ? { host: `${m[1]}${m[2]}.myworkdayjobs.com`, tenant: m[1], site: m[3] } : undefined;
}

function partsOrThrow(slug: string) {
  const p = workdayParts(slug);
  if (!p) throw new Error(`not a workday slug (want tenant.wdN/site): ${slug}`);
  return p;
}

/** Every distinct Workday board linked anywhere in a block of text, in order of first appearance. */
export function workdaySlugsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:https?:\/\/)?[A-Za-z0-9-]+(?:\.wd\d+)?\.myworkdayjobs\.com\/[^\s"'<>)\]|,]*/gi)) {
    const slug = parseWorkdayUrl(m[0]);
    if (slug) out.add(slug);
  }
  return [...out];
}

/** "Posted Today", "Posted Yesterday", "Posted 5 Days Ago", "Posted 30+ Days Ago" -> an ISO date; anything else undefined. */
export function postedOnToIso(label: string, now = new Date()): string | undefined {
  const s = label.trim().toLowerCase();
  const days = /\btoday\b/.test(s) ? 0 : /\byesterday\b/.test(s) ? 1 : Number(/(\d+)\+?\s+days?\s+ago/.exec(s)?.[1] ?? NaN);
  if (!Number.isFinite(days)) return undefined;
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** The posting's anchor id (last path segment): the CXS detail endpoint looks a posting up by it. */
const anchorOf = (externalPath: string) => externalPath.split("/").filter(Boolean).pop() ?? "";

/** "3 Locations" names nothing; the posting path's first segment is its main location ("US-CA-Santa-Clara"). */
function locationOf(j: any): string {
  const text = str(j.locationsText).trim();
  const many = /^(\d+)\s+locations?$/i.exec(text);
  if (!many) return text;
  const segs = str(j.externalPath).split("/").filter(Boolean);
  const main = segs[0] === "job" && segs.length > 2 ? segs[1].replace(/-+/g, " ").trim() : "";
  return main ? `${main} and ${Number(many[1]) - 1} more` : text;
}

/** POST one CXS list page. A wrong host or tenant answers 422, a wrong site 404: both mean no such board. */
async function listPage(p: { host: string; tenant: string; site: string }, offset: number): Promise<any> {
  await politely();
  try {
    return await getJson<any>(`https://${p.host}/wday/cxs/${p.tenant}/${p.site}/jobs`,
      { retries: 3, body: { appliedFacets: {}, limit: PAGE, offset, searchText: "" } });
  } catch (e) {
    if (e instanceof HttpError && e.status === 422) throw new NotFoundError(e.message);
    throw e;
  }
}

/** One list request: how many open roles a board says it has (2000 can mean more). Throws NotFoundError for no board. */
export async function workdayTotal(slug: string): Promise<number> {
  const data = await listPage(partsOrThrow(slug), 0);
  expectArray(data?.jobPostings);
  return Number(data?.total) || 0;
}

export async function fetchBoard(slug: string): Promise<NormalizedJob[]> {
  const p = partsOrThrow(slug);
  const company = titleCase(p.tenant);
  const seen = new Map<string, NormalizedJob>();
  let total = 0; // 0: Workday did not say, so page until a short page
  let capped = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await listPage(p, page * PAGE);
    const items = expectArray(data?.jobPostings);
    if (page === 0) total = Number(data?.total) || 0; // later pages answer total 0
    for (const j of mapSafe<any, NormalizedJob>(items, j => {
      const path = str(j.externalPath);
      const anchor = anchorOf(path);
      const title = str(j.title).trim();
      if (!anchor || !title) return undefined;
      const location = locationOf(j);
      const req = Array.isArray(j.bulletFields) ? j.bulletFields.map(str).filter(Boolean).join(", ") : "";
      const url = `https://${p.host}/${p.site}${path}`;
      return {
        id: `workday:${slug}:${anchor}`, ats: "workday", boardSlug: slug, company, title, location,
        remote: /\bremote\b/i.test(str(j.remoteType)) || detectRemote(location),
        // no company: the tenant label ("Fmr", "Hpe") is not the employer's name, and stub text is indexed for search
        description: [`${title}.`, location && `Location: ${location}.`, req && `Req: ${req}.`].filter(Boolean).join(" "),
        descriptionComplete: false, // the list carries no posting text; details.ts fetches it
        url, applyUrl: url, postedAt: postedOnToIso(str(j.postedOn)),
      };
    })) if (!seen.has(j.id)) seen.set(j.id, j);
    if (items.length < PAGE || (total > 0 && seen.size >= total)) break;
    capped = page === MAX_PAGES - 1;
  }
  const out = [...seen.values()];
  // the page cap, Workday's 2000 ceiling or a shifting order left roles unseen: sync must not close them
  if (capped || out.length < total || total === TOTAL_CEILING) markTruncated(out);
  return out;
}

/**
 * The CXS detail path of a stored posting URL (`https://<host>/<site>/job/<Location>/<anchor>`): `job/<Location>/<anchor>`,
 * the path the career site itself requests. A URL of another shape falls back to `job/<anchor>`.
 */
function detailPath(site: string, url: string, postingId: string): string {
  let parts: string[] = [];
  try { parts = new URL(url).pathname.split("/").filter(Boolean); } catch { /* fallback below */ }
  if (parts[0] && LOCALE_RE.test(parts[0])) parts = parts.slice(1);
  return parts[0] === site && parts[1] === "job" && parts.length > 2 ? parts.slice(1).join("/") : `job/${encodeURIComponent(postingId)}`;
}

/** The complete text of one posting: description, then where and how. Throws NotFoundError when it is gone. */
export async function workdayPostingText(slug: string, postingId: string, url = ""): Promise<string | undefined> {
  const p = partsOrThrow(slug);
  await politely();
  const d = await getJson<any>(`https://${p.host}/wday/cxs/${p.tenant}/${p.site}/${detailPath(p.site, url, postingId)}`);
  const info = d?.jobPostingInfo;
  const body = htmlToText(str(info?.jobDescription));
  if (!body) return undefined;
  const locations = [str(info.location), ...(Array.isArray(info.additionalLocations) ? info.additionalLocations.map(str) : [])].filter(Boolean);
  const facts = [
    locations.length && `Locations: ${locations.join("; ")}`,
    str(info.timeType) && `Time type: ${str(info.timeType)}`,
    str(info.jobReqId) && `Req: ${str(info.jobReqId)}`,
  ].filter(Boolean);
  return facts.length ? `${body}\n\n${facts.join("\n")}` : body;
}
