/** Text helpers shared by every source: HTML to plain text, remote detection, salary parsing. */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: "-", middot: "-", copy: "(c)", reg: "(r)",
  trade: "(tm)", eacute: "é", egrave: "è", agrave: "à", aacute: "á", uuml: "ü", ouml: "ö", auml: "ä",
  szlig: "ß", ntilde: "ñ", ccedil: "ç", euro: "€", pound: "£", times: "x", rarr: "->", larr: "<-",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Strip tags, decode entities, keep paragraph and list breaks, collapse the rest of the whitespace. */
export function htmlToText(html: string): string {
  if (!html) return "";
  let s = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|section|blockquote)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .replace(/ /g, " ")
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Board sources store this much text per posting; the DB keeps less (SNIPPET_CHARS), the rest is fetched on demand. */
export const LIST_CHARS = 1000;

/** Cut `text` to about `max` chars at a word boundary and mark the cut with "...". Shorter text passes through. */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.search(/\s\S*$/);
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "...";
}

/**
 * Text of roughly the first `maxChars` characters of an HTML string without converting the rest.
 * Converts a growing prefix (4x maxChars of markup, doubling) until enough text came out, so a long
 * posting costs one small pass instead of a full decode + strip. `escaped` = the HTML is entity-escaped
 * (Greenhouse). The result is only shorter than `maxChars` when the whole input is.
 */
export function htmlSnippet(html: string, maxChars: number, escaped = false): string {
  if (!html) return "";
  let n = Math.max(maxChars * 4, 512);
  for (;;) {
    const whole = n >= html.length;
    let head = whole ? html : html.slice(0, n).replace(/&[#a-z0-9]{0,9}$/i, "");
    if (escaped) head = decodeEntities(head);
    if (!whole) head = head.replace(/<[^>]*$/, "");
    const text = htmlToText(head);
    if (whole || text.length >= maxChars) return truncateWords(text, maxChars);
    n *= 2;
  }
}

/** Greenhouse ships its content HTML-escaped: decode once, then strip. */
export function escapedHtmlToText(escaped: string): string {
  return htmlToText(decodeEntities(escaped ?? ""));
}

const REMOTE_LOC = /\b(remote|anywhere|work from home|wfh|distributed|worldwide)\b/i;
const REMOTE_TEXT = /\b(fully remote|100% remote|remote[- ]first|remote[- ]friendly|work(?:ing)? remotely|remote position|remote role|this is a remote)\b/i;

export function detectRemote(location: string, text = ""): boolean {
  if (/\bhybrid\b/i.test(location) && !/\bremote\b.*\bremote\b/i.test(location)) return false;
  if (REMOTE_LOC.test(location)) return true;
  if (/\b(not|non)[- ]remote\b/i.test(text)) return false;
  return REMOTE_TEXT.test(text.slice(0, 4000));
}

const CURRENCY: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", USD: "USD", EUR: "EUR", GBP: "GBP", CAD: "CAD", AUD: "AUD", CHF: "CHF" };
const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s?([kK])(?![a-zA-Z]))?`;
const CUR = String.raw`(\$|€|£|USD|EUR|GBP|CAD|AUD|CHF)`;
const RANGE = new RegExp(String.raw`${CUR}\s*${NUM}\s*(?:-|–|—|to)\s*${CUR}?\s*${NUM}`, "gi");
const SINGLE = new RegExp(String.raw`${CUR}\s*${NUM}`, "gi");

const num = (v: string, k?: string) => Math.round(parseFloat(v.replace(/,/g, "")) * (k ? 1000 : 1));
/** Reject hourly rates and "$5 million" style amounts that only look like pay. */
const badTail = (s: string) => /^\s*(?:\/\s*h|per\s*h|an\s*h|hr\b|hour|m\b|mm\b|million|billion|bn\b|b\b|%)/i.test(s);

/** First plausible annual pay figure in free text: "$150,000 - $190,000", "$150K–$190K", "USD 120k". */
export function parseSalary(text: string): { min?: number; max?: number; currency?: string } | undefined {
  if (!text) return undefined;
  for (const m of text.matchAll(RANGE)) {
    // "$150-190K": the trailing k applies to both ends
    const k1 = m[3] ?? (num(m[2]) < 1000 ? m[6] : undefined);
    const min = num(m[2], k1);
    const max = num(m[5], m[6]);
    const tail = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 14);
    if (min >= 1000 && max >= min && !badTail(tail)) {
      return { min, max, currency: CURRENCY[m[1].toUpperCase()] ?? CURRENCY[m[1]] };
    }
  }
  for (const m of text.matchAll(SINGLE)) {
    const v = num(m[2], m[3]);
    const tail = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 14);
    if (v >= 1000 && !badTail(tail)) return { min: v, currency: CURRENCY[m[1].toUpperCase()] ?? CURRENCY[m[1]] };
  }
  return undefined;
}

/** Salary taken from a long description: only trust a full range, to avoid "$5,000 bonus" noise. */
export function salaryFromDescription(text: string): { min?: number; max?: number; currency?: string } | undefined {
  const s = parseSalary(text);
  return s && s.min && s.max && s.min >= 15000 && s.max <= 3_000_000 ? s : undefined;
}

/** Spread into a NormalizedJob. */
export function salaryProps(s?: { min?: number; max?: number; currency?: string }) {
  return s ? { salaryMin: s.min, salaryMax: s.max, salaryCurrency: s.currency } : {};
}

/** Any date-ish input to ISO 8601, or undefined if it does not parse. Numbers below 1e12 are seconds. */
export function toIso(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  let d: Date;
  if (typeof v === "number") d = new Date(v < 1e12 ? v * 1000 : v);
  else if (typeof v === "string") {
    const s = v.trim().replace(/ UTC$/, "Z").replace(/^(\d{4}-\d\d-\d\d) (\d)/, "$1T$2");
    d = new Date(/^\d{4}-\d\d-\d\dT[\d:.]+$/.test(s) ? s + "Z" : s);
  } else return undefined;
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function titleCase(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}
