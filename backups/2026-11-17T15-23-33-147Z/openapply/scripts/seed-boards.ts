/**
 * seed-boards.ts: builds data/boards.json, the bundled registry of VERIFIED live
 * company job boards on public ATS APIs (greenhouse, lever, ashby, workable,
 * recruitee, smartrecruiters). An entry is only written if the board's public
 * endpoint answered 200 with at least one open job at verification time.
 *
 * Usage:
 *   npx tsx scripts/seed-boards.ts                 # incremental: probe only what the cache lacks
 *   npx tsx scripts/seed-boards.ts --refresh       # ignore cache age, re-probe everything
 *   npx tsx scripts/seed-boards.ts --ttl-days 3    # re-probe cache entries older than 3 days (default 7)
 *   npx tsx scripts/seed-boards.ts --only ashby,lever
 *   npx tsx scripts/seed-boards.ts --limit 500     # probe at most N new pairs (smoke test)
 *   npx tsx scripts/seed-boards.ts --concurrency 32
 *   npx tsx scripts/seed-boards.ts --rebuild       # no network: rebuild data/boards.json from cache
 *
 * Candidates (add your own files; all are merged and deduped) in scripts/seed-candidates/:
 *   *.txt   one company name per line (# comments ok), or an ATS URL such as
 *           https://boards.greenhouse.io/stripe, or "ats:slug" (e.g. lever:plaid)
 *   *.json  {"greenhouse": ["slug", ...], "lever": [...], ...}  (exact slugs, tried on the ATS named by the key only)
 *           or [{"name": "Retool", "website": "https://retool.com"}, ...]  (slugs derived from name/domain)
 *           or ["Company name", ...]
 *
 * For every company name up to ~5 slug variants are derived (joined, hyphenated, first word,
 * domain label, suffix-stripped) and every ATS is tried. Probes use a ~24-wide pool, a 10s
 * timeout and one retry with backoff on 429/5xx. Results are cached in test/.tmp/probe-cache.json,
 * so reruns only touch new candidates or stale entries. All endpoints are public JSON.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAND_DIR = join(ROOT, "scripts", "seed-candidates");
const CACHE_PATH = join(ROOT, "test", ".tmp", "probe-cache.json");
const OUT_PATH = join(ROOT, "data", "boards.json");
const UA = "OpenApply/0.1 (+https://github.com/nturl/openapply)";

const ATSES = ["greenhouse", "lever", "ashby", "workable", "recruitee", "smartrecruiters"] as const;
type A = (typeof ATSES)[number];

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const CONCURRENCY = Number(opt("concurrency", "24"));
const TTL_MS = Number(opt("ttl-days", "7")) * 86400_000;
const LIMIT = Number(opt("limit", "0"));
const ONLY = new Set(opt("only", ATSES.join(",")).split(",") as A[]);

// ---------- cache ----------
interface Entry { j: number; n?: string; t: number } // j = open jobs (0 = miss/empty)
let cache: Record<string, Entry> = {};
if (existsSync(CACHE_PATH)) {
  try { cache = JSON.parse(readFileSync(CACHE_PATH, "utf8")); } catch { cache = {}; }
}
function saveCache() {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

// ---------- candidate loading ----------
const slugHints = new Map<string, string>(); // slug -> company name hint
const pairs = new Map<string, [A, string]>(); // "ats|slug" -> pair
const addPair = (a: A, slug: string) => {
  if (!ONLY.has(a) || !slug || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/.test(slug)) return;
  pairs.set(`${a}|${slug}`, [a, slug]);
};
const addSlugEverywhere = (slug: string, first?: A) => {
  if (first) addPair(first, slug);
  for (const a of ATSES) addPair(a, slug);
};

const SUFFIX = new Set(["inc", "incorporated", "llc", "ltd", "corp", "corporation", "co", "company", "labs", "lab", "hq", "technologies", "technology", "tech", "the", "group", "holdings", "systems", "software", "io", "app", "inc."]);
function strip(s: string) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/\.(com|ai|io|co|app|dev|xyz|org|net)\b/g, " ");
}
function variantsFromName(name: string, website?: string): string[] {
  const out: string[] = [];
  const push = (s: string) => { if (s && s.length >= 2 && !out.includes(s)) out.push(s); };
  const toks = strip(name).split(/[^a-z0-9]+/).filter(Boolean);
  if (toks.length) {
    push(toks.join(""));
    if (toks.length > 1) push(toks.join("-"));
    const core = toks.filter((t) => !SUFFIX.has(t));
    if (core.length && core.length !== toks.length) push(core.join(""));
    if (core.length > 1 && core.length !== toks.length) push(core.join("-"));
    const noAi = core.filter((t) => t !== "ai");
    if (noAi.length && noAi.length !== core.length) push(noAi.join(""));
  }
  if (website) {
    try {
      const host = new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "");
      const parts = host.split(".");
      const label = parts.length > 2 && ["co", "com", "org", "net"].includes(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] ?? parts[0];
      if (label) push(label.toLowerCase());
    } catch { /* ignore */ }
  }
  // Prefer: domain label and joined name first, cap at 5.
  return out.slice(0, 5);
}
const addCompany = (name: string, website?: string) => {
  const vs = variantsFromName(name, website);
  vs.forEach((v, i) => {
    if (!slugHints.has(v)) slugHints.set(v, name);
    // Workable is aggressively rate-limited, so only its two best slug variants are tried.
    for (const a of ATSES) if (a !== "workable" || i < 2) addPair(a, v);
  });
};

