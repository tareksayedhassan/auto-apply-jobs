import { addEvent, getApplication, getDb, getJob } from "./db.js";
import { loadProfile } from "./profile.js";
import { voiceCheck } from "./truth.js";
import type { ApplicationStatus, Job, Outreach } from "./types.js";

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const DAY = 86400e3;

function rowToOutreach(r: Row): Outreach {
  return {
    id: r.id, company: r.company, jobId: r.job_id ?? undefined, person: r.person,
    role: r.role ?? undefined, channel: r.channel, contact: r.contact ?? undefined,
    message: r.message ?? undefined, sentAt: r.sent_at, status: r.status, followUps: r.follow_ups,
    lastTouchAt: r.last_touch_at, notes: r.notes ?? undefined,
  };
}

function getOutreach(id: number): Outreach | undefined {
  const r = getDb().prepare("SELECT * FROM outreach WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToOutreach(r) : undefined;
}

export interface LogOutreachInput {
  company: string; jobId?: string; person: string; role?: string; channel: string;
  contact?: string; message?: string; sentAt?: string; notes?: string;
}

function insertOutreach(input: LogOutreachInput, status: "draft" | "sent"): Outreach {
  const at = input.sentAt ?? now();
  const res = getDb().prepare(`INSERT INTO outreach (company, job_id, person, role, channel, contact, message,
      sent_at, status, follow_ups, last_touch_at, notes) VALUES (?,?,?,?,?,?,?,?,?, 0, ?, ?)`)
    .run(input.company, input.jobId ?? null, input.person, input.role ?? null, input.channel,
      input.contact ?? null, input.message ?? null, at, status, at, input.notes ?? null);
  const who = `${input.person}${input.role ? ` (${input.role})` : ""} at ${input.company}`;
  if (input.jobId) addEvent(input.jobId, "outreach", status === "draft" ? `draft ready: ${input.channel} to ${who}` : `${input.channel} to ${who}`);
  return getOutreach(Number(res.lastInsertRowid))!;
}

/** Record a touch the user (or agent, with approval) actually made. */
export function logOutreach(input: LogOutreachInput): Outreach {
  return insertOutreach(input, "sent");
}

/** LinkedIn's connection-request note limit. A LinkedIn draft is that note: the longer ask waits until they accept. */
export const LINKEDIN_NOTE_MAX = 300;

/** The rules every draft's text meets, when written and when edited. Returns the voice notes (never blocking). */
function checkDraftMessage(message: string | undefined, channel: string, company: string): string[] {
  if (typeof message !== "string" || !message.trim()) throw new Error("A draft needs the message text");
  const len = message.trim().length;
  if (/linkedin/i.test(channel) && len > LINKEDIN_NOTE_MAX) {
    throw new Error(`A LinkedIn draft is a connection note: ${LINKEDIN_NOTE_MAX} characters max, this one is ${len}. Cut it to one fact and "Would love to connect"; save the ask for after they accept.`);
  }
  return voiceCheck(message, company);
}

/** Queue a message for the user to send. It waits in the dashboard until they mark it sent. */
export function draftOutreach(input: Omit<LogOutreachInput, "sentAt">): Outreach & { warnings: string[] } {
  const warnings = checkDraftMessage(input.message, input.channel, input.company);
  return { ...insertOutreach(input, "draft"), warnings };
}

/** The statuses a caller can move a row to. A draft is only ever made by draft_outreach, never by reopening a row. */
const SET_STATUSES: Outreach["status"][] = ["sent", "replied", "meeting", "no_reply", "closed"];

/**
 * Change an outreach row. `message` rewrites the text of an unsent draft only (the voice check runs again and its
 * notes come back as `warnings`); a sent message is the record of what went out and is never rewritten.
 */
export function updateOutreach(id: number, patch: { status?: Outreach["status"]; notes?: string; followedUp?: boolean; message?: string }): Outreach & { warnings?: string[] } {
  const cur = getOutreach(id);
  if (!cur) throw new Error(`No outreach with id ${id}`);
  if (patch.status !== undefined && patch.status !== cur.status) {
    if (patch.status === "draft") {
      throw new Error(`Cannot edit outreach ${id} to ${cur.person} back to a draft: it is ${cur.status}, and a sent message is the record of what went out. Draft a new message instead.`);
    }
    if (!SET_STATUSES.includes(patch.status)) throw new Error(`Unknown status ${JSON.stringify(patch.status)} for outreach ${id}: use one of ${SET_STATUSES.join(", ")}.`);
  }
  if (patch.followedUp && cur.status === "draft") {
    throw new Error(`Cannot follow up on an unsent draft: outreach ${id} to ${cur.person} was never sent. Mark it sent first; a follow-up only counts after the first message went out.`);
  }
  let warnings: string[] | undefined;
  if (patch.message !== undefined) {
    if (cur.status !== "draft") {
      throw new Error(cur.status === "closed"
        ? `Cannot edit outreach ${id} to ${cur.person}: it is closed, and only a draft's text can change. Draft a new message instead.`
        : `Cannot edit outreach ${id} to ${cur.person}: it was already sent (${cur.status}), and its message is the record of what went out. Only a draft's text can change; log a follow-up instead.`);
    }
    warnings = checkDraftMessage(patch.message, cur.channel, cur.company);
    if (patch.message !== cur.message) {
      // status = 'draft' in the write too: the MCP server and the dashboard are separate processes on one database.
      const res = getDb().prepare("UPDATE outreach SET message = ? WHERE id = ? AND status = 'draft'").run(patch.message, id);
      if (res.changes === 0) throw new Error(`Cannot edit outreach ${id} to ${cur.person}: it stopped being a draft while this edit was in flight. Only a draft's text can change.`);
      if (cur.jobId) addEvent(cur.jobId, "outreach", `draft edited: ${cur.channel} to ${cur.person} at ${cur.company}${warnings.length ? ` (${warnings.length} voice note${warnings.length > 1 ? "s" : ""})` : ""}`);
    }
  }
  const status = patch.status ?? cur.status;
  const sending = cur.status === "draft" && status === "sent";
  const followUps = cur.followUps + (patch.followedUp ? 1 : 0);
  const touch = patch.followedUp || sending ? now() : cur.lastTouchAt;
  getDb().prepare("UPDATE outreach SET status = ?, notes = ?, follow_ups = ?, last_touch_at = ?, sent_at = ? WHERE id = ?")
    .run(status, patch.notes ?? cur.notes ?? null, followUps, touch, sending ? touch : cur.sentAt, id);
  if (cur.jobId) {
    if (sending) addEvent(cur.jobId, "outreach", `${cur.channel} to ${cur.person} at ${cur.company}`);
    if (patch.status && patch.status !== cur.status && (status === "replied" || status === "meeting")) {
      addEvent(cur.jobId, "outreach", `${cur.person} at ${cur.company}: ${status}`);
    }
    if (patch.followedUp) addEvent(cur.jobId, "outreach", `follow-up ${followUps} to ${cur.person}`);
  }
  const out = getOutreach(id)!;
  return warnings ? { ...out, warnings } : out;
}

/** An outreach row with the status of the application it is about, when it is linked to one. */
export type OutreachRow = Outreach & { applicationStatus?: ApplicationStatus };

/** Attach each linked application's status, looking each job up once. */
function withAppStatus(rows: Outreach[]): OutreachRow[] {
  const seen = new Map<string, ApplicationStatus | undefined>();
  return rows.map(o => {
    if (!o.jobId) return o;
    if (!seen.has(o.jobId)) seen.set(o.jobId, getApplication(o.jobId)?.status);
    const applicationStatus = seen.get(o.jobId);
    return applicationStatus ? { ...o, applicationStatus } : o;
  });
}

export function listOutreach(filter: { company?: string; status?: Outreach["status"]; jobId?: string } = {}): OutreachRow[] {
  const where: string[] = [];
  const args: any[] = [];
  if (filter.company) { where.push("lower(company) = lower(?)"); args.push(filter.company); }
  if (filter.status) { where.push("status = ?"); args.push(filter.status); }
  if (filter.jobId) { where.push("job_id = ?"); args.push(filter.jobId); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return withAppStatus((getDb().prepare(`SELECT * FROM outreach ${w} ORDER BY last_touch_at DESC, id DESC`).all(...args) as Row[])
    .map(rowToOutreach));
}

export type DueKind = "send_or_close" | "propose_close" | "follow_up";
export type DueFollowUp = OutreachRow & { kind: DueKind; daysSinceTouch: number; suggestion: string; waitingOn?: "submit" };

/** Application states before it goes in: a note saying "just applied" would not be true yet. */
const PRE_SUBMIT: ApplicationStatus[] = ["saved", "drafted", "filled", "approved", "needs_human"];
/** Application states after it went in: a draft written before then may say something no longer true. */
const POST_SUBMIT: ApplicationStatus[] = ["submitted", "interview", "offer", "ghosted"];
/** Application states that make outreach about the role moot. */
const DEAD: ApplicationStatus[] = ["rejected", "withdrawn"];
const KIND_ORDER: DueKind[] = ["send_or_close", "propose_close", "follow_up"];

/**
 * What needs a decision in outreach, most urgent first:
 * - send_or_close: drafts left unsent for draftDays or more (held while their application is not submitted yet);
 * - propose_close: drafts or sent rows whose application was rejected or withdrawn (any age, never closed here);
 * - follow_up: 'sent' rows quiet for `days` or more. Sent rows that used up their follow-ups are closed as no_reply
 *   (with `readOnly`, they are left alone and simply not listed).
 */
export function dueFollowUps(opts: { days?: number; draftDays?: number; maxFollowUps?: number; readOnly?: boolean } = {}): DueFollowUp[] {
  const days = opts.days ?? 7;
  const draftDays = opts.draftDays ?? 2;
  const max = opts.maxFollowUps ?? 3;
  const cutoff = (d: number) => new Date(Date.now() - d * DAY).toISOString();
  const open = withAppStatus((getDb().prepare("SELECT * FROM outreach WHERE status IN ('draft', 'sent') ORDER BY last_touch_at, id")
    .all() as Row[]).map(rowToOutreach));
  const due: DueFollowUp[] = [];
  for (const o of open) {
    const daysSinceTouch = Math.floor((Date.now() - Date.parse(o.lastTouchAt)) / DAY);
    if (o.applicationStatus && DEAD.includes(o.applicationStatus)) {
      due.push({ ...o, kind: "propose_close", daysSinceTouch, suggestion: closeSuggestion(o) });
    } else if (o.status === "draft") {
      if (o.lastTouchAt > cutoff(draftDays)) continue;
      const waiting = !!o.applicationStatus && PRE_SUBMIT.includes(o.applicationStatus);
      due.push({ ...o, kind: "send_or_close", daysSinceTouch, suggestion: draftSuggestion(o, daysSinceTouch),
        ...(waiting ? { waitingOn: "submit" as const } : {}) });
    } else {
      if (o.lastTouchAt > cutoff(days)) continue;
      if (o.followUps >= max) { if (!opts.readOnly) updateOutreach(o.id, { status: "no_reply" }); continue; }
      due.push({ ...o, kind: "follow_up", daysSinceTouch, suggestion: followUpSuggestion(o) });
    }
  }
  return due.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)); // stable: oldest first within a kind
}

