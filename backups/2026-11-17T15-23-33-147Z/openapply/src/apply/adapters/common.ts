import type { Locator, Page } from "playwright";
import type { FormField, Job } from "../../types.js";
import { bestOption, bestPlace, exactOption, pickOptions } from "../fieldmap.js";

export interface Adapter {
  name: string;
  matches(url: string): boolean;
  /** e.g. lever: `${url}/apply` */
  applyUrl(job: Job): string;
  discover(page: Page): Promise<FormField[]>;
  fill(page: Page, field: FormField, value: string, files: { resume?: string; cover?: string }): Promise<void>;
  submit(page: Page): Promise<void>;
  /** Thank-you page / success message. */
  confirmSubmitted(page: Page): Promise<boolean>;
  /** Only confirmSubmitted counts as success (no generic thank-you heuristics). */
  strictSuccess?: boolean;
  /** After submit: why the ATS rejected the submission it was sent (e.g. Lever's verification banner), or null. */
  submitRejected?(page: Page): Promise<string | null>;
}

/** Selectors that describe one ATS's form layout to the shared scanner. */
export interface ScanConfig {
  /** Candidate form roots; the one holding the most controls wins. */
  root: string;
  /** One question's wrapper. Radios/checkboxes inside one wrapper form one group. */
  container: string;
  /** Question label inside a wrapper, tried before label[for]. */
  labelSel: string;
  /** Controls to ignore (and anything inside a match). */
  skip?: string;
  /** Wrapper marked required (besides required/aria-required/asterisk). */
  requiredSel?: string;
  /** Custom yes/no button groups (Ashby). */
  yesno?: string;
}

/**
 * Runs in the page. Finds every question, tags its control(s) with data-oa-key and
 * returns FormFields. Self-contained: Playwright serializes it.
 */