const URL_RE: [RegExp, A][] = [
  [/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_.-]+)/, "greenhouse"],
  [/jobs\.lever\.co\/([A-Za-z0-9_.-]+)/, "lever"],
  [/jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/, "ashby"],
  [/apply\.workable\.com\/([A-Za-z0-9_.-]+)/, "workable"],
  [/([a-z0-9-]+)\.recruitee\.com/, "recruitee"],
  [/jobs\.smartrecruiters\.com\/([A-Za-z0-9_.-]+)/, "smartrecruiters"],
];
function addLine(line: string) {
  line = line.trim();
  if (!line || line.startsWith("#")) return;
  if (/myworkdayjobs\.com/i.test(line)) return; // Workday tenants: scripts/workday-probe.ts
  for (const [re, a] of URL_RE) { const m = re.exec(line); if (m) { addSlugEverywhere(m[1], a); return; } }
  const m = /^(greenhouse|lever|ashby|workable|recruitee|smartrecruiters):(.+)$/.exec(line);
  if (m) { addSlugEverywhere(m[2].trim(), m[1] as A); return; }
  addCompany(line);
}
if (!flag("rebuild")) {
  for (const f of readdirSync(CAND_DIR).sort()) {
    const p = join(CAND_DIR, f);
    if (f.endsWith(".txt")) readFileSync(p, "utf8").split("\n").forEach(addLine);
    else if (f.endsWith(".json")) {
      const d = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(d)) {
        for (const x of d) {
          if (typeof x === "string") addLine(x);
          else if (x?.name) addCompany(String(x.name), x.website);
        }
      } else {
        for (const [k, v] of Object.entries(d as Record<string, string[]>)) {
          if (!(ATSES as readonly string[]).includes(k) || !Array.isArray(v)) continue;
          for (const s of v) addPair(k as A, String(s));
        }
      }
    }
  }
}

