import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, home } from "./paths.js";

/**
 * The job-search strategy the scoreboard measures against: lead lane, the lead companies, the bench, weekly
 * targets, milestones and the decision gate. It lives in strategy.json in the data dir. Reading never writes: with
 * no file the scoreboard uses the generic built-in defaults below (no companies, no milestones), and the file is
 * created only by `openapply scoreboard --init-config [file]`. A personal strategy is a JSON file kept outside the
 * code (for example strategy/example.json).
 */
export interface StrategyCompany {
  company: string;
  /** The seat named in the strategy. */
  seat: string;
  /** The path to a person the strategy names (a connector or the person), as written there. */
  path?: string;
  /** The strategy's first move: the next action until a send or an application is recorded, and shown on the card. */
  firstMove?: string;
  /** One message, no chase: sent messages here never show as follow-ups due. */
  noChase?: boolean;
}

export interface StrategyMilestone {
  /** YYYY-MM-DD, local date. */
  date: string;
  title: string;
  doneMeans: string;
  /** A gate, not a plain milestone (Dec 3 decision gate, Jan 15 runway gate). */
  gate?: boolean;
}

export interface StrategyConfig {
  /** Bump when the shape changes. */
  version: 1;
  /** Where the defaults came from. */
  source: string;
  /** IANA zone the week boundaries and day counts use. */
  timeZone: string;
  leadLane: string;
  /** Monday of week 1 (YYYY-MM-DD). */
  start: string;
  companies: StrategyCompany[];
  bench: Array<{ company: string; note?: string }>;
  weeklyTargets: { warmAsks: number; applications: number };
  /**
   * If fewer than this many of `companies` (never more than the number listed) have an application in by the end of
   * week 1, every weekly target is halved (rounded up; 0 stays 0) from week 2 to the end, once. 0 turns it off; it
   * never applies with no companies.
   */
  halveIfFewerSubmitted: number;
  /** The 48-hour rule: a named person contacted within this many hours of each application going in. */
  personWithinHours: number;
  /** A note counts toward the 48-hour rule only if it went out at most this many days before the application. */
  askWindowDaysBefore: number;
  /** Applications submitted on or after this date fall under the 48-hour rule (plus any at the five or the bench). */
  ruleSince: string;
  /** A sent message quiet this many days gets a follow-up. */
  followUpDays: number;
  /** An interview or offer with activity in this many days counts as a live process. */
  liveWithinDays: number;
  milestones: StrategyMilestone[];
  gate: {
    date: string;
    /** This many live processes or more: hold the lane. Fewer: widen. */
    holdAtLiveProcesses: number;
    hold: string;
    widen: string;
    /** Shown when nothing has passed a first screen by the gate. */
    noRoundPassed: string;
    /** Cumulative targets by the gate date, counted from `start`. */
    targets: { firstConversations: number; pastFirstScreen: number; warmAsks: number; applications: number };
  };
}

/** Generic defaults: targets and rules only, nobody's companies, contacts or milestones. */
export const STRATEGY_DEFAULTS: StrategyConfig = {
  version: 1,
  source: "built-in defaults (run `openapply scoreboard --init-config [file]` to write strategy.json)",
  timeZone: "America/New_York",
  leadLane: "",
  start: "2026-11-02",
  companies: [],
  bench: [],
  weeklyTargets: { warmAsks: 4, applications: 5 },
  halveIfFewerSubmitted: 3,
  personWithinHours: 48,
  askWindowDaysBefore: 14,
  ruleSince: "2026-11-02",
  followUpDays: 7,
  liveWithinDays: 30,
  milestones: [],
  gate: {
    date: "2026-12-03",
    holdAtLiveProcesses: 3,
    hold: "Hold the lane: push each live process to a final round.",
    widen: "Widen the search: add faster-hiring seats and lanes, and start bridge income.",
    noRoundPassed: "Nothing got past a first screen: the screen is the problem, not the funnel. Review the recorded screens before sending more.",
    targets: { firstConversations: 6, pastFirstScreen: 2, warmAsks: 16, applications: 20 },
  },
};

export const strategyPath = (): string => join(home(), "strategy.json");

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isStr = (v: unknown) => typeof v === "string";
/** A real calendar date: Date.parse("2026-02-30") gives March 2, so it must also come back as the same text. */
const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isZone = (v: unknown) => {
  if (typeof v !== "string" || !v) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: v }); return true; } catch { return false; }
};
const listOf = (ok: (x: any) => boolean) => (v: unknown) => Array.isArray(v) && v.every(x => !!x && typeof x === "object" && ok(x));

