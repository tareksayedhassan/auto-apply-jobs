import { randomInt } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Page } from "playwright";
import * as db from "../db.js";
import { paths } from "../paths.js";
import { loadProfile, loadResume, saveProfile } from "../profile.js";
import { exclusive } from "../lock.js";
import { assertNotDuplicate } from "../prior.js";
import { assertOwnResume, pickResume } from "../resume-track.js";
import { alignPackInner, loadPack, packTodos, seedTodos } from "../tailor.js";
import { currentFill, saveFill, voidFill } from "../track.js";
import type { FillResult, FormField, FormInspection, Job, SubmitResult } from "../types.js";
import { ashby } from "./adapters/ashby.js";
import type { Adapter } from "./adapters/common.js";
import { thankYouVisible } from "./adapters/common.js";
import { generic } from "./adapters/generic.js";
import { greenhouse } from "./adapters/greenhouse.js";
import { lever } from "./adapters/lever.js";
import { closeBrowser, closePage, fullPageShot, openPage, pageFor } from "./browser.js";
import { detectCaptcha } from "./captcha.js";
import { adapterFor, isWorkday, refineForPage, type AdapterName } from "./detect.js";
import { suggest, type MapContext } from "./fieldmap.js";

export { closeBrowser };

const ADAPTERS: Record<AdapterName, Adapter> = { greenhouse, lever, ashby, generic };
/** Which adapter drove each open job page (fill and submit must agree). */
const used = new Map<string, Adapter>();

/**
 * The fill a confirmation code belongs to. Submit only acts on the exact fill the user approved:
 * same process, same code, same page URL. Anything that re-navigates or re-fills the page voids it.
 */
const tickets = new Map<string, { code: string; url: string }>();

const sameUrl = (a: string, b: string) => a.split("#")[0] === b.split("#")[0];

/** Drop any outstanding approval for this job before its page changes. */
function voidApproval(jobId: string): void {
  tickets.delete(jobId);
  voidFill(jobId);
}

/** Whether this process holds an approvable fill for the job: its ticket, its open page and the adapter that filled it. */
export const canSubmit = (jobId: string): boolean => tickets.has(jobId) && !!openPage(jobId) && used.has(jobId);

function jobOrThrow(jobId: string): Job {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`Unknown job ${jobId}. Search or sync first.`);
  return job;
}

/** Workday forms sit behind a per-employer Workday account and a multi-page wizard: OpenApply does not drive them. */
function assertFormSupported(jobId: string): void {
  const job = db.getJob(jobId);
  if (job && (job.ats === "workday" || isWorkday(job.applyUrl || job.url))) {
    throw new Error(`OpenApply does not fill Workday forms. Open ${job.applyUrl || job.url} and apply in your own browser, then record it with update_application (status submitted) or log_applied_offsite.`);
  }
}

async function open(job: Job): Promise<{ page: Page; adapter: Adapter }> {
  let name = adapterFor(job.applyUrl || job.url);
  const page = await pageFor(job.id, ADAPTERS[name].applyUrl(job));
  name = await refineForPage(page, name);
  used.set(job.id, ADAPTERS[name]);
  return { page, adapter: ADAPTERS[name] };
}

/**
 * Profile, resume, pack and answers in one place. Without a usable pack PDF the resume is the user's own base PDF
 * for this role (pickResume: its resume track, else profile.resumePdf).
 */
function context(jobId: string, answers: Record<string, string> = {}): MapContext {
  const profile = loadProfile();
  const pack = loadPack(jobId);
  const job = db.getJob(jobId);
  const base = job && pickResume(profile, job)?.pdf;
  const resume = [pack?.resumePdf, base].find(p => p && existsSync(p));
  const cover = pack?.coverLetterPdf && existsSync(pack.coverLetterPdf) ? pack.coverLetterPdf : undefined;
  return {
    profile, resume: loadResume() ?? pack?.resume,
    answers: { ...(pack?.answers ?? {}), ...answers },
    files: { resume, cover }, coverLetter: pack?.coverLetter, job,
  };
}

function withSuggestions(fields: FormField[], ctx: MapContext): FormField[] {
  return fields.map(f => {
    const s = suggest(f, ctx);
    return s ? { ...f, suggested: s.value, source: s.source } : f;
  });
}

