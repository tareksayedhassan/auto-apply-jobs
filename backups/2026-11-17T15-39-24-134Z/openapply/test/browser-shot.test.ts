// fullPageShot in a real, headed browser (Dia, Chrome for Testing, any Chromium). Skipped unless
// OPENAPPLY_TEST_BROWSER_PATH names the browser binary, e.g.
//   OPENAPPLY_TEST_BROWSER_PATH=/Applications/Dia.app/Contents/MacOS/Dia node --import tsx --test test/browser-shot.test.ts
// It opens a window on a throwaway profile in the temp dir, never the fill profile in ~/.openapply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-shot-home-"));
const { fullPageShot } = await import("../src/apply/browser.js");

const exe = process.env.OPENAPPLY_TEST_BROWSER_PATH;
const FORM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ats", "odd-form.html"), "utf8");

test("fullPageShot: odd and even pages, both window widths, whole page from the first capture", { skip: !exe && "set OPENAPPLY_TEST_BROWSER_PATH" }, async () => {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "oa-shot-profile-")), {
    headless: false, executablePath: exe, viewport: { width: 1280, height: 900 }, timeout: 60_000,
    args: ["--use-mock-keychain", "--password-store=basic", "--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await ctx.newPage();
    let fallbacks = 0;
    const open = ctx.newCDPSession.bind(ctx);
    ctx.newCDPSession = (p: any) => { fallbacks++; return open(p); };
    const got: string[] = [], want: string[] = [];
    for (const width of [1280, 1265]) {
      await page.setViewportSize({ width, height: 900 });
      for (const h of [0, 1001, 1002, 7995, 12137]) {
        await page.setContent(h ? `<body style="margin:0"><div style="height:${h}px;background:linear-gradient(#fff,#999)"></div></body>` : FORM);
        const height = h || 2237;
        // The page's own width, not the viewport's: a classic scrollbar (macOS "Automatic" with a mouse) takes 15 px.
        const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const png = await fullPageShot(page);
        got.push(`${width}x${height}: ${png?.length ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : "empty"}`);
        want.push(`${width}x${height}: ${pageWidth - (pageWidth % 2)}x${height - (height % 2)}`);
      }
    }
    assert.deepEqual(got, want);
    assert.equal(fallbacks, 0, "the fresh-session fallback was never needed");
  } finally {
    await ctx.close();
  }
});
