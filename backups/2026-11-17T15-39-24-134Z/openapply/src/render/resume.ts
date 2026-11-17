import type { Resume } from "../types.js";
import { BASE_CSS, esc, href } from "./style.js";

const CSS = BASE_CSS + `
section { margin-top: 7pt; }
h2 { margin: 0 0 4pt; padding-bottom: 1.5pt; border-bottom: 0.5pt solid #bbb; font-size: 8.5pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #333; }
p { margin: 0; }
.entry + .entry { margin-top: 4pt; }
.row { display: flex; justify-content: space-between; align-items: baseline; gap: 12pt; }
.row b { font-weight: 650; }
.when, .where { font-size: 9pt; color: #555; white-space: nowrap; }
.sub { color: #333; }
.sub i { font-style: italic; }
ul { margin: 2pt 0 0; padding-left: 12pt; }
li { margin: 0 0 0.6pt; padding-left: 1pt; }
li::marker { color: #777; }
.summary { margin-top: 8pt; }
.skills p + p { margin-top: 1.5pt; }
`;

const dates = (a?: string, b?: string) => [a, b].filter(Boolean).join(" – ");

function list(items: string[]): string {
  return items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
}

function row(left: string, right?: string, cls = "when"): string {
  return `<div class="row"><span>${left}</span>${right ? `<span class="${cls}">${esc(right)}</span>` : ""}</div>`;
}

export function resumeHtml(r: Resume): string {
  const c = r.contact;
  const contact = [
    c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`,
    c.phone && esc(c.phone),
    c.location && esc(c.location),
    ...(c.links ?? []).map(l => `<a href="${esc(href(l))}">${esc(l.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>`),
  ].filter(Boolean).map(x => `<span>${x}</span>`).join("");

  const body: string[] = [];
  if (r.summary) body.push(`<p class="summary">${esc(r.summary)}</p>`);

  if (r.experience.length) {
    body.push(`<section><h2>Experience</h2>${r.experience.map(e => `<div class="entry">
      ${row(`<b>${esc(e.company)}</b>`, e.location, "where")}
      ${row(`<span class="sub"><i>${esc(e.title)}</i></span>`, dates(e.start, e.end))}
      ${list(e.bullets)}</div>`).join("")}</section>`);
  }
  if (r.projects?.length) {
    body.push(`<section><h2>Projects</h2>${r.projects.map(p => `<div class="entry">
      ${row(`<b>${esc(p.name)}</b>${p.description ? ` <span class="sub">${esc(p.description)}</span>` : ""}`,
        p.link?.replace(/^https?:\/\/(www\.)?/, ""), "where")}
      ${list(p.bullets)}</div>`).join("")}</section>`);
  }
  if (r.education.length) {
    body.push(`<section><h2>Education</h2>${r.education.map(e => `<div class="entry">
      ${row(`<b>${esc(e.school)}</b>${e.degree ? `<span class="sub">, ${esc(e.degree)}</span>` : ""}`, dates(e.start, e.end))}
      ${list(e.details ?? [])}</div>`).join("")}</section>`);
  }
  if (r.skills?.length) {
    const lines = r.skills.some(s => /^[^:]{1,30}:/.test(s)) ? r.skills : [r.skills.join(", ")];
    body.push(`<section class="skills"><h2>Skills</h2>${lines.map(l => `<p>${esc(l)}</p>`).join("")}</section>`);
  }
  for (const x of r.extras ?? []) {
    body.push(`<section><h2>${esc(x.heading)}</h2>${list(x.items)}</section>`);
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(r.name)} Resume</title><style>${CSS}</style></head>
<body><header><h1>${esc(r.name)}</h1>${r.headline ? `<p class="headline">${esc(r.headline)}</p>` : ""}<p class="contact">${contact}</p></header>
${body.join("\n")}</body></html>`;
}
