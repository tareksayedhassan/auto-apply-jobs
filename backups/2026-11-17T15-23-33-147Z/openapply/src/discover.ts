import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Ats, Board } from "./types.js";
import { ensureHome, paths } from "./paths.js";
import { BOARD_SOURCES, loadBoards, type BoardsFile } from "./sources/index.js";
import { NotFoundError } from "./sources/http.js";
import { parseWorkdayUrl, workdaySlugsIn, workdayTotal } from "./sources/workday.js";
import { getDb } from "./db.js";

const SUFFIXES = new Set(["inc", "labs", "lab", "ai", "hq", "co", "corp", "llc", "ltd", "technologies", "technology", "group"]);

/** Likely ATS slugs for a company name, most probable first (max 6). */
export function slugCandidates(name: string): string[] {
  const words = name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9\s-]/g, "").split(/[\s-]+/).filter(Boolean);
  const core = words.filter(w => !SUFFIXES.has(w));
  const variants = [
    words.join(""), words.join("-"), core.join(""), core.join("-"),
    core[0] ?? "", `${core.join("")}hq`,
  ];
  return [...new Set(variants.filter(v => v.length > 1))].slice(0, 6);
}

const PROBE_ORDER: Ats[] = ["greenhouse", "lever", "ashby", "workable", "recruitee", "smartrecruiters"];

/**
 * Probe every board ATS for a company; hits with open jobs come first. Workday needs the career site's own URL
 * (its host and site id cannot be guessed from a name), so a myworkdayjobs.com URL probes that one board, with one
 * request: the caller's sync pages it. Its company is the board list's name for it, never the tenant label ("Fmr").
 */
export async function discoverCompany(name: string): Promise<Array<Board & { jobCount: number }>> {
  const workday = parseWorkdayUrl(name.trim());
  if (workday) {
    let jobCount: number;
    try { jobCount = await workdayTotal(workday); }
    catch (e) { if (e instanceof NotFoundError) return []; throw e; } // a 5xx or 429 is not "no board"
    const company = loadBoards().find(b => b.ats === "workday" && b.slug === workday)?.company;
    return [{ ats: "workday", slug: workday, company, jobCount }];
  }
  const hits: Array<Board & { jobCount: number }> = [];
  const probes = slugCandidates(name).flatMap(slug => PROBE_ORDER.map(async ats => {
    try {
      const jobs = await BOARD_SOURCES[ats]!(slug);
      // SmartRecruiters answers 200 with nothing for any slug, so an empty result proves nothing there
      if (!jobs.length && ats === "smartrecruiters") return;
      hits.push({ ats, slug, company: jobs[0]?.company, jobCount: jobs.length });
    } catch { /* not on this ATS */ }
  }));
  await Promise.all(probes);
  return hits.sort((a, b) => (b.jobCount > 0 ? 1 : 0) - (a.jobCount > 0 ? 1 : 0) || b.jobCount - a.jobCount);
}

/**
 * Workday boards that indexed postings already link to (a feed role whose apply link is a myworkdayjobs.com page,
 * or a URL in its text) and that no board list names yet. The company is the first posting's company.
 */
export function workdayBoardsFromIndex(): Board[] {
  const known = new Set(loadBoards().filter(b => b.ats === "workday").map(b => b.slug));
  const rows = getDb().prepare(`SELECT company, url, apply_url, description FROM jobs
    WHERE url LIKE '%myworkdayjobs.com%' OR apply_url LIKE '%myworkdayjobs.com%' OR description LIKE '%myworkdayjobs.com%'
    ORDER BY first_seen`).all() as Array<{ company: string; url: string; apply_url: string; description: string }>;
  const found = new Map<string, Board>();
  for (const r of rows) {
    for (const slug of workdaySlugsIn(`${r.url} ${r.apply_url} ${r.description}`)) {
      if (!known.has(slug) && !found.has(slug)) found.set(slug, { ats: "workday", slug, company: r.company || undefined });
    }
  }
  return [...found.values()];
}

/** Merge boards into ~/.openapply/boards.json (same format as data/boards.json). */
export function addUserBoards(boards: Board[]): void {
  ensureHome();
  let data: BoardsFile = {};
  if (existsSync(paths.userBoards)) {
    try { data = JSON.parse(readFileSync(paths.userBoards, "utf8")) ?? {}; } catch { data = {}; }
  }
  for (const b of boards) {
    const list = (data[b.ats] ??= []);
    const i = list.findIndex(e => (typeof e === "string" ? e : e.slug) === b.slug);
    const entry = b.company ? { slug: b.slug, company: b.company } : b.slug;
    if (i < 0) list.push(entry);
    else if (b.company) list[i] = entry;
  }
  writeFileSync(paths.userBoards, JSON.stringify(data, null, 2) + "\n");
}