function scan(cfg: ScanConfig): FormField[] {
  const clean = (s: string | null | undefined) => (s || "").replace(/[*✱]/g, "").replace(/\s+/g, " ").trim();
  const roots = Array.from(document.querySelectorAll(cfg.root));
  const count = (e: Element) => e.querySelectorAll("input, select, textarea").length;
  const root = roots.sort((a, b) => count(b) - count(a))[0] || document.body;
  const out: FormField[] = [];
  const at: Element[] = [];
  // Rescans re-key from scratch in DOM order, so keys stay stable between inspect and fill.
  document.querySelectorAll("[data-oa-key]").forEach(e => e.removeAttribute("data-oa-key"));
  let n = 0;
  const nextKey = () => `oa-${++n}`;
  const skipped = (el: Element) => !!cfg.skip && !!el.closest(cfg.skip);

  const rawLabel = (el: Element): string => {
    const c = el.closest(cfg.container);
    const own = c && cfg.labelSel ? c.querySelector(cfg.labelSel) : null;
    if (own && clean(own.textContent)) return own.textContent || "";
    if (el.id) {
      const lf = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lf && clean(lf.textContent)) return lf.textContent || "";
    }
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ");
      if (clean(t)) return t;
    }
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label") || "";
    const wrap = el.closest("label");
    if (wrap && clean(wrap.textContent)) return wrap.textContent || "";
    const any = c?.querySelector("label, legend");
    if (any && clean(any.textContent)) return any.textContent || "";
    return el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "";
  };
  const isRequired = (el: Element, raw: string) => {
    const c = el.closest(cfg.container);
    return (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" ||
      /[*✱]/.test(raw) || !!(c && cfg.requiredSel && c.matches(cfg.requiredSel)) ||
      !!(c && cfg.requiredSel && c.querySelector(cfg.requiredSel));
  };
  const optionText = (inp: Element) => {
    if (inp.id) {
      const l = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
      if (l && clean(l.textContent)) return clean(l.textContent);
    }
    const w = inp.closest("label");
    if (w && clean(w.textContent)) return clean(w.textContent);
    return clean((inp as HTMLInputElement).value) || clean(inp.getAttribute("name"));
  };

  if (cfg.yesno) {
    for (const g of Array.from(root.querySelectorAll(cfg.yesno))) {
      if (g.hasAttribute("data-oa-key")) continue;
      const key = nextKey();
      g.setAttribute("data-oa-key", key);
      const raw = rawLabel(g);
      at.push(g);
      out.push({ key, label: clean(raw), type: "radio", required: isRequired(g, raw),
        options: Array.from(g.querySelectorAll("button")).map(b => clean(b.textContent)) });
    }
  }

  const groups = new Map<Element | string, HTMLInputElement[]>();
  for (const el of Array.from(root.querySelectorAll("input, select, textarea")) as HTMLInputElement[]) {
    if (el.hasAttribute("data-oa-key") || skipped(el) || (cfg.yesno && el.closest(cfg.yesno))) continue;
    const tag = el.tagName.toLowerCase();
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "input" && ["hidden", "submit", "button", "reset", "image", "search"].includes(t)) continue;
    if (t === "radio" || t === "checkbox") {
      const g = el.closest(cfg.container) || el.name || el.id;
      groups.set(g, [...(groups.get(g) || []), el]);
      continue;
    }
    if (t !== "file" && (el.getAttribute("aria-hidden") === "true" || !el.getClientRects().length)) continue;
    const raw = rawLabel(el);
    const key = nextKey();
    el.setAttribute("data-oa-key", key);
    const f: FormField = { key, label: clean(raw), type: "text", required: isRequired(el, raw) };
    if (tag === "textarea") f.type = "textarea";
    else if (tag === "select") {
      f.type = "select";
      f.options = Array.from((el as unknown as HTMLSelectElement).options)
        .filter(o => o.value !== "" && !/^(select|choose|--|please select)/i.test(clean(o.text)))
        .map(o => clean(o.text));
    } else if (t === "file") f.type = "file";
    else if (el.getAttribute("role") === "combobox") f.type = "combobox";
    else if (el.closest(".react-datepicker__input-container")) f.type = "date"; // a text input (Ashby "Pick date...")
    else if (["email", "tel", "url", "number", "date"].includes(t)) f.type = t as FormField["type"];
    at.push(el);
    out.push(f);
  }
  for (const inputs of groups.values()) {
    const key = nextKey();
    inputs.forEach(i => i.setAttribute("data-oa-key", key));
    const first = inputs[0];
    // Question label from the wrapper (or its legend); a lone unwrapped checkbox ("I agree...") uses its own text.
    const c = first.closest(cfg.container);
    const legend = c?.querySelector(cfg.labelSel || "legend") || c?.querySelector("legend");
    const raw = legend && clean(legend.textContent) ? legend.textContent || ""
      : c || inputs.length > 1 ? rawLabel(first) : optionText(first);
    at.push(first);
    out.push({
      key, label: clean(raw) || optionText(first),
      type: first.type === "radio" ? "radio" : "checkbox",
      required: inputs.some(i => isRequired(i, raw)),
      options: inputs.map(optionText),
    });
  }
  // DOM order, so fields read top to bottom like the form.
  return out.map((f, i) => [f, at[i]] as const)
    .sort((a, b) => a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
    .map(([f]) => f);
}

/** Visible listbox options, scoped to the combobox's aria-controls when it has one. */
async function visibleOptions(page: Page, input: Locator, optionSel: string, waitMs: number): Promise<Locator[]> {
  const end = Date.now() + waitMs;
  for (;;) {
    const ctl = await input.getAttribute("aria-controls").catch(() => null);
    const scope = ctl ? page.locator(`[id="${ctl}"]`) : page.locator("body");
    const opts = await scope.locator(optionSel).filter({ visible: true }).all();
    if (opts.length || Date.now() > end) return opts;
    await page.waitForTimeout(150);
  }
}

async function optionTexts(opts: Locator[]): Promise<string[]> {
  return Promise.all(opts.map(async o => (await o.innerText()).replace(/\s+/g, " ").trim()));
}

