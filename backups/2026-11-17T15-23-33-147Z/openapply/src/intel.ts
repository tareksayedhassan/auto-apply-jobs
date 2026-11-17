import { getDb, HISTORY_JOB } from "./db.js";
import { getJobFull } from "./details.js";
import { loadProfile } from "./profile.js";
import type { Job } from "./types.js";

type Row = Record<string, any>;
const DAY = 86400e3;

export type Seniority = "intern" | "junior" | "mid" | "senior" | "staff+" | "lead" | "manager" | "director+";

export function seniorityOf(title: string): Seniority {
  const t = title.toLowerCase();
  if (/\bintern(ship)?\b/.test(t)) return "intern";
  if (/\b(vp|vice president|director|head of|chief|cto|cmo|coo|svp)\b/.test(t)) return "director+";
  if (/\b(staff|principal|distinguished|fellow)\b/.test(t)) return "staff+";
  if (/\bmanager\b|\bengineering manager\b/.test(t)) return "manager";
  if (/\blead\b/.test(t)) return "lead";
  if (/\b(senior|sr\.?)\b/.test(t)) return "senior";
  if (/\b(junior|jr\.?|associate|entry|new grad|graduate)\b/.test(t)) return "junior";
  return "mid";
}

export interface HiringSignals {
  company: string;
  openRoles: number;
  newLast30d: number;
  closedLast30d: number;
  byDepartment: Record<string, number>;
  byLocation: Array<{ location: string; count: number }>;
  remoteShare: number;
  seniorityMix: Record<string, number>;
  salaryRange?: { min: number; max: number; currency?: string };
  boards: Array<{ ats: string; slug: string }>;
  sampleTitles: string[];
  notes: string[];
}

const DEPT_ALIASES: Array<[RegExp, string]> = [
  [/engineer|developer|software|devops|sre|infrastructure|data scien|machine learning|\bml\b/i, "Engineering"],
  [/sales|account exec|\bgtm\b|go.to.market|business develop|solutions|customer success|revenue/i, "GTM"],
  [/design|ux|ui\b/i, "Design"],
  [/product manager|product management|\bproduct\b/i, "Product"],
  [/market|growth|content|brand/i, "Marketing"],
  [/recruit|people|talent|hr\b/i, "People"],
  [/finance|legal|operations|ops\b|accounting/i, "Ops & Finance"],
];

/** Department as posted, else a guess from the title. */
function deptOf(r: Row): string {
  if (r.department && String(r.department).trim()) return String(r.department).trim();
  for (const [re, name] of DEPT_ALIASES) if (re.test(r.title)) return name;
  return "Other";
}

function isEng(dept: string, title: string) {
  return /engineer|develop|software|infrastructure|platform/i.test(dept + " " + title);
}

export function hiringSignals(company: string): HiringSignals {
  const d = getDb();
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rows = d.prepare(`SELECT title, location, remote, department, salary_min, salary_max, salary_currency,
      ats, board_slug, first_seen, last_seen, open, COALESCE(posted_at, first_seen) AS seen
    FROM jobs WHERE (lower(company) = lower(?) OR lower(board_slug) = ?) AND NOT (${HISTORY_JOB}) ORDER BY seen DESC`)
    .all(company, slug) as Row[];
  const cutoff = new Date(Date.now() - 30 * DAY).toISOString();
  const open = rows.filter(r => r.open);
  const byDepartment: Record<string, number> = {};
  const locs = new Map<string, number>();
  const mix: Record<string, number> = {};
  let remote = 0, newCount = 0, newEng = 0;
  let min = Infinity, max = 0, currency: string | undefined;
  const boards = new Map<string, { ats: string; slug: string }>();
  for (const r of open) {
    const dept = deptOf(r);
    byDepartment[dept] = (byDepartment[dept] ?? 0) + 1;
    const loc = (r.location || "Unspecified").trim();
    locs.set(loc, (locs.get(loc) ?? 0) + 1);
    const s = seniorityOf(r.title);
    mix[s] = (mix[s] ?? 0) + 1;
    if (r.remote) remote++;
    if (r.seen >= cutoff) { newCount++; if (isEng(dept, r.title)) newEng++; }
    const lo = r.salary_min ?? r.salary_max, hi = r.salary_max ?? r.salary_min;
    if (lo != null) { min = Math.min(min, lo); max = Math.max(max, hi); currency ??= r.salary_currency ?? undefined; }
  }
  for (const r of rows) boards.set(`${r.ats}:${r.board_slug}`, { ats: r.ats, slug: r.board_slug });
  const closedLast30d = rows.filter(r => !r.open && r.last_seen >= cutoff).length;

  const sig: HiringSignals = {
    company, openRoles: open.length, newLast30d: newCount, closedLast30d, byDepartment,
    byLocation: [...locs].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([location, count]) => ({ location, count })),
    remoteShare: open.length ? Math.round((remote / open.length) * 100) / 100 : 0,
    seniorityMix: mix,
    salaryRange: max > 0 ? { min, max, currency } : undefined,
    boards: [...boards.values()],
    sampleTitles: open.slice(0, 10).map(r => r.title),
    notes: [],
  };
  sig.notes = signalNotes(sig, newEng);
  return sig;
}