// ---------- probing ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Per-host politeness: min gap between requests, and a shared pause after a 429.
const GAP_MS: Record<string, number> = { "apply.workable.com": Number(opt("workable-gap-ms", "2000")) };
const nextSlot: Record<string, number> = {};
const pausedUntil: Record<string, number> = {};
const bannedHosts = new Set<string>();
async function throttle(host: string) {
  const gap = GAP_MS[host] ?? 0;
  const now = Date.now();
  const at = Math.max(now, nextSlot[host] ?? 0, pausedUntil[host] ?? 0);
  nextSlot[host] = at + gap;
  if (at > now) await sleep(at - now);
}
async function get(url: string): Promise<{ status: number; body?: any } | null> {
  const host = new URL(url).hostname;
  if (bannedHosts.has(host)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await throttle(host);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        redirect: "follow",
      });
      if (res.status === 429) {
        // Back off the whole host, then retry once; a second 429 is transient (not cached).
        // A long Retry-After means we are banned for a while: stop using that host this run.
        const ra = Number(res.headers.get("retry-after")) || 0;
        if (ra > 600) {
          if (!bannedHosts.has(host)) console.error(`  ${host} says Retry-After ${ra}s: skipping that host for this run (rerun later)`);
          bannedHosts.add(host);
          await res.body?.cancel();
          return null;
        }
        pausedUntil[host] = Date.now() + 20_000 + Math.random() * 10_000;
        await res.body?.cancel();
        if (attempt === 0) continue;
        return null;
      }
      if (res.status >= 500 && attempt === 0) { await res.body?.cancel(); await sleep(1500 + Math.random() * 1500); continue; }
      if (res.status >= 500) { await res.body?.cancel(); return null; }
      if (res.status !== 200) { await res.body?.cancel(); return { status: res.status }; }
      try { return { status: 200, body: await res.json() }; } catch { return { status: 200 }; }
    } catch (e: any) {
      const code = e?.cause?.code;
      if (code === "ENOTFOUND") return { status: 404 }; // e.g. recruitee subdomain absent
      if (attempt === 0) { await sleep(800); continue; }
      return null; // transient: do not cache
    }
  }
  return null;
}

const titleCase = (slug: string) => slug.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

async function probe(a: A, slug: string): Promise<Entry | null> {
  const enc = encodeURIComponent(slug);
  const miss: Entry = { j: 0, t: Date.now() };
  switch (a) {
    case "greenhouse": {
      const r = await get(`https://boards-api.greenhouse.io/v1/boards/${enc}/jobs`);
      if (!r) return null;
      const n = Array.isArray(r.body?.jobs) ? r.body.jobs.length : 0;
      if (r.status !== 200 || n === 0) return miss;
      const m = await get(`https://boards-api.greenhouse.io/v1/boards/${enc}`);
      return { j: n, n: m?.body?.name || slugHints.get(slug) || titleCase(slug), t: Date.now() };
    }
    case "lever": {
      let total = 0;
      for (let skip = 0; skip < 5000; skip += 200) {
        const r = await get(`https://api.lever.co/v0/postings/${enc}?mode=json&limit=200&skip=${skip}`);
        if (!r) return skip === 0 ? null : { j: total, n: slugHints.get(slug) || titleCase(slug), t: Date.now() };
        const len = r.status === 200 && Array.isArray(r.body) ? r.body.length : 0;
        total += len;
        if (len < 200) break;
      }
      return total ? { j: total, n: slugHints.get(slug) || titleCase(slug), t: Date.now() } : miss;
    }
    case "ashby": {
      const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${enc}`);
      if (!r) return null;
      const n = Array.isArray(r.body?.jobs) ? r.body.jobs.length : 0;
      return n ? { j: n, n: slugHints.get(slug) || titleCase(slug), t: Date.now() } : miss;
    }
    case "workable": {
      const r = await get(`https://apply.workable.com/api/v1/widget/accounts/${enc}`);
      if (!r) return null;
      const n = Array.isArray(r.body?.jobs) ? r.body.jobs.length : 0;
      return n ? { j: n, n: r.body?.name || slugHints.get(slug) || titleCase(slug), t: Date.now() } : miss;
    }
    case "recruitee": {
      if (!/^[a-z0-9-]+$/i.test(slug)) return miss;
      const r = await get(`https://${slug.toLowerCase()}.recruitee.com/api/offers/`);
      if (!r) return null;
      const offers = Array.isArray(r.body?.offers) ? r.body.offers : [];
      return offers.length ? { j: offers.length, n: offers[0]?.company_name || slugHints.get(slug) || titleCase(slug), t: Date.now() } : miss;
    }
    case "smartrecruiters": {
      const r = await get(`https://api.smartrecruiters.com/v1/companies/${enc}/postings?limit=1`);
      if (!r) return null;
      const n = Number(r.body?.totalFound) || 0;
      return n ? { j: n, n: r.body?.content?.[0]?.company?.name || slugHints.get(slug) || titleCase(slug), t: Date.now() } : miss;
    }
  }
}