/** Open a static dropdown and read its options (react-select style). Empty for async autocompletes. */
export async function readComboOptions(page: Page, input: Locator, optionSel = '[role="option"]'): Promise<string[]> {
  await input.click({ timeout: 3000 }).catch(() => {});
  const texts = await optionTexts(await visibleOptions(page, input, optionSel, 600));
  await input.press("Escape").catch(() => {});
  return texts.filter(Boolean);
}

/**
 * React-select / autocomplete: type, then click the closest option. Static lists must match;
 * async autocompletes (location) need a real place match (see bestPlace). Some widgets only react to
 * real keystrokes (Lever), so typing falls back from fill() to key presses, then to the first segment.
 * `exact` takes only the result that reads like the value (a school: a neighbour is a different school).
 */
export async function fillCombobox(page: Page, input: Locator, value: string, hasStaticOptions: boolean, optionSel = '[role="option"]', exact = false): Promise<void> {
  const wait = hasStaticOptions ? 1500 : 4000;
  const attempts: Array<() => Promise<void>> = [
    () => input.fill(value),
    async () => { await input.fill(""); await input.pressSequentially(value, { delay: 40 }); },
  ];
  if (!hasStaticOptions && value.includes(",")) {
    attempts.push(async () => { await input.fill(""); await input.pressSequentially(value.split(",")[0], { delay: 40 }); });
  }
  if (hasStaticOptions) attempts.push(() => input.fill(""));
  await input.click();
  let opts: Locator[] = [];
  for (const attempt of attempts) {
    await attempt();
    opts = await visibleOptions(page, input, optionSel, wait);
    if (opts.length) break;
  }
  const texts = await optionTexts(opts);
  const pick = exact ? exactOption : hasStaticOptions ? bestOption : bestPlace;
  const i = texts.indexOf(pick(texts, value) ?? "\u0000");
  if (i < 0) {
    await input.fill("").catch(() => {});
    await input.press("Escape").catch(() => {});
    throw new Error(texts.length ? `no option matching "${value}"` : `no suggestions for "${value}"`);
  }
  await opts[i].click();
}

const TRUTHY = /^(yes|y|true|1|checked|agree|i agree)$/i;

/** Radio / checkbox group (or Ashby yes/no buttons): click the option(s) matching value. */
async function fillChoice(loc: Locator, field: FormField, value: string): Promise<void> {
  const opts = field.options ?? [];
  const first = loc.first();
  const isButtons = (await loc.count()) === 1 && (await first.evaluate(e => e.tagName !== "INPUT"));
  if (isButtons) {
    const i = opts.indexOf(bestOption(opts, value) ?? "\u0000");
    if (i < 0) throw new Error(`no option matching "${value}"`);
    const button = first.locator("button").nth(i);
    if ((await button.getAttribute("aria-pressed")) !== "true") await button.click(); // clicking it again clears the answer
    return;
  }
  const picks = field.type === "checkbox" && opts.length <= 1
    ? (TRUTHY.test(value.trim()) ? [0] : [])
    : (field.type === "checkbox" ? pickOptions(opts, value) : [bestOption(opts, value) ?? "\u0000"]).map(o => opts.indexOf(o));
  if (!picks.length || picks.some(i => i < 0)) throw new Error(`no option matching "${value}"`);
  for (const i of picks) {
    const inp = loc.nth(i);
    if (await inp.isChecked()) continue;
    await inp.check({ force: true }).catch(async () => {
      const id = await inp.getAttribute("id");
      await (id ? loc.page().locator(`label[for="${id}"]`) : inp.locator("xpath=ancestor::label[1]")).click();
    });
  }
}

/**
 * A date field gets the YYYY-MM-DD date fieldmap made. A native date input takes it as is. A text date picker
 * (react-datepicker) is typed in its display format, MM/DD/YYYY (ISO typed there lands a day early), and read back
 * after blur, because the picker redraws the text from what it parsed and clears what it could not.
 */
