import { searchJobs } from "./db.js";
import { loadProfile, loadResume } from "./profile.js";
import type { Job, MatchResult, Profile, Resume } from "./types.js";

const STOP = new Set(("a an and are as at be by for from has have in is it of on or our that the their this to we with you your will " +
  "can all any not but if more most other such than then them they who what when where which while about across into over per via " +
  "experience work working team teams role company years year strong ability skills including etc using use new help build building " +
  "looking join us job position candidate responsibilities requirements qualifications benefits equal opportunity employer").split(" "));

const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9][a-z0-9+#.]*[a-z0-9+#]|[a-z0-9]/g) ?? []).map(stem);
const sig = (s: string) => tokens(s).filter(t => !STOP.has(t) && t.length > 1);

/** Everything about the user that scoring needs, computed once per profile/resume object. */
interface Ctx {
  titles: string[][];           // tokenized target titles
  titlesInferred: boolean;
  keywords: Array<{ phrase: string; toks: string[] }>;   // explicit: targets.keywords + skills
  bulletTerms: string[];        // significant terms from resume bullets
  locations: string[];
  remoteOk: boolean;
  seniority: number[];
  excludeCompanies: string[];
  excludeKeywords: string[];
  minSalary?: number;
}

/** Stored profiles may hold a bare string (or null) where a list belongs. */
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []);

function buildCtx(profile?: Profile, resume?: Resume): Ctx {
  const t = profile?.targets ?? {};
  let titles = list(t.titles).map(sig).filter(x => x.length);
  const inferred = titles.length === 0 && !!resume;
  if (inferred) titles = (resume!.experience ?? []).slice(0, 2).map(e => sig(e.title)).filter(x => x.length);

  const explicit = new Set<string>();
  for (const k of [...list(t.keywords), ...list(resume?.skills)]) {
    const phrase = k.toLowerCase().replace(/\s*\(.*\)\s*/g, " ").trim();
    if (phrase && phrase.length < 40) explicit.add(phrase);
  }
  const keywords = [...explicit].map(phrase => ({ phrase, toks: tokens(phrase) })).filter(k => k.toks.length);

  const freq = new Map<string, number>();
  for (const e of resume?.experience ?? []) for (const b of e.bullets ?? []) for (const w of sig(b)) {
    if (!/^\d/.test(w) && w.length > 3) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const known = new Set(keywords.flatMap(k => k.toks));
  const bulletTerms = [...freq].filter(([w]) => !known.has(w)).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w]) => w);

  let locations = list(t.locations).map(l => l.toLowerCase());
  if (!locations.length && profile?.location) locations = [profile.location.split(",")[0].trim().toLowerCase()];
  return {
    titles, titlesInferred: inferred, keywords, bulletTerms, locations,
    remoteOk: t.remoteOk ?? true,
    seniority: list(t.seniority).map(levelOf).filter((n): n is number => n !== undefined),
    excludeCompanies: list(t.excludeCompanies).map(c => c.toLowerCase()),
    excludeKeywords: list(t.excludeKeywords).map(c => c.toLowerCase()),
    minSalary: t.minSalary,
  };
}

let last: { profile?: Profile; resume?: Resume; ctx: Ctx } | undefined;

/** listMatches scores thousands of jobs against the same profile; build the context once. */
function ctxFor(profile?: Profile, resume?: Resume): Ctx {
  if (!last || last.profile !== profile || last.resume !== resume) last = { profile, resume, ctx: buildCtx(profile, resume) };
  return last.ctx;
}

/** 1 intern/junior ... 5 director+. 2 is the default for an unmarked title. */
function levelOf(s: string): number | undefined {
  const x = s.toLowerCase();
  if (/\b(intern|internship|trainee|apprentice)\b/.test(x)) return 0;
  if (/\b(junior|jr|entry|graduate|new grad|associate)\b/.test(x)) return 1;
  if (/\b(mid|mid-level|intermediate)\b/.test(x)) return 2;
  if (/\b(senior|sr)\b/.test(x)) return 3;
  if (/\b(staff|principal|lead|manager)\b/.test(x)) return 4;
  if (/\b(director|head|vp|vice president|chief|cto|ceo|coo)\b/.test(x)) return 5;
  return undefined;
}

const hasWord = (hay: string, needle: string) =>
  new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(hay);

