import { addEvent, getApplication, getDb, insertHistoryJob, setApplication } from "./db.js";
import { companyKeys, fold, isApplied, sameCompany } from "./prior.js";
import { STATUSES } from "./track.js";
import type { ApplicationStatus } from "./types.js";

export interface HistoryRecord {
  company: string;
  title: string;
  /** When the application went in; becomes submitted_at. Anything Date.parse reads, stored as YYYY-MM-DD unless already ISO. */
  appliedAt: string;
  status: ApplicationStatus;
  url?: string;
}

export interface HistoryReport {
  /** Placeholder jobs made for roles the index does not hold. */
  created: number;
  /** Records that matched an existing job and changed its application. */
  attached: number;
  unchanged: number;
}

/** Every status but approved, which is OpenApply's own go-ahead on a filled form: a past application never has it. */
export const HISTORY_STATUSES: ApplicationStatus[] = STATUSES.filter(s => s !== "approved");

const slug = (s: string) => fold(s).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const stubId = (r: HistoryRecord) => `history:${companyKeys(r.company)[0] ?? slug(r.company)}:${slug(r.title)}`;
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const urlOf = (u: string) => u.trim().replace(/\/+$/, "");

/** An ISO date (with or without a time) is kept as written; anything else Date.parse reads becomes YYYY-MM-DD. */
function isoDate(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function validate(records: HistoryRecord[]): void {
  if (!Array.isArray(records)) throw new Error("records must be an array");
  records.forEach((r, i) => {
    const at = `Record ${i + 1}`;
    for (const k of ["company", "title"] as const) {
      if (typeof r?.[k] !== "string" || !slug(r[k])) throw new Error(`${at}: ${k} is required`);
    }
    if (typeof r.appliedAt !== "string" || Number.isNaN(Date.parse(r.appliedAt))) throw new Error(`${at}: appliedAt must be a date like 2026-08-28`);
    if (!HISTORY_STATUSES.includes(r.status)) throw new Error(`${at}: status must be one of ${HISTORY_STATUSES.join(", ")}`);
    if (r.url !== undefined && typeof r.url !== "string") throw new Error(`${at}: url must be a string`);
  });
}

/** Existing postings that could match the records: same URL, or a company the records name. One pass each over the index. */
function candidates(records: HistoryRecord[]) {
  const d = getDb();
  const urls = [...new Set(records.flatMap(r => r.url ? [urlOf(r.url), urlOf(r.url) + "/"] : []))];
  const byUrl = new Map<string, string>();
  for (let i = 0; i < urls.length; i += 400) {
    const chunk = urls.slice(i, i + 400), marks = chunk.map(() => "?").join(",");
    for (const row of d.prepare(`SELECT id, url, apply_url FROM jobs WHERE url IN (${marks}) OR apply_url IN (${marks})`).all(...chunk, ...chunk) as any[]) {
      byUrl.set(urlOf(row.url), row.id); byUrl.set(urlOf(row.apply_url), row.id);
    }
  }
  const wanted = new Set(records.flatMap(r => companyKeys(r.company)));
  const names = (d.prepare("SELECT DISTINCT company FROM jobs").all() as any[]).map(r => r.company as string)
    .filter(c => companyKeys(c).some(k => wanted.has(k)));
  const jobs: Array<{ id: string; company: string; title: string }> = [];
  for (let i = 0; i < names.length; i += 400) {
    const chunk = names.slice(i, i + 400);
    jobs.push(...d.prepare(`SELECT id, company, title FROM jobs WHERE company IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as any[]);
  }
  return { byUrl, jobs };
}

/**
 * Record applications made before OpenApply. A record attaches to the posting its URL names, or, with no URL, to the
 * one with the same company and title; anything else gets a closed placeholder job (a similar title is not the same
 * posting, and the duplicate guard warns about it instead). History is the lowest authority: it creates an application
 * or completes one that has not gone in yet, and never changes the status of one that has. Running it again changes nothing.
 */
export function importHistory(records: HistoryRecord[]): HistoryReport {
  validate(records);
  const { byUrl, jobs } = candidates(records);
  const report: HistoryReport = { created: 0, attached: 0, unchanged: 0 };
  for (const r of records) {
    const found = r.url?.trim()
      ? byUrl.get(urlOf(r.url))
      : jobs.find(j => sameCompany(j.company, r.company) && sameTitle(j.title, r.title))?.id;
    const id = found ?? stubId(r);
    const made = !found && insertHistoryJob(id, r.company, r.title, r.url);
    const prev = getApplication(id);
    if (prev?.submittedAt) { report.unchanged++; continue; } // already dated, so already applied: nothing to add
    const upgrade = !prev || !isApplied(prev); // else it went in by status alone (no date): keep the status, add the date
    setApplication(id, {
      submittedAt: isoDate(r.appliedAt),
      ...(upgrade ? { status: r.status, confirmationCode: undefined } : {}),
      ...(prev ? {} : { source: "history" as const }),
    });
    addEvent(id, "imported", "Imported from history");
    if (made) report.created++; else report.attached++;
  }
  return report;
}

/**
 * One application the user sent outside OpenApply (LinkedIn Easy Apply, a company site). Its URL is usually not the
 * board posting the index holds, so a URL that matches nothing falls back to the same company and title before a
 * placeholder is made. The date must carry its year: Date.parse reads "Oct 30" as 2001.
 */
export function logAppliedOffsite(r: { company: string; title: string; url?: string; date: string }): HistoryReport {
  if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(r.date.trim())) throw new Error("date must start YYYY-MM-DD, like 2026-11-02");
  const rec: HistoryRecord = { company: r.company, title: r.title, url: r.url, appliedAt: r.date.trim(), status: "submitted" };
  if (rec.url?.trim()) {
    const { byUrl, jobs } = candidates([rec]);
    if (!byUrl.has(urlOf(rec.url)) && jobs.some(j => sameCompany(j.company, rec.company) && sameTitle(j.title, rec.title))) rec.url = undefined;
  }
  return importHistory([rec]);
}
