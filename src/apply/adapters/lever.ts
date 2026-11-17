import type { Page } from "playwright";
import type { Job } from "../../types.js";
import { isLever } from "../detect.js";
import { fillCombobox, makeAdapter } from "./common.js";

/** Lever's banner when its invisible hCaptcha rejects the submission. The page reloads and drops the attached resume. */
export const LEVER_VERIFY_ERROR = /there was an error verifying your application/i;
/** The only proof a Lever application went in: the /thanks URL or this text. */
export const LEVER_SUCCESS_TEXT = /application submitted!/i;
export const LEVER_SUCCESS_URL = /\/thanks\/?(\?|#|$)/;

/**
 * After submit: the verification banner, or the form back with an empty resume input (the page reloaded), means
 * Lever refused the submission. Returns what was seen, or null.
 */
export async function leverRejection(page: Page): Promise<string | null> {
  if (page.isClosed() || LEVER_SUCCESS_URL.test(page.url())) return null;
  const seen = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#resume-upload-input, input[name="resume"][type="file"]');
    return { text: document.body?.innerText || "", resumeEmpty: !!input && !input.files?.length };
  }).catch(() => null);
  if (!seen || LEVER_SUCCESS_TEXT.test(seen.text)) return null;
  const banner = LEVER_VERIFY_ERROR.test(seen.text);
  if (!banner && !seen.resumeEmpty) return null;
  return [banner && 'Lever showed "There was an error verifying your application."', seen.resumeEmpty && "the attached resume was dropped (the page reloaded)"]
    .filter(Boolean).join("; ");
}

/** Lever: li.application-question rows, card questions (radios, checkboxes, selects), invisible hCaptcha. */
export const lever = makeAdapter({
  name: "lever",
  matches: isLever,
  applyUrl(job: Job) {
    const u = job.applyUrl || job.url;
    return isLever(u) && !/\/apply\/?$/.test(u) ? `${u.replace(/\/$/, "")}/apply` : u;
  },
  scan: {
    root: "#application-form, form",
    container: "li.application-question, .application-additional",
    labelSel: ".application-label .text, .application-label",
    skip: "#hcaptchaResponseInput, .h-captcha",
  },
  async fill(page, field, value) {
    const el = page.locator(`[data-oa-key="${field.key}"]`).first();
    if (field.type !== "text" || !(await el.evaluate(e => e.classList.contains("location-input")))) return false;
    // Location autocomplete: results render as plain divs under .dropdown-results.
    await fillCombobox(page, el, value, false, ".dropdown-results > *");
    return true;
  },
  submitSel: "#btn-submit, button[data-qa='btn-submit']",
  successUrl: LEVER_SUCCESS_URL,
  successText: LEVER_SUCCESS_TEXT,
  strictSuccess: true,
  submitRejected: leverRejection,
});