const money = (n: number) => `$${Math.round(n / 1000)}k`;

const US = /\b(us|u\.s\.|usa|united states|americas?|north america|anywhere|worldwide|global|earth)\b/;
const ABROAD = /\b(uk|united kingdom|england|london|emea|europe|european|eu|cet|cest|gmt|germany|berlin|munich|france|paris|spain|madrid|barcelona|portugal|lisbon|italy|netherlands|amsterdam|ireland|dublin|poland|warsaw|sweden|stockholm|norway|denmark|finland|switzerland|zurich|austria|belgium|czech|romania|ukraine|israel|tel aviv|india|bangalore|bengaluru|hyderabad|pune|delhi|apac|asia|singapore|japan|tokyo|korea|seoul|china|hong kong|taiwan|philippines|vietnam|indonesia|australia|sydney|melbourne|new zealand|latam|latin america|brazil|argentina|mexico|colombia|chile|peru|canada|toronto|vancouver|montreal|africa|nigeria|kenya|egypt|south africa|dubai|uae|turkey|macedonia|serbia|croatia|greece|estonia|lithuania|latvia|bulgaria|hungary|pakistan|bangladesh)\b/;

/** For remote roles: can the user work from where the role allows? */
function remoteRegion(loc: string, c: Ctx): "fits" | "outside" | "unknown" {
  const abroadTargets = c.locations.filter(l => ABROAD.test(l));
  if (abroadTargets.some(l => loc.includes(l))) return "fits";
  if (US.test(loc) || c.locations.some(l => l !== "remote" && loc.includes(l))) return "fits";
  if (ABROAD.test(loc)) return "outside";
  return "unknown";
}

