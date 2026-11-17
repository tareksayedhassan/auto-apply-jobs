import type { Page } from "playwright";

export type AdapterName = "greenhouse" | "lever" | "ashby" | "generic";
const NAMES: AdapterName[] = ["greenhouse", "lever", "ashby", "generic"];

function host(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export function isGreenhouse(url: string): boolean {
  const h = host(url);
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(h)) return true;
  try { return new URL(url).searchParams.has("gh_jid"); } catch { return false; }
}
export const isLever = (url: string) => /^jobs(\.eu)?\.lever\.co$/.test(host(url));
export const isAshby = (url: string) => host(url) === "jobs.ashbyhq.com";
export const isWorkday = (url: string) => /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/.test(host(url));

/** Which adapter drives a form URL. OPENAPPLY_ADAPTER forces one (tests use it for local fixtures). */
export function adapterFor(url: string): AdapterName {
  const forced = process.env.OPENAPPLY_ADAPTER as AdapterName | undefined;
  if (forced && NAMES.includes(forced)) return forced;
  if (isGreenhouse(url)) return "greenhouse";
  if (isLever(url)) return "lever";
  if (isAshby(url)) return "ashby";
  return "generic";
}

const GH_FRAME = '#grnhse_app iframe, iframe[src*="greenhouse.io/embed/job_app"], iframe[src*="greenhouse.io/embed/job_board"]';

/**
 * Company career pages often embed the Greenhouse form in an iframe (#grnhse_app).
 * If so, navigate the page to the iframe's own URL and drive it as Greenhouse.
 */
export async function refineForPage(page: Page, name: AdapterName): Promise<AdapterName> {
  if (name !== "generic" || process.env.OPENAPPLY_ADAPTER) return name;
  const src = await page.locator(GH_FRAME).first().getAttribute("src", { timeout: 1500 }).catch(() => null);
  if (!src) return name;
  await page.goto(new URL(src, page.url()).href, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  return "greenhouse";
}
