import { execFileSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ensureHome, paths } from "../paths.js";

/** Main browser processes on our profile: { pid, orphan } where orphan means its OpenApply process is gone. */
function profileHolders(): Array<{ pid: number; orphan: boolean }> {
  let out = "";
  try { out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }); } catch { return []; }
  return out.split("\n").flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || /\s--type=/.test(m[3]) || !m[3].includes(`--user-data-dir=${paths.browserProfile}`)) return [];
    return [{ pid: Number(m[1]), orphan: m[2] === "1" && m[3].includes("--remote-debugging-pipe") }];
  });
}

/**
 * A launch while another browser holds the profile hands off to it ("Opening in existing browser session") and
 * never connects. Quit a window a dead OpenApply process left behind, wait for one that is closing, and say so
 * plainly when another live process (e.g. an agent's MCP server) is using the profile.
 */
async function freeProfile(): Promise<void> {
  for (const h of profileHolders()) if (h.orphan) { try { process.kill(h.pid, "SIGTERM"); } catch { /* already gone */ } }
  for (let i = 0; i < 60 && profileHolders().length; i++) await new Promise(r => setTimeout(r, 500));
  const left = profileHolders();
  if (left.length) throw new Error(`Another browser window is using the OpenApply profile (pid ${left.map(h => h.pid).join(", ")}). Close it (or the agent session that opened it), then fill again.`);
}

let ctx: Promise<BrowserContext> | null = null;
/** jobId -> the page holding that job's form, so fill and submit act on the same open page. */
const pages = new Map<string, Page>();
/** Tabs OpenApply opened. Anything else open right after launch is a tab the browser restored from its last run. */
const ours = new WeakSet<Page>();
/** Dia restores the last run's tabs over the first second or two after launch. */
const RESTORE_WINDOW_MS = 10_000;
let launchedAt = 0;
let swept = false;

/** Close restored tabs: those open now, and those that arrive within the restore window. Popups of our pages stay. */
function closeRestored(c: BrowserContext): void {
  const close = (p: Page) => {
    if (!ours.has(p)) void p.opener().then(o => o ? undefined : p.close()).catch(() => {});
  };
  c.pages().forEach(close);
  // A restored tab arrives with its URL; a tab opened by code (or the user's new tab) starts blank.
  const late = (p: Page) => Date.now() - launchedAt < RESTORE_WINDOW_MS ? p.url() !== "about:blank" && close(p) : c.off("page", late);
  c.on("page", late);
}

/**
 * On macOS a browser spawned straight from a launchd job (the dashboard's LaunchAgent) never answers Playwright's
 * control pipe; started through LaunchServices (`open`) it is up in about 2 s. OPENAPPLY_BROWSER_LAUNCH=open does
 * that and attaches over a DevTools port on 127.0.0.1, reusing a fill browser that is already running on it.
 */
const viaOpen = () => process.env.OPENAPPLY_BROWSER_LAUNCH === "open" && !!process.env.OPENAPPLY_BROWSER_PATH;
const CDP_PORT = Number(process.env.OPENAPPLY_CDP_PORT) || 9333;
let attached: Browser | null = null;
/**
 * The Playwright launch defaults that matter for this profile: its cookies were sealed with the mock keychain, and a
 * window behind others must not be throttled or its form stops answering.
 */
const OPEN_FLAGS = ["--use-mock-keychain", "--password-store=basic", "--disable-extensions", "--no-first-run",
  "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding", "--disable-hang-monitor"];

async function cdpUp(): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

async function openAndAttach(): Promise<BrowserContext> {
  if (!(await cdpUp())) {
    await freeProfile();
    const app = process.env.OPENAPPLY_BROWSER_PATH!.replace(/\/Contents\/MacOS\/[^/]+$/, "");
    execFileSync("open", ["-n", "-g", "-a", app, "--args", `--user-data-dir=${paths.browserProfile}`,
      `--remote-debugging-port=${CDP_PORT}`, ...OPEN_FLAGS]);
    for (let i = 0; i < 60 && !(await cdpUp()); i++) await new Promise(r => setTimeout(r, 1000));
  }
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 30_000 });
  attached = b;
  b.on("disconnected", () => { if (attached === b) { attached = null; ctx = null; pages.clear(); } });
  return b.contexts()[0];
}

function launchHere(): Promise<BrowserContext> {
  return freeProfile().then(() => chromium.launchPersistentContext(paths.browserProfile, {
    headless: process.env.OPENAPPLY_HEADLESS === "1",
    // Any Chromium-based browser (e.g. /Applications/Dia.app/Contents/MacOS/Dia); default is Playwright's Chromium.
    executablePath: process.env.OPENAPPLY_BROWSER_PATH || undefined,
    viewport: { width: 1280, height: 900 },
    timeout: 60_000, // Dia starts in ~7 s; a launch that has not connected by now is not going to
  })).then(c => { c.on("close", () => { ctx = null; pages.clear(); }); return c; });
}

