import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ensureHome, paths } from "./paths.js";
import { normalizeResume, saveResume } from "./profile.js";
import type { Resume } from "./types.js";

// ---------------------------------------------------------------- text extraction

export async function extractText(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return pdfText(path);
  if (ext === ".docx") return docxText(readFileSync(path));
  if (ext === ".tex") return texToText(readFileSync(path, "utf8"));
  if (ext === ".json") return resumeToText(normalizeResume(jsonToResume(JSON.parse(readFileSync(path, "utf8")))));
  return readFileSync(path, "utf8");
}

/** Lines rebuilt from positioned text items; a wide horizontal gap becomes a tab (left/right columns). */
async function pdfText(path: string): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
  const out: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const rows: Array<{ y: number; items: Array<{ x: number; w: number; s: string }> }> = [];
    for (const it of content.items as any[]) {
      if (!it.str?.trim() && !it.str?.includes(" ")) continue;
      const y = it.transform[5];
      let row = rows.find(r => Math.abs(r.y - y) < 2.5);
      if (!row) rows.push(row = { y, items: [] });
      row.items.push({ x: it.transform[4], w: it.width ?? 0, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let line = "";
      let end = row.items[0]?.x ?? 0;
      for (const it of row.items) {
        if (line && it.x - end > 24) line = line.trimEnd() + "\t";
        line += it.s;
        end = it.x + (it.s.trim() ? it.w : Math.min(it.w, 4)); // spacer items can span a whole gap
      }
      out.push(line.replace(/[ﬀ-ﬆ]/g, ligature).trimEnd());
    }
    out.push("");
  }
  return out.join("\n");
}

const ligature = (c: string) => ({ "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl" } as Record<string, string>)[c] ?? c;

/** Minimal zip reader: central directory + inflateRaw. Returns one entry's bytes. */
function zipEntry(buf: Buffer, name: string): Buffer | undefined {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return undefined;
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = buf.readUInt16LE(eocd + 10); i > 0; i--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString("utf8", p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nameLen + extra + comment;
  }
  return undefined;
}

function docxText(buf: Buffer): string {
  const xml = zipEntry(buf, "word/document.xml")?.toString("utf8");
  if (!xml) throw new Error("Not a .docx file (word/document.xml not found)");
  return xml.split("</w:p>").map(par => {
    const bullet = /<w:numPr[ >/]/.test(par) ? "- " : "";
    const text = par.replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "");
    return text.trim() ? bullet + decodeEntities(text) : "";
  }).join("\n");
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()];
  });
}

// ---------------------------------------------------------------- LaTeX

/** Read a balanced {...} group starting at s[i] (skipping spaces). Returns [content, indexAfter]. */
function texGroup(s: string, i: number): [string, number] {
  while (s[i] === " " || s[i] === "\n") i++;
  if (s[i] !== "{") return ["", i];
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return [s.slice(i + 1), s.length];
}

/** Macros that take N brace arguments, mapped to a text template (args as $1..$N). */
const TEX_MACROS: Record<string, [number, (a: string[]) => string]> = {
  resumeSubheading: [4, a => `\n${a[0]}\t${a[1]}\n${a[2]}\t${a[3]}\n`],
  resumeSubSubheading: [2, a => `\n${a[0]}\t${a[1]}\n`],
  resumeProjectHeading: [2, a => `\n${a[0]}\t${a[1]}\n`],
  resumeItem: [1, a => `\n- ${a[0]}\n`],
  resumeSubItem: [1, a => `\n- ${a[0]}\n`],
  section: [1, a => `\n\n${a[0]}\n`],
  subsection: [1, a => `\n\n${a[0]}\n`],
  href: [2, a => (/[.@]/.test(a[1]) ? a[1] : a[0]).replace(/^mailto:/, "")],
  url: [1, a => a[0]],
  vspace: [1, () => ""], hspace: [1, () => " "], setlength: [2, () => ""],
};

const ESC = "\u0001";

export function texToText(tex: string): string {
  return texCore(tex, true).replace(new RegExp(ESC + "([A-G])", "g"), (_, c: string) => "&%$#_{}"["ABCDEFG".indexOf(c)]);
}

