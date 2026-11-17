#!/usr/bin/env node
// Build a static copy of the dashboard that always runs on the fixture data in ui/demo-data.js.
// Usage: node scripts/build-demo.mjs <out-dir>
// The output is five plain files with relative paths, so it can be served from any folder of a static host.
// Nothing in it talks to a server: the page is pinned to ?demo=1, where every request is answered in memory.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = process.argv[2];
if (!out) { console.error("usage: node scripts/build-demo.mjs <out-dir>"); process.exit(1); }
const ui = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
const dest = resolve(out);
mkdirSync(dest, { recursive: true });
for (const f of ["app.css", "app.js", "demo-data.js", "favicon.svg"]) copyFileSync(join(ui, f), join(dest, f));

const pin = `<script>if(new URLSearchParams(location.search).get("demo")!=="1"){const u=new URL(location.href);u.searchParams.set("demo","1");history.replaceState(null,"",u);}</script>`;
let html = readFileSync(join(ui, "index.html"), "utf8");
const swaps = [
  ["<title>OpenApply</title>", "<title>OpenApply demo</title>\n  <meta name=\"robots\" content=\"noindex\">"],
  ["  <script type=\"module\" src=\"app.js\"></script>", `  ${pin}\n  <script type="module" src="app.js"></script>`],
];
for (const [from, to] of swaps) {
  if (!html.includes(from)) { console.error(`ui/index.html changed: cannot find ${from}`); process.exit(1); }
  html = html.replace(from, to);
}
writeFileSync(join(dest, "index.html"), html);
console.log(`demo written to ${dest}`);
