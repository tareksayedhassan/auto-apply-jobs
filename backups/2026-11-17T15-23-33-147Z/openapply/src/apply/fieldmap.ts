import type { FormField, Job, Profile, Resume } from "../types.js";

/** Everything the mapper may draw from. `answers` = pack answers merged with agent answers (agent wins). */
export interface MapContext {
  profile?: Profile;
  resume?: Resume;
  answers: Record<string, string>;
  files: { resume?: string; cover?: string };
  coverLetter?: string;
  /** The role's location: the place a relocation or office question means when it names none. */
  job?: Pick<Job, "location" | "remote">;
}

export interface Suggestion { value: string; source: "pack" | "profile" | "savedAnswer" | "default" }

const STOP = new Set(["a", "an", "the", "you", "your", "are", "is", "do", "to", "of", "in", "for", "or", "and", "if", "any", "this", "that", "with", "on", "at", "we", "our", "us", "please", "be", "have", "will", "what"]);

export function norm(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter(t => t && !STOP.has(t)));
}

/** 0..1 similarity: exact 1, containment 0.9, else token overlap over the larger set. */
export function similarity(a: string, b: string): number {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if ((na.length >= 8 && nb.includes(na)) || (nb.length >= 8 && na.includes(nb))) return 0.9;
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

/** Best entry of a question->answer map for a form label, or undefined below `min`. */
/** How alike a pack question and a form label must be to count as the same question. */
export const MATCH_MIN = 0.6;

export function lookup(map: Record<string, string> | undefined, label: string, min = MATCH_MIN): string | undefined {
  return lookupEntry(map, label, min)?.[1];
}

/** lookup, with the question it matched. */
function lookupEntry(map: Record<string, string> | undefined, label: string, min = MATCH_MIN): [string, string] | undefined {
  let best: [string, string] | undefined, score = min;
  for (const [q, a] of Object.entries(map ?? {})) {
    const s = similarity(q, label);
    if (s >= score && a !== "") { best = [q, a]; score = s; }
  }
  return best;
}

/** Relocating, office or on-site days, commuting, travel: a promise about a place. */
const COMMITMENT = /relocat|\bon ?site\b|\b(in|at|from|into|to) (the |our |an? )?(\w+ )?office\b|\boffice (role|days?|based)\b|\bin person\b|\bcommut|\btravel|\bdays (a|per) week\b|\bhybrid\b/;
const NOT_PLACE = /^(I|I['’]\S*|January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;

/** Places a label names: runs of capitalized words after each sentence's first word ("San Francisco", "California", "NYC"). */
function placesIn(label: string): string[] {
  return label.split(/[.?!:;]\s+/).flatMap(s => [...s.replace(/^\W*\S+/, "").matchAll(/\p{Lu}[\p{L}\p{N}.'’-]*(?:\s+\p{Lu}[\p{L}\p{N}.'’-]*)*/gu)])
    .map(m => m[0]).filter(w => !NOT_PLACE.test(w));
}

/**
 * The place a commitment question binds the user to: the first place it names, else the job's city (none for a remote
 * job), "" when there is none. undefined when the question is no commitment. A start date counts only "in" a place
 * ("start in Boston"); sponsorship and work-authorization questions are never one ("to start or continue to work ... in
 * the United States").
 */
export function commitmentPlace(label: string, job?: MapContext["job"]): string | undefined {
  const L = norm(label);
  if (/\bsponsor|\bvisa\b|authori[sz]ed|work authori|legally (able|eligible|permitted)|right to work|eligible to work/.test(L)) return undefined;
  const named = placesIn(label);
  const startIn = /\bstart(?:\s+\w+)?\s+in\s+(?:the\s+|our\s+)?\p{Lu}/u.test(label) && named.length > 0;
  if (!COMMITMENT.test(L) && !startIn) return undefined;
  if (named.length) return named[0];
  return job && !job.remote ? job.location.split(/[,;/|(]/)[0].trim() : "";
}

/** Normalized text with the common short names spelled out, so NYC and New York City both read "new york". */
const canon = (s: string) => ` ${norm(s)} `.replace(/ (nyc|new york city) /g, " new york ").replace(/ sf /g, " san francisco ");
/** Whether a text names a place (whole words, case, punctuation and NYC/SF aside). */
const names = (text: string | undefined, place: string) => !!text && canon(text).includes(canon(place));

const NEG = /\b(no|not|dont|don t|do not|wont|will not|cannot|cant|never|n t)\b/;
const DECLINE = /decline|prefer not|(dont|do not) (wish|want)|not wish|choose not|rather not|not to (say|answer|disclose|self|specify)|no answer/;

/** Pick the option matching a yes/no answer ("Yes", "I am authorized...", "No, I will not require..."). */
export function yesNoOption(options: string[], yes: boolean): string | undefined {
  const n = options.map(norm);
  const lead = n.findIndex(o => (yes ? /^yes\b/ : /^no\b/).test(o));
  if (lead >= 0) return options[lead];
  const cands = options.filter((_, i) => !DECLINE.test(n[i]) && NEG.test(n[i]) !== yes);
  return cands.length === 1 ? cands[0] : undefined;
}

/** Closest option for a free-text value; undefined when nothing is close (never a random pick). `strict` also refuses a tie. */
export function bestOption(options: string[], value: string, strict = false): string | undefined {
  const v = norm(value);
  if (!v) return undefined;
  if (/^(yes|y|true)$/.test(v)) return yesNoOption(options, true);
  if (/^(no|n|false)$/.test(v)) return yesNoOption(options, false);
  let best: string | undefined, score = 0.5, tie = false;
  for (const o of options) {
    const no = norm(o);
    let s = similarity(o, value);
    if (no && (no.startsWith(v) || v.startsWith(no))) s = Math.max(s, 0.85);
    if (s > score) { best = o; score = s; tie = false; } else if (best && s === score) tie = true;
  }
  return strict && tie ? undefined : best;
}

/** The option that reads exactly like the value (case and punctuation aside), for lists where a near miss is a different answer. */
export function exactOption(options: string[], value: string): string | undefined {
  const v = norm(value);
  return v ? options.find(o => norm(o) === v) : undefined;
}

/**
 * The option(s) a multi-select answer names. An answer equal to one option picks only that option, even when the
 * option itself contains commas. A list ("Career Growth, Compensation") picks each entry. When any option contains a
 * separator the answer cannot be split safely: it must be made of whole options (and "and"/"or") to pick them;
 * otherwise it picks the one option it is clearly a rewording of, or nothing.
 */
export function pickOptions(options: string[], raw: string): string[] {
  const n = norm(raw);
  const exact = options.find(o => norm(o) === n);
  if (exact) return [exact];
  if (!options.some(o => /[,;|]/.test(o))) {
    return [...new Set(raw.split(/\s*[,;|]\s*/).map(p => bestOption(options, p)).filter((p): p is string => !!p))];
  }
  let hay = ` ${n} `;
  const found: Array<[number, string]> = [];
  for (const o of [...options].sort((a, b) => norm(b).length - norm(a).length)) {
    const no = ` ${norm(o)} `;
    const at = no.trim() ? hay.indexOf(no) : -1;
    if (at < 0) continue;
    found.push([at, o]);
    hay = hay.slice(0, at) + " ".repeat(no.length) + hay.slice(at + no.length);
  }
  if (found.length && !hay.replace(/\b(and|or)\b/g, " ").trim()) return found.sort((a, b) => a[0] - b[0]).map(([, o]) => o);
  const reworded = bestOption(options, raw, true);
  return reworded ? [reworded] : [];
}

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
/** Full state names; Georgia is left out because it is also a country. */
const STATE_NAMES = new Set(Object.values(US_STATES).filter(n => n !== "Georgia"));

/**
 * Closest place suggestion for a location like "Brooklyn, NY". US state codes are expanded so
 * "Brooklyn, New York, United States" wins and "Brooklyn, New South Wales" does not.
 * Needs 3 shared tokens (city + region/country); undefined rather than a wrong city.
 */
export function bestPlace(options: string[], value: string): string | undefined {
  const direct = bestOption(options, value);
  if (direct) return direct;
  const code = value.split(",").map(p => p.trim().toUpperCase()).find(p => US_STATES[p]);
  const state = code && US_STATES[code];
  const want = tokens([value, state ?? "", state ? "United States USA" : ""].join(" "));
  let best: string | undefined, score = Math.min(3, want.size) - 1;
  for (const o of options) {
    const t = tokens(o);
    if (state && !norm(o).includes(norm(state)) && !t.has(code!.toLowerCase())) continue;
    let hit = 0;
    for (const w of want) if (t.has(w)) hit++;
    if (hit > score) { best = o; score = hit; }
  }
  return best;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const COUNT: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };

/** Local YYYY-MM-DD (toISOString is UTC and can land a day off). */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** A real calendar day, or undefined (Feb 30 is not one). */
const day = (y: number, m: number, d: number) => {
  const t = new Date(y, m - 1, d);
  return t.getMonth() === m - 1 && t.getDate() === d ? ymd(t) : undefined;
};

/**
 * A start-date answer as YYYY-MM-DD for a date field, or undefined when it names no date (the question then goes back
 * to the user). Takes a date (2026-11-04, 11/04/2026, Nov 4 2026, November 4) or a span from today ("1-2 weeks",
 * "two weeks' notice", "a month", "immediately"): a span counts its upper bound, and a start on a weekend moves to the Monday.
 */
export function toDate(raw: string, today = new Date()): string | undefined {
  const s = raw.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return day(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return day(+m[3], +m[1], +m[2]);
  m = /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(s);
  const month = m ? MONTHS.findIndex(n => n.startsWith(m![1])) + 1 : 0;
  if (m && month) {
    if (m[3]) return day(+m[3], month, +m[2]);
    const next = day(today.getFullYear(), month, +m[2]);
    return next && next < ymd(today) ? day(today.getFullYear() + 1, month, +m[2]) : next;
  }
  let days: number | undefined;
  if (/^(immediately|asap|as soon as possible|right away|now|today)$/.test(s)) days = 0;
  m = /^(?:(?:in|within|about|around|approximately|roughly) )?(\d+|a|an|one|two|three|four|five|six)(?: ?(?:-|–|to|or) ?(\d+|two|three|four|five|six))? ?(day|week|month)s?['’]?(?: notice)?$/.exec(s);
  if (m) days = (COUNT[m[2] ?? m[1]] ?? +(m[2] ?? m[1])) * UNIT_DAYS[m[3]];
  if (days === undefined) return undefined;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  start.setDate(start.getDate() + (start.getDay() === 6 ? 2 : start.getDay() === 0 ? 1 : 0));
  return ymd(start);
}

function declineOption(options?: string[]): string | undefined {
  return options?.find(o => DECLINE.test(norm(o)));
}

const HEAR_PREFS = ["company website", "careers page", "company careers", "website", "job board", "online", "internet", "other"];

/** Fit a raw answer to the field: map onto an option when the field has options. */
function fit(field: FormField, raw: string | boolean | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (field.type === "date") return typeof raw === "string" ? toDate(raw) : undefined;
  const opts = field.options;
  if (typeof raw === "boolean") return opts?.length ? yesNoOption(opts, raw) : raw ? "Yes" : "No";
  if (!opts?.length) return raw;
  if (field.type === "checkbox" && opts.length > 1) {
    const picks = pickOptions(opts, raw);
    return picks.length ? picks.join(", ") : undefined;
  }
  if (field.type === "checkbox" && opts.length <= 1) return /^(yes|y|true|1|checked|agree|i agree)$/i.test(raw.trim()) ? "Yes" : undefined;
  return bestOption(opts, raw);
}

function countryFrom(p: Profile): string | undefined {
  if (p.phone?.trim().startsWith("+1") || /\b(usa|united states|us)\b/i.test(p.location ?? "")) return "United States";
  const last = (p.location ?? "").split(",").map(s => s.trim()).pop();
  // A trailing state name, or a state code with a 10-digit US number ("New York, NY"; "Berlin, DE" alone is Germany)
  const usPhone = (p.phone ?? "").replace(/\D/g, "").length === 10;
  const stateCode = !!last && usPhone && !!US_STATES[last.toUpperCase()];
  if (stateCode || (last && STATE_NAMES.has(last))) return "United States";
  return last && last.length > 3 ? last : undefined;
}

/** Profile-derived value for a label. Booleans mean a yes/no answer. */
function fromProfile(field: FormField, ctx: MapContext): string | boolean | undefined {
  const p = ctx.profile;
  const L = norm(field.label);
  const job = ctx.resume?.experience?.[0];
  if (!p) return undefined;
  if (/\b(cover letter)\b/.test(L) && field.type !== "file") return ctx.coverLetter;
  if (/\bpronoun/.test(L)) return p.pronouns;
  if (/\b(first|given) name\b|^preferred (first )?name\b|^preferred name/.test(L)) return p.firstName;
  if (/\b(last|family) name\b|\bsurname\b/.test(L)) return p.lastName;
  if (/^(full |legal |your )?name$|\bfull name\b|\blegal name\b/.test(L)) return `${p.firstName} ${p.lastName}`;
  if (/\be ?mail\b/.test(L)) return p.email;
  if (/\b(phone|mobile|cell)\b/.test(L) && !/country/.test(L)) return p.phone;
  if (/\blinkedin\b/.test(L)) return p.linkedin;
  if (/\bgithub\b/.test(L)) return p.github;
  // A long free-text question that only mentions "city", "website" or "employer" is asking something else.
  const prose = (field.type === "text" || field.type === "textarea") && field.label.trim().split(/\s+/).length > 6;
  if (!prose && /\b(website|portfolio|personal site|blog)\b/.test(L)) return p.website;
  if (/\bsponsor|\bvisa\b/.test(L)) return p.needsSponsorship;
  if (/authori[sz]ed|legally (able|eligible|permitted)|right to work|eligible to work|work authori/.test(L)) return p.workAuthorizedUS;
  if (/relocat/.test(L)) return p.willingToRelocate;
  if (/^country( code)?$|\bcountry\b.*\b(reside|based|located|live)\b|\b(reside|based|located|live)\b.*\bcountry\b/.test(L)) return countryFrom(p);
  if (/where (are |do )?you (currently )?(located|based|live)|where do you plan on working|currently located|(what|which) city|city and state/.test(L)) return p.location;
  if (!prose && /\blocation\b|\bcity\b|\baddress\b/.test(L)) return p.location;
  if (!prose && /\b(current (company|employer)|company name|employer)\b|^company$|^org$/.test(L)) return job?.company;
  if (!prose && /\b(current (job )?title|job title|current role|current position)\b/.test(L)) return job?.title;
  if (/(salary|compensation|pay) (expectation|requirement|range)|(expected|desired) (salary|compensation|pay)/.test(L)) return p.salaryExpectation;
  // Greenhouse's education block (first entry). Only the exact listed wording is taken from a list: a near miss is a
  // different degree or major, so the question stays blank for the user. The year labels never reach the notice period.
  const edu = p.education?.[0];
  const listed = (v?: string) => (v && field.options?.length ? exactOption(field.options, v) : v);
  if (L === "school") return edu?.school;
  if (L === "degree") return listed(edu?.degree);
  if (L === "discipline") return listed(edu?.discipline);
  if (L === "start date year") return edu?.startYear ? String(edu.startYear) : undefined;
  if (L === "end date year") return edu?.endYear ? String(edu.endYear) : undefined;
  if (/notice period|when can you start|earliest .*start|start date|available to start/.test(L)) return p.noticePeriod;
  return undefined;
}

const EEO: Array<[RegExp, keyof NonNullable<Profile["eeo"]>]> = [
  [/hispanic|latin[oax]/, "hispanic"],
  [/transgender/, "transgender"],
  [/sexual orientation|lgbt/, "orientation"],
  [/\bgender\b|\bsex\b/, "gender"],
  [/\brac(e|ial)\b|ethnic/, "race"],
  [/veteran/, "veteran"],
  [/disabilit/, "disability"],
];

/** Value for one field, or undefined when the agent must answer it. */
export function suggest(field: FormField, ctx: MapContext): Suggestion | undefined {
  if (field.type === "file") {
    const L = norm(field.label);
    if (/cover/.test(L)) return ctx.files.cover ? { value: ctx.files.cover, source: "pack" } : undefined;
    if (/resume|\bcv\b/.test(L)) return ctx.files.resume ? { value: ctx.files.resume, source: "pack" } : undefined;
    return undefined;
  }
  const direct = fit(field, ctx.answers[field.key] ?? lookup(ctx.answers, field.label));
  if (direct) return { value: direct, source: "pack" };

  const L = norm(field.label);
  const eeo = EEO.find(([re]) => re.test(L));
  if (eeo && !/pronoun/.test(L)) {
    const own = ctx.profile?.eeo?.[eeo[1]]?.split("|").map(v => fit(field, v.trim())).find(Boolean);
    if (own) return { value: own, source: "profile" };
    const d = declineOption(field.options);
    return d ? { value: d, source: "default" } : undefined;
  }

  // A relocation or office question about a place is answered only by a profile or saved answer that names that place.
  const place = commitmentPlace(field.label, ctx.job);
  const prof = !place || names(ctx.profile?.location, place) ? fit(field, fromProfile(field, ctx)) : undefined;
  if (prof) return { value: prof, source: "profile" };

  const hit = lookupEntry(ctx.profile?.savedAnswers, field.label);
  const saved = hit && (!place || names(hit.join(" "), place)) ? fit(field, hit[1]) : undefined;
  if (saved) return { value: saved, source: "savedAnswer" };

  if (/how (did |do )?you (hear|heard|learn|learned|find|found|discover)|where did you (hear|find|learn|see)|referral source|^source$/.test(L)) {
    if (!field.options?.length) return { value: "Company website", source: "default" };
    for (const pref of HEAR_PREFS) {
      const o = field.options.find(x => norm(x).includes(pref));
      if (o) return { value: o, source: "default" };
    }
    return undefined;
  }
  if (/\bpronoun/.test(L)) {
    const d = declineOption(field.options);
    if (d) return { value: d, source: "default" };
  }
  return undefined;
}
