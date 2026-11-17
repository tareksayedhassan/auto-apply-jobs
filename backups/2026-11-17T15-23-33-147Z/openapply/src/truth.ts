import { splitList } from "./resume-import.js";
import type { Resume } from "./types.js";

type Entry = Resume["experience"][number];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const FIGURE = /\$?\d[\d,]*(?:\.\d+)?\s?(?:%|[kmb]\b|x\b)?\+?/gi;

/** Key for comparing figures: "$300K+" and "300k" are the same claim. */
const figureKey = (f: string) => f.toLowerCase().replace(/[\s,$+]/g, "");

function figures(text: string): string[] {
  return (text.match(FIGURE) ?? []).map(figureKey).filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const tokens = (s: string) => norm(s).split(" ").filter(Boolean);
const PAREN = /\(([^)]*)\)/g;

/**
 * Same thing, allowing a shortened form: every word of `t` (tailored) must be a whole word of `m` (master).
 * Dropping words is fine, adding words is not. A parenthetical like "(acquired by X)" is ignored only if X is in the corpus.
 */
function similar(t: string, m: string, corpus: Set<string>): boolean {
  const own = t.replace(PAREN, (whole, inner: string) => {
    const by = /^\s*(?:acquired by|now part of|formerly|part of)\s+(.+)$/i.exec(inner)?.[1];
    return by && tokens(by).length && tokens(by).every(w => corpus.has(w)) ? " " : whole;
  });
  const x = tokens(own), y = new Set(tokens(m));
  return x.length > 0 && y.size > 0 && x.every(w => y.has(w));
}

/** "October 2024" / "Oct. 2024" / "10/2024" -> "2024-10"; "2024" -> "2024"; "Present" -> "present". */
function dateKey(d: string): string {
  const s = d.toLowerCase().trim();
  if (/^(present|current|now|today)$/.test(s)) return "present";
  const year = /\b((?:19|20)\d{2})\b/.exec(s)?.[1];
  if (!year) return s;
  const slash = /^(\d{1,2})\/\d{4}$/.exec(s);
  const mon = slash ? +slash[1] - 1 : MONTHS.findIndex(m => new RegExp(`\\b${m}`).test(s));
  return mon >= 0 ? `${year}-${String(mon + 1).padStart(2, "0")}` : year;
}

/** A tailored date is fine if it equals the master's, or is the same year when the master has a month. */
const dateOk = (t: string, m: string | undefined) => {
  if (!m) return false;
  const a = dateKey(t), b = dateKey(m);
  return a === b || (a.length === 4 && b.startsWith(a));
};

function resumeText(r: Resume): string {
  return JSON.stringify(r);
}

/** Scheduling figures a question states ("5-days in office", "3 days per week"): echoing one is not a new claim. */
const logistics = (q: string) => (q.match(/\d+(?=\s*-?\s*(?:days?|hours?|weeks?)\b)/gi) ?? []).map(figureKey);