async function run() {
  const now = Date.now();
  const todo = [...pairs.values()].filter(([a, s]) => {
    const e = cache[`${a}|${s}`];
    return flag("refresh") || !e || now - e.t > TTL_MS;
  });
  // Interleave ATSes so no single host sees a burst.
  todo.sort((x, y) => (hash(x[1]) - hash(y[1])));
  const work = LIMIT ? todo.slice(0, LIMIT) : todo;
  console.error(`candidates: ${pairs.size} pairs, ${work.length} to probe (${pairs.size - todo.length} cached)`);
  let done = 0, hits = 0, errs = 0;
  const t0 = Date.now();
  // Workable is rate-limited hard (Cloudflare 1015), so it gets its own slow lane.
  const lanes = [work.filter(([a]) => a !== "workable"), work.filter(([a]) => a === "workable")];
  const worker = (q: [A, string][]) => async () => {
    while (q.length) {
      const [a, s] = q.pop()!;
      const e = await probe(a, s);
      if (e) { cache[`${a}|${s}`] = e; if (e.j > 0) hits++; } else errs++;
      if (++done % 500 === 0) {
        saveCache();
        const rate = done / ((Date.now() - t0) / 1000);
        console.error(`  ${done}/${work.length}  hits ${hits}  transient-errors ${errs}  ${rate.toFixed(1)}/s`);
      }
    }
  };
  await Promise.all([
    ...Array.from({ length: CONCURRENCY }, worker(lanes[0])),
    ...Array.from({ length: 2 }, worker(lanes[1])),
  ]);
  saveCache();
  console.error(`probed ${done}, new hits ${hits}, transient errors ${errs}`);
}
function hash(s: string) { let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0; return h; }

/** Aggregators and mass reposting boards that flood search with noise; never bundle them. */
const EXCLUDE = new Set(["jobgether", "usasurveyjob", "svetness", "tsmg", "bjakcareer", "liquidpersonnel", "privateequityinsights"]);

function build() {
  const out: Record<string, any> = {};
  const counts: Record<string, number> = {};
  let totalBoards = 0, totalJobs = 0;
  for (const a of ATSES) {
    const list: { slug: string; company: string; jobs: number }[] = [];
    for (const [k, e] of Object.entries(cache)) {
      if (!k.startsWith(a + "|") || e.j <= 0 || EXCLUDE.has(k.slice(a.length + 1).toLowerCase())) continue;
      list.push({ slug: k.slice(a.length + 1), company: e.n || titleCase(k.slice(a.length + 1)), jobs: e.j });
    }
    list.sort((x, y) => y.jobs - x.jobs || x.slug.localeCompare(y.slug));
    out[a] = list;
    counts[a] = list.length;
    totalBoards += list.length;
    totalJobs += list.reduce((s, x) => s + x.jobs, 0);
  }
  // Workday boards come from scripts/workday-probe.ts, not this cache: carry them over untouched
  try { const prev = JSON.parse(readFileSync(OUT_PATH, "utf8")); if (Array.isArray(prev.workday)) out.workday = prev.workday; } catch { /* first build */ }
  const res = { _generated: new Date().toISOString(), _counts: { ...counts, total: totalBoards, jobs: totalJobs }, _excluded: [...EXCLUDE], ...out };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(res));
  console.error(`wrote ${OUT_PATH}: ${JSON.stringify(res._counts)}`);
}

if (!flag("rebuild")) await run();
build();
