import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Browser } from "playwright";

let browser: Promise<Browser> | undefined;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = import("playwright").then(pw => pw.chromium.launch({ headless: true }));
    browser.catch(() => { browser = undefined; });
  }
  const b = await browser;
  if (!b.isConnected()) { browser = undefined; return getBrowser(); }
  return b;
}

/** Render HTML to a Letter PDF at outPath. Returns the page count. */
export async function htmlToPdf(html: string, outPath: string): Promise<{ pages: number }> {
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    const buf = await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buf);
    return { pages: await countPages(buf) };
  } finally {
    await page.close();
  }
}

async function countPages(buf: Uint8Array): Promise<number> {
  const { getDocumentProxy } = await import("unpdf");
  return (await getDocumentProxy(new Uint8Array(buf))).numPages;
}

const TEX_ENGINES = ["tectonic", "pdflatex", "xelatex", "lualatex"];
const TEX_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/Library/TeX/texbin"];

/** The TeX engine to build LaTeX with: OPENAPPLY_TEX (a path, or "off"), else tectonic or a TeX Live engine on PATH or in the usual install dirs. */
export function texEngine(): string | undefined {
  const env = process.env.OPENAPPLY_TEX;
  if (env) return env === "off" ? undefined : env;
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...TEX_DIRS];
  for (const e of TEX_ENGINES) for (const d of dirs) if (existsSync(join(d, e))) return join(d, e);
  return undefined;
}

/** Compile a LaTeX document to a PDF at outPath in a throwaway temp dir. Throws when no engine is found, the build fails, a glyph is missing or it times out. */
export async function texToPdf(tex: string, outPath: string, timeoutMs = 60_000): Promise<{ pages: number }> {
  const engine = texEngine();
  if (!engine) throw new Error("no TeX engine found; install tectonic");
  const dir = mkdtempSync(join(tmpdir(), "openapply-tex-"));
  try {
    writeFileSync(join(dir, "letter.tex"), tex);
    const args = basename(engine).startsWith("tectonic")
      ? ["-X", "compile", "--outdir", dir, "letter.tex"]
      : ["-interaction=nonstopmode", "-halt-on-error", `-output-directory=${dir}`, "letter.tex"];
    const { stdout, stderr } = await promisify(execFile)(engine, args, { cwd: dir, timeout: timeoutMs }).catch((e: { stdout?: string; stderr?: string; killed?: boolean; message: string }) => {
      const line = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.split("\n").find(l => /^(!|error:)/.test(l));
      throw new Error(`${basename(engine)} failed: ${e.killed ? `timed out after ${timeoutMs / 1000}s` : (line ?? e.message).slice(0, 200)}`);
    });
    // XeTeX drops a glyph the font lacks with only a warning; refuse rather than ship a PDF with holes in it
    const lost = [...new Set([...`${stdout}\n${stderr}`.matchAll(/Missing character: There is no .*?\(U\+([0-9A-F]+)\)/g)].map(m => m[1]))];
    if (lost.length) throw new Error(`the font has no glyph for ${lost.map(h => `${String.fromCodePoint(parseInt(h, 16))} U+${h}`).join(", ")}`);
    const buf = readFileSync(join(dir, "letter.pdf"));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buf);
    return { pages: await countPages(buf) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function closePdfBrowser(): Promise<void> {
  const b = browser;
  browser = undefined;
  if (b) await (await b).close().catch(() => {});
}
