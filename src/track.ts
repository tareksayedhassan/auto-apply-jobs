import { addEvent, getApplication, getJob, kvGetJson, kvSetJson, listApplications, listEvents, setApplication } from "./db.js";
import { isLever } from "./apply/detect.js";
import type { Application, ApplicationEvent, ApplicationStatus, Job, StoredFill } from "./types.js";

export const STATUSES: ApplicationStatus[] = [
  "saved", "drafted", "filled", "approved", "submitted", "needs_human",
  "interview", "offer", "rejected", "withdrawn", "ghosted",
];

const stamp = (note: string) => `${new Date().toISOString().slice(0, 10)}: ${note}`;

function requireJob(jobId: string): void {
  if (!getJob(jobId)) throw new Error(`Unknown job: ${jobId}`);
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}:\s*/;

/**
 * Append a dated note to whatever notes the application already has. A note the caller already dated is
 * not dated again, and one the last note already says (a retry, or its tail repeated) is skipped: undefined.
 */
function appendNote(prev: string | undefined, note: string): string | undefined {
  const text = note.trim().replace(DATE_PREFIX, "");
  const last = prev?.split("\n").pop()?.replace(DATE_PREFIX, "");
  if (!text || (last !== undefined && last.endsWith(text))) return undefined;
  const line = stamp(text);
  return prev ? `${prev}\n${line}` : line;
}

/** Bookmark a job. An application that already exists keeps its status. */
export function saveJob(jobId: string, notes?: string): Application {
  requireJob(jobId);
  const prev = getApplication(jobId);
  if (!notes) return prev ?? setApplication(jobId, { status: "saved" });
  const next = appendNote(prev?.notes, notes);
  if (next === undefined) return prev ?? setApplication(jobId, { status: "saved" });
  const app = setApplication(jobId, { status: prev?.status ?? "saved", notes: next });
  addEvent(jobId, "note", notes);
  return app;
}

export const LEVER_NO_PROOF = "Marked submitted without Lever's confirmation (no /thanks page or \"Application submitted!\" seen by OpenApply). Check for Lever's confirmation email before counting it.";

/** A hand-set "submitted" on a Lever job whose note does not cite the /thanks page: Lever may have refused it (verification banner). */
function leverWithoutProof(jobId: string, prev: Application | undefined, note?: string): boolean {
  const job = getJob(jobId);
  if (!job || prev?.status === "submitted") return false;
  if (job.ats !== "lever" && !isLever(job.applyUrl || job.url)) return false;
  return !/\/thanks\b|application submitted!?/i.test(note ?? "");
}

export function updateStatus(jobId: string, status: ApplicationStatus, note?: string): Application {
  if (!STATUSES.includes(status)) throw new Error(`Unknown status "${status}". Use one of: ${STATUSES.join(", ")}`);
  if (status === "approved") throw new Error(`Cannot approve ${jobId} by setting a status: use approve with the confirmation code shown for the fill.`);
  requireJob(jobId);
  const prev = getApplication(jobId);
  const patch: Partial<Application> = { status };
  if (status === "submitted" && !prev?.submittedAt) patch.submittedAt = new Date().toISOString();
  const notes = [note, status === "submitted" && leverWithoutProof(jobId, prev, note) ? LEVER_NO_PROOF : undefined].filter((n): n is string => !!n);
  const added: string[] = [];
  let next = prev?.notes;
  for (const n of notes) {
    const after = appendNote(next, n);
    if (after !== undefined) { next = after; added.push(n); }
  }
  if (added.length) patch.notes = next;
  const app = setApplication(jobId, patch);
  for (const n of added) addEvent(jobId, "note", n);
  return app;
}

/**
 * The user's go-ahead for one specific fill: lets submit proceed without the agent passing the code.
 * `code` must be the confirmation code the user was shown, so a re-fill they never saw can't ride on it.
 */