function draftSuggestion(o: OutreachRow, age: number): string {
  const what = `The draft to ${o.person} at ${o.company} has waited ${age} day${age === 1 ? "" : "s"} unsent`;
  if (o.applicationStatus && PRE_SUBMIT.includes(o.applicationStatus)) {
    return `${what}. Hold it: the application is ${o.applicationStatus}, not submitted yet. Send it once the application goes in, or close the draft.`;
  }
  if (o.applicationStatus && POST_SUBMIT.includes(o.applicationStatus)) {
    return `${what}, and the application is ${o.applicationStatus}: send now. Re-read it first so any timing ("just applied") is still true, or close it.`;
  }
  return `${what}. Send it now or close it; an unsent note does no work.`;
}

function closeSuggestion(o: OutreachRow): string {
  const what = o.status === "draft" ? `the unsent draft to ${o.person}` : `outreach to ${o.person}`;
  return `The ${o.company} application was ${o.applicationStatus}. Close ${what}, or keep it open on purpose if the relationship is worth more than this role.`;
}

function followUpSuggestion(o: Outreach): string {
  const n = o.followUps + 1;
  const who = `${o.person} at ${o.company}`;
  if (n === 1) return `Follow-up 1 to ${who}: reply in the same thread with one new piece of value (a relevant link, a short note on something they shipped, or your proof-of-work draft). Do not just "bump".`;
  if (n === 2) return `Follow-up 2 to ${who}: try a different channel or a different person on the team, and share something concrete you built or learned since the first note.`;
  return `Final follow-up to ${who}: keep it two lines, say you will stop here, and leave the door open. It is marked no_reply if this goes unanswered.`;
}