/** Lazy singleton browser context. Headed unless OPENAPPLY_HEADLESS=1, so the user can watch and take over. */
export function browserContext(): Promise<BrowserContext> {
  if (!ctx) {
    ensureHome();
    ctx = (viaOpen() ? openAndAttach() : launchHere()).then(async c => {
      launchedAt = Date.now();
      swept = false;
      // tsx/esbuild wraps named inner functions in __name(); functions sent to page.evaluate need it defined.
      await c.addInitScript("globalThis.__name ??= (f) => f;");
      return c;
    }, e => { ctx = null; throw e; });
  }
  return ctx;
}

/** The open page for a job, if it is still alive. */
export function openPage(jobId: string): Page | undefined {
  const p = pages.get(jobId);
  if (p && !p.isClosed()) return p;
  pages.delete(jobId);
  return undefined;
}

/** Reuse the job's page (navigating only when it is elsewhere) or open a new tab. */
export async function pageFor(jobId: string, url: string): Promise<Page> {
  let page = openPage(jobId);
  if (!page) {
    const c = await browserContext();
    page = await c.newPage();
    // Attached over CDP the page takes the window's size, which `open -g` leaves at a phone-width 310 px.
    if (attached) await page.setViewportSize({ width: 1280, height: 900 });
    ours.add(page);
    pages.set(jobId, page);
    // Only once our tab exists, so closing every restored tab never leaves the window empty.
    if (!swept) { swept = true; closeRestored(c); }
  }
  if (page.url() !== url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  }
  return page;
}

/**
 * Full-page PNG, or undefined. Playwright pins the page at devicePixelRatio 1 while a retina window paints at 2, so
 * the capture is scaled down, and Dia answers a scaled capture whose image has an odd width or height with zero bytes
 * and no error (measured 2026-11-02: every odd height failed, every even one worked, up to 16000 CSS px). Most forms
 * are an odd number of px tall and the fill window is 1265 px wide beside a scrollbar, so the capture is clipped to
 * the even size at or under the page (at most 1 px short). The fallback, the same CDP call from a fresh session at the
 * window's own scale, needs no scaling but in Dia errors or never answers past about 8000 CSS px, so it gets a time
 * limit. The capture paints a sticky header where the page is scrolled to, so it starts from the top (else Ashby's
 * logo bar covers a question mid-page).
 */
export async function fullPageShot(page: Page, fallbackMs = 20_000): Promise<Buffer | undefined> {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  // Playwright's own full-page size, so its clip trimming never makes a side odd again.
  const size = await page.evaluate(() => {
    const b = document.body, d = document.documentElement;
    return b && d ? [Math.max(b.scrollWidth, d.scrollWidth, b.offsetWidth, d.offsetWidth, b.clientWidth, d.clientWidth),
      Math.max(b.scrollHeight, d.scrollHeight, b.offsetHeight, d.offsetHeight, b.clientHeight, d.clientHeight)] : undefined;
  }).catch(() => undefined);
  const even = (n: number) => Math.max(2, n - (n % 2));
  const clip = size && { x: 0, y: 0, width: even(size[0]), height: even(size[1]) };
  const png = await page.screenshot(clip ? { fullPage: true, clip } : { fullPage: true }).catch(() => undefined);
  if (png?.length) return png;
  const cdp = await page.context().newCDPSession(page).catch(() => undefined);
  if (!cdp) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<undefined>(r => { timer = setTimeout(r, fallbackMs, undefined); });
  const capture = (async () => {
    const { cssContentSize: s } = await cdp.send("Page.getLayoutMetrics");
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(s.width), height: Math.ceil(s.height), scale: 1 },
    });
    return data ? Buffer.from(data, "base64") : undefined;
  })().catch(() => undefined);
  try {
    return await Promise.race([capture, gaveUp]);
  } finally {
    clearTimeout(timer);
    await cdp.detach().catch(() => {});
  }
}

/** Close a job's tab once nothing is left to do in it (submitted). */
export async function closePage(jobId: string): Promise<void> {
  const p = openPage(jobId);
  pages.delete(jobId);
  await p?.close().catch(() => {});
}

export async function closeBrowser(): Promise<void> {
  const c = ctx;
  ctx = null;
  pages.clear();
  if (attached) {
    // Attached over CDP: disconnecting leaves the window up, so quit the browser on our profile and wait it out.
    const b = attached;
    attached = null;
    await b.close().catch(() => {});
    for (const h of profileHolders()) { try { process.kill(h.pid, "SIGTERM"); } catch { /* already gone */ } }
    for (let i = 0; i < 30 && profileHolders().length; i++) await new Promise(r => setTimeout(r, 500));
    return;
  }
  if (c) await (await c.catch(() => undefined))?.close().catch(() => {});
}