/** `ownAnswers` is the user's own saved form answers (salary, start date): known for form answers only. */
export function truthCheck(
  master: Resume, sourceText: string, tailored: Resume, coverLetter?: string, answers?: Record<string, string>, ownAnswers = "",
): string[] {
  const w: string[] = [];
  const corpus = `${resumeText(master)}\n${sourceText}`;
  const known = new Set(figures(corpus));
  const own = new Set(figures(ownAnswers));
  const corpusLow = corpus.toLowerCase();
  const corpusWords = new Set(tokens(corpus));
  const same = (t: string, m: string) => similar(t, m, corpusWords);

  // ---- numbers in every free-text field
  const fields: Array<{ where: string; text: string; question?: string }> = [];
  if (tailored.summary) fields.push({ where: "the summary", text: tailored.summary });
  if (tailored.headline) fields.push({ where: "the headline", text: tailored.headline });
  for (const e of tailored.experience ?? []) (e.bullets ?? []).forEach((b, i) => fields.push({ where: `${e.company} bullet ${i + 1}`, text: b }));
  for (const p of tailored.projects ?? []) {
    if (p.description) fields.push({ where: `${p.name} description`, text: p.description });
    (p.bullets ?? []).forEach((b, i) => fields.push({ where: `${p.name} bullet ${i + 1}`, text: b }));
  }
  for (const x of tailored.extras ?? []) (x.items ?? []).forEach((t, i) => fields.push({ where: `${x.heading} item ${i + 1}`, text: t }));
  for (const e of tailored.education ?? []) (e.details ?? []).forEach((t, i) => fields.push({ where: `${e.school} detail ${i + 1}`, text: t }));
  if (coverLetter) fields.push({ where: "the cover letter", text: coverLetter });
  for (const [q, a] of Object.entries(answers ?? {})) if (a) fields.push({ where: `the answer to "${q}"`, text: String(a), question: q });

  for (const f of fields) {
    const asked = f.question === undefined ? [] : logistics(f.question);
    const ok = (k: string) => known.has(k) || (f.question !== undefined && (own.has(k) || asked.includes(k)));
    for (const raw of f.text.match(FIGURE) ?? []) {
      if (!ok(figureKey(raw))) w.push(`New number "${raw.trim()}" in ${f.where} is not in your master resume`);
    }
    if (f.text.includes("—")) w.push(`Style: em dash in ${f.where}; use a comma, colon or period`);
  }

  // ---- contact
  if (norm(tailored.name) !== norm(master.name)) w.push(`Name "${tailored.name}" differs from your master resume ("${master.name}")`);
  for (const k of ["email", "phone"] as const) {
    const t = tailored.contact?.[k];
    if (t && t.replace(/\D/g, "") !== (master.contact?.[k] ?? "").replace(/\D/g, "") && norm(t) !== norm(master.contact?.[k] ?? "")) {
      w.push(`Contact ${k} "${t}" does not match your master resume`);
    }
  }

  // ---- employers, titles, dates
  for (const e of tailored.experience ?? []) {
    const m = (master.experience ?? []).filter(x => same(e.company, x.company));
    if (!m.length) { w.push(`Employer "${e.company}" is not in your master resume`); continue; }
    const match = m.find(x => same(e.title, x.title));
    if (!match) w.push(`Title "${e.title}" at ${e.company} does not match your master resume (${m.map(x => `"${x.title}"`).join(", ")})`);
    const ref: Entry = match ?? m[0];
    for (const k of ["start", "end"] as const) {
      const t = e[k];
      if (t && !dateOk(t, ref[k])) w.push(`Date "${t}" (${k}) at ${e.company} does not match your master resume (${ref[k] ?? "none"})`);
    }
  }

  // ---- education
  for (const e of tailored.education ?? []) {
    const m = (master.education ?? []).filter(x => same(e.school, x.school));
    if (!m.length) { w.push(`School "${e.school}" is not in your master resume`); continue; }
    if (e.degree && !m.some(x => x.degree && same(e.degree!, x.degree))) {
      w.push(`Degree "${e.degree}" at ${e.school} does not match your master resume (${m.map(x => `"${x.degree ?? "none"}"`).join(", ")})`);
    }
    for (const k of ["start", "end"] as const) {
      const t = e[k];
      if (t && !m.some(x => dateOk(t, x[k]))) w.push(`Date "${t}" (${k}) at ${e.school} does not match your master resume`);
    }
  }

  // ---- projects (name only)
  for (const p of tailored.projects ?? []) {
    if (!(master.projects ?? []).some(x => same(p.name, x.name)) && !(norm(p.name) && corpusLow.includes(p.name.toLowerCase()))) {
      w.push(`Project "${p.name}" is not in your master resume`);
    }
  }

  // ---- skills (soft)
  for (const s of (tailored.skills ?? []).flatMap(x => splitList(x.replace(/^[^:,(]{1,30}:\s*/, "")))) {
    const key = s.toLowerCase().replace(/\s*\(.*\)\s*/g, "").trim();
    if (key && !corpusLow.includes(key)) w.push(`New skill "${s}" is not in your master resume or source text (soft warning)`);
  }

  return [...new Set(w)];
}

// ---------------------------------------------------------------- voice

const CLICHES: Array<[RegExp, string]> = [
  [/\bi am (so |truly |really )?thrilled\b/i, "I am thrilled"],
  [/\bi am (so |truly |really )?excited to apply\b/i, "I am excited to apply"],
  [/\bpassionate about\b/i, "passionate about"],
  [/\bleverag(e|es|ed|ing)\b/i, "leverage"],
  [/\bdelv(e|es|ed|ing)\b/i, "delve"],
  [/\btestament to\b/i, "testament to"],
  [/\bfast[- ]paced (work )?environment\b/i, "fast-paced environment"],
  [/\bsynerg(y|ies|ize)\b/i, "synergy"],
  [/\bproven track record\b/i, "proven track record"],
  [/\bresults[- ]driven\b/i, "results-driven"],
  [/\bdynamic\b/i, "dynamic"],
  [/\bever[- ]evolving\b/i, "ever-evolving"],
  [/\bgreat fit\b/i, "great fit"],
  [/\bhit the ground running\b/i, "hit the ground running"],
  [/\btapestry\b/i, "tapestry"],
  [/\bnavigate the complexities\b/i, "navigate the complexities"],
  [/\bunlock(s|ed|ing)? (the )?(potential|value|growth)\b/i, "unlock"],
  [/\belevate\b/i, "elevate"],
  [/\bseamless(ly)?\b/i, "seamless"],
  [/\brobust\b/i, "robust"],
  [/\balign(s|ed)? with your (mission|values)\b/i, "align with your mission"],
];

/**
 * Whether the text names the company. Lever has no display name, so its company is the board slug title-cased
 * ("Initrodesystems 2"): drop the board counter and also accept the short form a person would write ("Initrode"),
 * a word of five or more letters that starts the slug-glued name.
 */
export function mentions(text: string, company: string): boolean {
  const name = company.toLowerCase().replace(/,?\s*(inc|llc|ltd|corp)\.?$/i, "").replace(/\s+\d+$/, "");
  const lower = text.toLowerCase();
  return lower.includes(name) || (lower.match(/[a-z0-9]+/g) ?? []).some(word => word.length >= 5 && name.split(" ")[0].startsWith(word));
}

/** Style warnings for AI-sounding prose. `company` enables the "could be sent to anyone" check. */
export function voiceCheck(text: string, company?: string): string[] {
  const w: string[] = [];
  for (const [re, label] of CLICHES) {
    if (re.test(text)) w.push(`Voice: "${label}" reads as AI boilerplate; say it plainly or cut it`);
  }
  const spear = text.match(/\bspearhead(ed|ing|s)?\b/gi)?.length ?? 0;
  if (spear > 1) w.push(`Voice: "spearheaded" used ${spear} times`);

  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paras.length >= 3) {
    const lens = paras.map(p => p.split(/\s+/).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    if (lens.every(l => Math.abs(l - mean) / mean < 0.15)) w.push("Voice: every paragraph is about the same length; vary the rhythm");
  }
  const triples = text.match(/\b[\w-]+, [\w-]+,? and [\w-]+\b/g)?.length ?? 0;
  if (triples >= 3) w.push(`Voice: ${triples} three-item lists; real writing rarely lists in threes this often`);

  if (company && text.split(/\s+/).length > 60 && !mentions(text, company)) {
    w.push(`Voice: never mentions ${company}; it could be sent to any company`);
  }
  return w;
}