export interface OutreachBrief {
  company: string;
  job?: { id: string; title: string; url: string; location: string };
  people_to_find: string[];
  channels: string[];
  rules: string[];
  history: Outreach[];
  existingContacts: Array<{ person: string; role?: string; channel: string; contact?: string; status: string }>;
}

/** Guidance for a human, personal approach. Never invents people or contact details. */
export function outreachBrief(company: string, jobId?: string): OutreachBrief {
  const job: Job | undefined = jobId ? getJob(jobId) : undefined;
  const profile = loadProfile();
  const history = listOutreach({ company });
  const title = job ? ` (${job.title})` : "";

  const people_to_find = [
    `The recruiter or talent partner running this search at ${company}${title}: they own the pipeline and can route you.`,
    `The hiring manager for this role: the person whose problem it solves. They decide, and they answer people who understand their problem.`,
    `An individual contributor on the team you would join: they can tell you what the work is really like and refer you internally.`,
    `A founder or executive, if ${company} has under about 50 people: at that size they usually make hiring calls directly.`,
    `Anyone in your network who already works there or knows someone who does: a warm intro beats every cold route.`,
    "OpenApply does not look people up or scrape LinkedIn. Find names yourself (company page, posts, team page) and tell the agent who and how to reach them.",
  ];
  const channels = [
    "1. In person or at an event (meetups, demo days, conferences): warmest, most memorable.",
    "2. Intro or referral from a mutual connection: ask them to forward a two-line blurb you wrote.",
    "3. Text or DM (X, LinkedIn message) to someone you have a real reason to contact.",
    "4. Email: coldest, but fine when the note is short and specific. Use an address you were given or found yourself.",
  ];
  const rules = [
    "Under 120 words. Short and specific beats polished.",
    `LinkedIn: send a connection request with a note of ${LINKEDIN_NOTE_MAX} characters or fewer (greeting and sign-off count). One fact, then "Would love to connect"; the 15-minute ask goes in a follow-up after they accept.`,
    `Lead with something specific about ${company}'s product or the problem this hire solves, not with yourself.`,
    "One line of relevant evidence: something you built or shipped that maps to their problem.",
    "Name a past employer only if the reader will recognize it; otherwise say the work and the result. A short note has no resume next to it to explain the name.",
    "One concrete ask: a 15-minute chat, or feedback on a small project you built for them.",
    "No AI clichés (\"I hope this finds you well\", \"I'm passionate about\", \"synergy\"). Write it in your own words.",
    "Follow up about once a week, up to 3 times. Each follow-up adds something new (a link, a draft, a thought), never just a bump.",
    "Aim at 2 of 4 parameters (role, stage, geography, industry) and ignore the rest; a targeted list beats a wide one.",
    "Warm intros and referrals beat inbound applications. Apply too, but do not rely on it.",
  ];
  const samples = (profile?.voiceSamples ?? []).filter(s => s.trim());
  if (samples.length) {
    rules.push("Write in the user's voice. Samples of how they write:\n" +
      samples.slice(0, 3).map(s => `- ${s.trim().replace(/\s+/g, " ").slice(0, 300)}`).join("\n"));
  } else {
    rules.push("No voice samples saved yet: ask the user for two or three things they wrote (emails, posts) and save them to the profile before drafting.");
  }
  if (profile?.story) rules.push(`Personal context the user supplied (use only what is true): ${profile.story.replace(/\s+/g, " ").slice(0, 300)}`);

  return {
    company,
    job: job && { id: job.id, title: job.title, url: job.url, location: job.location },
    people_to_find, channels, rules, history,
    existingContacts: history.map(h => ({ person: h.person, role: h.role, channel: h.channel, contact: h.contact, status: h.status })),
  };
}
