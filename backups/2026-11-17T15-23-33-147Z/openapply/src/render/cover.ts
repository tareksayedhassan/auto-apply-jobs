import type { Job, Profile } from "../types.js";
import { BASE_CSS, esc, href } from "./style.js";

const CSS = BASE_CSS + `
body { font-size: 10.5pt; line-height: 1.5; }
.date { margin: 18pt 0 14pt; color: #555; font-size: 9.5pt; }
.letter p { margin: 0 0 9pt; }
.sig { margin-top: 14pt; }
`;

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CLOSING = /^(sincerely|best|best regards|regards|thanks|thank you|cheers|warmly|respectfully|kind regards)[,.!]?$/im;
// a sign-off: one of the closings above, or any short phrase ending in a comma ("Best wishes,", "Yours sincerely,")
const isSignoff = (l = "") => CLOSING.test(l.trim()) || /^\p{L}[\p{L}'\u2019 ]{0,47},$/u.test(l.trim());

/**
 * Body paragraphs and the signature block, shared by the HTML and LaTeX letters. The last paragraph is a signature
 * when it is the user's name, any line(s) then the name (contact lines may follow), or "Best, Jane Doe" on one
 * line. A letter signed but with no closing gets "Sincerely," above the name; an unsigned one gets the name added.
 */
export function letterParts(text: string, profile: Profile | undefined): { name: string; paras: string[]; sig: string[]; date: string } {
  const name = profile ? `${profile.firstName} ${profile.lastName}`.trim() : "";
  const paras = text.trim().split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const last = paras.at(-1) ?? "";
  // a name line: up to four words ending in the last name ("Jane Doe", "Jane A. Doe"), never "janedoe.dev"; it may
  // open with a dash ("– Jane Doe") and end in credentials or pronouns ("Jane Doe, PhD", "Jane Doe (he/him)")
  const isName = (l = "") => !!profile?.lastName &&
    new RegExp(`^([-\u2013\u2014]+\\s*)?(\\p{L}[\\p{L}.'-]*\\s+){0,3}${escRe(profile.lastName)}(,\\s*\\p{L}[\\p{L}.]*)*(\\s*\\([^()]*\\))?$`, "iu").test(l.trim());
  const lines = last.split("\n");
  const at = lines.findIndex(l => isName(l));
  const oneLine = lines[0].match(/^(.*?,)\s*(.+)$/);
  const dashed = at === 0 && /^[-\u2013\u2014]/.test(lines[0].trim());
  // the name below any line of the closing paragraph ("Best wishes!", "Warm regards \u2014") is signed off, whatever that line says
  const signedOff = at > 0 || (!!oneLine && isSignoff(oneLine[1]) && isName(oneLine[2]));
  const signed = at === 0 || signedOff;
  const closed = signedOff || dashed || CLOSING.test(last) || (!signed && isSignoff(lines.at(-1)))
    || (signed && isSignoff((paras.at(-2) ?? "").split("\n").at(-1)));
  const sig = signed
    ? (closed ? [] : ["Sincerely,", ...paras.pop()!.split("\n")])
    : [...(closed ? [] : ["Sincerely,"]), ...(name ? [name] : [])];
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return { name, paras, sig, date };
}

export function coverLetterHtml(text: string, profile: Profile | undefined, job: Job): string {
  const { name, paras, sig, date } = letterParts(text, profile);
  const contact = profile ? [
    profile.email && `<a href="mailto:${esc(profile.email)}">${esc(profile.email)}</a>`,
    profile.phone && esc(profile.phone),
    profile.location && esc(profile.location),
    ...[profile.linkedin, profile.github, profile.website].filter(Boolean)
      .map(l => `<a href="${esc(href(l!))}">${esc(l!.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>`),
  ].filter(Boolean).map(x => `<span>${x}</span>`).join("") : "";

  const html = paras.map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(name)} Cover letter, ${esc(job.company)}</title><style>${CSS}</style></head>
<body><header><h1>${esc(name)}</h1><p class="contact">${contact}</p></header>
<div class="date">${esc(date)}</div>
<div class="letter">${html}${sig.length ? `<p class="sig">${sig.map(esc).join("<br>")}</p>` : ""}</div></body></html>`;
}
