import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { commitmentPlace, suggest, lookup, similarity, toDate, MATCH_MIN, type MapContext } from "./apply/fieldmap.js";
import { getJobFull } from "./details.js";
import { addEvent, getApplication, getJob, listApplications, setApplication } from "./db.js";
import { voidFill } from "./track.js";
import { packDir, packPath, paths } from "./paths.js";
import { exclusive } from "./lock.js";
import { htmlToPdf, texToPdf } from "./pdf.js";
import { loadProfile, loadResume, normalizeResume } from "./profile.js";
import { formQuestions } from "./questions.js";
import { coverLetterHtml } from "./render/cover.js";
import { coverLetterTex } from "./render/cover-tex.js";
import { resumeHtml } from "./render/resume.js";
import { truthCheck, voiceCheck } from "./truth.js";
import { isWhyUs, whyUsCheck } from "./whyus-check.js";
import type { ApplicationPack, ApplicationStatus, DraftedAnswer, FormField, Job, Profile, Resume } from "./types.js";

/** Sent or later: a new pack never moves these back to drafted, and dashboard edits are refused. */
const SENT = new Set<ApplicationStatus>(["submitted", "needs_human", "interview", "offer", "rejected", "withdrawn", "ghosted"]);
/** A filled form awaiting (or holding) approval: changing its pack voids the fill. */
const formOpen = (s?: ApplicationStatus) => s === "filled" || s === "approved";

const TODO = /\btodo \([^()\n]{1,30}\)/i; // any short owner, so packs written with an older owner-named marker still count
/**
 * What is still unfinished in a pack: answers holding a "TODO (you)" placeholder or left blank, drafted answers the
 * user has not reviewed (pack.drafted), and a cover letter with a TODO. Fill refuses while this is non-empty (HTTP
 * route and engine alike).
 */
export function packTodos(pack: { answers?: Record<string, string>; coverLetter?: string; drafted?: Record<string, unknown> } | undefined): string[] {
  const names = Object.entries(pack?.answers ?? {})
    .filter(([q, a]) => TODO.test(String(a)) || !String(a ?? "").trim() || Object.hasOwn(pack?.drafted ?? {}, q)).map(([q]) => q);
  if (pack?.coverLetter && TODO.test(pack.coverLetter)) names.push("Cover letter");
  return names;
}

/** Placeholder seeded for a required form question nobody has answered; the TODO gates refuse a fill until it is replaced. */
const SEED = "TODO (you): answer this form question";

/** What the form mapper can fill from the profile alone (no pack answers). */
function profileCtx(job?: Job): MapContext {
  return { profile: loadProfile(), resume: loadResume(), answers: {}, files: {}, coverLetter: "(the cover letter)", job };
}

/**
 * Required non-file form questions that neither the pack nor the profile answers. A date question's answer has to
 * name a date ("1-2 weeks" does) or already be a TODO; anything else goes back to the user.
 */
function unanswered(fields: FormField[], answers: Record<string, string>, job: Job): string[] {
  const ctx = profileCtx(job);
  const answered = (f: FormField) => {
    const a = answers[f.key] ?? lookup(answers, f.label);
    return a !== undefined && (f.type !== "date" || TODO.test(a) || toDate(a) !== undefined);
  };
  return [...new Set(fields.filter(f => f.required && f.type !== "file" && !answered(f) && !suggest(f, ctx)).map(f => f.label))];
}

/** Pack answer keys that match no real form question (fill would never use them). */
const offForm = (fields: FormField[], answers: Record<string, string>): string[] =>
  Object.keys(answers).filter(q => !fields.some(f => q === f.key || similarity(q, f.label) >= MATCH_MIN));

/** Answers with a TODO seed added for each label. */
const withSeeds = (answers: Record<string, string>, labels: string[]) => ({ ...answers, ...Object.fromEntries(labels.map(l => [l, SEED])) });

export function writePack(jobId: string, pack: ApplicationPack): void {
  writeFileSync(join(packDir(jobId), "pack.json"), JSON.stringify(pack, null, 2) + "\n");
}

const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "..." : s);

