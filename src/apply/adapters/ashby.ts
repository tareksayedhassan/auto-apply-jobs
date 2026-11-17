import type { Page, Request } from "playwright";
import type { FormField, Job } from "../../types.js";
import { isAshby } from "../detect.js";
import { fillField, makeAdapter } from "./common.js";

/**
 * Ashby keeps the answers on its server: each change sends ApiSetFormValue for one field path, the reply is the whole
 * form as stored, and the submit is checked against that copy, not the page. Saves that overlap drop each other
 * (seen 2026-10-22: four yes/no clicks in a row, the page showed all four, the submit said one was missing), so
 * every field waits for its saves before the next starts, and an answer the reply does not hold is a failed field.
 * An upload asks for a handle (ApiCreateFileUploadHandle), goes to storage, and is filed on the form by
 * ApiSetFormValueToFile after setInputFiles returns; the same file set again on a re-fill uploads nothing.
 */
interface Saves { pending: number; sent: Map<string, unknown>; stored?: Map<string, unknown> }
const op = (name: string) => new RegExp(`[?&]op=${name}\\b`); // \b: ApiSetFormValue is not ApiSetFormValueToFile
const SAVE = op("ApiSetFormValue"), UPLOAD = op("ApiCreateFileUploadHandle"), FILE_SAVE = op("ApiSetFormValueToFile");
const savesByPage = new WeakMap<Page, Saves>();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function watchSaves(page: Page): Saves {
  const known = savesByPage.get(page);
  if (known) return known;
  const s: Saves = { pending: 0, sent: new Map() };
  savesByPage.set(page, s);
  page.on("request", r => {
    if (!SAVE.test(r.url())) return;
    s.pending++;
    try { const v = r.postDataJSON()?.variables; if (v?.path) s.sent.set(v.path, v.value ?? null); } catch { /* not a save we can read */ }
  });
  const settled = async (r: Request) => {
    try {
      const entries = (await (await r.response())?.json())?.data?.setFormValue?.sections?.flatMap((x: any) => x.fieldEntries);
      if (entries) {
        s.stored = new Map(entries.map((e: any) => {
          const v = e.fieldValue; // { value } for text, booleans, choices and dates; a File object for uploads
          return [e.field.path, v && typeof v === "object" && "value" in v ? v.value : v ?? null];
        }));
      }
    } catch { /* an unreadable reply proves nothing either way */ }
    finally { s.pending--; }
  };
  page.on("requestfinished", r => { if (SAVE.test(r.url())) void settled(r); });
  page.on("requestfailed", r => { if (SAVE.test(r.url())) void settled(r); });
  return s;
}

/** Until the field's saves are back. A save starts as its click or blur lands, so a field that sent none gets a short grace. */
async function saved(s: Saves): Promise<void> {
  if (!s.sent.size) await sleep(100);
  for (const end = Date.now() + 10_000; s.pending > 0 && Date.now() < end;) await sleep(25);
}

/** An upload Ashby started must be filed on the form; the same file set again starts none. */
async function fillUpload(page: Page, field: FormField, value: string): Promise<void> {
  const filed = page.waitForRequest(r => UPLOAD.test(r.url()), { timeout: 300 }).then(
    () => page.waitForResponse(r => FILE_SAVE.test(r.url()), { timeout: 60_000 }).then(r => r.ok(), () => false),
    () => true);
  await fillField(page, field, value);
  if (!(await filed)) throw new Error("Ashby did not file this upload on the form (the submit would say it is missing)");
}

/** Ashby: .ashby-application-form-field-entry rows, yes/no buttons, async location combobox, EEO survey radios. */
export const ashby = makeAdapter({
  name: "ashby",
  matches: isAshby,
  applyUrl(job: Job) {
    const u = job.applyUrl || job.url;
    return isAshby(u) && !/\/application\/?$/.test(u) ? `${u.replace(/\/$/, "")}/application` : u;
  },
  async prepare(page) {
    watchSaves(page); // before the scan, which opens comboboxes
    // The posting opens on the overview tab on some boards.
    const tab = page.locator("#job-application-form");
    if (await tab.count()) await tab.first().click().catch(() => {});
    // The form body is fetched after load ("Fetching application form").
    await page.locator(".ashby-application-form-field-entry").first().waitFor({ timeout: 20_000 }).catch(() => {});
  },
  scan: {
    root: "#form, .ashby-application-form-container",
    container: ".ashby-application-form-field-entry, fieldset.ashby-application-form-input-radio-group, fieldset.ashby-application-form-input-checkbox-group",
    labelSel: ".ashby-application-form-question-title",
    skip: "[class*='ashby-application-form-autofill'], [name='communicationConsent']",
    requiredSel: ".ashby-application-form-question-title[class*='_required']",
    yesno: ".ashby-application-form-input-yesno",
  },
  async fill(page, field, value) {
    const s = watchSaves(page);
    s.sent.clear();
    await (field.type === "file" ? fillUpload(page, field, value) : fillField(page, field, value));
    if (["text", "textarea", "email", "tel", "url", "number"].includes(field.type)) {
      await page.locator(`[data-oa-key="${field.key}"]`).first().blur(); // text saves on blur (or after a pause)
    }
    await saved(s);
    // What the field sent must be on the server: a yes/no exactly, any other answer at least set.
    for (const [path, sent] of s.sent) {
      if (!s.stored?.has(path)) continue; // not on this reply's form (the EEO survey is a form of its own)
      const kept = s.stored.get(path);
      if (sent == null || kept == null || kept === "" || (typeof sent === "boolean" && kept !== sent)) {
        throw new Error("Ashby's server did not keep this answer (the page shows it, but the submit would say it is missing)");
      }
    }
    return true;
  },
  submitSel: ".ashby-application-form-submit-button",
  successSel: ".ashby-application-form-success-container",
});