export function approve(jobId: string, code: string | undefined): Application {
  requireJob(jobId);
  const app = getApplication(jobId);
  if (!app || app.status !== "filled") {
    throw new Error(`Cannot approve ${jobId}: status is ${app ? `"${app.status}"` : "none"}, expected "filled".`);
  }
  if (!code || !app.confirmationCode || code.trim().toUpperCase() !== app.confirmationCode) {
    throw new Error(`Cannot approve ${jobId}: the form was filled again since you looked. Review the latest fill and approve that one.`);
  }
  const blanks = currentFill(jobId, app)?.blanks ?? [];
  if (blanks.length) throw new Error(`Cannot approve ${jobId}: required fields are blank on the form: ${blanks.join(", ")}`);
  return setApplication(jobId, { status: "approved" });
}

const fillKey = (jobId: string) => `fill:${jobId}`;

/** Keep what a fill put on the form; each fill replaces the last. */
export const saveFill = (jobId: string, fill: StoredFill): void => kvSetJson(fillKey(jobId), fill);

/** The open form no longer counts (re-filled, re-opened, or its pack changed): back to drafted, code gone. */
export function voidFill(jobId: string): void {
  const app = getApplication(jobId);
  const open = app?.status === "filled" || app?.status === "approved";
  if (app && (app.confirmationCode || open)) setApplication(jobId, { confirmationCode: undefined, status: open ? "drafted" : app.status });
}

/**
 * The stored fill, only while it is the one awaiting approval: status filled or approved with the same code.
 * Undefined for older fills that stored none, and once a re-fill or re-open voided the code.
 */
export function currentFill(jobId: string, app = getApplication(jobId)): StoredFill | undefined {
  if (!app?.confirmationCode || (app.status !== "filled" && app.status !== "approved")) return undefined;
  const fill = kvGetJson<StoredFill>(fillKey(jobId));
  return fill?.code === app.confirmationCode ? fill : undefined;
}

/** A readable one-liner for an event; stored details may be JSON. */
export function describeEvent(e: ApplicationEvent): string {
  const d = e.detail ?? "";
  const label = e.kind.replace(/[_-]/g, " ").replace(/^./, c => c.toUpperCase());
  if (e.kind === "status") return `Moved to ${d}`;
  if (e.kind === "note") return `Note: ${d}`;
  if (e.kind === "imported") return d;
  let o: unknown;
  try { o = JSON.parse(d); } catch { return d ? `${label}: ${d}` : label; }
  if (!o || typeof o !== "object") return d ? `${label}: ${d}` : label;
  const rec = o as Record<string, unknown>;
  const lead = e.kind === "filled" ? "Form filled" : label;
  if (typeof rec.summary === "string") return `${lead}: ${rec.summary}`;
  const parts = Object.entries(rec).filter(([, v]) => v != null && typeof v !== "object").map(([k, v]) => `${k}: ${v}`);
  return parts.length ? `${lead}: ${parts.join(", ")}` : lead;
}

const withText = (e: ApplicationEvent): ApplicationEvent & { text: string } => ({ ...e, text: describeEvent(e) });

/** Two postings of one role (same company, title and location) show as one row: the furthest along wins. */
function collapseDuplicatePostings<T extends Application & { job?: Job }>(items: T[]): Array<T & { alsoPosted?: number }> {
  const best = new Map<string, T & { alsoPosted?: number }>();
  const rank = (a: Application) => STATUSES.indexOf(a.status);
  for (const a of items) {
    const j = a.job;
    if (!j) { best.set(a.jobId, a); continue; }
    const key = [j.company, j.title, j.location].map(s => s.trim().toLowerCase()).join("|");
    const cur = best.get(key);
    if (!cur) { best.set(key, a); continue; }
    const keep = rank(a) > rank(cur) || (rank(a) === rank(cur) && a.updatedAt > cur.updatedAt) ? a : cur;
    best.set(key, { ...keep, alsoPosted: (cur.alsoPosted ?? 0) + 1 });
  }
  return [...best.values()];
}

export function pipeline(): {
  counts: Record<ApplicationStatus, number>;
  recent: Array<ApplicationEvent & { text: string }>;
  items: Array<Application & { job?: Job; alsoPosted?: number }>;
} {
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<ApplicationStatus, number>;
  const items = collapseDuplicatePostings(listApplications());
  for (const a of items) counts[a.status]++;
  return { counts, recent: listEvents(undefined, 20).map(withText), items };
}
