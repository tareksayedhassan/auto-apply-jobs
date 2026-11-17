import { addEvent, getDb, kvGet, kvSetJson, listApplications, setApplication } from "./db.js";
import { listOutreach } from "./outreach.js";
import { isApplied, sameCompany, titlesSimilar } from "./prior.js";
import { STATUSES, updateStatus } from "./track.js";
import type { Application, ApplicationStatus, Job } from "./types.js";

/**
 * What the employer said, as read from mail by the agent (the server stays LLM-free): a rejection, an interview
 * invite, or an acknowledgement that the application arrived. Silence is not a mail: ageOutProposals proposes those.
 */
export type OutcomeKind = "rejected" | "interview" | "ack";
export const OUTCOME_KINDS: OutcomeKind[] = ["rejected", "interview", "ack"];

export interface OutcomeItem {
  company: string;
  /** Narrows the match when the mail names the role. */
  title?: string;
  kind: OutcomeKind;
  /** When the mail arrived (or the interview is set for), starting YYYY-MM-DD. */
  date: string;
  /** The mail's id: the same id never applies twice to the same application. */
  source_id: string;
  snippet?: string;
  /**
   * Where an interview's date came from, as the inbox sweep reports it: "invite" or "invite-wall-time" (the
   * invitation's start, a scheduled conversation) or "mail" (the day the mail came: a notice that a process is
   * active, not a conversation date). Kept in the interview event for the scoreboard, with the mail's own date.
   */
  date_source?: string;
  mail_date?: string;
  /** Interview only: the date this invite replaces (a reschedule), kept in the event so the scoreboard moves that conversation. */
  rescheduled_from?: string;
}

interface Candidate { jobId: string; company: string; title: string; status: ApplicationStatus }

export interface OutcomeReport {
  applied: Array<{ source_id: string; jobId: string; company: string; title: string; kind: OutcomeKind; from: ApplicationStatus; to: ApplicationStatus }>;
  skipped: Array<{ source_id: string; reason: string }>;
  /** More than one application fits: nothing changed, a human picks (update_application). */
  ambiguous: Array<{ source_id: string; company: string; title?: string; kind: OutcomeKind; candidates: Candidate[] }>;
  /** Outreach a rejection made moot. Proposed only: close it with update_outreach if the user agrees. */
  proposals: Array<{ outreachId: number; action: "close"; company: string; person: string; status: string; reason: string }>;
}

const TARGET: Record<OutcomeKind, ApplicationStatus> = { rejected: "rejected", interview: "interview", ack: "submitted" };
/** Keyed per application, so one mail that names two roles moves both. */
const outcomeKey = (sourceId: string, jobId: string) => `outcome:${sourceId}:${jobId}`;
/** Closed for good: an outcome never moves these, and they do not compete with a newer application at the company. */
const CLOSED: ApplicationStatus[] = ["rejected", "withdrawn"];
const DAY = 86400e3;

/**
 * Status only moves forward in STATUSES order. Rejected, withdrawn and offer are final here (an offer changes only
 * by hand). Two exceptions, both toward the truth: an ack moves needs_human (stopped at a CAPTCHA) to submitted,
 * and a real interview or rejection replaces ghosted, which was only a guess from silence.
 */
function movesForward(from: ApplicationStatus, to: ApplicationStatus): boolean {
  if (CLOSED.includes(from) || from === "offer") return false;
  if (from === "needs_human" && to === "submitted") return true;
  if (from === "ghosted") return to === "interview" || to === "rejected";
  return STATUSES.indexOf(to) > STATUSES.indexOf(from);
}

function invalid(item: OutcomeItem): string | undefined {
  if (typeof item?.source_id !== "string" || !item.source_id.trim()) return "source_id is required";
  if (typeof item.company !== "string" || !item.company.trim()) return "company is required";
  if (!OUTCOME_KINDS.includes(item.kind)) return `kind must be one of ${OUTCOME_KINDS.join(", ")}`;
  // Date.parse reads "Oct 30" as 2001-10-30, so the year must be written out.
  if (typeof item.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(item.date.trim()) || Number.isNaN(Date.parse(item.date))) return "date must start YYYY-MM-DD, like 2026-10-31";
  if (item.title !== undefined && typeof item.title !== "string") return "title must be a string";
  return undefined;
}

type Row = Application & { job?: Job };
const candidate = (a: Row): Candidate => ({ jobId: a.jobId, company: a.job!.company, title: a.job!.title, status: a.status });

/** Every application at the company (and with a similar title, when the mail names one). */
function matches(item: OutcomeItem, rows: Row[]): { found: Row[]; titleMissed: boolean } {
  const atCompany = rows.filter(a => a.job && sameCompany(a.job.company, item.company));
  if (!item.title?.trim()) return { found: atCompany, titleMissed: false };
  const byTitle = atCompany.filter(a => titlesSimilar(a.job!.title, item.title!));
  return byTitle.length ? { found: byTitle, titleMissed: false } : { found: atCompany, titleMissed: atCompany.length > 0 };
}

