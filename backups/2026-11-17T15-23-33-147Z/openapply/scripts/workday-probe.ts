/**
 * workday-probe.ts: find Workday career sites in the lists OpenApply already has and check them live.
 *
 * Candidates, in this order, deduped: every myworkdayjobs.com URL in scripts/seed-candidates/* ("Company | URL" lines
 * name the company), the "workday" boards in data/boards.json and ~/.openapply/boards.json, and with --index the
 * Workday links inside postings already in the local index (OPENAPPLY_HOME).
 *
 * Each board gets one CXS list request (its open-role count), one at a time, 400 ms apart through the shared
 * Workday gate; a 429 is retried by getJson and then once more after a 30 s pause.
 *
 *   npx tsx scripts/workday-probe.ts                 # probe at most 30 boards, print counts
 *   npx tsx scripts/workday-probe.ts --max 10
 *   npx tsx scripts/workday-probe.ts --full          # also page through each live board (fetchBoard) and count rows
 *   npx tsx scripts/workday-probe.ts --index         # add Workday links found in the local index (reads OPENAPPLY_HOME)
 *   npx tsx scripts/workday-probe.ts --write         # merge live boards into data/boards.json under "workday"
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBoard, workdaySlugsIn, workdayTotal } from "../src/sources/workday.js";
import { NotFoundError } from "../src/sources/http.js";
import { loadBoards } from "../src/sources/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAND_DIR = join(ROOT, "scripts", "seed-candidates");
const OUT_PATH = join(ROOT, "data", "boards.json");
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MAX = Number(opt("max", "30"));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const candidates = new Map<string, { company?: string; from: string }>();
const add = (slug: string, company: string | undefined, from: string) => {
  const had = candidates.get(slug);
  if (!had) candidates.set(slug, { company, from });
  else if (!had.company && company) had.company = company;
};

for (const f of readdirSync(CAND_DIR).sort()) {
  const text = readFileSync(join(CAND_DIR, f), "utf8");
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const label = line.includes("|") ? line.split("|")[0].trim() : "";
    for (const slug of workdaySlugsIn(line)) add(slug, label && !/myworkdayjobs/i.test(label) ? label : undefined, `seed-candidates/${f}`);
  }
}
for (const b of loadBoards()) if (b.ats === "workday") add(b.slug, b.company, "boards.json");
if (flag("index")) {
  const { workdayBoardsFromIndex } = await import("../src/discover.js");
  const found = workdayBoardsFromIndex();
  console.error(`index: ${found.length} Workday board(s) linked from postings`);
  for (const b of found) add(b.slug, b.company, "index");
}

const list = [...candidates.entries()].slice(0, MAX);
console.error(`${candidates.size} Workday candidate board(s); probing ${list.length}, one at a time\n`);

type Row = { slug: string; company?: string; status: string; total: number; rows?: number; ms: number };
const rows: Row[] = [];
for (const [slug, c] of list) {
  const t0 = Date.now();
  let row: Row = { slug, company: c.company, status: "?", total: 0, ms: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const total = await workdayTotal(slug);
      row = { ...row, status: total > 0 ? "live" : "empty", total };
      if (flag("full") && total > 0) row.rows = (await fetchBoard(slug)).length;
      break;
    } catch (e) {
      if (e instanceof NotFoundError) { row.status = "not found"; break; }
      const m = e instanceof Error ? e.message : String(e);
      row.status = `error: ${m.slice(0, 80)}`;
      if (/HTTP 429/.test(m) && attempt === 0) { console.error(`  429 on ${slug}: pausing 30 s`); await sleep(30_000); continue; }
      break;
    }
  }
  row.ms = Date.now() - t0;
  rows.push(row);
  console.log(`${row.status.padEnd(10)} ${String(row.total).padStart(5)}${row.rows !== undefined ? ` (${row.rows} fetched)` : ""}  ${slug}  ${c.company ?? ""}  [${c.from}] ${row.ms}ms`);
}

const live = rows.filter(r => r.status === "live");
const sum = live.reduce((s, r) => s + r.total, 0);
const capped = live.filter(r => r.total === 2000).length;
console.log(`\nprobed ${rows.length}: live ${live.length}, empty ${rows.filter(r => r.status === "empty").length}, not found ${rows.filter(r => r.status === "not found").length}, errors ${rows.filter(r => r.status.startsWith("error")).length}`);
console.log(`open roles reported: ${sum}${capped ? ` (${capped} board(s) report exactly 2000, which can mean more)` : ""}`);
if (flag("full")) console.log(`rows fetched: ${live.reduce((s, r) => s + (r.rows ?? 0), 0)} (each board capped at 1000)`);

if (flag("write")) {
  const data = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  const prev: Array<{ slug: string; company?: string; jobs?: number }> = Array.isArray(data.workday) ? data.workday : [];
  const merged = new Map(prev.map(e => [e.slug, e]));
  for (const r of live) merged.set(r.slug, { slug: r.slug, company: r.company ?? merged.get(r.slug)?.company ?? r.slug.split(".")[0], jobs: r.total });
  data.workday = [...merged.values()].sort((a, b) => (b.jobs ?? 0) - (a.jobs ?? 0) || a.slug.localeCompare(b.slug));
  data._counts = { ...data._counts, workday: data.workday.length };
  writeFileSync(OUT_PATH, JSON.stringify(data));
  console.error(`wrote ${data.workday.length} Workday board(s) to ${OUT_PATH}`);
}