function signalNotes(s: HiringSignals, newEng: number): string[] {
  const n: string[] = [];
  if (!s.openRoles) return ["No open roles in the local index for this company. Run a sync, or check whether it uses a board OpenApply does not cover."];
  if (newEng >= 3) n.push(`${newEng} new engineering roles in 30 days: team is scaling.`);
  else if (s.newLast30d >= 5) n.push(`${s.newLast30d} roles posted in the last 30 days: active hiring push.`);
  else if (s.newLast30d === 0) n.push("Nothing new in 30 days: hiring is slow or this is a long-open backlog.");
  if (s.closedLast30d > 0) n.push(`${s.closedLast30d} role${s.closedLast30d > 1 ? "s" : ""} closed in the last 30 days (filled or pulled).`);
  const top = Object.entries(s.byDepartment).sort((a, b) => b[1] - a[1])[0];
  if (top && s.openRoles >= 4 && top[1] / s.openRoles >= 0.5) n.push(`${Math.round((top[1] / s.openRoles) * 100)}% of openings are ${top[0]}: that is where the company is investing.`);
  const gtm = s.byDepartment.GTM ?? 0;
  if (gtm >= 1 && gtm <= 2 && s.openRoles >= 5) n.push(`Only ${gtm} GTM role${gtm > 1 ? "s" : ""} open: possibly an early go-to-market build-out, or a first GTM hire.`);
  const senior = (s.seniorityMix["staff+"] ?? 0) + (s.seniorityMix["director+"] ?? 0);
  if (senior >= 2) n.push(`${senior} staff-or-director level roles open: building out leadership.`);
  if (s.openRoles <= 3) n.push("Very few open roles: likely a small company, so reaching the founders directly may beat the application form.");
  if (s.remoteShare >= 0.7) n.push("Mostly remote postings.");
  return n;
}

export interface CompanyBrief {
  job: Job;
  signals: HiringSignals;
  whyNow: string[];
  researchChecklist: string[];
  proofOfWorkIdeas: string[];
  questionsToAsk: string[];
  focusCheck: string;
}

type Family = "pm" | "eng" | "gtm" | "design" | "ops" | "data" | "other";

export function roleFamily(title: string): Family {
  const t = title.toLowerCase();
  if (/product manager|\bpm\b|product lead|head of product/.test(t)) return "pm";
  if (/design|ux|ui\b/.test(t)) return "design";
  if (/data (scientist|analyst|engineer)|analytics|machine learning|\bml\b/.test(t)) return "data";
  if (/engineer|developer|software|sre|devops|architect|forward deployed|solutions engineer/.test(t)) return "eng";
  if (/sales|account exec|\bsdr\b|\bbdr\b|marketing|growth|partnership|customer success|go.to.market|\bgtm\b|revenue|business development|content/.test(t)) return "gtm";
  if (/operations|\bops\b|chief of staff|finance|people|recruit|program manager|strategy/.test(t)) return "ops";
  return "other";
}

