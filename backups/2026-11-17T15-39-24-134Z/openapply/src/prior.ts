import { getJob, listApplications } from "./db.js";
import type { Application, ApplicationStatus, Job } from "./types.js";

/** An application made earlier at the same company (OpenApply's own, or imported from history). */
export interface PriorApplication {
  jobId: string;
  company: string;
  title: string;
  status: ApplicationStatus;
  /** Date the application went in: submittedAt, else the last update. ISO string as stored. */
  appliedAt: string;
  /** The title is close enough to this job's that it is the same role: fill and draft refuse unless forced. */
  similarTitle: boolean;
  /** Came from import_history rather than from OpenApply. */
  imported: boolean;
}

/** Thrown by assertNotDuplicate; the HTTP server answers 409 with `priors`. */
export class DuplicateApplicationError extends Error {
  constructor(message: string, public priors: PriorApplication[]) { super(message); }
}

// ---- company names ----

const COMPANY_SUFFIXES = new Set(["inc", "llc", "ltd", "corp", "co", "ai", "labs", "hq", "technologies"]);
/** Renames with no "(formerly ...)" in the name to link them. Keys and values are already normalized. */
const COMPANY_ALIASES: Record<string, string> = { asksoylent: "soylent" };
const FORMER = /^(?:formerly|f\/k\/a|fka|previously|aka|a\.k\.a\.?)\s+(.+)$/i;

/** Lowercase with accents folded away: "Café" and "cafe" compare equal. */
export const fold = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

function squash(name: string): string {
  const tokens = fold(name).replace(/&/g, " and ").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  const key = tokens.join("");
  return COMPANY_ALIASES[key] ?? key;
}

/** Every normalized name a company goes by: its own, plus any "(formerly X)" in the text. */
export function companyKeys(name: string): string[] {
  const keys = [squash(name.replace(/\([^)]*\)/g, " "))];
  for (const m of name.matchAll(/\(([^)]*)\)/g)) {
    const former = FORMER.exec(m[1].trim());
    if (former) keys.push(squash(former[1]));
  }
  return [...new Set(keys.filter(Boolean))];
}

export function sameCompany(a: string, b: string): boolean {
  const kb = new Set(companyKeys(b));
  return companyKeys(a).some(k => kb.has(k));
}

// ---- titles ----

const LEVEL_WORDS = new Set(["senior", "sr", "staff", "principal", "lead", "junior", "jr", "associate", "intern"]);
const STOP_WORDS = new Set(["the", "a", "an", "of", "and", "for", "to", "at", "in", "i", "ii", "iii"]);
const SYNONYMS: Record<string, string[]> = { fde: ["forward", "deployed", "engineer"] };

function titleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (LEVEL_WORDS.has(w) || STOP_WORDS.has(w)) continue;
    for (const t of SYNONYMS[w] ?? [w]) out.add(t.length > 3 ? t.replace(/s$/, "") : t);
  }
  return out;
}

/**
 * Same role if the titles share at least 60% of their words (level words like Senior and filler like "of" ignored).
 * "Forward Deployed Engineer" and "Delivery Strategist" share none: the same job family to a person but not
 * to a word match, so that pair is a warning, never a block.
 */
export function titlesSimilar(a: string, b: string): boolean {
  const ta = titleTokens(a), tb = titleTokens(b);
  if (!ta.size || !tb.size) return false;
  const shared = [...ta].filter(t => tb.has(t)).length;
  return shared / (ta.size + tb.size - shared) >= 0.6;
}

// ---- prior applications ----

type AppRow = Application & { job?: Job };

const WENT_IN: ApplicationStatus[] = ["submitted", "interview", "offer", "rejected", "ghosted"];

/** The application went in: stamped with a submit date, or in a state only a sent application reaches. Withdrawn alone is not (Withdraw also drops a role never sent), nor is a CAPTCHA stop. */
export function isApplied(a: Application): boolean {
  return !!a.submittedAt || WENT_IN.includes(a.status);
}

/** The applied rows, loaded once so a list of jobs does one pass. */
export function appliedRows(): AppRow[] {
  return listApplications().filter(a => a.job && isApplied(a));
}

export function priorApplications(company: string, title?: string, excludeJobId?: string, rows: AppRow[] = appliedRows()): PriorApplication[] {
  return rows
    .filter(a => a.jobId !== excludeJobId && sameCompany(a.job!.company, company))
    .map(a => ({
      jobId: a.jobId, company: a.job!.company, title: a.job!.title, status: a.status,
      appliedAt: a.submittedAt ?? a.updatedAt,
      similarTitle: !!title && titlesSimilar(a.job!.title, title),
      imported: a.source === "history",
    }))
    .sort((x, y) => Number(y.similarTitle) - Number(x.similarTitle) || y.appliedAt.localeCompare(x.appliedAt));
}

export function priorWarning(priors: PriorApplication[]): string | undefined {
  return priors.length
    ? priors.map(p => `Already applied to ${p.company} · ${p.title} on ${p.appliedAt.slice(0, 10)}`).join("; ")
    : undefined;
}

/** The fields every job surface carries: the earlier applications at this company and a one-line warning. */
export function priorFields(job: Pick<Job, "id" | "company" | "title">, rows?: AppRow[]): { priorApplications: PriorApplication[]; warning?: string } {
  const priors = priorApplications(job.company, job.title, job.id, rows);
  const warning = priorWarning(priors);
  return warning ? { priorApplications: priors, warning } : { priorApplications: priors };
}

/** Draft and fill stop when the same role (same company, similar title) already went in under another job id. */
export function assertNotDuplicate(jobId: string, force = false): void {
  const job = getJob(jobId);
  if (!job || force) return;
  const dupes = priorApplications(job.company, job.title, jobId).filter(p => p.similarTitle);
  if (dupes.length) {
    throw new DuplicateApplicationError(`${priorWarning(dupes)}. Pass force:true to apply anyway.`, dupes);
  }
}