/** Saves a full-page screenshot; undefined (never an empty file) when the browser gives nothing back. */
async function screenshot(page: Page, jobId: string, tag = ""): Promise<string | undefined> {
  const png = await fullPageShot(page);
  if (!png) return undefined;
  mkdirSync(paths.screenshots, { recursive: true });
  const file = join(paths.screenshots, `${jobId.replace(/[^a-zA-Z0-9._-]/g, "_")}${tag}-${Date.now()}.png`);
  return writeFile(file, png).then(() => file, () => undefined);
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");

/** Open the form, list fields with what OpenApply would put there, and the required questions it cannot answer. */
export function inspectForm(jobId: string): Promise<FormInspection> {
  return exclusive(jobId, () => inspectInner(jobId));
}

async function inspectInner(jobId: string): Promise<FormInspection> {
  const job = jobOrThrow(jobId);
  assertFormSupported(jobId);
  if (tickets.has(jobId)) voidApproval(jobId); // re-opening the form wipes what was filled
  const { page, adapter } = await open(job);
  const fields = withSuggestions(await adapter.discover(page), context(jobId));
  const captcha = await detectCaptcha(page);
  return {
    jobId, adapter: adapter.name, url: page.url(), fields,
    missing: fields.filter(f => f.required && !f.suggested).map(f => f.label),
    captchaDetected: captcha.interactive,
  };
}

/**
 * Fill every field it can (never submits). Answers are keyed by field label (or key) and override the pack.
 * `remember` saves the agent's answers into profile.savedAnswers for future forms.
 */
export function fillForm(jobId: string, answers: Record<string, string> = {}, remember = false, force = false): Promise<FillResult> {
  // Take the lock first so a racing submit queues behind this fill. Required form questions nobody answered
  // become TODOs, so the gate in fillInner refuses instead of leaving them blank.
  return exclusive(jobId, async () => {
    assertFormSupported(jobId); // before the pack or a browser is touched
    assertNotDuplicate(jobId, force); // the same role already went in under another job id: before the pack is touched
    assertOwnResume(jobId); // before the form or the pack is touched
    await alignPackInner(jobId, answers);
    return fillInner(jobId, answers, remember);
  });
}

async function fillInner(jobId: string, answers: Record<string, string>, remember: boolean): Promise<FillResult> {
  const job = jobOrThrow(jobId);
  if (db.getApplication(jobId)?.status === "submitted") throw new Error(`${jobId} is already submitted.`);
  const ctx = context(jobId, answers);
  // Every fill path (dashboard run, MCP tool) refuses here, before the form is touched.
  // A drafted answer the user has not reviewed is unfinished, unless this fill passes its own answer for it.
  const drafted = Object.fromEntries(Object.entries(loadPack(jobId)?.drafted ?? {}).filter(([q]) => !Object.hasOwn(answers, q)));
  const todos = packTodos({ answers: ctx.answers, coverLetter: ctx.coverLetter, drafted });
  if (todos.length) throw new Error(`Cannot fill ${jobId}: unfinished answers (TODO or blank): ${todos.join(", ")}. Finish them first.`);
  voidApproval(jobId);
  const { page, adapter } = await open(job);
  const fields = withSuggestions(await adapter.discover(page), ctx);
  const files = ctx.files;
  const filled: FillResult["filled"] = [];
  const skipped: FillResult["skipped"] = [];
  // Blanks have no answer (or no file) and block approval; failed fields have an answer the adapter could not
  // enter, so the user finishes them by hand in the open window. Blank questions become pack TODOs.
  const blanks: string[] = [], failed: string[] = [], unanswered: string[] = [];
  const skip = (f: FormField, reason: string) => skipped.push({ key: f.key, label: f.label, reason });

  // Files first: Lever parses the resume and may prefill fields we then overwrite.
  const ordered = [...fields.filter(f => f.type === "file"), ...fields.filter(f => f.type !== "file")];
  for (const f of ordered) {
    if (!f.suggested) {
      if (!f.required) { skip(f, "optional, no answer"); continue; }
      skip(f, f.type === "file" ? "no file for this upload (resume PDF missing?)" : "required, no answer: ask the user");
      blanks.push(f.label);
      if (f.type !== "file") unanswered.push(f.label);
      continue;
    }
    try {
      await adapter.fill(page, f, f.suggested, files);
      filled.push({ key: f.key, label: f.label, value: f.type === "file" ? basename(f.suggested) : f.suggested });
      if (f.type === "file") await page.waitForTimeout(800);
    } catch (e) {
      skip(f, `fill failed: ${(e as Error).message.split("\n")[0]}`);
      if (f.required) failed.push(f.label);
    }
  }

  const captcha = await detectCaptcha(page);
  if (captcha.invisible && !captcha.interactive) {
    skipped.push({ key: "captcha", label: "CAPTCHA", reason: `hasInvisibleCaptcha (${captcha.kinds.join(", ")}): background check only, usually passes in a real browser` });
  }
  seedTodos(jobId, unanswered);
  const shot = await screenshot(page, jobId);
  const confirmationCode = newCode();
  saveFill(jobId, { at: new Date().toISOString(), code: confirmationCode, filled, blanks, failed }); // before the code goes live
  tickets.set(jobId, { code: confirmationCode, url: page.url() });
  db.setApplication(jobId, { status: "filled", confirmationCode });
  db.addEvent(jobId, "filled", JSON.stringify({
    summary: `${filled.length} filled, ${blanks.length} required missing via ${adapter.name}`,
    screenshot: shot ? basename(shot) : undefined,
  }));

  if (remember && Object.keys(answers).length) {
    const byKey = new Map(fields.map(f => [f.key, f.label]));
    const saved = Object.fromEntries(Object.entries(answers).map(([k, v]) => [byKey.get(k) ?? k, v]));
    saveProfile({ savedAnswers: saved });
  }
  return { jobId, filled, skipped, blanks, failed, screenshot: shot, confirmationCode, captchaDetected: captcha.interactive };
}

type Outcome = { kind: "submitted" | "captcha" | "timeout" } | { kind: "rejected"; why: string };

async function waitForOutcome(page: Page, adapter: Adapter, formUrl: string, timeoutMs: number): Promise<Outcome> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !page.isClosed()) {
    await page.waitForTimeout(500);
    if (await adapter.confirmSubmitted(page).catch(() => false)) return { kind: "submitted" };
    const why = await adapter.submitRejected?.(page).catch(() => null);
    if (why) return { kind: "rejected", why };
    if (!adapter.strictSuccess) {
      const moved = page.url().split("#")[0] !== formUrl.split("#")[0];
      const thanks = await thankYouVisible(page);
      const formGone = !(await page.locator("form").filter({ visible: true }).count().catch(() => 1));
      if (thanks && (moved || formGone)) return { kind: "submitted" };
      if (moved && /thank|confirm|success|submitted/i.test(page.url())) return { kind: "submitted" };
    }
    if ((await detectCaptcha(page).catch(() => ({ interactive: false }))).interactive) return { kind: "captcha" };
  }
  return { kind: "timeout" };
}