/** Every field the scoreboard reads, with the check a hand-edited value must pass. */
const CHECKS: Array<[string, (v: unknown) => boolean]> = [
  ["source", isStr], ["timeZone", isZone], ["leadLane", isStr], ["start", isDate], ["ruleSince", isDate],
  ["companies", listOf(c => isStr(c.company) && isStr(c.seat))],
  ["bench", listOf(b => isStr(b.company))],
  ["milestones", listOf(m => isDate(m.date) && isStr(m.title) && isStr(m.doneMeans))],
  ["weeklyTargets.warmAsks", isNum], ["weeklyTargets.applications", isNum],
  ["halveIfFewerSubmitted", isNum], ["personWithinHours", isNum], ["askWindowDaysBefore", isNum],
  ["followUpDays", isNum], ["liveWithinDays", isNum],
  ["gate.date", isDate], ["gate.holdAtLiveProcesses", isNum],
  ["gate.hold", isStr], ["gate.widen", isStr], ["gate.noRoundPassed", isStr],
  ["gate.targets.firstConversations", isNum], ["gate.targets.pastFirstScreen", isNum],
  ["gate.targets.warmAsks", isNum], ["gate.targets.applications", isNum],
];

const get = (o: any, path: string) => path.split(".").reduce((x, k) => x?.[k], o);
function put(o: any, path: string, v: unknown) {
  const keys = path.split(".");
  const last = keys.pop()!;
  keys.reduce((x, k) => x[k], o)[last] = v;
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

/**
 * A strategy.json object merged over the defaults, nested objects included. A value that fails its check falls back
 * to the default and adds a warning, so one bad edit never breaks the scoreboard.
 */
export function parseStrategy(raw: unknown): { config: StrategyConfig; warnings: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a JSON object");
  const D = STRATEGY_DEFAULTS;
  const r = raw as Record<string, any>;
  const config = {
    ...D, ...r,
    weeklyTargets: { ...D.weeklyTargets, ...obj(r.weeklyTargets) },
    gate: { ...D.gate, ...obj(r.gate), targets: { ...D.gate.targets, ...obj(obj(r.gate).targets) } },
  } as StrategyConfig;
  const warnings: string[] = [];
  for (const [path, ok] of CHECKS) {
    if (ok(get(config, path))) continue;
    warnings.push(`strategy.json: ${path} is ${JSON.stringify(get(config, path)) ?? "missing"}, not valid; using the default.`);
    put(config, path, get(D, path));
  }
  // noChase must be a real boolean: the string "false" is truthy and would silence every follow-up
  config.companies = config.companies.map(c => {
    if (c.noChase === undefined || typeof c.noChase === "boolean") return c;
    warnings.push(`strategy.json: companies "${c.company}" noChase is ${JSON.stringify(c.noChase)}, not true or false; ignored.`);
    const { noChase: _, ...rest } = c;
    return rest;
  });
  return { config, warnings };
}

/**
 * The strategy config, read without writing anything. No file: the built-in defaults, with a warning saying how to
 * write one. A file that will not parse: the defaults and a warning, the file left as it is.
 */
export function loadStrategy(): { config: StrategyConfig; path: string; exists: boolean; warnings: string[] } {
  const path = strategyPath();
  if (!existsSync(path)) {
    return { config: STRATEGY_DEFAULTS, path, exists: false,
      warnings: [`No strategy.json yet: using the built-in defaults (no lead companies or milestones). Run \`openapply scoreboard --init-config [file]\` to write ${path}.`] };
  }
  try {
    return { ...parseStrategy(JSON.parse(readFileSync(path, "utf8"))), path, exists: true };
  } catch (e) {
    return { config: STRATEGY_DEFAULTS, path, exists: true,
      warnings: [`${path} could not be read (${e instanceof Error ? e.message : e}); using the built-in defaults.`] };
  }
}

/**
 * Write strategy.json, from `from` (a strategy JSON file, which must pass every check) or the built-in defaults.
 * Never overwrites: an existing file is an error. The write goes to a temp file first, so a reader never sees half a file.
 */
export function initStrategy(from?: string): { path: string } {
  const path = strategyPath();
  let config: unknown = STRATEGY_DEFAULTS;
  if (from) {
    config = JSON.parse(readFileSync(from, "utf8"));
    const { warnings } = parseStrategy(config);
    if (warnings.length) throw new Error(`${from} has problems, nothing written:\n${warnings.join("\n")}`);
  }
  if (existsSync(path)) throw new Error(`${path} already exists and is never overwritten. Edit it by hand.`);
  ensureHome();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  try { linkSync(tmp, path); } finally { unlinkSync(tmp); }
  return { path };
}