const PROOF: Record<Family, (c: string) => string[]> = {
  pm: c => [
    `Teardown of ${c}'s onboarding or core flow: what works, what loses users, and three specific changes with expected impact.`,
    `Synthesis of 5 short user interviews (people who use ${c} or a competitor): themes, quotes, and the one problem you would fix first.`,
    `One-page PRD for a feature ${c} could ship next, tied to something in this job description.`,
    `Competitive grid of ${c} against 3 alternatives on the dimensions customers actually choose by.`,
  ],
  eng: c => [
    `Small working prototype built on ${c}'s public API, SDK or docs, with a short README and a demo clip.`,
    `A pull request or issue with a real fix to one of their open-source repos, if they have any.`,
    `A short write-up of a technical problem named in this job description, with a minimal implementation of your approach.`,
    `A benchmark or reliability teardown of one ${c} public surface (docs, API, status page).`,
  ],
  gtm: c => [
    `Point-of-view memo on ${c}'s market: who buys, why now, and where the pipeline should come from.`,
    `A 20-account target list for ${c} with the trigger and first-message angle for each.`,
    `Teardown of ${c}'s website and sales motion (positioning, pricing page, outbound they send) with 3 fixes.`,
    `A sample outbound sequence for one segment, written in plain words.`,
  ],
  design: c => [
    `Redesign of one ${c} flow (onboarding, pricing, or checkout), before and after, with the reasoning.`,
    `Heuristic review of ${c}'s product with the five highest-impact usability problems.`,
    `A small component or interaction prototype that fits their existing visual language.`,
    `A one-page design critique of a competitor flow and what ${c} should take from it.`,
  ],
  data: c => [
    `Dashboard on public data relevant to ${c}'s market (or ${c}'s own public numbers) answering one business question.`,
    `A short analysis of a metric the JD names, with the SQL or notebook linked.`,
    `A prototype model or pipeline for a problem ${c} likely has, with honest evaluation and limits.`,
  ],
  ops: c => [
    `Dashboard or tracker for a process this role owns at ${c} (pipeline, hiring funnel, spend), built from sample data.`,
    `Process teardown: how the function probably runs today, where it breaks at ${c}'s stage, and a 30-60-90 plan to fix it.`,
    `A one-page operating cadence (weekly metrics, owners, reviews) for the team.`,
  ],
  other: c => [
    `A short teardown of ${c}'s product and the problem this role exists to solve, with three concrete suggestions.`,
    `A 30-60-90 day plan for this role, written from public information only.`,
    `A small artifact (memo, prototype, or dashboard) that shows how you would approach the first problem named in the JD.`,
  ],
};

function whyNowFor(job: Job, s: HiringSignals): string[] {
  const text = `${job.title}\n${job.description}`.toLowerCase();
  const w: string[] = [];
  if (/\bfirst\b|\bfounding\b|\bearly\b|0\s*(to|-)\s*1|from scratch|zero to one/.test(text)) w.push("Inference: posting says 'first', 'founding' or 'from scratch', so this likely builds a new function rather than backfilling one.");
  if (/\bseries [a-c]\b|recently raised|\bfunding\b|backed by/.test(text)) w.push("Inference: posting mentions funding, so hiring is probably tied to fresh capital. Confirm the round and date.");
  if (/\bscal(e|ing)\b|hyper.?growth|rapid growth/.test(text)) w.push("Inference: the text talks about scaling, so expect process-building and a fast-changing org.");
  if (/\breplace|\bbackfill/.test(text)) w.push("Inference: possible backfill; ask what the previous person did and why the seat opened.");
  if (/\bownership|end.to.end|wear many hats|ambiguity/.test(text)) w.push("Inference: language about ownership and ambiguity suggests a small team with loose process.");
  if (s.newLast30d >= 5) w.push(`Inference: ${s.newLast30d} roles opened in 30 days, so this hire is likely part of a broader build-out.`);
  if (s.closedLast30d >= 3 && s.newLast30d < 2) w.push("Inference: several roles closed recently with few new ones, which can mean a hiring freeze or a reorg. Ask about it.");
  if (!w.length) w.push("Inference: nothing in the posting or local data pins down why now. That is a question for the recruiter.");
  return w;
}

