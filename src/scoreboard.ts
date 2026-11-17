import { getDb } from "./db.js";
import { dueFollowUps, listOutreach, type DueFollowUp } from "./outreach.js";
import { companyKeys } from "./prior.js";
import { loadStrategy, type StrategyConfig } from "./strategy.js";
import type { ApplicationStatus, Outreach } from "./types.js";

/**
 * The strategy scoreboard: sends and conversations against the strategy's weekly targets, the 48-hour person rule,
 * day-7 follow-ups, the lead companies, milestones and the decision gate (strategy.json, see strategy.ts). It counts
 * what went out and who answered, never artifacts made (packs, drafts, dossiers).
 *
 * computeScoreboard is pure: it takes rows, the config and "now". loadScoreboardInput reads them from the DB and
 * loadStrategy reads strategy.json, neither writing anything; strategyScoreboard ties them together for the CLI,
 * MCP tool and HTTP route.
 */

const HOUR = 3600e3;
const DAY = 86400e3;

export interface ScoreApplication {
  jobId: string;
  company: string;
  title: string;
  status: ApplicationStatus;
  submittedAt?: string;
  source?: string;
  /** When it was first on record as submitted or past it (its first such status row, or its history import). */
  recordedAt?: string;
}

/** An event row. The loader leaves out history-import rows (and the status rows the import wrote with them). */
export interface ScoreEvent { jobId: string; at: string; kind: string; detail?: string }

export interface ScoreboardInput {
  applications: ScoreApplication[];
  outreach: Outreach[];
  events: ScoreEvent[];
  /** dueFollowUps output (read-only); only kind follow_up is used. */
  followUps: DueFollowUp[];
}

// ---- time ----

function partsIn(ms: number, tz: string): number[] {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return [+p.year, +p.month, +p.day, +p.hour, +p.minute, +p.second];
}
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** Epoch ms of a stored time. A plain date, or a time with no zone, is read as local time in `tz`. */
export function instant(t: string | undefined, tz: string): number | undefined {
  if (!t) return undefined;
  if (HAS_ZONE.test(t)) { const ms = Date.parse(t); return Number.isNaN(ms) ? undefined : ms; }
  const m = LOCAL.exec(t);
  if (!m) return undefined;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const offset = (ms: number) => { const p = partsIn(ms, tz); return Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]) - Math.floor(ms / 1000) * 1000; };
  let ms = wall - offset(wall);
  const again = offset(ms);
  if (wall - again !== ms) ms = wall - again; // a DST change between the guess and the answer
  return ms;
}

/** The local calendar date (YYYY-MM-DD) in `tz` of a stored time; a plain date or zone-less time keeps its own date. */
export function localDate(t: string | undefined, tz: string): string | undefined {
  if (!t) return undefined;
  if (!HAS_ZONE.test(t)) { const m = LOCAL.exec(t); return m ? ymd(+m[1], +m[2], +m[3]) : undefined; }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return undefined;
  const p = partsIn(ms, tz);
  return ymd(p[0], p[1], p[2]);
}

const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY;
const addDays = (d: string, n: number) => new Date((dayNum(d) + n) * DAY).toISOString().slice(0, 10);

// ---- rows ----

function atCompany(name: string): (other: string) => boolean {
  const keys = new Set(companyKeys(name));
  return other => companyKeys(other).some(k => keys.has(k));
}
const personKey = (p: string) => p.trim().toLowerCase().replace(/\s+/g, " ");
/** A row whose notes say HOLD (in capitals): a parked draft, never named as the next send. */
const onHold = (o: Outreach) => /\bHOLD\b/.test(o.notes ?? "");

const SENT_STATUSES: Outreach["status"][] = ["sent", "replied", "meeting", "no_reply"];

/** The "<channel> to <person>" event written when a row was logged sent or marked sent, matched on the exact person. */
function isSendEvent(e: ScoreEvent, jobId: string, channel: string, person: string): boolean {
  if (e.jobId !== jobId || e.kind !== "outreach") return false;
  const d = e.detail ?? "";
  const lead = `${channel} to ${person}`;
  return d.startsWith(lead) && (d.length === lead.length || d.startsWith(" (", lead.length) || d.startsWith(" at ", lead.length));
}

/**
 * Whether a message actually went out. Open statuses say so; a draft never did. A closed row is ambiguous (a skipped
 * draft and a sent note closed later look alike), so it counts only with proof: a follow-up logged on it, or a send
 * event of its own. Every send writes one "<channel> to <person>" event at the moment the row's sent_at is set, so
 * each such event (same job, channel and exact person) belongs to the row whose sent_at is that time, else to the
 * row with the closest earlier sent_at; a row with no event of its own (a draft moved straight to replied, a skipped
 * draft) takes nobody's proof. `all` is every outreach row (defaults to just this one).
 */