/**
 * Record employer outcomes read from mail. Each item matches one application by company (and title when given);
 * zero or several matches change nothing (skipped or ambiguous). Status only moves forward and never touches an
 * application that has not gone in yet. An interview also gets a dated 'interview' event; a rejection proposes
 * closing open outreach at that company. Applied items are remembered by source_id per application, so a replay is a
 * no-op, and a rejection or ack dated before the application went in is skipped (an old mail never closes a new one).
 */
export function applyOutcomes(items: OutcomeItem[]): OutcomeReport {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  const report: OutcomeReport = { applied: [], skipped: [], ambiguous: [], proposals: [] };
  const d = getDb();
  for (const item of items) {
    const sourceId = typeof item?.source_id === "string" ? item.source_id.trim() : String(item?.source_id ?? "");
    const skip = (reason: string) => { report.skipped.push({ source_id: sourceId, reason }); };
    const bad = invalid(item);
    if (bad) { skip(bad); continue; }

    const { found, titleMissed } = matches(item, listApplications());
    if (found.some(a => kvGet(outcomeKey(sourceId, a.jobId)) !== undefined)) { skip("already recorded (same source_id)"); continue; }
    // An outcome is about an application that went in; rows still in the user's hands are never moved.
    const sent = found.filter(a => isApplied(a) || a.status === "needs_human");
    const live = sent.filter(a => !CLOSED.includes(a.status));
    const describe = (rows: Row[]) => rows.map(a => `${a.job!.company} · ${a.job!.title} is ${a.status}`).join("; ");
    const ambiguous = (rows: Row[]) => report.ambiguous.push({ source_id: sourceId, company: item.company, title: item.title, kind: item.kind, candidates: rows.map(candidate) });
    if (!found.length) { skip(`no application at ${item.company}`); continue; }
    if (titleMissed) { ambiguous(found); continue; }
    if (live.length > 1) { ambiguous(live); continue; }
    if (!live.length) {
      skip(sent.length ? `${describe(sent)}: closed, status never moves back` : `${describe(found)}: nothing sent there yet, a human moves it`);
      continue;
    }

    const app = live[0];
    const from = app.status, to = TARGET[item.kind];
    const date = item.date.trim();
    if (item.kind !== "interview" && app.submittedAt && date.slice(0, 10) < app.submittedAt.slice(0, 10)) {
      skip(`mail predates this application (${app.job!.company} · ${app.job!.title} went in ${app.submittedAt.slice(0, 10)})`);
      continue;
    }
    const repeatInterview = item.kind === "interview" && from === "interview";
    if (!repeatInterview && !movesForward(from, to)) {
      skip(from === to ? `already ${from}` : `${app.job!.company} · ${app.job!.title} is ${from}: status never moves back to ${to}`);
      continue;
    }

    const snippet = item.snippet?.trim().replace(/\s+/g, " ").slice(0, 300);
    d.exec("BEGIN");
    try {
      if (from !== to) {
        updateStatus(app.jobId, to, `${item.kind} (mail ${date})${snippet ? `: ${snippet}` : ""}`);
        if (to === "submitted" && !app.submittedAt) setApplication(app.jobId, { submittedAt: date });
      }
      if (item.kind === "interview") {
        addEvent(app.jobId, "interview", JSON.stringify({ summary: snippet ? `${date}: ${snippet}` : date, date, source_id: sourceId,
          ...(typeof item.date_source === "string" ? { date_source: item.date_source } : {}),
          ...(typeof item.mail_date === "string" ? { mail_date: item.mail_date } : {}),
          ...(typeof item.rescheduled_from === "string" ? { rescheduled_from: item.rescheduled_from } : {}) }));
      }
      kvSetJson(outcomeKey(sourceId, app.jobId), { jobId: app.jobId, kind: item.kind, from, to, at: new Date().toISOString() });
      d.exec("COMMIT");
    } catch (e) { d.exec("ROLLBACK"); throw e; }
    report.applied.push({ source_id: sourceId, jobId: app.jobId, company: app.job!.company, title: app.job!.title, kind: item.kind, from, to });

    if (item.kind === "rejected") {
      for (const o of listOutreach()) {
        if ((o.status !== "sent" && o.status !== "draft") || !(o.jobId === app.jobId || sameCompany(o.company, app.job!.company))) continue;
        if (report.proposals.some(p => p.outreachId === o.id)) continue;
        report.proposals.push({ outreachId: o.id, action: "close", company: o.company, person: o.person, status: o.status,
          reason: `${app.job!.company} rejected ${app.job!.title} (${date})` });
      }
    }
  }
  return report;
}

export interface AgeOutProposal { jobId: string; company: string; title: string; daysSince: number; propose: "ghosted" }

/** Submitted applications with no answer for `days` or more, oldest first. Proposed only: never moved automatically. */
export function ageOutProposals(days = 45): AgeOutProposal[] {
  const now = Date.now();
  return listApplications("submitted")
    .map(a => ({ a, age: now - Date.parse(a.submittedAt ?? a.updatedAt) }))
    .filter(({ a, age }) => a.job && age > days * DAY)
    .map(({ a, age }) => ({ a, daysSince: Math.floor(age / DAY) }))
    .sort((x, y) => y.daysSince - x.daysSince)
    .map(({ a, daysSince }) => ({ jobId: a.jobId, company: a.job!.company, title: a.job!.title, daysSince, propose: "ghosted" as const }));
}