/** One real form question: `willFill` is what OpenApply already enters from the profile; answer only when `needsAnswer`. */
export interface BriefQuestion { question: string; required: boolean; type: FormField["type"]; options?: string[]; willFill?: string; needsAnswer: boolean }

export async function tailoringBrief(jobId: string): Promise<{
  job: Job; master: Resume; profile?: Profile; rules: string[]; formQuestions?: BriefQuestion[]; questionsHint: string[];
  needsUserInput: string[]; voiceSamples: string[];
}> {
  const job = await getJobFull(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  const master = loadResume();
  if (!master) throw new Error("No master resume yet. Import one first (import_resume) or save_resume.");
  const profile = loadProfile();
  const voiceSamples = (profile?.voiceSamples ?? []).map(s => trim(s.trim(), 1200)).filter(Boolean).slice(0, 4);

  const rules = [
    "Never invent facts, numbers, employers, titles, schools, degrees, dates or skills. Use only what is in the master resume (and the user's own words).",
    "You may reorder, cut and rephrase bullets, and mirror the job description's wording where it is truthful. Keep every number exactly as in the master.",
    "Keep employer names, titles and date ranges as in the master. A shortened title is fine; a new one is not.",
    "List experience newest first by start date, with current roles (end \"Present\") at the top.",
    "If the user keeps their own finished resume files (for example LaTeX builds), produce or pick that file and pass its path as resume_pdf. OpenApply then uploads it as is instead of rendering its own.",
    "Resume: one page, about 450 to 600 words. Lead with the experience most relevant to this role, cut the rest. Return a full Resume object.",
    "Do not use em dashes anywhere. Use commas, colons or periods.",
    `Cover letter: 150 to 250 words, short paragraphs. Open with the specific problem ${job.company} is hiring for right now (read the job description for it) and how the user has solved something like it before, using real resume facts. Do not open with enthusiasm or "I am writing to apply".`,
    "Add one concrete piece of evidence or proof-of-work (a shipped project, a metric from the master, a link) the reader can check.",
    "Never write a gap paragraph or name a shortfall: end the letter on the closest true proof for the posting's top requirement (shipped work, a link, a number), then a specific close. State a hard logistics fact only when the reader will check it first (location, work authorization, start date). Never claim more than the resume shows.",
    "A human reads every word. No filler: avoid \"passionate\", \"thrilled\", \"leverage\", \"proven track record\", \"fast-paced\", \"dynamic\", \"seamless\", \"robust\". Every sentence must be specific to this company or this person, never usable for any other job.",
    "Mention the company by name and at least one specific thing from the posting (product, problem, team, stack).",
    "Greeting and sign-off belong in the letter text. The signature block is added from the profile if the closing is missing.",
    voiceSamples.length
      ? "Write in the user's own voice. Voice samples are included below: match this voice, sentence length and vocabulary. Do not sound more polished than they do."
      : "No voice samples are saved. Ask the user for a short paragraph they wrote themselves (saved as profile.voiceSamples) so drafts sound like them, or keep the prose plain and short.",
    "For free-text questions like \"why this company\" or \"why you\", do NOT invent enthusiasm. Save a why-us question as \"TODO (you): one specific, true reason.\", then call draft_why_us: it drafts one true link between the company and the user's work for them to review, or says there is none.",
    "Prefer one focused narrative for this role over covering everything. Cut experience that does not support it.",
    "After saving, check the warnings returned by save_pack and fix anything flagged as a new number, employer, title or date.",
  ];

  const fields = await formQuestions(job);
  const ctx = profileCtx(job);
  const real = fields?.map((f): BriefQuestion => {
    const s = f.type === "file" ? undefined : suggest(f, ctx);
    const needsAnswer = f.type !== "file" && !s;
    return { question: f.label, required: f.required, type: f.type, options: needsAnswer ? f.options : undefined, willFill: s?.value, needsAnswer };
  });

  const text = job.description.toLowerCase();
  const questionsHint = real ? [] : [
    `Why do you want to work at ${job.company}?`,
    "Why are you a good fit for this role?",
    "Are you legally authorized to work in the United States? (profile.workAuthorizedUS)",
    "Will you now or in the future require visa sponsorship? (profile.needsSponsorship)",
    "What are your salary expectations? (profile.salaryExpectation)",
    "When can you start? / notice period (profile.noticePeriod)",
    "Are you willing to relocate? (profile.willingToRelocate)",
    "How did you hear about this role?",
    "LinkedIn, GitHub and website URLs (profile)",
    ...(/\bsponsor|visa\b/.test(text) ? ["The posting mentions visa or sponsorship terms: check the answer matches the profile."] : []),
    ...Object.keys(profile?.savedAnswers ?? {}).map(q => `Saved answer available: ${q}`),
  ];

  const needsUserInput = [
    `Why ${job.company}? One specific reason that is true for you${profile?.story ? " (profile.story exists: use it if it fits)" : ""}`,
    "Why you for this role? One proud, checkable thing you did that matches the posting",
  ];

  return { job, master, profile, rules, formQuestions: real, questionsHint, needsUserInput, voiceSamples };
}

/** The resume's source text plus the user's own proof points (true things not on the resume), for the truth guard. */
const resumeSource = () => [existsSync(paths.resumeSource) ? readFileSync(paths.resumeSource, "utf8") : "", ...(loadProfile()?.proofPoints ?? [])].join("\n");

/** Truth guard plus voice guard over everything a reader sees: the resume, the letter and the answers. */
function checkPack(master: Resume, source: string, resume: Resume, coverLetter: string | undefined, answers: Record<string, string>, company: string): string[] {
  // The user's own saved answers (salary, start date) are facts they gave for form answers, never for the resume or letter.
  const own = Object.values(loadProfile()?.savedAnswers ?? {}).join("\n");
  const warnings = truthCheck(master, source, resume, coverLetter, answers, own);
  const prose = [resume.summary, ...Object.values(answers)].filter(Boolean) as string[];
  if (prose.length) warnings.push(...voiceCheck(prose.join("\n\n")));
  if (coverLetter) warnings.push(...voiceCheck(coverLetter, company));
  warnings.push(...otherCompanyCheck(master, coverLetter, answers, company));
  const avoid = loadProfile()?.avoidClaims;
  for (const [q, a] of Object.entries(answers)) {
    if (a && !TODO.test(a) && isWhyUs(q, company)) warnings.push(...whyUsCheck(a, { question: q, company, avoid }));
  }
  if (coverLetter) {
    const n = coverLetter.trim().split(/\s+/).length;
    if (n > 300) warnings.push(`Cover letter is ${n} words; aim for 150 to 250`);
  }
  return warnings;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An answer or letter that names another company in the pipeline was likely written for that one (an answer copied
 * across packs). Names as written, whole words, so a lowercase common word never matches a company of the same name; past employers never count.
 */
function otherCompanyCheck(master: Resume, coverLetter: string | undefined, answers: Record<string, string>, company: string): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const skip = new Set([company, ...(master.experience ?? []).map(e => e.company)].filter(Boolean).map(norm));
  const others = [...new Set(listApplications().map(a => a.job?.company?.trim() ?? ""))]
    .filter(n => n.length >= 3 && !skip.has(norm(n)))
    .map(n => ({ n, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "u") }));
  if (!others.length) return [];
  const w: string[] = [];
  const named = (text: string) => others.filter(o => o.re.test(text)).map(o => o.n);
  for (const [q, text] of Object.entries(answers)) {
    const hit = named(text ?? "");
    if (hit.length) w.push(`Answer to "${q}" names ${hit.join(", ")}, another company in your pipeline: rewrite it for ${company}`);
  }
  const hit = coverLetter ? named(coverLetter) : [];
  if (hit.length) w.push(`Cover letter names ${hit.join(", ")}, another company in your pipeline: rewrite it for ${company}`);
  return w;
}