export function outreachSent(o: Outreach, events: ScoreEvent[], all: Outreach[] = [o]): boolean {
  if (SENT_STATUSES.includes(o.status)) return true;
  if (o.status !== "closed") return false;
  if (o.followUps > 0) return true;
  if (!o.jobId) return false;
  const jobId = o.jobId;
  const rows = [o, ...all.filter(x => x.id !== o.id && x.jobId === jobId && x.channel === o.channel && x.person === o.person)]
    .map(x => ({ x, ms: Date.parse(x.sentAt) })).filter(r => !Number.isNaN(r.ms));
  return events.filter(e => isSendEvent(e, jobId, o.channel, o.person)).some(e => {
    const at = Date.parse(e.at);
    const same = rows.filter(r => Math.abs(r.ms - at) <= SAME_SEND_MS).sort((p, q) => Math.abs(p.ms - at) - Math.abs(q.ms - at))[0];
    const owner = same ?? rows.filter(r => r.ms <= at).sort((p, q) => q.ms - p.ms)[0];
    return owner?.x.id === o.id;
  });
}
/** A send event and the sent_at it was written with are a few milliseconds apart (two clock reads). */
const SAME_SEND_MS = 5000;

const POST_SUBMIT: ApplicationStatus[] = ["submitted", "interview", "offer", "rejected", "ghosted"];
const ORDER: ApplicationStatus[] = ["saved", "drafted", "filled", "approved", "needs_human", "withdrawn", "submitted", "ghosted", "rejected", "interview", "offer"];
const wentIn = (a: ScoreApplication) => !!a.submittedAt || POST_SUBMIT.includes(a.status);

const CONVERSATION = /interview|screen/i;
/** Scheduled mentions this many days apart or less are the same conversation (invite, confirmation, reminder, a small move). */
export const SAME_CONVERSATION_DAYS = 3;

export interface Conversation {
  jobId: string; company: string; title: string;
  /** Its local date: the date of the most recently logged mention (so a reschedule, earlier or later, wins). */
  date: string;
  /** False for the one undated "in process" conversation of a job with only status changes or notices on record. */
  scheduled: boolean;
  /** The job's first conversation (the earliest). Only these count as first conversations. */
  first: boolean;
  /** The round on record: 1 for the first, N when an event in it says "round": N; unknown (absent) otherwise. */
  round?: number;
  /** A held conversation after the first with no round marker covering it: maybe a next round, never counted as one. */
  possibleRound?: boolean;
  /** The local day it was first on record. */
  recorded: string;
}

/** A round marker: the round passed count rises when an event says "round": N (N - 1 rounds passed), on the day it was logged. */
export interface RoundCredit { jobId: string; logged: string; rounds: number }

interface Mention {
  type: "status" | "notice" | "scheduled";
  /** Local date: the scheduled day, the notice's mail day, or (status) the day logged. */
  date: string;
  logged: string;
  /** Logged order (time, then position in the input). */
  order: number;
  reschedule: boolean;
  /** Local date of `rescheduled_from`, when the event names it. */
  from?: string;
  round?: number;
}

const json = (detail?: string): Record<string, any> | undefined => {
  try { const d = JSON.parse(detail ?? ""); return d && typeof d === "object" && !Array.isArray(d) ? d : undefined; } catch { return undefined; }
};
const roundOf = (d?: Record<string, any>) => (d && Number.isInteger(d.round) && d.round >= 1 ? d.round as number : undefined);
const HAS_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * One application's conversation mentions, in logged order:
 * - status changes to interview or offer (dated the day logged);
 * - interview/screen events with a scheduled date. The inbox sweep says which with date_source: "invite" or
 *   "invite-wall-time" is the invitation's start; "mail" is the day the mail came, a notice that a process is active,
 *   not a conversation date. Older events have no date_source: a date with a time is scheduled; a plain date written
 *   by the outcomes bridge (it always writes source_id) is a notice; a manual event with a date keeps it. An event
 *   with no date (plain text, or JSON without one) is a notice dated the day logged, never a conversation of its own.
 *   A JSON event with a round and no date is only a round marker.
 */
function mentions(events: ScoreEvent[], tz: string): Mention[] {
  const out: Mention[] = [];
  events.forEach((e, i) => {
    const logged = localDate(e.at, tz);
    if (!logged) return;
    const order = (instant(e.at, tz) ?? 0) + i / 1e6;
    if (e.kind === "status") {
      if (e.detail === "interview" || e.detail === "offer") out.push({ type: "status", date: logged, logged, order, reschedule: false });
      return;
    }
    if (!CONVERSATION.test(e.kind)) return;
    const d = json(e.detail);
    const round = roundOf(d);
    const date = d && typeof d.date === "string" ? localDate(d.date, tz) : undefined;
    if (d && !date && round !== undefined) return;
    const notice = !date || d!.date_source === "mail" || (d!.date_source === undefined && !HAS_TIME.test(d!.date) && typeof d!.source_id === "string");
    out.push({
      type: notice ? "notice" : "scheduled", date: date ?? logged, logged, order, round,
      reschedule: /reschedul/i.test(e.kind) || d?.rescheduled_from !== undefined,
      from: d && typeof d.rescheduled_from === "string" ? localDate(d.rescheduled_from, tz) : undefined,
    });
  });
  return out.sort((x, y) => x.order - y.order);
}

