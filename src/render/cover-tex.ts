import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pkgRoot } from "../paths.js";
import type { Profile } from "../types.js";
import { letterParts } from "./cover.js";
import { href } from "./style.js";

const SPECIAL: Record<string, string> = {
  "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "$": "\\$", "&": "\\&", "%": "\\%", "#": "\\#", "_": "\\_",
  "^": "\\textasciicircum{}", "~": "\\textasciitilde{}", "<": "\\textless{}", ">": "\\textgreater{}", "|": "\\textbar{}",
  // a raw backtick after ! or ? would ligature to an inverted mark; typographic characters go through TeX commands
  "`": "\\textasciigrave{}", "\u2018": "\\textquoteleft{}", "\u2019": "\\textquoteright{}", "\u201c": "\\textquotedblleft{}",
  "\u201d": "\\textquotedblright{}", "\u2013": "\\textendash{}", "\u2014": "\\textemdash{}", "\u2026": "\\ldots{}", "\u2022": "\\textbullet{}",
};

/**
 * Escape text for LaTeX body copy. Straight double quotes become curly ones through \textquotedblleft/right, never
 * the `` '' ligatures, which after ! or ? print as an inverted mark.
 */
export const texEsc = (s: unknown): string =>
  String(s ?? "").replace(/[\\{}$&%#_^~<>|`\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u2022]/g, c => SPECIAL[c])
    .replace(/"([^"\n]*)"/g, "\\textquotedblleft{}$1\\textquotedblright{}").replace(/"/g, "\\textquotedblright{}");

/**
 * A URL for \href with its target unchanged: hyperref takes ~ _ $ as written and \# \% \& for those three; only
 * characters a URL cannot hold raw (space, non-ASCII, \ { } ^ ` " < > |) are percent-encoded, and so is any # after
 * the first, which hyperref would cut the target at.
 */
const texUrl = (u: string) => u.replace(/[^\x21-\x7e]|[\\{}^`"<>|]/gu, c => encodeURIComponent(c)).replace(/(?<=#.*)#/g, "%23")
  .replace(/[#%&]/g, c => `\\${c}`);
const shown = (l: string) => l.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
const link = (url: string, text: string) => `\\href{${texUrl(url)}}{${texEsc(text)}}`;

/** Cover letter as a LaTeX document: templates/cover-letter.tex (the sb2nov resume preamble) filled from the profile and text. */
export function coverLetterTex(text: string, profile: Profile | undefined): string {
  // compose accents ("Café" pasted as e + U+0301 from macOS) before escaping, so they extract as one letter and a
  // singleton like U+1FEF (to `) is escaped too; a glyph the font lacks (emoji, CJK, ✓) is refused by texToPdf
  // from the engine's own missing-character report
  const nfc = <T>(v: T) => (typeof v === "string" ? v.normalize("NFC") : v) as T;
  profile = profile && Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, nfc(v)])) as Profile;
  const { name, paras, sig, date } = letterParts(nfc(text), profile);
  // same contact order as the resume header: email, profiles, phone, location
  const contact = profile ? [
    profile.email && link(`mailto:${profile.email}`, profile.email),
    ...[profile.linkedin, profile.github, profile.website].filter(Boolean).map(l => link(href(l!), shown(l!))),
    profile.phone && texEsc(profile.phone),
    profile.location && texEsc(profile.location),
  ].filter(Boolean).join(" $\\cdot$ ") : "";
  // \newline, not \\, which would take a next line starting with [ or * as its own argument
  const block = (lines: string[]) => lines.map(l => texEsc(l.trim())).filter(Boolean).join("\\newline\n");
  const body = [...paras.map(p => block(p.split("\n"))), ...(sig.length ? [block(sig)] : [])].join("\n\n");
  const slots: Record<string, string> = { NAME: texEsc(name), CONTACT: contact, DATE: texEsc(date), BODY: body };
  return readFileSync(join(pkgRoot, "templates", "cover-letter.tex"), "utf8").replace(/<<(NAME|CONTACT|DATE|BODY)>>/g, (_, k) => slots[k]);
}
