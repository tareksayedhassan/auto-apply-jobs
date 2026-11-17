import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureHome, paths } from "./paths.js";
import type { Education, Profile, Resume, ResumeTrack } from "./types.js";

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; }
}

function writeJson(file: string, v: unknown): void {
  ensureHome();
  writeFileSync(file, JSON.stringify(v, null, 2) + "\n");
}

export function loadProfile(): Profile | undefined {
  return readJson<Profile>(paths.profile);
}

const TARGET_LISTS = ["titles", "keywords", "locations", "excludeCompanies", "excludeKeywords", "seniority"] as const;

/** A plain string where a list is expected becomes a one-element (comma-split) array. */
function normalizeTargets(t: Record<string, any>): Record<string, any> {
  const out = { ...t };
  for (const k of TARGET_LISTS) {
    const v = out[k];
    if (typeof v === "string") out[k] = splitCommas(v);
    else if (v === null) delete out[k];
  }
  return out;
}

/**
 * Shallow merge, except targets / eeo / savedAnswers which merge one level deeper. Arrays are replaced; education is
 * validated first. resumes is replaced as a whole map; defaultResume must name one of its tracks.
 */
export function saveProfile(patch: Partial<Profile>): Profile {
  const cur = loadProfile() ?? ({ firstName: "", lastName: "", email: "" } as Profile);
  const next: Record<string, any> = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "education") { next[k] = normalizeEducation(v); continue; }
    if (k === "resumes") { next[k] = normalizeResumes(v); continue; }
    const merge = k === "targets" || k === "eeo" || k === "savedAnswers";
    next[k] = merge && v && typeof v === "object" ? { ...(next[k] ?? {}), ...(k === "targets" ? normalizeTargets(v) : v) } : v;
  }
  if (next.defaultResume != null && !next.resumes?.[next.defaultResume]) {
    throw new Error(`defaultResume "${next.defaultResume}" must name a track in resumes (${Object.keys(next.resumes ?? {}).join(", ") || "none set"})`);
  }
  writeJson(paths.profile, next);
  return next as Profile;
}

/** {track: {pdf, useFor}} with trimmed names and keywords; every pdf must be a .pdf path (the user's own resume). */
export function normalizeResumes(input: unknown): Record<string, ResumeTrack> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("resumes must be an object: {track: {pdf, useFor}}");
  const out: Record<string, ResumeTrack> = {};
  for (const [rawName, raw] of Object.entries(input)) {
    const name = rawName.trim();
    const t = obj(raw);
    const pdf = optStr(t.pdf)?.trim();
    if (!name) throw new Error("resumes: a track needs a name");
    if (!pdf || !pdf.toLowerCase().endsWith(".pdf")) throw new Error(`resumes.${name}.pdf must be a path to a .pdf file`);
    const useFor = (typeof t.useFor === "string" ? splitCommas(t.useFor) : strList(t.useFor).map(x => x.trim())).filter(Boolean);
    out[name] = { pdf, ...(useFor.length && { useFor }) };
  }
  return out;
}

const year = (v: unknown, where: string): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1900 || n > 2100) throw new Error(`${where} must be a four-digit year`);
  return n;
};

/** Coerce loosely typed education entries; throw a plain Error when one is unusable. */
export function normalizeEducation(input: unknown): Education[] {
  if (!Array.isArray(input)) throw new Error("education must be a list of {school, degree, discipline, startYear, endYear}");
  return input.map((raw, i) => {
    const e = obj(raw);
    const school = optStr(e.school)?.trim();
    if (!school) throw new Error(`education[${i}] needs a school`);
    const [degree, discipline] = [optStr(e.degree)?.trim(), optStr(e.discipline)?.trim()];
    const [startYear, endYear] = [year(e.startYear, `education[${i}].startYear`), year(e.endYear, `education[${i}].endYear`)];
    return { school, ...(degree && { degree }), ...(discipline && { discipline }), ...(startYear && { startYear }), ...(endYear && { endYear }) };
  });
}

export function loadResume(): Resume | undefined {
  return readJson<Resume>(paths.resume);
}

export function saveResume(r: Resume): void {
  writeJson(paths.resume, normalizeResume(r));
}

// ---- resume shape coercion (agents send resumes as untyped JSON)

const optStr = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => String(x)) : []);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const asList = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const splitCommas = (s: string): string[] => s.split(",").map(x => x.trim()).filter(Boolean);

/** Coerce loosely typed input into a well-formed Resume; throw a plain Error when it is unusable. */
export function normalizeResume(input: unknown): Resume {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("resume must be an object");
  const r = input as Record<string, any>;
  const name = optStr(r.name)?.trim();
  if (!name) throw new Error("resume.name is required");
  const c = obj(r.contact);
  const experience = asList(r.experience).map((raw, i) => {
    const e = obj(raw);
    const company = optStr(e.company)?.trim(), title = optStr(e.title)?.trim();
    if (!company || !title) throw new Error(`resume.experience[${i}] needs a company and a title`);
    return { company, title, location: optStr(e.location), start: optStr(e.start), end: optStr(e.end), bullets: strList(e.bullets) };
  });
  const out: Resume = {
    name, headline: optStr(r.headline),
    contact: {
      ...(optStr(c.email) && { email: optStr(c.email) }), ...(optStr(c.phone) && { phone: optStr(c.phone) }),
      ...(optStr(c.location) && { location: optStr(c.location) }), ...(Array.isArray(c.links) && { links: strList(c.links) }),
    },
    summary: optStr(r.summary),
    experience,
    education: asList(r.education).map(raw => {
      const e = obj(raw);
      return {
        school: optStr(e.school) ?? "", degree: optStr(e.degree), location: optStr(e.location),
        start: optStr(e.start), end: optStr(e.end), details: Array.isArray(e.details) ? strList(e.details) : undefined,
      };
    }),
  };
  if (r.projects != null) {
    out.projects = asList(r.projects).map(raw => {
      const p = obj(raw);
      return { name: optStr(p.name) ?? "", description: optStr(p.description), link: optStr(p.link), bullets: strList(p.bullets) };
    });
  }
  if (r.skills != null) out.skills = typeof r.skills === "string" ? splitCommas(r.skills) : strList(r.skills);
  if (r.extras != null) {
    out.extras = asList(r.extras).map(raw => {
      const x = obj(raw);
      return { heading: optStr(x.heading) ?? "", items: strList(x.items) };
    });
  }
  return out;
}

/** What is still needed before the agent can fill an application form. */
export function profileStatus(): { hasProfile: boolean; hasResume: boolean; missing: string[] } {
  const p = loadProfile();
  const r = loadResume();
  const missing: string[] = [];
  for (const k of ["firstName", "lastName", "email", "phone"] as const) {
    if (!p?.[k]?.trim()) missing.push(k);
  }
  if (!r) missing.push("resume");
  if (p?.workAuthorizedUS === undefined) missing.push("workAuthorizedUS");
  if (p?.needsSponsorship === undefined) missing.push("needsSponsorship");
  return { hasProfile: !!p, hasResume: !!r, missing };
}