const daysApart = (a: string, b: string) => Math.abs(dayNum(a) - dayNum(b));

/**
 * One application's conversations, oldest first. Scheduled mentions group into conversations, in logged order: a
 * mention joins the single nearest conversation with a mention SAME_CONVERSATION_DAYS or less from its date (never one
 * already held when the mention was logged, unless on the same day), or, when
 * it is a reschedule (kind interview_rescheduled or JSON rescheduled_from), the conversation nearest its
 * rescheduled_from (else its new date), preferring ones not yet past when it was logged. A mention with an explicit
 * round only joins a conversation with the same round (at any distance) or one with no round that is not the job's
 * earliest (that one is round 1), so a round 2 booked a few days after the screen never swallows it. The most
 * recently logged mention's date wins. Status changes and notices never start a second conversation; only when a job
 * has no scheduled mention at all do they make one undated "in process" conversation, held on the earliest of them.
 * Conversations never count rounds: see roundCredits.
 */
function jobConversations(a: ScoreApplication, events: ScoreEvent[], tz: string, today: string): Conversation[] {
  const all = mentions(events, tz);
  const base = { jobId: a.jobId, company: a.company, title: a.title };
  const sched = all.filter(m => m.type === "scheduled");
  if (!sched.length) {
    const status = all.filter(m => m.type === "status").map(m => m.date).sort();
    const held = status[0] ?? all.map(m => m.date).sort()[0];
    return held ? [{ ...base, date: held, scheduled: false, first: true, round: 1, recorded: all.map(m => m.logged).sort()[0] }] : [];
  }
  const groups: Array<{ ms: Mention[]; round?: number }> = [];
  const current = (g: { ms: Mention[] }) => g.ms[g.ms.length - 1].date;
  const near = (g: { ms: Mention[] }, d: string) => Math.min(...g.ms.map(x => daysApart(x.date, d)));
  /** The nearest group to `d` among `pool`; on a tie, the newer group. */
  const nearest = (pool: typeof groups, d: string) => pool.map((g, i) => ({ g, i }))
    .sort((p, q) => near(p.g, d) - near(q.g, d) || q.i - p.i)[0]?.g;
  for (const m of sched) {
    const earliest = groups.reduce<(typeof groups)[number] | undefined>((p, q) => (!p || current(q) < current(p) ? q : p), undefined);
    const fits = groups.filter(g => m.round === undefined || g.round === m.round || (g.round === undefined && (m.round === 1 || g !== earliest)));
    let target = m.round !== undefined ? nearest(groups.filter(g => g.round === m.round), m.date) : undefined;
    if (!target && m.reschedule && fits.length) {
      const ahead = fits.filter(g => current(g) >= m.logged);
      target = nearest(ahead.length ? ahead : fits, m.from ?? m.date);
    }
    target ??= nearest(fits.filter(g => near(g, m.date) <= SAME_CONVERSATION_DAYS && !(current(g) < m.logged && current(g) !== m.date)), m.date);
    if (target) { target.ms.push(m); target.round ??= m.round; } else groups.push({ ms: [m], round: m.round });
  }
  const convos = groups.map(g => ({ ...base, date: current(g), scheduled: true, first: false, round: g.round,
    recorded: g.ms.map(m => m.logged).sort()[0] } as Conversation)).sort((x, y) => x.date.localeCompare(y.date));
  const maxRound = Math.max(1, ...markerRounds(events));
  convos.forEach((c, k) => {
    if (k === 0) { c.first = true; c.round ??= 1; return; }
    if (c.date <= today && maxRound < k + 1 && c.round === undefined) c.possibleRound = true;
  });
  return convos;
}

/** Every round number an application's events name ("round": N in any event's JSON, status rows aside). */
function markerRounds(events: ScoreEvent[]): number[] {
  return events.filter(e => e.kind !== "status").map(e => roundOf(json(e.detail))).filter((r): r is number => r !== undefined);
}

/**
 * Every application's conversations (interviews and screens), oldest first. `today` (local date) marks which are
 * held, for the possible-round hint; it defaults to far in the future (every one held).
 */