function texCore(tex: string, root: boolean): string {
  let s = tex.replace(/\\([&%$#_{}])/g, (_, c: string) => ESC + "ABCDEFGHIJ"["&%$#_{}".indexOf(c)])
    .replace(/%.*$/gm, "");
  const doc = root ? s.indexOf("\\begin{document}") : -1;
  if (doc >= 0) s = s.slice(doc + 16);
  s = s.replace(/\\end\{document\}[\s\S]*$/, "");
  // expand argument macros innermost-last so nested \textbf{} inside args are still plain text
  let out = "";
  for (let i = 0; i < s.length;) {
    if (s[i] === "\\") {
      const m = /^\\([A-Za-z]+)\*?/.exec(s.slice(i, i + 40));
      const macro = m && TEX_MACROS[m[1]];
      if (m && macro) {
        let j = i + m[0].length;
        const args: string[] = [];
        for (let n = 0; n < macro[0]; n++) {
          if (m[1] === "href" && n === 0 && s[j] !== "{") break;
          const [a, next] = texGroup(s, j);
          args.push(texCore(a, false).trim());
          j = next;
        }
        while (args.length < macro[0]) args.push("");
        out += macro[1](args);
        i = j;
        continue;
      }
    }
    out += s[i++];
  }
  return out
    .replace(/\\\\(\[[^\]]*\])?/g, "\n").replace(/\\hfill|\\quad|\\qquad/g, "\t")
    .replace(/\\item\b/g, "\n- ")
    .replace(/\$\s*\|\s*\$/g, " | ").replace(/\$/g, "")
    .replace(/\\ /g, " ")
    .replace(/\\(begin|end)\{[^}]*\}(\[[^\]]*\])?/g, "")
    .replace(/\\[A-Za-z]+\*?/g, "")
    .replace(/``/g, "“").replace(/''/g, "”").replace(/---/g, "—").replace(/--/g, "–")
    .replace(/~/g, " ").replace(/[{}]/g, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- JSON Resume

function fmtDate(d?: string): string | undefined {
  if (!d) return undefined;
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(d);
  if (!m) return d;
  return m[2] ? `${MONTHS[+m[2] - 1] ?? ""} ${m[1]}`.trim() : m[1];
}

/** Accepts the JSON Resume schema, or a file that is already our Resume shape. */
export function jsonToResume(j: any): Resume {
  if (Array.isArray(j.experience) && typeof j.name === "string") return j as Resume;
  const b = j.basics ?? {};
  const loc = [b.location?.city, b.location?.region].filter(Boolean).join(", ");
  return {
    name: b.name ?? "",
    headline: b.label || undefined,
    contact: {
      email: b.email, phone: b.phone, location: loc || undefined,
      links: [b.url, ...(b.profiles ?? []).map((p: any) => p.url)].filter(Boolean),
    },
    summary: b.summary || undefined,
    experience: (j.work ?? []).map((w: any) => ({
      company: w.name ?? w.company ?? "", title: w.position ?? "", location: w.location || undefined,
      start: fmtDate(w.startDate), end: w.endDate ? fmtDate(w.endDate) : "Present",
      bullets: w.highlights?.length ? w.highlights : (w.summary ? [w.summary] : []),
    })),
    projects: (j.projects ?? []).map((p: any) => ({
      name: p.name ?? "", description: p.description, link: p.url, bullets: p.highlights ?? [],
    })),
    education: (j.education ?? []).map((e: any) => ({
      school: e.institution ?? "", degree: [e.studyType, e.area].filter(Boolean).join(" in ") || undefined,
      start: fmtDate(e.startDate), end: fmtDate(e.endDate),
    })),
    skills: (j.skills ?? []).flatMap((s: any) => (s.keywords?.length ? s.keywords : [s.name])).filter(Boolean),
  };
}

/** Plain-text rendering of a Resume (used as the truth-guard source for JSON imports). */
export function resumeToText(r: Resume): string {
  const L: string[] = [r.name, [r.contact.email, r.contact.phone, r.contact.location, ...(r.contact.links ?? [])].filter(Boolean).join(" | ")];
  if (r.summary) L.push(r.summary);
  L.push("", "Experience");
  for (const e of r.experience) {
    L.push(`${e.company}\t${e.location ?? ""}`, `${e.title}\t${[e.start, e.end].filter(Boolean).join(" - ")}`, ...e.bullets.map(b => `- ${b}`));
  }
  if (r.projects?.length) {
    L.push("", "Projects");
    for (const p of r.projects) L.push(p.name, ...(p.description ? [p.description] : []), ...p.bullets.map(b => `- ${b}`));
  }
  L.push("", "Education");
  for (const e of r.education) L.push(`${e.school}`, `${e.degree ?? ""}\t${[e.start, e.end].filter(Boolean).join(" - ")}`);
  if (r.skills?.length) L.push("", "Skills", r.skills.join(", "));
  return L.join("\n");
}

// ---------------------------------------------------------------- heuristic parser

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const DATE = `(?:(?:${MON}\\s+)?\\d{4}|\\d{1,2}/\\d{4})`;
const RANGE = new RegExp(`(${DATE})\\s*(?:-|–|—|to)\\s*(${DATE}|Present|Current|Now|Today)`, "i");
const SINGLE_DATE = new RegExp(`(?:(?:expected|anticipated)\\s+)?(${DATE})`, "i");
const BULLET = /^\s*[-–—•·▪●◦*■]\s+/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/;
const URL_RE = /(?:https?:\/\/)?(?:www\.)?(?:[\w-]+\.)+(?:com|io|dev|xyz|me|co|org|net|ai|app|sh)(?:\/[^\s|,;·•]*)?/gi;
const TITLE_WORDS = /\b(engineer|developer|manager|analyst|intern|president|founder|co-?founder|director|lead|designer|consultant|advisor|associate|head|officer|scientist|specialist|architect|vp|coordinator|researcher|strategist|representative|executive|owner|partner|fellow|assistant|administrator|operator|writer|editor)\b/i;
const SCHOOL_WORDS = /\b(university|college|school|institute|academy|universit[aäé]|polytechnic|sciences po|bootcamp)\b/i;

const SECTION_NAMES: Array<[string, RegExp]> = [
  ["summary", /^(summary|professional summary|profile|about( me)?|objective|overview)$/i],
  ["experience", /^(experience|work experience|professional experience|employment( history)?|work history|career history|relevant experience)$/i],
  ["education", /^(education|academic background|education & training|education and training)$/i],
  ["projects", /^(projects|selected projects|personal projects|side projects|open source)$/i],
  ["skills", /^(skills|technical skills|core skills|skills & tools|skills and tools|tools|technologies|competencies)$/i],
];

function sectionOf(line: string): { key: string; heading: string } | undefined {
  const t = line.replace(/[:\t]+$/, "").trim();
  if (!t || t.length > 40 || BULLET.test(t) || /[.@]/.test(t)) return undefined;
  for (const [key, re] of SECTION_NAMES) if (re.test(t)) return { key, heading: t };
  // unknown all-caps or known extra heading -> extras
  if (/^(awards?|honors?|certifications?|publications?|volunteer(ing)?|leadership|languages|interests|activities|achievements|extracurriculars?|speaking|press|patents)( .*)?$/i.test(t)) {
    return { key: "extras", heading: t.replace(/\b\w/g, c => c.toUpperCase()).replace(/(\w)(\w*)/g, (_, a, b) => a + b.toLowerCase()) };
  }
  return undefined;
}

const cols = (line: string) => line.split(/\t+| {3,}| \| /).map(s => s.trim()).filter(Boolean);
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function dateRange(line: string): { start: string; end: string; rest: string } | undefined {
  const m = RANGE.exec(line);
  if (!m) return undefined;
  return { start: m[1], end: /^(present|current|now|today)$/i.test(m[2]) ? "Present" : m[2], rest: (line.slice(0, m.index) + "\t" + line.slice(m.index + m[0].length)).trim() };
}

/** Split "a, b (c, d), e" on commas outside parentheses. */
export function splitList(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === ";" || ch === "•" || ch === "|") && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

export function parseResumeText(text: string): Resume {
  const lines = text.replace(/\r/g, "").split("\n").map(l => l.replace(/[ ]/g, " ").trimEnd());
  const resume: Resume = { name: "", contact: {}, experience: [], education: [] };

  // split into sections
  const head: string[] = [];
  const sections: Array<{ key: string; heading: string; lines: string[] }> = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const sec = sectionOf(line);
    if (sec) sections.push({ ...sec, lines: [] });
    else (sections.at(-1)?.lines ?? head).push(raw.replace(/^\s+/, (w) => (w.includes("\t") ? w : "")));
  }

  parseHead(head, resume);

  for (const s of sections) {
    if (s.key === "summary") resume.summary = clean([resume.summary, s.lines.join(" ")].filter(Boolean).join(" "));
    else if (s.key === "experience") resume.experience.push(...parseExperience(s.lines));
    else if (s.key === "education") resume.education.push(...parseEducation(s.lines));
    else if (s.key === "projects") (resume.projects ??= []).push(...parseProjects(s.lines));
    else if (s.key === "skills") (resume.skills ??= []).push(...parseSkills(s.lines));
    else (resume.extras ??= []).push({ heading: s.heading, items: s.lines.map(l => clean(l.replace(BULLET, ""))) });
  }
  return resume;
}

function parseHead(head: string[], r: Resume): void {
  r.name = clean(head[0] ?? "").replace(/\t.*/, "");
  const links: string[] = [];
  const loose: string[] = [];
  for (const line of head.slice(1)) {
    const hasContact = EMAIL.test(line) || PHONE.test(line) || (line.length < 160 && (line.match(URL_RE)?.length ?? 0) > 0 && !/\s{2}[a-z]{4,}\s/.test(line) && line.split(/\s+/).length < 16);
    if (!hasContact) { loose.push(clean(line)); continue; }
    let rest = line;
    const email = EMAIL.exec(rest)?.[0];
    if (email) { r.contact.email ??= email; rest = rest.replace(email, "|"); }
    const phone = PHONE.exec(rest)?.[0];
    if (phone) { r.contact.phone ??= phone.trim(); rest = rest.replace(phone, "|"); }
    for (const u of rest.match(URL_RE) ?? []) { links.push(u.replace(/[.,)]+$/, "")); rest = rest.replace(u, "|"); }
    for (const piece of rest.split(/[|·•\t]| – /).map(clean).filter(Boolean)) {
      if (!r.contact.location && piece.length < 50 && /^[A-Z][\w .'-]*(,\s*[A-Za-z .]+)?$/.test(piece) && !/\d/.test(piece)) r.contact.location = piece;
    }
  }
  if (links.length) r.contact.links = [...new Set(links)];
  const first = loose[0];
  if (first && loose.length === 1 && first.length <= 80 && !/[.!]$/.test(first)) r.headline = first;
  else if (loose.length) r.summary = loose.join(" ");
}

const isDateLine = (l: string) => !BULLET.test(l) && !!dateRange(l) && l.replace(RANGE, "").trim().length < 100;

function parseExperience(lines: string[]): Resume["experience"] {
  const out: Resume["experience"] = [];
  let cur: Resume["experience"][number] | undefined;
  let inBullet = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (BULLET.test(line)) { cur?.bullets.push(clean(line.replace(BULLET, ""))); inBullet = true; continue; }
    const next = lines[i + 1]?.trim() ?? "";
    if (isDateLine(line)) {
      // second line of a two-line header was handled when its first line was seen
      cur = headerEntry(undefined, line);
      out.push(cur); inBullet = false; continue;
    }
    if (next && isDateLine(next) && !BULLET.test(next) && line.length < 100) {
      cur = headerEntry(line, next);
      out.push(cur); inBullet = false; i++; continue;
    }
    if (cur && cur.bullets.length) cur.bullets[cur.bullets.length - 1] += " " + clean(line);
    else if (cur && inBullet) cur.bullets.push(clean(line));
    else if (cur) cur.bullets.push(clean(line));
  }
  return out;
}

/** Build an entry from an optional company-ish first line and the line that holds the dates. */
function headerEntry(first: string | undefined, dateLine: string): Resume["experience"][number] {
  const d = dateRange(dateLine)!;
  const dateParts = cols(d.rest);
  let company = "", title = "", location: string | undefined;
  if (first) {
    const fp = cols(first);
    company = fp[0] ?? "";
    location = fp[1];
    title = dateParts[0] ?? "";
    // "Title" on the first line and "Company" on the date line (less common)
    if (TITLE_WORDS.test(company) && !TITLE_WORDS.test(title) && title) [company, title] = [title, company];
  } else {
    const parts = dateParts.length > 1 ? dateParts : splitOnce(dateParts[0] ?? "");
    const titleIdx = parts.findIndex(p => TITLE_WORDS.test(p));
    if (titleIdx >= 0) {
      title = parts[titleIdx];
      const others = parts.filter((_, k) => k !== titleIdx);
      company = others[0] ?? "";
      location = others[1];
    } else [company, title, location] = parts;
  }
  return { company: clean(company ?? ""), title: clean(title ?? ""), location: location ? clean(location) : undefined, start: d.start, end: d.end, bullets: [] };
}

/** "Title, Company" / "Title at Company" / "Company - Title" in one string. */
function splitOnce(s: string): string[] {
  const m = /^(.*?)(?:,| at | @ | - | – | — )\s*(.+)$/.exec(s);
  return m ? [m[1], m[2]] : [s];
}

function parseEducation(lines: string[]): Resume["education"] {
  const out: Resume["education"] = [];
  let cur: Resume["education"][number] | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (BULLET.test(line)) { (cur ??= { school: "" }).details = [...(cur?.details ?? []), clean(line.replace(BULLET, ""))]; if (!out.includes(cur)) out.push(cur); continue; }
    let rest = line;
    const d = dateRange(line);
    let start: string | undefined, end: string | undefined;
    if (d) { start = d.start; end = d.end; rest = d.rest; }
    else {
      const sd = SINGLE_DATE.exec(line);
      if (sd && /\b(19|20)\d{2}\b/.test(line)) { end = sd[1]; rest = line.replace(sd[0], "\t"); }
    }
    const parts = cols(rest);
    const schoolPart = parts.find(p => SCHOOL_WORDS.test(p));
    if (schoolPart && (!cur || cur.school || cur.degree)) {
      cur = { school: clean(schoolPart) };
      const degree = parts.filter(p => p !== schoolPart && !/^[A-Z][\w .]+,\s*[A-Z]{2,}$/.test(p) && !/^[A-Z][a-z]+(?: [A-Z][a-z]+)*, [A-Z][a-z]+$/.test(p)).join(", ");
      if (degree) cur.degree = clean(degree);
      out.push(cur);
    } else if (cur && !cur.school && schoolPart) cur.school = clean(schoolPart);
    else if (cur && !cur.degree && parts[0]) cur.degree = clean(parts[0]);
    else if (cur && parts[0]) cur.details = [...(cur.details ?? []), clean(parts.join(" "))];
    else if (!cur && parts[0]) { cur = { school: "", degree: clean(parts[0]) }; out.push(cur); }
    if (cur && start && !cur.start) cur.start = start;
    if (cur && end && !cur.end) cur.end = end;
  }
  return out.map(e => (e.school ? e : { ...e, school: e.degree ?? "" }));
}