async function fillDate(el: Locator, iso: string): Promise<void> {
  if ((await el.getAttribute("type")) === "date") return el.fill(iso);
  const typed = iso.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1");
  await el.fill(typed);
  await el.press("Escape"); // closes the calendar so it does not cover the next field
  await el.blur();
  const shown = await el.inputValue();
  if (shown !== typed) throw new Error(`the date picker shows "${shown}" after typing ${typed}`);
}

/** Default fill for any scanned field. */
export async function fillField(page: Page, field: FormField, value: string): Promise<void> {
  const loc = page.locator(`[data-oa-key="${field.key}"]`);
  const el = loc.first();
  switch (field.type) {
    case "file": return el.setInputFiles(value);
    case "select": {
      const label = bestOption(field.options ?? [], value) ?? value;
      await el.selectOption({ label });
      return;
    }
    case "combobox": return fillCombobox(page, el, value, !!field.options?.length);
    case "date": return fillDate(el, value);
    case "radio":
    case "checkbox": return fillChoice(loc, field, value);
    default:
      await el.fill(value);
  }
}

const THANKS = /thank you for (applying|your application|your interest|submitting)|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully submitted/i;

/** Success text visible on the page (body text only, not scripts). */
export async function thankYouVisible(page: Page): Promise<boolean> {
  const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  return THANKS.test(text);
}

export interface AdapterSpec {
  name: string;
  matches(url: string): boolean;
  applyUrl?(job: Job): string;
  scan: ScanConfig;
  submitSel: string;
  /** Selector that only exists on the success state. */
  successSel?: string;
  /** URL pattern of the success page. */
  successUrl?: RegExp;
  /** Text visible only on the success state. */
  successText?: RegExp;
  /** See Adapter.strictSuccess. */
  strictSuccess?: boolean;
  /** See Adapter.submitRejected. */
  submitRejected?(page: Page): Promise<string | null>;
  /** Comboboxes whose label matches are search-backed (Greenhouse School): the open menu shows only the first page of a huge list, so no options are recorded and the fill types the value to search. */
  searchLabel?: RegExp;
  /** Runs before scanning (e.g. hop into an embedded iframe URL). */
  prepare?(page: Page): Promise<void>;
  /** Adapter-specific fill; return false to fall back to fillField. */
  fill?(page: Page, field: FormField, value: string): Promise<boolean>;
}

export function makeAdapter(spec: AdapterSpec): Adapter {
  return {
    name: spec.name,
    matches: spec.matches,
    applyUrl: job => spec.applyUrl?.(job) ?? job.applyUrl ?? job.url,
    async discover(page) {
      await spec.prepare?.(page);
      await page.locator(spec.scan.root).first().waitFor({ timeout: 15_000 }).catch(() => {});
      const fields = await page.evaluate(scan, spec.scan);
      for (const f of fields) {
        if (f.type !== "combobox" || spec.searchLabel?.test(f.label)) continue;
        const opts = await readComboOptions(page, page.locator(`[data-oa-key="${f.key}"]`));
        if (opts.length) f.options = opts;
      }
      return fields;
    },
    async fill(page, field, value) {
      if (spec.fill && (await spec.fill(page, field, value))) return;
      if (field.type === "combobox" && spec.searchLabel?.test(field.label)) {
        return fillCombobox(page, page.locator(`[data-oa-key="${field.key}"]`).first(), value, false, undefined, true);
      }
      await fillField(page, field, value);
    },
    async submit(page) {
      await page.locator(spec.submitSel).filter({ visible: true }).first().click();
    },
    async confirmSubmitted(page) {
      if (spec.successUrl?.test(page.url())) return true;
      if (spec.successSel && (await page.locator(spec.successSel).filter({ visible: true }).count())) return true;
      if (spec.successText) return spec.successText.test(await page.locator("body").innerText({ timeout: 2000 }).catch(() => ""));
      return false;
    },
    strictSuccess: spec.strictSuccess,
    submitRejected: spec.submitRejected,
  };
}