export function conversations(apps: ScoreApplication[], events: ScoreEvent[], tz: string, today = "9999-12-31"): Conversation[] {
  return apps.flatMap(a => jobConversations(a, events.filter(e => e.jobId === a.jobId), tz, today))
    .sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * Rounds passed, only from explicit markers: an event whose JSON says "round": N. The highest N at a job means N - 1
 * rounds passed; each marker that raises it is credited the rise, on the local day it was logged. Two held
 * conversations with no marker are never a round passed (Conversation.possibleRound flags them instead).
 */
export function roundCredits(apps: ScoreApplication[], events: ScoreEvent[], tz: string): RoundCredit[] {
  const out: RoundCredit[] = [];
  for (const a of apps) {
    let max = 1;
    const marks = events.filter(e => e.jobId === a.jobId && e.kind !== "status")
      .map((e, i) => ({ round: roundOf(json(e.detail)), logged: localDate(e.at, tz), order: (instant(e.at, tz) ?? 0) + i / 1e6 }))
      .filter(m => m.round !== undefined && m.logged).sort((x, y) => x.order - y.order);
    for (const m of marks) {
      if (m.round! > max) { out.push({ jobId: a.jobId, logged: m.logged!, rounds: m.round! - max }); max = m.round!; }
    }
  }
  return out;
}

// ---- output ----

export interface WeekRow {
  week: number;
  start: string;
  end: string;
  current: boolean;
  /** People asked for the first time since the start, in this week (each person counts once, in the week first asked). */
  warmAsks: number;
  applications: number;
  /** First conversations dated in this week, held or booked. */
  firstConversations: number;
  /** Of those, the ones still ahead (booked, not held yet). */
  firstConversationsBooked: number;
  /** Rounds passed, only by explicit marker ("round": N logged this week); an offer alone is not counted. */
  roundsPassed: number;
  /** Held conversations this week after a job's first with no round marker: maybe a next round, not counted as one. */
  possibleRounds: number;
  targets: { warmAsks: number; applications: number };
  /** Targets halved by the week-1 rule (see StrategyConfig.halveIfFewerSubmitted). */
  halved: boolean;
  /** Ended under any target. Null while the week is still running. */
  slipped: boolean | null;
}

export interface PersonFlag {
  jobId: string;
  company: string;
  title: string;
  submittedAt: string;
  hoursElapsed: number;
  /** due: still inside the window; overdue: window passed, nobody contacted; sent_late: a note went out after the window. */
  state: "due" | "overdue" | "sent_late";
  hoursLeft?: number;
  /** An unsent draft to someone at the company, ready to go (never one marked HOLD). */
  draft?: { id: number; person: string; channel: string };
  sentLate?: { person: string; sentAt: string };
}

export interface CompanyStatus {
  company: string;
  seat: string;
  path?: string;
  firstMove?: string;
  applied: boolean;
  appliedAt?: string;
  applicationStatus?: ApplicationStatus;
  /** The title of the application the status comes from (it may be a different role from the seat). */
  applicationTitle?: string;
  /** An interview or offer is open: the applied and asked chips give way to "In process". */
  inProcess: boolean;
  asked: boolean;
  personNamed?: { id: number; person: string; role?: string; sent: boolean; onHold: boolean };
  lastTouch?: string;
  nextConversation?: string;
  nextAction: string;
}

export interface Scoreboard {
  today: string;
  generatedAt: string;
  timeZone: string;
  leadLane: string;
  source: string;
  week: WeekRow;
  weeks: WeekRow[];
  /** The week-1 halving rule: how many of the lead companies were in by the end of week 1, against the threshold. */
  halving: { threshold: number; submittedByWeek1: number; decided: boolean; halved: boolean };
  personFlags: PersonFlag[];
  followUpsDue: Array<{ id: number; person: string; role?: string; company: string; channel: string; daysSinceTouch: number; followUps: number; dueSince: string; suggestion: string; notes?: string }>;
  companies: CompanyStatus[];
  bench: string[];
  upcoming: Conversation[];
  liveProcesses: Array<{ jobId: string; company: string; title: string; status: ApplicationStatus; lastActivity: string }>;
  /**
   * Cumulative from the start to the gate date (or today, if sooner). First conversations count only held ones; past
   * a first screen only by round marker; possibleRounds are unmarked later conversations (a hint, not a count).
   */
  totals: { warmAsks: number; applications: number; firstConversations: number; pastFirstScreen: number; possibleRounds: number };
  gate: {
    date: string;
    daysLeft: number;
    reached: boolean;
    liveProcesses: number;
    threshold: number;
    verdict: "hold" | "widen";
    action: string;
    note?: string;
    progress: Record<"firstConversations" | "pastFirstScreen" | "warmAsks" | "applications", { actual: number; target: number }>;
  };
  milestones: Array<{ date: string; title: string; doneMeans: string; gate: boolean; daysLeft: number; state: "past" | "today" | "ahead" }>;
  warnings: string[];
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function computeScoreboard(input: ScoreboardInput, cfg: StrategyConfig, now: Date = new Date()): Scoreboard {
  const tz = cfg.timeZone;
  const nowMs = now.getTime();
  const today = localDate(now.toISOString(), tz)!;
  const weekOf = (d: string) => Math.floor((dayNum(d) - dayNum(cfg.start)) / 7);
  const thisWeek = Math.max(0, weekOf(today));
  const g = cfg.gate;
  /** Cumulative counts stop at the gate. */
  const countTo = g.date < today ? g.date : today;

  const sentRows = input.outreach.filter(o => outreachSent(o, input.events, input.outreach));
  const allConvos = conversations(input.applications, input.events, tz, today);
  const convos = allConvos.filter(c => c.date >= cfg.start);
  const credits = roundCredits(input.applications, input.events, tz);

  // each person counts once, in the week they were first asked since the start
  const firstAsk = new Map<string, string>();
  for (const o of sentRows) {
    const d = localDate(o.sentAt, tz);
    if (!d || d < cfg.start) continue;
    const k = personKey(o.person);
    const seen = firstAsk.get(k);
    if (!seen || d < seen) firstAsk.set(k, d);
  }
  const askDays = [...firstAsk.values()];
  const submitDays = input.applications.filter(wentIn).map(a => localDate(a.submittedAt, tz)).filter((d): d is string => !!d);

  // the week-1 rule (STRATEGY.md section 4): fewer than N of the lead companies in by the end of week 1 halves every
  // target after it. Decided once from what was on record by then: an application counts on the later of its submit
  // date and the day it was first on record as submitted or past it (recordedAt, else its first such status row), so
  // a status set in week 3, or a week-1 submit date logged in week 3, never reaches back into week 1.
  const week1End = addDays(cfg.start, 6);
  const wentInDay = (a: ScoreApplication) => {
    const sub = localDate(a.submittedAt, tz);
    const rec = localDate(a.recordedAt, tz) ?? input.events
      .filter(e => e.jobId === a.jobId && e.kind === "status" && POST_SUBMIT.includes(e.detail as ApplicationStatus))
      .map(e => localDate(e.at, tz)).filter((d): d is string => !!d).sort()[0];
    return sub && rec ? (sub > rec ? sub : rec) : sub ?? rec;
  };
  const submittedByWeek1 = cfg.companies.filter(c => {
    const same = atCompany(c.company);
    return input.applications.some(a => same(a.company) && (wentInDay(a) ?? "9999") <= week1End);
  }).length;
  const decided = today > week1End;
  const threshold = Math.min(cfg.halveIfFewerSubmitted, cfg.companies.length);
  const halving = { threshold, submittedByWeek1, decided, halved: threshold > 0 && decided && submittedByWeek1 < threshold };
  const half = (n: number) => Math.ceil(n / 2);

  // ---- weeks ----
  const weeks: WeekRow[] = [];
  for (let w = 0; w <= thisWeek; w++) {
    const start = addDays(cfg.start, w * 7);
    const end = addDays(start, 6);
    const inWeek = (d?: string) => !!d && d >= start && d <= end;
    const halved = halving.halved && w >= 1;
    const targets = halved
      ? { warmAsks: half(cfg.weeklyTargets.warmAsks), applications: half(cfg.weeklyTargets.applications) }
      : { ...cfg.weeklyTargets };
    const firsts = convos.filter(c => c.first && inWeek(c.date));
    const row: WeekRow = {
      week: w + 1, start, end, current: w === thisWeek,
      warmAsks: askDays.filter(inWeek).length,
      applications: submitDays.filter(inWeek).length,
      firstConversations: firsts.length,
      firstConversationsBooked: firsts.filter(c => c.scheduled && c.date > today).length,
      roundsPassed: credits.filter(r => inWeek(r.logged)).reduce((n, r) => n + r.rounds, 0),
      possibleRounds: convos.filter(c => c.possibleRound && inWeek(c.date)).length,
      targets, halved, slipped: null,
    };
    if (w < thisWeek) row.slipped = row.warmAsks < targets.warmAsks || row.applications < targets.applications;
    weeks.push(row);
  }

  // ---- 48-hour rule ----
  const watched = [...cfg.companies.map(c => c.company), ...cfg.bench.map(b => b.company)];
  const isWatched = (name: string) => watched.some(w => atCompany(w)(name));
  const windowMs = cfg.personWithinHours * HOUR;
  const beforeMs = cfg.askWindowDaysBefore * DAY;
  const personFlags: PersonFlag[] = [];
  for (const a of input.applications) {
    if (a.status !== "submitted" || !a.submittedAt) continue;
    const day = localDate(a.submittedAt, tz);
    let sub = instant(a.submittedAt, tz);
    if (!day || sub === undefined) continue;
    if (day < cfg.ruleSince && !(isWatched(a.company) && a.source !== "history")) continue;
    if (PLAIN_DATE.test(a.submittedAt)) {
      // a date with no time: start the clock when the submission was logged that day, else at the end of the day
      const logged = input.events
        .filter(e => e.jobId === a.jobId && (e.kind === "submitted" || (e.kind === "status" && e.detail === "submitted")) && localDate(e.at, tz) === day)
        .map(e => instant(e.at, tz)!).sort((x, y) => x - y)[0];
      sub = logged ?? instant(addDays(day, 1), tz)!;
    }
    const same = atCompany(a.company);
    const sent = sentRows.filter(o => same(o.company))
      .map(o => ({ o, at: instant(o.sentAt, tz) ?? Infinity }))
      .filter(s => s.at >= sub - beforeMs)
      .sort((x, y) => x.at - y.at);
    if (sent.some(s => s.at <= sub + windowMs)) continue;
    const hoursElapsed = Math.max(0, Math.floor((nowMs - sub) / HOUR));
    const draft = input.outreach.filter(o => o.status === "draft" && same(o.company) && !onHold(o)).sort((x, y) => y.lastTouchAt.localeCompare(x.lastTouchAt))[0];
    const flag: PersonFlag = {
      jobId: a.jobId, company: a.company, title: a.title, submittedAt: a.submittedAt, hoursElapsed,
      state: sent.length ? "sent_late" : nowMs - sub < windowMs ? "due" : "overdue",
    };
    if (flag.state === "due") flag.hoursLeft = Math.max(0, Math.ceil((sub + windowMs - nowMs) / HOUR));
    if (sent.length) flag.sentLate = { person: sent[0].o.person, sentAt: sent[0].o.sentAt };
    else if (draft) flag.draft = { id: draft.id, person: draft.person, channel: draft.channel };
    personFlags.push(flag);
  }
  const FLAG_ORDER = ["due", "overdue", "sent_late"];
  personFlags.sort((x, y) => FLAG_ORDER.indexOf(x.state) - FLAG_ORDER.indexOf(y.state) || (x.hoursLeft ?? 0) - (y.hoursLeft ?? 0) || y.hoursElapsed - x.hoursElapsed);

  // ---- day-7 follow-ups ----
  const noChase = cfg.companies.filter(c => c.noChase).map(c => atCompany(c.company));
  const followUpsDue = input.followUps.filter(f => f.kind === "follow_up" && !noChase.some(same => same(f.company))).map(f => ({
    id: f.id, person: f.person, role: f.role, company: f.company, channel: f.channel,
    daysSinceTouch: f.daysSinceTouch, followUps: f.followUps,
    dueSince: addDays(localDate(f.lastTouchAt, tz) ?? today, cfg.followUpDays), suggestion: f.suggestion,
    ...(f.notes ? { notes: f.notes } : {}),
  }));

  // ---- the lead companies ----
  const upcoming = allConvos.filter(c => c.scheduled && c.date >= today);
  const companies: CompanyStatus[] = cfg.companies.map(c => {
    const same = atCompany(c.company);
    const apps = input.applications.filter(a => same(a.company));
    const jobIds = new Set(apps.map(a => a.jobId));
    const going = apps.filter(wentIn);
    const furthest = [...apps].sort((x, y) => ORDER.indexOf(y.status) - ORDER.indexOf(x.status))[0];
    const rows = input.outreach.filter(o => same(o.company));
    const sent = rows.filter(o => sentRows.includes(o)).sort((x, y) => y.lastTouchAt.localeCompare(x.lastTouchAt));
    const drafts = rows.filter(o => o.status === "draft").sort((x, y) => y.lastTouchAt.localeCompare(x.lastTouchAt));
    const ready = drafts.filter(o => !onHold(o));
    const named = sent[0] ?? ready[0] ?? drafts[0];
    // contact with the company: sends, submissions, held conversations and the events that record them
    const touchEvents = input.events.filter(e => jobIds.has(e.jobId) && (CONVERSATION.test(e.kind) || e.kind === "submitted"
      || (e.kind === "status" && ["submitted", "interview", "offer"].includes(e.detail ?? ""))
      || (e.kind === "outreach" && !/^draft/.test(e.detail ?? ""))));
    const touches = [
      ...sent.map(o => o.lastTouchAt),
      ...going.map(a => a.submittedAt).filter((t): t is string => !!t),
      ...allConvos.filter(x => jobIds.has(x.jobId) && x.date <= today).map(x => x.date),
      ...touchEvents.map(e => e.at),
    ].map(t => ({ t, ms: instant(t, tz) ?? -Infinity })).filter(x => x.ms <= nowMs).sort((x, y) => y.ms - x.ms);
    const next = upcoming.find(x => same(x.company));
    const appliedAt = going.map(a => a.submittedAt).filter((t): t is string => !!t).sort()[0];
    const live = apps.some(a => a.status === "interview" || a.status === "offer");
    const lastTouch = touches[0]?.t;
    let nextAction: string;
    if (next) nextAction = `Prepare for the conversation on ${next.date}.`;
    else if (live) nextAction = "Follow up on the last conversation.";
    else if (!sent.length && !going.length) nextAction = c.firstMove ?? (ready[0] ? `Send the note to ${ready[0].person}, then apply.` : "Name a person, then apply.");
    else if (going.length && !sent.length) nextAction = ready[0] ? `Send the note to ${ready[0].person} (48-hour rule).`
      : drafts[0] ? `The draft to ${drafts[0].person} is on hold: clear it or name another person (48-hour rule).`
      : "Name a person and send a note (48-hour rule).";
    else if (sent.length && !going.length) nextAction = furthest?.status === "drafted" ? "Apply: the pack is drafted." : "Apply.";
    else nextAction = c.noChase ? "Wait for a reply (no chase)." : `Wait for a reply; follow up on ${addDays(localDate(sent[0].lastTouchAt, tz) ?? today, cfg.followUpDays)} if quiet.`;
    return {
      company: c.company, seat: c.seat, path: c.path, firstMove: c.firstMove,
      applied: going.length > 0, appliedAt, applicationStatus: furthest?.status, applicationTitle: furthest?.title,
      inProcess: live,
      asked: sent.length > 0,
      personNamed: named ? { id: named.id, person: named.person, role: named.role, sent: sent.includes(named), onHold: !sent.includes(named) && onHold(named) } : undefined,
      lastTouch, nextConversation: next?.date, nextAction,
    };
  });

  // ---- live processes and the gate ----
  const liveSince = nowMs - cfg.liveWithinDays * DAY;
  const liveProcesses = input.applications.filter(a => a.status === "interview" || a.status === "offer").flatMap(a => {
    const last = input.events.filter(e => e.jobId === a.jobId).map(e => e.at).sort().pop();
    const ms = instant(last, tz);
    return last && ms !== undefined && ms >= liveSince ? [{ jobId: a.jobId, company: a.company, title: a.title, status: a.status, lastActivity: last }] : [];
  });
  const counted = (d?: string) => !!d && d >= cfg.start && d <= countTo;
  const totals = {
    warmAsks: askDays.filter(counted).length,
    applications: submitDays.filter(counted).length,
    firstConversations: convos.filter(c => c.first && counted(c.date)).length,
    pastFirstScreen: new Set(credits.filter(r => counted(r.logged)).map(r => r.jobId)).size,
    possibleRounds: convos.filter(c => c.possibleRound && counted(c.date)).length,
  };
  const verdict = liveProcesses.length >= g.holdAtLiveProcesses ? "hold" : "widen";
  const gate: Scoreboard["gate"] = {
    date: g.date, daysLeft: dayNum(g.date) - dayNum(today), reached: today >= g.date,
    liveProcesses: liveProcesses.length, threshold: g.holdAtLiveProcesses,
    verdict, action: verdict === "hold" ? g.hold : g.widen,
    progress: {
      firstConversations: { actual: totals.firstConversations, target: g.targets.firstConversations },
      pastFirstScreen: { actual: totals.pastFirstScreen, target: g.targets.pastFirstScreen },
      warmAsks: { actual: totals.warmAsks, target: g.targets.warmAsks },
      applications: { actual: totals.applications, target: g.targets.applications },
    },
  };
  if (totals.firstConversations > 0 && totals.pastFirstScreen === 0) gate.note = g.noRoundPassed;

  const milestones = cfg.milestones.map(m => {
    const daysLeft = dayNum(m.date) - dayNum(today);
    return { date: m.date, title: m.title, doneMeans: m.doneMeans, gate: !!m.gate, daysLeft,
      state: (daysLeft < 0 ? "past" : daysLeft === 0 ? "today" : "ahead") as "past" | "today" | "ahead" };
  });

  return {
    today, generatedAt: now.toISOString(), timeZone: tz, leadLane: cfg.leadLane, source: cfg.source,
    week: weeks[weeks.length - 1], weeks, halving, personFlags, followUpsDue, companies, bench: cfg.bench.map(b => b.company), upcoming,
    liveProcesses, totals, gate, milestones, warnings: [],
  };
}

// ---- DB ----

type Row = Record<string, any>;

/** Read the rows the scoreboard needs. Writes nothing (follow-ups are read with dueFollowUps' readOnly). */
export function loadScoreboardInput(cfg: StrategyConfig): ScoreboardInput {
  const d = getDb();
  const applications = (d.prepare(`SELECT a.job_id, a.status, a.submitted_at, a.source, j.company, j.title,
    (SELECT min(e.at) FROM events e WHERE e.job_id = a.job_id AND (e.kind = 'imported'
      OR (e.kind = 'status' AND e.detail IN ('submitted', 'interview', 'offer', 'rejected', 'ghosted')))) AS recorded_at
    FROM applications a JOIN jobs j ON j.id = a.job_id`).all() as Row[]).map(r => ({
    jobId: r.job_id, company: r.company, title: r.title, status: r.status,
    submittedAt: r.submitted_at ?? undefined, source: r.source ?? undefined, recordedAt: r.recorded_at ?? undefined,
  }));
  // same filter as db.listEvents: history-import rows and the status rows the import wrote are not activity
  const events = (d.prepare(`SELECT e.job_id, e.at, e.kind, e.detail FROM events e WHERE e.kind != 'imported'
    AND NOT (e.kind = 'status' AND EXISTS (SELECT 1 FROM events i WHERE i.job_id = e.job_id AND i.kind = 'imported'
      AND abs(julianday(i.at) - julianday(e.at)) < 2 / 86400.0))
    ORDER BY e.id`).all() as Row[]).map(r => ({ jobId: r.job_id, at: r.at, kind: r.kind, detail: r.detail ?? undefined }));
  return {
    applications, events,
    outreach: listOutreach(),
    followUps: dueFollowUps({ days: cfg.followUpDays, readOnly: true }),
  };
}

/** The whole scoreboard from the data dir: strategy.json (built-in defaults when there is none) plus the DB. Writes nothing. */
export function strategyScoreboard(now: Date = new Date()): Scoreboard & { configPath: string; configExists: boolean } {
  const { config, path, exists, warnings } = loadStrategy();
  const sb = computeScoreboard(loadScoreboardInput(config), config, now);
  sb.warnings.push(...warnings);
  return { ...sb, configPath: path, configExists: exists };
}

/** How a round gets counted: rounds passed come only from explicit markers. */
export const ROUND_HINT = "Log a round with log_event (JSON round: 2) when a second round is booked.";

/** Plain-text scoreboard for the CLI. */
export function scoreboardText(sb: Scoreboard): string {
  const w = sb.week;
  const mark = (a: number, t: number) => `${a}/${t}${a >= t ? "" : "  (under)"}`;
  const lines = [
    `Scoreboard, ${sb.today} (week ${w.week}: ${w.start} to ${w.end})${w.halved ? `  targets halved: ${sb.halving.submittedByWeek1} of the lead companies in by the end of week 1 (needed ${sb.halving.threshold})` : ""}`,
    `  warm asks sent       ${mark(w.warmAsks, w.targets.warmAsks)}`,
    `  applications sent    ${mark(w.applications, w.targets.applications)}`,
    `  first conversations  ${w.firstConversations}${w.firstConversationsBooked ? ` (${w.firstConversationsBooked} booked, not held yet)` : ""}`,
    `  rounds passed        ${w.roundsPassed}${w.possibleRounds ? `  (${w.possibleRounds} possible next round${w.possibleRounds === 1 ? "" : "s"} not logged)` : ""}`,
    `  ${ROUND_HINT}`,
    "",
    `48-hour rule (${sb.personFlags.length} flagged)`,
    ...sb.personFlags.map(f => `  ${f.state.padEnd(9)} ${f.company} · ${f.title}  ${f.hoursElapsed}h since submit${f.hoursLeft !== undefined ? `, ${f.hoursLeft}h left` : ""}${f.draft ? `; draft to ${f.draft.person} ready` : ""}${f.sentLate ? `; ${f.sentLate.person} contacted late` : ""}`),
    "",
    `Follow-ups due (${sb.followUpsDue.length})`,
    ...sb.followUpsDue.map(f => `  ${f.person} at ${f.company}, ${f.daysSinceTouch} days quiet`),
    "",
    `Lead companies (${sb.companies.length})`,
    ...sb.companies.map(c => `  ${c.company.padEnd(8)} applied ${c.applied ? "yes" : "no "}  asked ${c.asked ? "yes" : "no "}  person ${c.personNamed ? `${c.personNamed.person}${c.personNamed.sent ? "" : c.personNamed.onHold ? " (draft, on hold)" : " (draft)"}` : "none"}  last touch ${c.lastTouch ? localDate(c.lastTouch, sb.timeZone) : "none"}\n           next: ${c.nextAction}`),
    "",
    `Gate ${sb.gate.date}: ${sb.gate.liveProcesses} live process${sb.gate.liveProcesses === 1 ? "" : "es"} (hold at ${sb.gate.threshold}) -> ${sb.gate.verdict.toUpperCase()}${sb.gate.reached ? "" : ` if it were today; ${sb.gate.daysLeft} days left`}`,
    `  ${sb.gate.action}`,
    ...(sb.gate.note ? [`  ${sb.gate.note}`] : []),
    ...(sb.totals.possibleRounds ? [`  ${sb.totals.possibleRounds} held conversation${sb.totals.possibleRounds === 1 ? "" : "s"} after a first may be a next round; not counted until logged.`] : []),
    ...(sb.upcoming.length ? ["", "Upcoming conversations", ...sb.upcoming.map(c => `  ${c.date}  ${c.company} · ${c.title}${c.round && c.round > 1 ? ` (round ${c.round})` : ""}`)] : []),
    "",
    "Milestones",
    ...sb.milestones.map(m => `  ${m.date}  ${m.daysLeft < 0 ? `${-m.daysLeft}d ago` : m.daysLeft === 0 ? "today" : `in ${m.daysLeft}d`}  ${m.title}`),
    ...sb.warnings.map(x => `warning: ${x}`),
  ];
  return lines.join("\n");
}