function questionsFor(job: Job, fam: Family): string[] {
  const q = [
    "What does success look like in this role at 30, 60 and 90 days?",
    "What problem does this hire solve that is not getting solved today?",
    "Where is the company in its growth: what changed in the last two quarters, and what is the next milestone?",
    "Who are the closest competitors, and where do you win and lose against them?",
    "What is on the roadmap for the next six months that this role touches?",
    "Why is this seat open now, and how did the team decide to hire for it?",
  ];
  if (fam === "eng") q.push("How do technical decisions get made, and how often does the team ship to customers?");
  if (fam === "gtm") q.push("What is the current pipeline source mix, and what is the sales cycle and average deal size?");
  if (fam === "pm") q.push("How are priorities set between customers, leadership and engineering?");
  if (fam === "design") q.push("How early does design enter product decisions, and who signs off?");
  return q;
}

/** Heuristic prep from the JD and local signals. No network, no LLM: the agent does the live research. */
export async function companyBrief(jobId: string): Promise<CompanyBrief> {
  const job = await getJobFull(jobId);
  if (!job) throw new Error(`Unknown job id ${jobId}`);
  const signals = hiringSignals(job.company);
  const fam = roleFamily(job.title);
  const c = job.company;
  const researchChecklist = [
    `What ${c} sells, to whom, and the pricing model (product pages, docs, changelog).`,
    `Customers and proof points: case studies, logos, public reviews.`,
    `Competitors and how ${c} positions against them.`,
    `Stage and funding: last round, date, investors, headcount trend.`,
    `Recent news, launches, and posts by the founders and the likely hiring manager.`,
    `The people: who would manage this role, who sits on the team, and what they post publicly about the work.`,
    `The problem this role solves right now, restated in your own words from the JD: "${job.title}" responsibilities.`,
    `Glassdoor or community chatter on how the team actually works (treat as anecdotal).`,
  ];
  return {
    job, signals, whyNow: whyNowFor(job, signals), researchChecklist,
    proofOfWorkIdeas: PROOF[fam](c), questionsToAsk: questionsFor(job, fam), focusCheck: focusCheck(job),
  };
}

/** Recruiters' advice: pick 2 of 4 (role, stage, geography, industry) and stay on them. */
function focusCheck(job: Job): string {
  const t = loadProfile()?.targets;
  if (!t) return "No targets in the profile yet. Pick 2 of 4 parameters (role, stage, geography, industry) to focus on and save them, so the list stays targeted.";
  const hay = `${job.title} ${job.description}`.toLowerCase();
  const hits: string[] = [];
  const misses: string[] = [];
  const roleOk = !t.titles?.length || t.titles.some(x => job.title.toLowerCase().includes(x.toLowerCase()));
  if (t.titles?.length) (roleOk ? hits : misses).push("role");
  if (t.locations?.length || t.remoteOk) {
    const locOk = (t.remoteOk && job.remote) || (t.locations ?? []).some(l => job.location.toLowerCase().includes(l.toLowerCase()));
    (locOk ? hits : misses).push("geography");
  }
  if (t.keywords?.length) (t.keywords.some(k => hay.includes(k.toLowerCase())) ? hits : misses).push("industry/keywords");
  const verdict = hits.length >= 2 ? "Fits at least 2 of your parameters: worth a targeted push."
    : hits.length === 1 ? "Fits only 1 of your parameters: apply only if the company itself is a priority."
    : "Fits none of your tracked parameters: probably skip.";
  return `${verdict} Matches: ${hits.join(", ") || "none"}. Misses: ${misses.join(", ") || "none"}. Stage is not in the job data: check it yourself.`;
}