export function scoreJob(job: Job, profile: Profile | undefined, resume: Resume | undefined): MatchResult {
  const c = ctxFor(profile, resume);
  const reasons: string[] = [];
  const titleLow = job.title.toLowerCase();
  const textLow = `${job.title} ${job.department ?? ""} ${job.description}`.toLowerCase();

  // hard exclusions
  const co = c.excludeCompanies.find(x => job.company.toLowerCase().includes(x));
  if (co) return { job, score: 0, reasons: [`Excluded company: ${co}`] };
  const kw = c.excludeKeywords.find(x => hasWord(textLow, x));
  if (kw) return { job, score: 0, reasons: [`Contains excluded keyword: ${kw}`] };

  let score = 0;

  // title (40)
  const jt = new Set(sig(job.title));
  let bestTitle = 0;
  let bestTitleToks: string[] = [];
  const jtSeq = sig(job.title).join(" ");
  for (const tt of c.titles) {
    let frac = tt.filter(w => jt.has(w)).length / tt.length;
    // All words but not in order ("Product Security Engineer" for "product engineer"): partial credit.
    if (frac === 1 && tt.length > 1 && !` ${jtSeq} `.includes(` ${tt.join(" ")} `)) frac = 0.75;
    if (frac > bestTitle) { bestTitle = frac; bestTitleToks = tt; }
  }
  if (bestTitle > 0) {
    const w = c.titlesInferred ? 24 : 40;
    score += w * (bestTitle === 1 ? 1 : bestTitle * bestTitle * 0.8);
    reasons.push(bestTitle === 1
      ? `Title matches ${c.titlesInferred ? "your recent role" : "a target title"} (${bestTitleToks.join(" ")})`
      : `Title partly matches (${Math.round(bestTitle * 100)}% of "${bestTitleToks.join(" ")}")`);
  } else if (c.titles.length) reasons.push("Title does not match your targets");

  // keywords (35): explicit keywords and skills count fully, resume bullet terms count a third
  if (c.keywords.length || c.bulletTerms.length) {
    const body = new Set(tokens(textLow));
    const titleToks = new Set(tokens(titleLow));
    let matched = 0;
    const hits: string[] = [];
    for (const k of c.keywords) {
      const ok = k.toks.length === 1 ? body.has(k.toks[0]) : textLow.includes(k.phrase);
      if (!ok) continue;
      matched += k.toks.every(t => titleToks.has(t)) ? 1.6 : 1;
      hits.push(k.phrase);
    }
    let bulletHits = 0;
    for (const w of c.bulletTerms) if (body.has(w)) bulletHits++;
    matched += bulletHits * 0.35;
    const denom = Math.min(Math.max(c.keywords.length, 4), 9);
    score += 35 * Math.min(1, matched / denom);
    if (hits.length) reasons.push(`Mentions ${hits.slice(0, 6).join(", ")}${hits.length > 6 ? ` and ${hits.length - 6} more` : ""}`);
    else if (bulletHits >= 3) reasons.push(`Shares ${bulletHits} terms with your resume bullets`);
  }

  // location (15, -30 when clearly outside the user's targets)
  const loc = job.location.toLowerCase();
  const locHit = c.locations.find(l => l !== "remote" && loc.includes(l));
  const region = remoteRegion(loc, c);
  if (locHit) { score += 15; reasons.push(`Location matches ${locHit}`); }
  else if (job.remote && c.remoteOk && region !== "outside") {
    score += region === "fits" ? 15 : 9;
    reasons.push(region === "fits" ? "Remote in a region you can work from" : "Remote (region not stated)");
  } else if (!c.locations.length && !job.remote) score += 7;
  else if (job.remote && region === "outside") { score -= 30; reasons.push(`Remote only in ${job.location}`); }
  else if (job.remote) reasons.push("Remote, but you prefer on-site");
  else { score -= 30; reasons.push(`Location (${job.location || "unspecified"}) is outside your targets`); }

  // seniority (-15..+5)
  const jl = levelOf(job.title);
  if (c.seniority.length) {
    const level = jl ?? 2;
    const dist = Math.min(...c.seniority.map(s => Math.abs(s - level)));
    if (dist === 0) { score += 5; if (jl !== undefined) reasons.push("Seniority fits"); }
    else { score -= Math.min(15, dist * 7); reasons.push(`Seniority mismatch (${job.title})`); }
  }

  // salary floor
  if (c.minSalary) {
    const top = job.salaryMax ?? job.salaryMin;
    if (top && top < c.minSalary) { score -= 20; reasons.push(`Pays up to ${money(top)}, below your ${money(c.minSalary)} floor`); }
    else if (top) { score += 5; reasons.push(`Pays up to ${money(top)}`); }
  }

  // recency (10)
  const posted = Date.parse(job.postedAt ?? job.firstSeen);
  if (!Number.isNaN(posted)) {
    const days = (Date.now() - posted) / 86400e3;
    const pts = days <= 3 ? 10 : days <= 7 ? 8 : days <= 14 ? 6 : days <= 30 ? 4 : days <= 60 ? 2 : 0;
    score += pts;
    if (days <= 7) reasons.push(`Posted ${Math.max(0, Math.round(days))} day${Math.round(days) === 1 ? "" : "s"} ago`);
  }

  return { job, score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

/** Candidate pool: one FTS search per target title / top keyword, merged. Falls back to recent open jobs. */
function candidates(c: Ctx, profile: Profile | undefined, opts: { postedWithinDays?: number; query?: string }): Job[] {
  const byId = new Map<string, Job>();
  const add = (jobs: Job[]) => { for (const j of jobs) byId.set(j.id, j); };
  const days = opts.postedWithinDays;
  if (opts.query) {
    add(searchJobs({ query: opts.query, postedWithinDays: days, limit: 200 }).jobs);
    return [...byId.values()];
  }
  const queries = [
    ...(profile?.targets?.titles ?? []).slice(0, 8),
    ...(profile?.targets?.keywords ?? []).slice(0, 4),
  ];
  for (const q of queries) add(searchJobs({ query: q, postedWithinDays: days, limit: 200 }).jobs);
  if (!queries.length) {
    for (let offset = 0; offset < 600; offset += 200) {
      const page = searchJobs({ postedWithinDays: days, limit: 200, offset }).jobs;
      add(page);
      if (page.length < 200) break;
    }
  }
  return [...byId.values()];
}

export function listMatches(opts: { limit?: number; postedWithinDays?: number; minScore?: number; query?: string } = {}): MatchResult[] {
  const profile = loadProfile();
  const resume = loadResume();
  const c = ctxFor(profile, resume);
  const minScore = opts.minScore ?? 25;
  return candidates(c, profile, opts)
    .map(j => scoreJob(j, profile, resume))
    .filter(m => m.score >= minScore && m.score > 0)
    .sort((a, b) => b.score - a.score || (b.job.postedAt ?? "").localeCompare(a.job.postedAt ?? ""))
    .slice(0, opts.limit ?? 25);
}