function parseProjects(lines: string[]): NonNullable<Resume["projects"]> {
  const out: NonNullable<Resume["projects"]> = [];
  let cur: NonNullable<Resume["projects"]>[number] | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (BULLET.test(line)) { (cur ??= (out[out.push({ name: "", bullets: [] }) - 1])).bullets.push(clean(line.replace(BULLET, ""))); continue; }
    const nextIsBullet = BULLET.test(lines[i + 1]?.trim() ?? "");
    if (!cur || nextIsBullet || !cur.bullets.length && !cur.description && /^[A-Z]/.test(line) && line.length < 60) {
      const link = line.match(URL_RE)?.[0];
      const name = clean(cols(line)[0].replace(link ?? "", "").replace(/[()|:–-]+\s*$/, ""));
      if (cur && !cur.bullets.length && !cur.description && !nextIsBullet && line.length >= 60) { cur.description = clean(line); continue; }
      cur = { name, link, bullets: [] };
      const rest = cols(line).slice(1).join(" ");
      if (rest) cur.description = clean(rest);
      out.push(cur);
    } else if (cur.bullets.length) cur.bullets[cur.bullets.length - 1] += " " + clean(line);
    else cur.description = clean((cur.description ?? "") + " " + line);
  }
  return out;
}

function parseSkills(lines: string[]): string[] {
  const items: string[] = [];
  for (const l of lines) items.push(...splitList(l.replace(BULLET, "").replace(/^[^:,(]{1,30}:\s*/, "")));
  return [...new Set(items)];
}

// ---------------------------------------------------------------- import

/** Extract, parse and store the master resume plus its raw text (the truth guard's second source). */
export async function importResume(path: string): Promise<Resume> {
  const text = await extractText(path);
  const resume = extname(path).toLowerCase() === ".json"
    ? normalizeResume(jsonToResume(JSON.parse(readFileSync(path, "utf8"))))
    : parseResumeText(text);
  ensureHome();
  writeFileSync(paths.resumeSource, text);
  saveResume(resume);
  return resume;
}