/**
 * Render cover-letter.pdf in dir: LaTeX from templates/cover-letter.tex (the resume's own preamble) when a TeX
 * engine is on this machine, else the HTML renderer plus a warning. Returns the PDF path and render warnings.
 */
export async function renderCoverLetter(text: string, profile: Profile | undefined, job: Job, dir: string): Promise<{ pdf: string; warnings: string[] }> {
  const pdf = join(dir, "cover-letter.pdf");
  const warnings: string[] = [];
  let pages: number;
  try {
    ({ pages } = await texToPdf(coverLetterTex(text, profile), pdf));
  } catch (e) {
    warnings.push(`Cover letter rendered without LaTeX (${(e as Error).message}), so its font will not match a LaTeX resume`);
    ({ pages } = await htmlToPdf(coverLetterHtml(text, profile, job), pdf));
  }
  if (pages > 1) warnings.push(`Cover letter renders at ${pages} pages; shorten it`);
  return { pdf, warnings };
}

export function savePack(
  jobId: string,
  input: { resume: Resume; coverLetter?: string; answers?: Record<string, string>; resumePdf?: string },
): Promise<ApplicationPack> {
  return exclusive(jobId, () => savePackInner(jobId, input));
}

async function savePackInner(
  jobId: string,
  input: { resume: Resume; coverLetter?: string; answers?: Record<string, string>; resumePdf?: string },
): Promise<ApplicationPack> {
  input = { ...input, resume: normalizeResume(input.resume) };
  const job = getJob(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  const master = loadResume();
  if (!master) throw new Error("No master resume yet. Import one first.");
  const fieldsP = formQuestions(job); // never rejects; read while the PDFs render
  const profile = loadProfile();
  const answers = input.answers ?? {};

  const warnings = checkPack(master, resumeSource(), input.resume, input.coverLetter, answers, job.company);

  const dir = packDir(jobId);
  const pack: ApplicationPack = { jobId, resume: input.resume, coverLetter: input.coverLetter, answers, warnings, createdAt: new Date().toISOString() };
  // A drafted answer saved again unchanged is still unreviewed: keep its flag so it cannot pass as finished.
  const prev = loadPack(jobId);
  const kept = Object.entries(prev?.drafted ?? {}).filter(([q]) => answers[q] !== undefined && answers[q] === prev!.answers[q]);
  if (kept.length) pack.drafted = Object.fromEntries(kept);

  // The user's own finished PDF wins: upload it under its own filename, never re-render over it.
  let pages = 1;
  if (input.resumePdf) {
    if (!input.resumePdf.toLowerCase().endsWith(".pdf") || !existsSync(input.resumePdf)) throw new Error(`resume_pdf not found or not a PDF: ${input.resumePdf}`);
    pack.resumePdf = join(dir, basename(input.resumePdf));
    copyFileSync(input.resumePdf, pack.resumePdf);
  } else {
    const r = await htmlToPdf(resumeHtml(input.resume), join(dir, "resume.pdf"));
    pack.resumePdf = join(dir, "resume.pdf");
    pages = r.pages;
    if (r.pages > 1) warnings.push(`Resume renders at ${r.pages} pages; cut it to one page`);
    if (profile?.resumePdf || Object.keys(profile?.resumes ?? {}).length) {
      warnings.push("No resume_pdf: this pack uses OpenApply's rendered resume, and fill refuses it because you keep your own PDF. Save again with resume_pdf");
    }
  }
  if (input.coverLetter) {
    const c = await renderCoverLetter(input.coverLetter, profile, job, dir);
    pack.coverLetterPdf = c.pdf;
    warnings.push(...c.warnings);
  }

  // Line the pack up with the real form: seed required questions nobody answered, flag answers the form never asks.
  const fields = await fieldsP;
  if (fields) {
    pack.answers = withSeeds(answers, unanswered(fields, answers, job));
    warnings.push(...offForm(fields, answers).map(q => `Not on the form: ${q} (this answer will not be used)`));
  }

  writePack(jobId, pack);
  const status = getApplication(jobId)?.status;
  // A filled (or approved) form no longer matches the saved pack: void it so the next step is a fresh fill.
  if (!status || !SENT.has(status)) setApplication(jobId, { status: "drafted", confirmationCode: undefined });
  addEvent(jobId, "pack", `${warnings.length} warning(s), resume ${input.resumePdf ? "user PDF" : `${pages} page(s)`}${pack.coverLetterPdf ? ", cover letter" : ""}`);
  return pack;
}

/**
 * Before a fill: seed "TODO (you)" for every required form question that has no pack answer (counting `extra`,
 * answers passed with the fill) and no profile value, so the TODO gates refuse the fill instead of leaving the
 * question blank. Returns the seeded labels; does nothing when the form cannot be read.
 */
export function alignPack(jobId: string, extra: Record<string, string> = {}): Promise<string[]> {
  return exclusive(jobId, () => alignPackInner(jobId, extra));
}

/** alignPack for a caller that already holds the job's lock (fill does, so a racing submit queues behind it). */
export async function alignPackInner(jobId: string, extra: Record<string, string> = {}): Promise<string[]> {
  const job = getJob(jobId);
  const pack = loadPack(jobId);
  const fields = job && pack ? await formQuestions(job) : undefined;
  if (!job || !fields || !pack) return [];
  // A TODO seed is replaced by an answer passed with the fill (keyed by the form's own label, maybe under another
  // wording than the API's) and dropped when the profile can now answer the question itself.
  const ctx = profileCtx(job);
  const answers = Object.fromEntries(Object.entries(pack.answers).flatMap(([q, v]): Array<[string, string]> => {
    if (v !== SEED) return [[q, v]];
    const given = lookup(extra, q);
    if (given !== undefined) return [[q, given]];
    return fields.some(f => f.type !== "file" && similarity(q, f.label) >= MATCH_MIN && suggest(f, ctx)) ? [] : [[q, v]];
  }));
  const seeded = unanswered(fields, { ...answers, ...extra }, job);
  const changed = seeded.length > 0 || Object.keys(answers).length !== Object.keys(pack.answers).length || Object.keys(answers).some(q => answers[q] !== pack.answers[q]);
  if (!changed) return [];
  writePack(jobId, { ...pack, answers: withSeeds(answers, seeded), updatedAt: new Date().toISOString() });
  if (seeded.length) addEvent(jobId, "pack", `Form read: ${seeded.length} required question(s) added as TODO`);
  return seeded;
}

/**
 * Add required questions a fill left blank to the pack as TODOs, so the user can answer them in the dashboard before
 * filling again. The caller holds the job's lock (fill does); questions the pack already has are left alone.
 */
export function seedTodos(jobId: string, labels: string[]): void {
  const pack = labels.length ? loadPack(jobId) : undefined;
  const add = pack ? labels.filter(l => lookup(pack.answers, l) === undefined) : [];
  if (pack && add.length) writePack(jobId, { ...pack, answers: withSeeds(pack.answers, add), updatedAt: new Date().toISOString() });
}

/**
 * After a dashboard draft: the drafter's answers to relocation, office-day, commute or travel questions go back to TODO
 * seeds unless the profile or a saved answer covers that place (fieldmap commitmentPlace), so only the user commits
 * to a city. A TODO the drafter left stays as written. Returns the questions seeded.
 */
export function seedCommitments(jobId: string): string[] {
  const job = getJob(jobId);
  const pack = loadPack(jobId);
  if (!job || !pack) return [];
  const ctx = profileCtx(job);
  const held = Object.keys(pack.answers).filter(q => !TODO.test(pack.answers[q]) && commitmentPlace(q, job) !== undefined
    && !suggest({ key: q, label: q, type: "text", required: true }, ctx));
  if (!held.length) return [];
  writePack(jobId, { ...pack, answers: withSeeds(pack.answers, held) });
  addEvent(jobId, "pack", `Drafter's answer to ${held.length} relocation or office question(s) put back to TODO for you`);
  return held;
}

/**
 * The user's own edits from the dashboard: merges answers per question and/or replaces the cover letter text.
 * Only questions already in the pack can be edited, and not once the application is submitted or later. Editing a
 * filled (or approved) form's pack voids that fill, so the form is filled again before approval. Re-runs the truth and
 * voice guards, re-renders the letter PDF only when its text changed, and never touches the resume, its PDF
 * or createdAt. Runs under the job's lock and reads the pack inside it, so concurrent edits never drop one.
 */
/**
 * `reviewed` keeps drafted answers as they are (the user read them; a no-honest-link draft must be edited instead), and
 * `drafted` marks answers just written by the why-us drafter as awaiting review. Editing a drafted answer reviews it.
 */
export interface PackPatch { answers?: Record<string, string>; coverLetter?: string; reviewed?: string[]; drafted?: Record<string, DraftedAnswer> }

export function updatePack(jobId: string, patch: PackPatch): Promise<ApplicationPack> {
  return exclusive(jobId, () => updatePackInner(jobId, patch));
}

async function updatePackInner(jobId: string, patch: PackPatch): Promise<ApplicationPack> {
  const job = getJob(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  const prev = loadPack(jobId);
  if (!prev) throw new Error(`No pack for ${jobId}`);
  const status = getApplication(jobId)?.status;
  if (status && SENT.has(status)) throw new Error(`Cannot edit ${jobId}: already ${status}`);
  const reopen = formOpen(status);
  const unknown = [...Object.keys(patch.answers ?? {}), ...(patch.reviewed ?? [])].filter(q => !Object.hasOwn(prev.answers ?? {}, q));
  if (unknown.length) throw new Error(`Cannot edit ${jobId}: not a question in this pack: ${unknown.join(", ")}`);
  const master = loadResume();
  if (!master) throw new Error("No master resume yet. Import one first.");

  const answers = { ...prev.answers, ...patch.answers };
  const editedQs = Object.keys(patch.answers ?? {}).filter(q => prev.answers[q] !== answers[q]);
  const edited = editedQs.length;
  const coverLetter = patch.coverLetter === undefined ? prev.coverLetter : patch.coverLetter.trim() || undefined;
  const letterChanged = (coverLetter ?? "") !== (prev.coverLetter ?? "");
  const drafted = { ...prev.drafted };
  for (const q of editedQs) delete drafted[q];
  const kept = (patch.reviewed ?? []).filter(q => Object.hasOwn(drafted, q));
  for (const q of kept) {
    if (drafted[q].noLink) throw new Error(`Cannot keep "${q}" as drafted: no honest link was found, so rewrite it in your own words`);
    delete drafted[q];
  }
  const newDrafts = Object.keys(patch.drafted ?? {});
  Object.assign(drafted, patch.drafted);
  if (!edited && !letterChanged && !kept.length && !newDrafts.length) return prev;

  const warnings = checkPack(master, resumeSource(), prev.resume, coverLetter, answers, job.company);
  // render notes (page counts, LaTeX fallback) come from rendering, not from the text checks: keep the ones still true
  warnings.push(...prev.warnings.filter(w => /^Resume renders at/.test(w) || (!letterChanged && /^Cover letter render/.test(w))));
  const pack: ApplicationPack = { ...prev, answers, coverLetter, warnings, updatedAt: new Date().toISOString() };
  if (Object.keys(drafted).length) pack.drafted = drafted; else delete pack.drafted;
  if (letterChanged && coverLetter) {
    const c = await renderCoverLetter(coverLetter, loadProfile(), job, packDir(jobId));
    pack.coverLetterPdf = c.pdf;
    warnings.push(...c.warnings);
  } else if (letterChanged) delete pack.coverLetterPdf;

  writePack(jobId, pack);
  if (reopen) voidFill(jobId); // the open form no longer matches: fill again
  const voided = reopen ? `, ${status} form voided: fill again` : "";
  if (newDrafts.length) addEvent(jobId, "pack", `Why-us drafted for your review: ${newDrafts.join(", ")}${voided}`);
  else addEvent(jobId, "pack", `Edited in dashboard: ${edited} answer(s)${letterChanged ? ", cover letter" : ""}${kept.length ? `, ${kept.length} draft(s) kept` : ""}, ${warnings.length} warning(s)${voided}`);
  return pack;
}

export function loadPack(jobId: string): ApplicationPack | undefined {
  const file = join(packPath(jobId), "pack.json");
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")) as ApplicationPack; } catch { return undefined; }
}
