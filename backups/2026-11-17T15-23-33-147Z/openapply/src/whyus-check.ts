/**
 * "Why us" questions ("Why do you want to work at X?", "What interests you in X?") and the checks a drafted answer
 * to one must pass. Pure: no database, no files, so the pack guard (tailor.ts) and the drafter (whyus.ts) share it.
 */
import { mentions } from "./truth.js";

const WHY_US: RegExp[] = [
  /\bwhy (?:do|would) you (?:want|like|wish) to (?:work|join|be)\b/i,
  /\bwhy (?:are you|you're) (?:interested|excited|applying)\b/i,
  /\bwhat (?:interests|excites|draws|attracts|motivates) you (?:in|about|to)\b/i,
  /\bwhat (?:makes|made) you (?:want to|interested in) (?:work|join|apply)/i,
  /\bwhy (?:this|our|the) (?:role|company|team|position|job|opportunity)\b/i,
  /\bwhy (?:us|here)\b\??\s*$/i,
];
/** "Why are you a good fit", "Why should we hire you": about the person, not the company. */
const NOT_WHY_US = /\bwhy (?:are you a|are you the|should we|you\b)|\bgood fit\b|\bqualif/i;

/**
 * Whether a form question asks why the user wants this company or role. "Why X?" counts only when X names the
 * company, so "Why Rust?" or "Why are you a good fit?" never do.
 */
export function isWhyUs(question: string, company?: string): boolean {
  const q = question.trim();
  if (!q || NOT_WHY_US.test(q)) return false;
  if (WHY_US.some(re => re.test(q))) return true;
  const bare = /^why\s+(.{1,60}?)\s*\??$/i.exec(q)?.[1];
  return !!(bare && company && bare.split(/\s+/).length <= 5 && mentions(bare, company));
}

export const whyUsQuestions = (answers: Record<string, string> | undefined, company?: string): string[] =>
  Object.keys(answers ?? {}).filter(q => isWhyUs(q, company));

export const WHY_US_WORDS = { min: 60, max: 110 } as const;

const FIGURE_ONLY = /^\$?\d[\d,.]*\s?(?:%|[kmb]|x)?\+?$/i;
const figKey = (f: string) => f.toLowerCase().replace(/[\s,$+]/g, "");
const flat = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");

/** The avoid-list entries the text uses: a bare figure matches the same figure anywhere ("$300K" = "300k+"), anything else as a phrase. */
export function avoidedClaims(text: string, avoid: string[] = []): string[] {
  const figs = new Set((text.match(/\$?\d[\d,]*(?:\.\d+)?\s?(?:%|[kmb]\b|x\b)?\+?/gi) ?? []).map(figKey));
  const low = flat(text);
  return avoid.map(a => a.trim()).filter(Boolean).filter(a => (FIGURE_ONLY.test(a) ? figs.has(figKey(a)) : low.includes(flat(a))));
}

/**
 * Checks for one why-us answer, on top of the pack-wide truth and voice guards: length, names the company, no em
 * dash, never "honestly", no three-item list, nothing from the user's avoid list. Each warning names the answer, so
 * the dashboard shows it under that field.
 */
export function whyUsCheck(text: string, o: { question: string; company: string; avoid?: string[] }): string[] {
  const where = `the answer to "${o.question}"`;
  const w: string[] = [];
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words < WHY_US_WORDS.min || words > WHY_US_WORDS.max) w.push(`Why-us: ${where} is ${words} words; aim for ${WHY_US_WORDS.min} to ${WHY_US_WORDS.max}`);
  if (!mentions(text, o.company)) w.push(`Why-us: ${where} never names ${o.company}`);
  if (/[—]|\s–\s/.test(text)) w.push(`Why-us: dash in ${where}; use a comma, colon or period`);
  if (/\bhonestly\b|\bthe honest answer\b/i.test(text)) w.push(`Why-us: "honestly" in ${where}; cut it`);
  const triple = text.match(/\b[\w'-]+, [\w'-]+,? (?:and|or) [\w'-]+\b/);
  if (triple) w.push(`Why-us: three-item list ("${triple[0]}") in ${where}; keep one thing`);
  for (const a of avoidedClaims(text, o.avoid)) w.push(`Why-us: "${a}" in ${where} is on your avoid list (your records do not back it)`);
  return w;
}