async function visibleErrors(page: Page): Promise<string[]> {
  const texts = await page.locator('[role="alert"], .error-message, .error, [class*="error"]:not(:has(*))')
    .filter({ visible: true }).allInnerTexts().catch(() => [] as string[]);
  return [...new Set(texts.map(t => t.trim()).filter(Boolean))].slice(0, 5);
}

/**
 * Submit the open, filled form. Requires the code fill returned (shown to the user, who said yes)
 * or status 'approved'. Never solves CAPTCHAs: a challenge ends in needs_human with the browser left open.
 */
export function submitForm(jobId: string, confirmationCode?: string): Promise<SubmitResult> {
  return exclusive(jobId, () => submitInner(jobId, confirmationCode));
}

async function submitInner(jobId: string, confirmationCode?: string): Promise<SubmitResult> {
  jobOrThrow(jobId);
  const app = db.getApplication(jobId);
  if (app?.status === "submitted") throw new Error(`${jobId} is already submitted.`);
  const ticket = tickets.get(jobId);
  const page = openPage(jobId);
  const adapter = used.get(jobId);
  if (!app || !ticket || !page || !adapter || !["filled", "approved"].includes(app.status) || app.confirmationCode !== ticket.code) {
    throw new Error("Submit refused: there is no filled form awaiting approval for this job in this session (browser closed, process restarted, or the form was re-opened). Run fill again, show the user the new preview, and submit with the new code.");
  }
  const codeOk = !!confirmationCode && confirmationCode.trim().toUpperCase() === ticket.code;
  if (!(codeOk || app.status === "approved")) {
    throw new Error("Submit refused: no user approval. Show the user the fill preview (screenshot and filled fields), get an explicit yes, then call submit with the confirmation code from fill (or the user approves in the dashboard).");
  }
  const blanks = currentFill(jobId, app)?.blanks ?? [];
  if (blanks.length && app.status !== "approved") {
    throw new Error(`Submit refused: required fields are blank on the form (answer them, run fill again, get a fresh yes): ${blanks.join(", ")}`);
  }
  if (!sameUrl(page.url(), ticket.url)) {
    voidApproval(jobId);
    throw new Error(`Submit refused: the page moved since it was filled (${page.url()}). Run fill again and get a fresh yes.`);
  }

  tickets.delete(jobId); // single use, whatever happens next
  const job = jobOrThrow(jobId);
  const elsewhere = { applyUrl: adapter.applyUrl(job), resume: context(jobId).files.resume };
  const finish = async (outcome: SubmitResult["outcome"], detail: string, extra: Partial<SubmitResult> = {}): Promise<SubmitResult> => {
    const shot = await screenshot(page, jobId, `-${outcome}`);
    db.setApplication(jobId, outcome === "submitted"
      ? { status: "submitted", submittedAt: new Date().toISOString(), confirmationCode: undefined }
      : { status: "needs_human", confirmationCode: undefined });
    db.addEvent(jobId, outcome, JSON.stringify({ summary: detail, screenshot: shot ? basename(shot) : undefined, ...extra }));
    // The confirmation is on the screenshot; the tab has nothing left to do. Anything else stays open for the user.
    if (outcome === "submitted") { used.delete(jobId); await closePage(jobId); }
    return { jobId, outcome, detail, screenshot: shot, ...extra };
  };
  /** Lever's invisible hCaptcha fails in the automated profile and passes in the user's own browser. */
  const inOwnBrowser = `Finish in your normal browser: open ${elsewhere.applyUrl}, attach ${elsewhere.resume ?? "your resume PDF"}, submit, and record it with update_application (status submitted) once the page reads "Application submitted!".`;

  const before = await detectCaptcha(page);
  if (before.interactive) {
    return finish("needs_human", `CAPTCHA on the page (${before.kinds.join(", ")}). OpenApply does not solve CAPTCHAs: the browser is left open for the user to finish and submit.`);
  }
  const formUrl = page.url();
  try {
    await adapter.submit(page);
  } catch (e) {
    return finish("failed", `Could not click submit: ${(e as Error).message.split("\n")[0]}. The browser is left open.`);
  }
  const outcome = await waitForOutcome(page, adapter, formUrl, 20_000);
  if (outcome.kind === "submitted") return finish("submitted", `Submitted via ${adapter.name}; confirmation seen at ${page.url()}`);
  if (outcome.kind === "rejected") {
    return finish("verification_failed", `NOT submitted: ${outcome.why}. Clearing a CAPTCHA in the OpenApply window does not help here. ${inOwnBrowser}`, elsewhere);
  }
  if (outcome.kind === "captcha") {
    return adapter.name === "lever"
      ? finish("needs_human", `A CAPTCHA challenge appeared after clicking submit; Lever usually rejects this window even after it is cleared. ${inOwnBrowser}`, elsewhere)
      : finish("needs_human", "A CAPTCHA challenge appeared after clicking submit. The browser is left open for the user to complete it.");
  }
  const errs = await visibleErrors(page);
  return finish("failed", errs.length
    ? `The form did not submit. Errors shown: ${errs.join(" | ")}. The browser is left open.`
    : "No confirmation seen within 20 s. Check the open browser before retrying (it may have submitted).");
}
