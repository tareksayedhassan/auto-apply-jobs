// OpenApply dashboard. Vanilla ES module, no build step, no network beyond the local API.
import { createDemo } from "./demo-data.js";

// ---------------------------------------------------------------------------
// tiny template helpers

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join("") : v === false || v == null ? "" : esc(v));
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += val(v) + strings[i + 1]; });
  return raw(out);
}
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ICON = {
  today: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.2"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/></svg>',
  check: '<svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" rx="3.5"/><path d="M6.8 10.2l2.2 2.2 4.4-4.6"/></svg>',
  spark: '<svg viewBox="0 0 20 20"><path d="M10 2.8l1.8 4.6 4.6 1.8-4.6 1.8L10 15.6l-1.8-4.6-4.6-1.8 4.6-1.8z"/><path d="M15.5 14.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/></svg>',
  send: '<svg viewBox="0 0 20 20"><path d="M17 3L8.6 11.4M17 3l-5 14-3.4-5.6L3 8z"/></svg>',
  columns: '<svg viewBox="0 0 20 20"><rect x="3" y="3.5" width="4" height="13" rx="1.2"/><rect x="8" y="3.5" width="4" height="9" rx="1.2"/><rect x="13" y="3.5" width="4" height="6" rx="1.2"/></svg>',
  search: '<svg viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4 4"/></svg>',
  user: '<svg viewBox="0 0 20 20"><circle cx="10" cy="7" r="3.5"/><path d="M3.5 17c.8-3.3 3.4-5 6.5-5s5.7 1.7 6.5 5"/></svg>',
  ext: '<svg viewBox="0 0 20 20"><path d="M11 4h5v5M16 4l-7 7M14 12v3.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1h3.5"/></svg>',
  x: '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>',
  sync: '<svg viewBox="0 0 20 20"><path d="M16 10a6 6 0 0 1-10.3 4.2M4 10a6 6 0 0 1 10.3-4.2"/><path d="M14.5 2.5v3.3h-3.3M5.5 17.5v-3.3h3.3"/></svg>',
  bookmark: '<svg viewBox="0 0 20 20"><path d="M6 3h8a1 1 0 0 1 1 1v13l-5-3.2L5 17V4a1 1 0 0 1 1-1z"/></svg>',
  warn: '<svg viewBox="0 0 20 20"><path d="M10 3.2l7.5 13H2.5z"/><path d="M10 8.2v3.6M10 14.2v.1"/></svg>',
  ok: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5"/><path d="M6.8 10.2l2.2 2.2 4.4-4.6"/></svg>',
  tick: '<svg viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-5"/></svg>',
  pen: '<svg viewBox="0 0 20 20"><path d="M12.8 3.7l3.5 3.5L7.5 16H4v-3.5z"/><path d="M11 5.5l3.5 3.5"/></svg>',
  target: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3.6"/><circle cx="10" cy="10" r=".6"/></svg>',
};
const icon = (k) => raw(ICON[k]);

// ---------------------------------------------------------------------------
// state + API

const qs = new URLSearchParams(location.search);
const S = {
  demo: false,
  demoReason: "",
  stats: null,
  followups: [],
  drafts: [],
  profileData: null,
  route: { name: "", params: {} },
  sel: 0,
  renderId: 0,
  drawer: null,
  syncing: false,
  cache: new Map(),
  packSaves: new Map(), // jobId -> the pack save chain still queued or in flight
  packFailed: new Map(), // jobId -> { error, answers, coverLetter }: edits whose save failed after their drawer closed
  mf: { q: "", remote: false, days: "" },
  sf: { location: "", remote: false, days: "", offset: 0 },
  pipeFilter: null,
  reviewItems: [],
  reviewSel: 0,
  outFilter: "all",
  blocked: new Map(), // jobId -> { kind, priors }: a draft or fill the server refused as a repeat application
  historyOpen: false,
  browser: null, // { up, port }: whether the fill browser (where filled forms are held) answers
  todos: [], // /api/todos: answers only the user can write, one entry per question across saved and drafted packs
};
let demo = null;

function startDemo(reason) {
  S.demo = true;
  S.demoReason = reason;
  demo = createDemo();
}

async function api(method, path, body) {
  if (S.demo) return demo.request(method, path, body);
  const opts = { method, headers: { Accept: "application/json" } };
  if (method !== "GET") opts.headers["X-OpenApply"] = "1";
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const e = new Error((data && typeof data === "object" && (data.error || data.message)) || `${res.status} ${res.statusText}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}
const get = (p) => api("GET", p);
const post = (p, b = {}) => api("POST", p, b);
const jobPath = (id, rest = "") => `/api/jobs/${enc(id)}${rest}`;

async function jobDetail(id, fresh = false) {
  if (!fresh && S.cache.has(id)) return S.cache.get(id);
  const d = await get(jobPath(id));
  S.cache.set(id, d);
  return d;
}

async function refreshGlobals() {
  const [stats, fu, prof, out, br, td] = await Promise.allSettled([get("/api/stats"), get("/api/followups"), get("/api/profile"), get("/api/outreach"), get("/api/browser"), get("/api/todos")]);
  if (stats.status === "fulfilled" && stats.value) S.stats = stats.value;
  S.browser = br.status === "fulfilled" ? br.value : null;
  if (td.status === "fulfilled" && Array.isArray(td.value)) S.todos = td.value;
  S.followups = fu.status === "fulfilled" && Array.isArray(fu.value) ? fu.value : [];
  S.drafts = out.status === "fulfilled" && Array.isArray(out.value) ? out.value.filter((o) => o.status === "draft") : [];
  if (prof.status === "fulfilled" && prof.value) S.profileData = prof.value;
  renderChrome();
}

// ---------------------------------------------------------------------------
// formatting

function ago(t) {
  if (!t) return "unknown";
  const s = (Date.now() - Date.parse(t)) / 1000;
  if (Number.isNaN(s)) return "";
  if (s < 60) return "just now";
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24; if (d < 30) return `${Math.floor(d)}d ago`;
  const mo = d / 30; if (mo < 12) return `${Math.floor(mo)}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
const short = (t) => (t ? ago(t).replace(" ago", "") : "");
const daysSince = (t) => (t ? (Date.now() - Date.parse(t)) / 864e5 : Infinity);
const fmtN = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : n ?? "0");
const plural = (n, one, many = one + "s") => `${fmtN(n)} ${n === 1 ? one : many}`;
function money(n, cur = "USD") {
  if (n == null) return "";
  const sym = { USD: "$", EUR: "€", GBP: "£", CAD: "C$", AUD: "A$" }[cur || "USD"];
  const v = n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  return sym ? sym + v : `${v} ${cur}`;
}
function salary(j) {
  if (!j || (!j.salaryMin && !j.salaryMax)) return null;
  if (j.salaryMin && j.salaryMax && j.salaryMin !== j.salaryMax) return `${money(j.salaryMin, j.salaryCurrency)}–${money(j.salaryMax, j.salaryCurrency)}`;
  return money(j.salaryMin || j.salaryMax, j.salaryCurrency);
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const basename = (p) => String(p || "").split(/[\\/]/).pop();
const human = (k) => String(k).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.]/g, " ").toLowerCase();
const score100 = (s) => Math.max(0, Math.min(100, Math.round(typeof s === "number" ? (s <= 1 ? s * 100 : s) : 0)));
const firstName = () => S.profileData?.profile?.firstName || "";

const STATUSES = ["saved", "drafted", "filled", "approved", "submitted", "needs_human", "interview", "offer", "rejected", "withdrawn", "ghosted"];
const STATUS_LABEL = { saved: "Saved", drafted: "Drafted", filled: "Needs your yes", approved: "Approved", submitted: "Submitted", needs_human: "Needs you in browser", interview: "Interview", offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn", ghosted: "No response" };
const STAGE_LABEL = { ...STATUS_LABEL, filled: "Filled", needs_human: "Needs you", ghosted: "Ghosted" };
const OUT_STATUSES = ["sent", "replied", "meeting", "no_reply", "closed"];
/**
 * Each /api/followups row has a kind: "follow_up" (sent, no reply for a week), "send_or_close" (a draft left unsent;
 * it also shows under Ready to send) or "propose_close" (its application was rejected or withdrawn).
 * A server from before kinds sends follow-ups only.
 */
const dueKind = (f) => f.kind || "follow_up";
const dueOf = (kind) => S.followups.filter((f) => dueKind(f) === kind);
/** Drafts still worth sending: not the ones whose role closed. */
const liveDrafts = () => { const dead = new Set(dueOf("propose_close").map((f) => f.id)); return S.drafts.filter((o) => !dead.has(o.id)); };
const OUT_LABEL = { draft: "Ready to send", sent: "Sent", replied: "Replied", meeting: "Meeting", no_reply: "No reply", closed: "Closed" };
const status = (s, labels = STATUS_LABEL) => html`<span class="status" data-s="${s}"><span class="dot"></span>${labels[s] || human(s)}</span>`;

// Applied before: earlier applications at the same company, from OpenApply or imported history (server: prior.ts).
// The server sorts same-role priors (similarTitle, the ones that block draft and fill) first, then newest.
/** "08-28" this year, "2025-08-28" before. Dates are read as written, never shifted by time zone. */
function pday(t) {
  const d = t.slice(0, 10);
  return d.slice(0, 4) === String(new Date().getFullYear()) ? d.slice(5) : d;
}
const priorLine = (p) => `${p.company} · ${p.title} · ${p.appliedAt.slice(0, 10)} · ${STAGE_LABEL[p.status] || human(p.status)}${p.imported ? " (imported)" : ""}`;
function priorChip(priors) {
  if (!priors?.length) return "";
  const dup = priors[0].similarTitle;
  return html`<span class="chip prior ${dup ? "dup" : ""}" title="${priors.map(priorLine).join("\n")}"><span class="dot" aria-hidden="true"></span>${dup ? "Already applied" : "Applied before"} · ${pday(priors[0].appliedAt)}${priors.length > 1 ? ` +${priors.length - 1}` : ""}<span class="sr">: ${priors.map(priorLine).join("; ")}</span></span>`;
}

function splitWarnings(ws) {
  const facts = [], voice = [];
  for (const w of Array.isArray(ws) ? ws : []) {
    const s = String(w);
    if (/^voice:/i.test(s)) voice.push(s.replace(/^voice:\s*/i, ""));
    else facts.push(s);
  }
  return { facts, voice };
}

function shotUrl(p) {
  if (!p || typeof p !== "string") return null;
  if (/^(data:|https?:|blob:)/.test(p) || p.startsWith("/files/")) return p;
  return `/files/screenshots/${enc(basename(p))}`;
}
/** Latest form screenshot for a job detail. Accepts several shapes; see the report for the contract. */
function findShot(d) {
  const direct = d?.application?.screenshot || d?.pack?.screenshot || d?.screenshot || d?.fill?.screenshot;
  if (direct) return shotUrl(direct);
  const evs = [...(d?.events || [])].sort((a, b) => String(b.at).localeCompare(String(a.at)) || (b.id || 0) - (a.id || 0));
  for (const e of evs) {
    const det = e?.detail;
    if (!det) continue;
    let obj = null;
    if (typeof det === "object") obj = det;
    else { try { obj = JSON.parse(det); } catch { /* plain text */ } }
    if (obj && typeof obj === "object" && obj.screenshot) return shotUrl(obj.screenshot);
    const m = String(det).match(/[^\s"'()]+\.(png|jpe?g|webp)/i);
    if (m) return shotUrl(m[0]);
  }
  return null;
}
const packFile = (jobId, p) => (p ? `/files/packs/${enc(jobId)}/${enc(basename(p))}` : null);

function describeEvent(e) {
  if (e.text && e.kind !== "status") return e.text;
  const d = e.detail;
  switch (e.kind) {
    case "status": return `Moved to ${STATUS_LABEL[d] || human(d || "")}`;
    case "fill": {
      try { const o = typeof d === "object" ? d : JSON.parse(d); return `Form filled: ${plural(o.filled ?? 0, "field")}${o.skipped ? `, ${o.skipped} skipped` : ""}`; } catch { return d ? `Form filled. ${d}` : "Form filled"; }
    }
    case "pack": return d || "Application pack saved";
    case "note": return `Note: ${d || ""}`;
    case "captcha": return d || "CAPTCHA detected. Finish it in the open browser.";
    default: return d ? `${human(e.kind)}: ${typeof d === "string" ? d : JSON.stringify(d)}` : human(e.kind);
  }
}

// ---------------------------------------------------------------------------
// chrome

const NAV = [
  ["today", "Today", "t", "today"],
  ["scoreboard", "Scoreboard", "b", "target", "", "Score"],
  ["review", "Review", "r", "check"],
  ["matches", "Matches", "m", "spark"],
  ["answers", "Answers", "w", "pen", "hide-m"],
  ["outreach", "Outreach", "o", "send"],
  ["pipeline", "Pipeline", "p", "columns"],
  ["search", "Search", "s", "search", "hide-m"],
  ["profile", "Profile", "f", "user"],
];

function renderChrome() {
  const filled = S.stats?.pipeline?.filled || 0;
  // an old draft is both a draft and a send_or_close row: count each message once
  const due = new Set([...S.drafts, ...S.followups].map((o) => o.id)).size;
  const count = (name) => {
    if (name === "review" && filled > 0) return html`<span class="count hot" aria-label="${filled} waiting">${filled}</span>`;
    if (name === "outreach" && due > 0) return html`<span class="count" aria-label="${due} outreach to handle">${due}</span>`;
    if (name === "answers" && todoCount() > 0) return html`<span class="count" aria-label="${todoCount()} answers to write">${todoCount()}</span>`;
    return "";
  };
  $("#nav").innerHTML = String(html`${NAV.map(([name, label, key, ic, cls, shortLabel]) => html`
    <a href="#/${name}" class="${cls || ""}" ${S.route.name === name ? raw('aria-current="page"') : ""} title="${label} (g then ${key})">
      ${icon(ic)}<span class="lbl">${shortLabel ? html`<span class="lbl-l">${label}</span><span class="lbl-s" aria-hidden="true">${shortLabel}</span>` : label}</span>${count(name)}
    </a>`)}`);
  const lastSync = S.stats?.jobs?.lastSync;
  const br = S.browser;
  $("#topMeta").innerHTML = String(html`
    ${S.demo && html`<span class="pill-demo" title="Fixture data. Nothing here is real and nothing is sent."><span class="dot"></span>Demo data</span>`}
    ${br && html`<span class="fb-chip ${br.up ? "up" : ""}" role="status" title="${br.up ? `The fill browser is open (DevTools port ${br.port}). Forms filled from this dashboard stay open in it until you approve.` : `The fill browser is closed (nothing answers on port ${br.port}), so no filled form is held open. Fill form opens it again.`}"><span class="dot" aria-hidden="true"></span><span class="fb-txt">Fill browser ${br.up ? "open" : "closed"}</span><span class="sr">${br.up ? "" : ": no filled form is held open"}</span></span>`}
    <button class="btn ghost sm" data-action="sync" ${S.syncing ? "disabled" : ""} title="Refresh the job index from every board">
      ${S.syncing ? raw('<span class="spin"></span>') : icon("sync")}
      <span class="sync-txt">${S.syncing ? "Syncing boards" : lastSync ? `Synced ${ago(lastSync)}` : "Never synced"}</span>
    </button>`);
  $("#sideFoot").innerHTML = String(html`
    <button class="linkish" data-action="shortcuts">Keyboard shortcuts <kbd>?</kbd></button>
    <span>${S.demo ? "Demo mode. No server needed." : "Local only. Data stays on this machine."}</span>`);
  const open = S.stats?.jobs?.open;
  if (open) $("#q").placeholder = matchMedia("(max-width: 520px)").matches ? "Search roles" : `Search ${fmtN(open)} open roles`;
  $("#banner").innerHTML = S.demo && S.demoReason === "offline"
    ? String(html`<div class="banner"><b>Showing demo data.</b><span>The OpenApply server is not answering at this address. Start it with <code>openapply ui</code>; this page switches to your data as soon as it answers.</span></div>`)
    : "";
}

// ---------------------------------------------------------------------------
// router

const view = $("#view");
const VIEWS = { today: viewToday, scoreboard: viewScoreboard, review: viewReview, answers: viewAnswers, matches: viewMatches, outreach: viewOutreach, pipeline: viewPipeline, search: viewSearch, profile: viewProfile };

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [name, query] = h.split("?");
  return { name: VIEWS[name] ? name : "today", params: Object.fromEntries(new URLSearchParams(query || "")) };
}
function go(name, params) {
  const q = params ? "?" + new URLSearchParams(params).toString() : "";
  const target = `#/${name}${q}`;
  if (location.hash === target) route(); else location.hash = target;
}
async function route() {
  if (S.profileDirty && S.route.name === "profile" && parseHash().name !== "profile") {
    const r = await confirmModal({ title: "Leave without saving?", body: html`<p>Your profile edits have not been saved.</p>`, ok: "Discard changes", cancel: "Keep editing" });
    if (!r.ok) { history.replaceState(null, "", "#/profile"); return; }
    S.profileDirty = false;
  }
  const r = parseHash();
  const changed = r.name !== S.route.name;
  S.route = r;
  if (changed) { S.sel = 0; window.scrollTo(0, 0); }
  renderChrome();
  await VIEWS[r.name]();
  if (changed) { view.classList.remove("enter"); void view.offsetWidth; view.classList.add("enter"); }
}
function paint(id, markup) {
  if (id !== S.renderId) return false;
  view.innerHTML = String(markup);
  applySel(false);
  return true;
}
const skeleton = (n = 4) => html`<div class="head"><div><div class="skel" style="width:120px;height:12px"></div><div class="skel" style="width:300px;height:36px;margin-top:12px"></div></div></div>
  <div class="stack">${Array.from({ length: n }, () => html`<div class="skel" style="height:64px"></div>`)}</div>`;
function errorState(e) {
  return html`<div class="empty"><h3>Could not load this view</h3><p>${e?.message || String(e)}</p><div style="margin-top:16px"><button class="btn" data-action="reload">Try again</button></div></div>`;
}
function askAgent(prompt) {
  return html`<div class="ask"><span class="lbl">Ask your agent</span><q>${prompt}</q><button class="btn sm ghost" data-action="copy" data-text="${prompt}">Copy</button></div>`;
}

// ---------------------------------------------------------------------------
// shared pieces

function scoreRing(s) {
  const v = score100(s);
  const C = 2 * Math.PI * 19;
  return html`<div class="score" title="Match score ${v} of 100" aria-label="Match score ${v}">
    <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true"><circle class="trk" cx="22" cy="22" r="19"/><circle class="val" cx="22" cy="22" r="19" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - v / 100)).toFixed(1)}"/></svg>
    <b>${v}</b></div>`;
}
const locLine = (j) => html`${j.location || "Location not listed"}${j.remote ? html` <span class="badge-remote">Remote</span>` : ""}`;

function checksBlock(pack) {
  const { facts, voice } = splitWarnings(pack?.warnings);
  return html`
    ${facts.length ? html`<div class="warnings">${facts.map((w) => html`<div class="warn-item" role="note">${icon("warn")}<div>${w}</div></div>`)}</div>`
      : html`<div class="clean">${icon("ok")}Every fact matches your master resume.</div>`}
    ${voice.length > 0 && html`<details class="voice-group">
      <summary>Sounds like AI <span class="chip outline">${voice.length}</span></summary>
      <ul>${voice.map((v) => html`<li>${v}</li>`)}</ul>
      <p class="hint">Recruiters read every answer, and stock phrasing reads as unread. Worth a quick rewrite in your own words.</p>
    </details>`}`;
}

function quotedPhrases(ws) {
  const out = [];
  for (const w of splitWarnings(ws).facts) for (const m of String(w).matchAll(/"([^"]{2,80})"/g)) out.push(m[1]);
  return out;
}
function hl(text, phrases) {
  let s = esc(text);
  for (const p of phrases) { const e = esc(p); if (e && s.includes(e)) s = s.split(e).join(`<mark>${e}</mark>`); }
  return raw(s);
}
function resumePaper(r, phrases = []) {
  if (!r) return html`<div class="empty compact"><p>No resume yet.</p>${askAgent("Import my resume from ~/Documents/resume.pdf")}</div>`;
  const c = r.contact || {};
  return html`<article class="paper" aria-label="Resume text">
    <h5>${r.name}</h5>
    ${r.headline && html`<div class="hl">${hl(r.headline, phrases)}</div>`}
    <div class="ct">${[c.email, c.phone, c.location, ...(c.links || [])].filter(Boolean).join("  ·  ")}</div>
    ${r.summary && html`<h6>Summary</h6><p>${hl(r.summary, phrases)}</p>`}
    ${(r.experience || []).length > 0 && html`<h6>Experience</h6>${r.experience.map((x) => html`<div class="job">
      <div class="job-h"><span>${hl(x.title, phrases)}, ${x.company}</span><span>${[x.start, x.end].filter(Boolean).join("–")}</span></div>
      <ul>${(x.bullets || []).map((b) => html`<li>${hl(b, phrases)}</li>`)}</ul></div>`)}`}
    ${(r.projects || []).length > 0 && html`<h6>Projects</h6>${r.projects.map((p) => html`<div class="job"><div class="job-h"><span>${p.name}</span><span>${p.link || ""}</span></div>
      ${p.description && html`<div>${p.description}</div>`}<ul>${(p.bullets || []).map((b) => html`<li>${hl(b, phrases)}</li>`)}</ul></div>`)}`}
    ${(r.education || []).length > 0 && html`<h6>Education</h6>${r.education.map((e) => html`<div class="job"><div class="job-h"><span>${[e.degree, e.school].filter(Boolean).join(", ")}</span><span>${[e.start, e.end].filter(Boolean).join("–")}</span></div></div>`)}`}
    ${(r.skills || []).length > 0 && html`<h6>Skills</h6><p>${hl(r.skills.join(", "), phrases)}</p>`}
    ${(r.extras || []).map((x) => html`<h6>${x.heading}</h6><p>${(x.items || []).join(", ")}</p>`)}
  </article>`;
}

// "TODO (you): hint" marks an answer only the user can write; fill refuses the pack while any answer is a TODO or blank.
const TODO_RE = /\btodo \([^()\n]{1,30}\)/i; // any short owner, so answers written with an older owner-named marker still count
const TODO_LEAD = /^\s*todo \([^()\n]{1,30}\):?\s*/i;
const unfinished = (v) => TODO_RE.test(v) || !String(v ?? "").trim();
/** Unfinished, or drafted by OpenApply (why-us) and not reviewed yet: fill stays locked either way, same as the server. */
const pendingQ = (pack, q) => unfinished(pack?.answers?.[q]) || !!pack?.drafted?.[q];
/** Statuses where the application is sent or past it: no more edits (mirrors the server). Editing a filled form's pack voids the fill. */
const EDIT_LOCKED = new Set(["submitted", "needs_human", "interview", "offer", "rejected", "withdrawn", "ghosted"]);
function packTodoList(pack) {
  const out = Object.keys(pack?.answers || {}).filter((q) => pendingQ(pack, q));
  if (pack?.coverLetter && TODO_RE.test(pack.coverLetter)) out.push("Cover letter");
  return out;
}
const PACK_FIELDS = "textarea[data-pack-q], textarea[data-pack-cover]";

let tabSeq = 0;
function packTabs(pack, jobId, opts = {}) {
  const k = `pt${++tabSeq}`;
  const edit = !!opts.edit;
  const answers = Object.entries(pack.answers || {});
  const todos = answers.filter(([q]) => pendingQ(pack, q)).length;
  const resumeSrc = !S.demo && packFile(jobId, pack.resumePdf);
  const tabs = [
    ["resume", "Resume"],
    ["cover", "Cover letter"],
    ...(opts.noAnswers ? [] : [["answers", "Answers"]]),
    ...(opts.noChecks ? [] : [["checks", "Checks"]]),
  ];
  const coverTodo = edit && !!pack.coverLetter && TODO_RE.test(pack.coverLetter);
  const sel = edit && todos && !opts.noAnswers ? "answers" : coverTodo ? "cover" : "resume";
  const panel = (id, inner) => html`<div role="tabpanel" id="${k}-${id}" data-panel="${id}" aria-labelledby="${k}-t-${id}" ${id === sel ? "" : raw("hidden")}>${inner}</div>`;
  return html`<div class="packtabs" ${edit ? raw(`data-edit data-k="${k}" data-job="${esc(jobId)}"`) : ""}>
    ${edit && html`<div data-todo-sum>${todoSummary(pack, k)}</div>`}
    <div class="tabs" role="tablist">${tabs.map(([id, label]) => html`<button role="tab" id="${k}-t-${id}" aria-controls="${k}-${id}" aria-selected="${String(id === sel)}" data-tab="${k}-${id}" data-tabname="${id}">${label}${tabCount(id, pack)}</button>`)}</div>
    ${panel("resume", html`${resumeSrc ? html`<iframe class="pdf" title="Tailored resume PDF" src="${resumeSrc}"></iframe>` : resumePaper(pack.resume, quotedPhrases(pack.warnings))}
      ${resumeSrc && html`<p class="muted" style="font-size:12px;margin-top:8px"><a href="${resumeSrc}" target="_blank" rel="noopener">Open PDF in a new tab</a></p>`}`)}
    ${panel("cover", edit ? coverEditor(pack, jobId, k, coverTodo) : coverPreview(pack, jobId))}
    ${!opts.noAnswers && panel("answers", edit ? answersEditor(pack, k, opts.whyUs) : answersList(pack.answers))}
    ${!opts.noChecks && panel("checks", checksBlock(pack))}
  </div>`;
}
function tabCount(id, pack) {
  if (id === "answers") {
    const all = Object.keys(pack.answers || {});
    const todo = all.filter((q) => pendingQ(pack, q)).length;
    return todo ? html`<span class="n warn">${todo}<span class="sr"> to finish</span></span>` : all.length ? html`<span class="n">${all.length}</span>` : "";
  }
  if (id === "checks") {
    const { facts, voice } = splitWarnings(pack.warnings);
    return facts.length + voice.length ? html`<span class="n ${facts.length ? "warn" : ""}">${facts.length + voice.length}</span>` : "";
  }
  return "";
}
function coverPreview(pack, jobId, bust = "") {
  const src = !S.demo && packFile(jobId, pack.coverLetterPdf);
  if (src) return html`<iframe class="pdf" title="Cover letter PDF" src="${src}${bust}"></iframe>`;
  return pack.coverLetter ? html`<div class="paper letter">${pack.coverLetter}</div>` : html`<p class="muted">No cover letter in this pack.</p>`;
}
/** Fact warnings that name one field ("the answer to \"Why us?\"", "the cover letter"), shown right under it. */
function fieldWarns(pack, where) {
  const ws = splitWarnings(pack.warnings).facts.filter((w) => w.includes(where));
  return ws.length ? html`<ul class="field-warns">${ws.map((w) => html`<li>${icon("warn")}<span>${w}</span></li>`)}</ul>` : "";
}
function todoSummary(pack, k) {
  const items = Object.entries(pack.answers || {}).map(([q, v], i) => [q, v, `${k}-a${i}`]).filter(([q]) => pendingQ(pack, q));
  if (pack.coverLetter && TODO_RE.test(pack.coverLetter)) items.push(["Cover letter", "", `${k}-cl`]);
  if (!items.length) return "";
  const review = items.filter(([q]) => pack.drafted?.[q] && !unfinished(pack.answers?.[q])).length;
  return html`<div class="todo-sum" role="note">${icon("warn")}<div><b>${items.length} to finish</b> before the form can be filled. ${review ? "Only you can write or approve these." : "Only you can write these."}
    <ul>${items.map(([q, , id]) => html`<li><button type="button" class="linkish" data-action="jump-pack" data-target="${id}">${q}</button>${pack.drafted?.[q] && html` <span class="muted">(${pack.drafted[q].noLink ? "no honest link, rewrite" : "drafted, review"})</span>`}</li>`)}</ul></div></div>`;
}
/** Row state: "todo" (TODO or blank), "review" (a why-us draft to read), "rewrite" (a no-honest-link stub), or "". */
function qaState(pack, q) {
  const dr = pack.drafted?.[q];
  if (dr && !unfinished(pack.answers?.[q])) return dr.noLink ? "rewrite" : "review";
  return unfinished(pack.answers?.[q]) ? "todo" : "";
}
/** The chip and buttons beside a question: To do (+ Draft for why-us), Drafted, review (+ Keep it, Redraft), or No honest link. */
function qaBadges(pack, q, whyUs = []) {
  const st = qaState(pack, q);
  const draft = (label) => html`<button type="button" class="btn sm ghost qa-btn" data-action="whyus" data-q="${q}">${icon("spark")} ${label}</button>`;
  if (st === "todo") return html`<span class="chip warn">To do</span>${whyUs.includes(q) && draft("Draft")}`;
  if (st === "review") return html`<span class="chip accent">Drafted, review</span><button type="button" class="btn sm qa-btn" data-action="keep-draft" data-q="${q}">Keep it</button>${draft("Redraft")}`;
  if (st === "rewrite") return html`<span class="chip warn">No honest link: rewrite</span>${draft("Try again")}`;
  return "";
}
function qaNote(pack, q) {
  const dr = pack.drafted?.[q];
  if (!dr || unfinished(pack.answers?.[q])) return "";
  return html`<p class="qa-note">${dr.noLink ? "OpenApply found nothing true that ties this company to your work. Write your own reason; this stub only holds the place." : html`Drafted by OpenApply from the posting and your resume${dr.link ? html`: <span>${dr.link}</span>` : ""}. Edit it or keep it; the form stays locked until you do.`}</p>`;
}
function answersEditor(pack, k, whyUs = []) {
  const entries = Object.entries(pack.answers || {});
  if (!entries.length) return html`<p class="muted">No form answers in this pack yet.</p>`;
  return html`<div class="qa-edit">${entries.map(([q, v], i) => {
    const lead = TODO_LEAD.test(v), st = qaState(pack, q);
    return html`<div class="qa-row ${st}" data-field>
      <div class="qa-head"><label for="${k}-a${i}">${q}</label><span class="qa-badges">${qaBadges(pack, q, whyUs)}</span><span class="save-state" aria-live="polite"></span></div>
      <textarea class="input" id="${k}-a${i}" rows="2" data-pack-q="${q}" placeholder="${lead ? v.replace(TODO_LEAD, "") || "Your answer" : ""}">${lead ? "" : v}</textarea>
      <div data-note>${qaNote(pack, q)}</div>
      <div data-warns>${fieldWarns(pack, `the answer to "${q}"`)}</div>
    </div>`;
  })}</div>
  <p class="edit-hint">Saves when you leave a field or press <kbd>⌘</kbd> <kbd>↵</kbd>. The fact and voice checks run again on every save.</p>`;
}
function coverEditor(pack, jobId, k, editing) {
  return html`<div data-field>
    <div class="cover-bar"><div class="seg" role="group" aria-label="Cover letter view">
      <button type="button" data-action="cover-mode" data-v="preview" aria-pressed="${String(!editing)}">Preview</button>
      <button type="button" data-action="cover-mode" data-v="edit" aria-pressed="${String(editing)}">Edit text</button></div>
      <span class="save-state" aria-live="polite"></span></div>
    <div class="cover-preview" ${editing ? raw("hidden") : ""}>${coverPreview(pack, jobId)}</div>
    <div class="cover-edit" ${editing ? "" : raw("hidden")}>
      <label class="sr" for="${k}-cl">Cover letter text</label>
      <textarea class="input letter-edit" id="${k}-cl" data-pack-cover rows="12">${pack.coverLetter || ""}</textarea>
      <div data-warns>${fieldWarns(pack, "the cover letter")}</div>
      <p class="edit-hint">Saves when you leave the field or press <kbd>⌘</kbd> <kbd>↵</kbd>, then the PDF is rendered again.</p>
    </div></div>`;
}
function answersList(a) {
  const entries = Object.entries(a || {});
  if (!entries.length) return html`<p class="muted">No form answers in this pack yet.</p>`;
  return html`<dl class="qa">${entries.map(([q, v]) => html`<div><dt>${q}</dt><dd>${v}</dd></div>`)}</dl>`;
}
/** What the fill actually typed, picked or attached, by the form's own labels. */
const filledList = (filled) => filled.length ? answersList(Object.fromEntries(filled.map((f) => [f.label, f.value]))) : html`<p class="muted">Nothing was filled on the form.</p>`;
const blankLine = (n) => `${plural(n, "required field")} ${n === 1 ? "is" : "are"} blank`;
/** A warning box: a bold lead line, then the form questions it is about. */
const noteBox = (head, items) => html`<div class="todo-sum" role="note">${icon("warn")}<div>${head}<ul>${items.map((l) => html`<li>${l}</li>`)}</ul></div></div>`;
/** Required fields the fill left blank. Approve stays off until a new fill has none. */
const blankSummary = (blanks) => noteBox(html`<b>${blankLine(blanks.length)}</b> on the form. They are now To do in the pack: answer them there, then fill again.`, blanks);
/** Required fields that have an answer the filler could not enter. They do not block approval: finish them by hand. */
const failedSummary = (failed) => noteBox(html`<b>${plural(failed.length, "field")} could not be filled</b>. Fill ${failed.length === 1 ? "it" : "them"} in yourself in the open browser window before you approve.`, failed);

// Held: whether this dashboard's process still has the filled form open (server: engine.canSubmit). Only then does
// Approve press Submit here. A form filled before a restart, or by an agent in its own process, is not held: approving
// it only records the yes, and the agent that holds it (if any) submits.
const notHeld = (a) => a.held === false && (a.status === "filled" || a.status === "approved");
const approveLabel = (held) => (held === false ? "Approve (your agent submits)" : "Approve, let it submit");
function heldNote(jobId, status = "filled") {
  return html`<div class="held-note" role="note">${icon("warn")}<div>
    <b>Form not open in this dashboard.</b> ${status === "approved"
      ? "It is approved, but nothing was submitted from here: the filled form is no longer open in the fill browser."
      : "Approving here won't submit it: the filled form is no longer open in the fill browser (it was closed or restarted since the fill)."}
    Re-fill to open it again, then approve. An agent that filled it in its own window can still submit it there.
    <div class="held-acts"><button type="button" class="btn sm primary" data-action="refill" data-id="${jobId}">Re-fill form</button></div></div></div>`;
}
/**
 * The submit the employer refused (Lever: "There was an error verifying your application", resume dropped), or a Lever
 * CAPTCHA after submit: nothing went in, and it passes from the user's own browser. Latest such event, while the
 * application still needs the user.
 */
function elsewhereEvent(app, events) {
  if (app?.status !== "needs_human") return null;
  const evs = [...(events || [])].sort((a, b) => String(b.at).localeCompare(String(a.at)) || (b.id || 0) - (a.id || 0));
  const last = evs.find((e) => e.kind === "verification_failed" || e.kind === "needs_human" || e.kind === "submitted");
  if (!last || last.kind === "submitted") return null;
  try { const o = typeof last.detail === "object" ? last.detail : JSON.parse(last.detail); return o?.applyUrl ? { ...o, kind: last.kind } : null; } catch { return null; }
}
function elsewhereNote(app, events) {
  const o = elsewhereEvent(app, events);
  if (!o) return "";
  return html`<div class="held-note" role="note" data-elsewhere>${icon("warn")}<div>
    <b>${o.kind === "verification_failed" ? "Not submitted: the form refused it." : "Stopped at a CAPTCHA."}</b>
    ${o.kind === "verification_failed" ? "The employer could not verify the application from the OpenApply window and dropped the resume." : "Clearing it in the OpenApply window usually fails on Lever."}
    Finish it in your normal browser, then mark it submitted once the page reads "Application submitted!".
    <div class="held-acts"><a class="btn sm primary" href="${o.applyUrl}" target="_blank" rel="noopener">Open in my browser ${icon("ext")}</a>
      ${o.resume && html`<span>Attach <code>${o.resume}</code></span><button type="button" class="btn sm ghost" data-action="copy" data-text="${o.resume}" data-msg="Resume path copied.">Copy path</button>`}</div></div></div>`;
}
/** Answers still to write, counted per pack field (one question asked by two packs counts twice). */
const todoCount = () => S.todos.reduce((n, g) => n + g.jobs.length, 0);
const todoJobs = () => new Set(S.todos.flatMap((g) => g.jobs.map((x) => x.jobId)));

// ---------------------------------------------------------------------------
// Today

async function viewToday() {
  const id = ++S.renderId;
  paint(id, skeleton(3));
  let pipe;
  try { [pipe] = await Promise.all([get("/api/pipeline"), refreshGlobals()]); } catch (e) { return paint(id, errorState(e)); }
  const items = pipe.items || [];
  const filled = items.filter((a) => a.status === "filled");
  const approved = items.filter((a) => a.status === "approved");
  const needsHuman = items.filter((a) => a.status === "needs_human");
  const loose = filled.filter(notHeld);
  const looseApproved = approved.filter(notHeld);
  const drafted = items.filter((a) => !isPast(a) && a.status === "drafted");
  const blocked = todoJobs();
  const needAnswers = drafted.filter((a) => blocked.has(a.jobId)).length;
  const staleDays = Math.floor(daysSince(S.stats?.jobs?.lastSync));
  const details = await Promise.all(filled.slice(0, 6).map((a) => jobDetail(a.jobId).catch(() => null)));
  const counts = activeCounts(items);
  const js = S.stats?.jobs || {};
  const missing = S.stats?.profile?.missing || [];
  const due = dueOf("follow_up");
  const hour = new Date().getHours();
  const greet = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const lede = [];
  if (filled.length) lede.push(html`<em>${plural(filled.length, "application")}</em> ${filled.length === 1 ? "is" : "are"} filled and waiting for your yes.`);
  if (todoCount()) lede.push(html`<em>${plural(todoCount(), "answer")}</em> only you can write ${todoCount() === 1 ? "is" : "are"} holding up ${plural(blocked.size, "pack")}.`);
  if (due.length) lede.push(html`<em>${plural(due.length, "follow-up")}</em> ${due.length === 1 ? "is" : "are"} due.`);
  if (!lede.length) lede.push(html`Nothing needs you right now. Your agent can keep looking.`);

  const queue = filled.length ? html`<div class="queue">${filled.map((a, i) => {
    const d = details[i]; const j = a.job || d?.job || {};
    const shot = d ? findShot(d) : null;
    const { facts, voice } = splitWarnings(d?.pack?.warnings);
    return html`<div class="qcard" data-row data-id="${a.jobId}" data-status="filled" data-open="review">
      <div class="thumb ${shot ? "" : "empty"}">${shot ? html`<img src="${shot}" alt="" loading="lazy">` : "No screenshot"}</div>
      <div style="min-width:0">
        <div class="co">${j.company || a.jobId}</div>
        <div class="ti">${j.title || "Untitled role"}</div>
        <div class="meta"><span>Filled ${ago(a.updatedAt)}</span>
          ${notHeld(a) && html`<span class="chip warn" title="The filled form is no longer open in the fill browser, so Approve here would not submit it.">Form not open here</span>`}
          ${facts.length > 0 ? html`<span class="chip warn">${plural(facts.length, "fact")} to check</span>` : html`<span class="chip accent">Facts check out</span>`}
          ${voice.length > 0 && html`<span class="chip">${voice.length} phrasing note${voice.length > 1 ? "s" : ""}</span>`}
        </div>
      </div>
      <div class="acts">${notHeld(a) ? html`<button type="button" class="btn primary" data-action="refill" data-id="${a.jobId}">Re-fill</button><a class="btn" href="#/review?job=${enc(a.jobId)}">Review</a>`
        : html`<a class="btn primary" href="#/review?job=${enc(a.jobId)}">Review</a>`}</div>
    </div>`;
  })}</div>` : html`<div class="empty"><h3>No applications waiting</h3><p>When your agent fills a form it stops here and waits. Nothing is submitted until you approve it.</p>${askAgent("Find me remote product roles and get the top 3 ready")}</div>`;

  const lastSync = js.lastSync;
  const drafts = liveDrafts();
  const checklist = [
    ...(drafts.length ? [{ done: false, t: `Send ${plural(drafts.length, "drafted message")}`, d: drafts.slice(0, 2).map((o) => `${o.person} at ${o.company}`).join(", ") + (drafts.length > 2 ? ` and ${drafts.length - 2} more` : ""), href: "#/outreach", go: "Open" }] : []),
    { done: filled.length === 0, t: filled.length ? `Review ${plural(filled.length, "filled application")}` : "Nothing waiting for your yes", d: !filled.length ? "Your agent will queue the next ones here."
      : loose.length ? `${loose.length === filled.length ? (filled.length === 1 ? "Its form is" : "Their forms are") : `${loose.length} of ${filled.length} forms are`} no longer open here. Re-fill so Approve can submit.`
      : "Approve or reject each one. Approve presses Submit.", href: "#/review", go: filled.length ? "Review" : "", warn: loose.length > 0 },
    ...(todoCount() ? [{ done: false, t: `Write ${plural(todoCount(), "answer")}`, d: `Only you can. Fill stays locked on ${plural(blocked.size, "pack")} until they're in.`, href: "#/answers", go: "Write" }] : []),
    { done: due.length === 0, t: due.length ? `Send ${plural(due.length, "follow-up")}` : "Follow-ups are caught up", d: due.length ? due.slice(0, 2).map((f) => `${f.person} at ${f.company}`).join(", ") + (due.length > 2 ? ` and ${due.length - 2} more` : "") : "Nobody has been waiting more than a week.", href: "#/outreach", go: due.length ? "Open" : "" },
    ...(looseApproved.length ? [{ done: false, t: `${plural(looseApproved.length, "approved application")} not submitted`, d: `Nothing was submitted from here: ${looseApproved.map((a) => a.job?.company || a.jobId).join(", ")} ${looseApproved.length === 1 ? "is" : "are"} not open in the fill browser. Re-fill and approve again, or let the agent holding ${looseApproved.length === 1 ? "it" : "them"} submit.`, href: `#/pipeline?status=approved`, go: "See", warn: true }] : []),
    ...(approved.length > looseApproved.length ? [{ done: false, t: `Hand ${plural(approved.length - looseApproved.length, "approved application")} back to your agent`, d: "Approval allows submission. Your agent presses Submit on its next step.", copy: "Submit my approved applications" }] : []),
    ...(needsHuman.length ? [{ done: false, t: `Finish ${plural(needsHuman.length, "form")} in the browser`, d: "A CAPTCHA, login or a refused submit stopped the run. Open each one for what to do.", href: "#/pipeline?status=needs_human", go: "See" }] : []),
    ...(missing.length ? [{ done: false, t: "Fill in your profile", d: `Missing ${missing.map(human).join(", ")}. Forms that ask will stop for you.`, href: "#/profile", go: "Edit" }] : []),
  ];

  paint(id, html`
    <div class="head"><div>
      <div class="eyebrow">${dateStr}</div>
      <h1 class="title">${greet}${firstName() ? `, ${firstName()}` : ""}.</h1>
      <p class="lede">${lede.map((l, i) => html`${i ? " " : ""}${l}`)}</p>
    </div></div>
    ${staleDays >= 2 && html`<div class="stale" role="note">${icon("warn")}<div><b>The job index is ${staleDays === Infinity ? "empty" : `${staleDays} days old`}.</b>
      ${staleDays === Infinity ? "Sync once to load open roles." : `Matches and search miss everything posted since ${new Date(S.stats.jobs.lastSync).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, and some listed roles have closed.`}</div>
      <button class="btn sm" data-action="sync" ${S.syncing ? "disabled" : ""}>${S.syncing ? raw('<span class="spin"></span> Syncing') : html`${icon("sync")} Sync now`}</button></div>`}
    <div class="grid-today">
      <div>
        <div class="section-head" style="margin-top:0"><h2>Needs your yes</h2><span class="aside">${filled.length ? "Nothing is sent without your approval" : ""}</span></div>
        ${queue}
        ${S.todos.length > 0 && html`<div class="section">
          <div class="section-head"><h2>Answers to write</h2><a class="aside" href="#/answers">Write them</a></div>
          <ul class="todo-list">${S.todos.slice(0, 5).map((g, i) => html`<li><a href="#/answers?q=${i}">
            <span class="q">${g.question}</span><span class="who">${g.jobs.map((x) => x.company).join(", ")}</span></a></li>`)}
            ${S.todos.length > 5 && html`<li class="more"><a href="#/answers">${plural(S.todos.length - 5, "more question")}</a></li>`}</ul>
        </div>`}
        <div class="section">
          <div class="section-head"><h2>Pipeline</h2><a class="aside" href="#/pipeline">Open pipeline</a></div>
          <div class="stat-row">
            <a class="stat" href="${needAnswers ? "#/answers" : "#/pipeline?status=drafted"}"><div class="k">Drafted</div><div class="v">${fmtN(counts.drafted || 0)}</div><div class="s">${needAnswers ? html`${fmtN(drafted.length - needAnswers)} ready, <span class="warn-t">${fmtN(needAnswers)} need answers</span>` : "packs ready"}</div></a>
            <a class="stat ${counts.filled ? "hot" : ""}" href="#/review"><div class="k">Waiting on you</div><div class="v">${fmtN(counts.filled || 0)}</div><div class="s">filled forms</div></a>
            <a class="stat" href="#/pipeline?status=submitted"><div class="k">Submitted</div><div class="v">${fmtN(counts.submitted || 0)}</div><div class="s">${fmtN(counts.approved || 0)} approved, queued</div></a>
            <a class="stat" href="#/pipeline?status=interview"><div class="k">Interviews</div><div class="v">${fmtN((counts.interview || 0) + (counts.offer || 0))}</div><div class="s">${counts.offer ? plural(counts.offer, "offer") : "keep going"}</div></a>
          </div>
        </div>
        <div class="section">
          <div class="section-head"><h2>Recently</h2></div>
          ${activityList((pipe.recent || []).slice(0, 7), items)}
        </div>
      </div>
      <div class="stack">
        <section class="card panel" aria-labelledby="todo-h">
          <h3 id="todo-h">Today</h3>
          <ul class="checklist">${checklist.map((c) => html`<li class="${c.done ? "done-t" : ""}">
            <span class="box ${c.done ? "is-done" : c.warn ? "is-warn" : "is-due"}">${c.done ? icon("tick") : ""}</span>
            <div><div class="t">${c.t}</div><div class="d">${c.d}</div></div>
            ${c.go ? html`<a class="go" href="${c.href}">${c.go}</a>` : c.copy ? html`<button class="btn sm ghost" data-action="copy" data-text="${c.copy}">Copy ask</button>` : html`<span></span>`}
          </li>`)}</ul>
        </section>
        ${due.length > 0 && html`<div class="nudge"><span class="ic">i</span><div><b>${plural(due.length, "follow-up")} due.</b> Recruiters say a weekly nudge beats another application.
          <div class="chips"><a class="chip accent" href="#/outreach" style="text-decoration:none">See who to nudge</a></div></div></div>`}
        <section class="card panel" aria-labelledby="idx-h">
          <h3 id="idx-h">Job index <span class="muted" style="letter-spacing:0;text-transform:none;font-weight:500">${lastSync ? `synced ${ago(lastSync)}` : "never synced"}</span></h3>
          <div class="index-big">${fmtN(js.open || 0)}</div>
          <div class="index-sub">open roles at ${fmtN(js.companies || 0)} companies, from ${fmtN(js.boards || 0)} public boards</div>
          <button class="btn" data-action="sync" ${S.syncing ? "disabled" : ""}>${S.syncing ? raw('<span class="spin"></span> Syncing') : html`${icon("sync")} Sync now`}</button>
        </section>
      </div>
    </div>`);
}

function activityList(events, items) {
  if (!events.length) return html`<p class="muted">No activity yet.</p>`;
  const byJob = new Map(items.map((a) => [a.jobId, a.job]));
  return html`<ul class="timeline">${events.map((e) => {
    const j = byJob.get(e.jobId);
    return html`<li><span><span class="who">${j ? j.company : ""}</span>${j ? " · " : ""}${describeEvent(e)}</span><time datetime="${e.at}">${short(e.at)}</time></li>`;
  })}</ul>`;
}

// ---------------------------------------------------------------------------
// Review

async function viewReview() {
  const id = ++S.renderId;
  paint(id, skeleton(2));
  let pipe;
  try { pipe = await get("/api/pipeline"); } catch (e) { return paint(id, errorState(e)); }
  const items = (pipe.items || []).filter((a) => a.status === "filled");
  S.reviewItems = items;
  const want = S.route.params.job;
  if (want) { const i = items.findIndex((a) => a.jobId === want); if (i >= 0) S.reviewSel = i; }
  S.reviewSel = Math.min(Math.max(0, S.reviewSel), Math.max(0, items.length - 1));
  S.sel = S.reviewSel;
  const head = html`<div class="head"><div>
    <div class="eyebrow">Review</div>
    <h1 class="title">${items.length ? `${plural(items.length, "application")} waiting for your yes` : "You're all caught up"}</h1>
    <p class="lede">Your agent filled these forms in a real browser and stopped before Submit. Check what it wrote. <em>Nothing is sent until you approve.</em></p>
  </div></div>`;
  if (!items.length) {
    return paint(id, html`${head}<div class="empty"><h3>Nothing to approve</h3><p>Filled applications land here with a screenshot of the form, the tailored resume, every answer, and any facts the truth guard could not verify.</p>${askAgent("Fill the application for my best match and show me before submitting")}</div>`);
  }
  paint(id, html`${head}
    <div class="review">
      <div class="rail" role="listbox" aria-label="Applications waiting">
        ${items.map((a, i) => html`<button class="rail-item ${i === S.reviewSel ? "is-sel" : ""}" role="option" aria-selected="${i === S.reviewSel}" data-row data-id="${a.jobId}" data-status="filled" data-action="pick" data-i="${i}">
          <span class="co">${a.job?.company || ""}</span><span class="ti">${a.job?.title || a.jobId}</span>
          <span class="meta"><span>Filled ${ago(a.updatedAt)}</span>${notHeld(a) && html`<span class="warn-t">Not open here</span>`}</span></button>`)}
        <p class="rail-note"><kbd>j</kbd> <kbd>k</kbd> to move, <kbd>a</kbd> to approve, <kbd>x</kbd> for not this one.</p>
      </div>
      <div id="sheetSlot"></div>
    </div>`);
  await renderSheet(id);
}

async function renderSheet(id = S.renderId) {
  const slot = $("#sheetSlot");
  const a = S.reviewItems[S.reviewSel];
  if (!slot || !a) return;
  slot.innerHTML = String(html`<div class="sheet"><div class="skel" style="height:520px;border-radius:0"></div></div>`);
  let d;
  try { d = await jobDetail(a.jobId); } catch (e) { if (id === S.renderId) slot.innerHTML = String(errorState(e)); return; }
  if (id !== S.renderId || S.reviewItems[S.reviewSel] !== a) return;
  const j = d.job || a.job || {};
  const pack = d.pack;
  const shot = findShot(d);
  const app = d.application || a;
  const { facts } = splitWarnings(pack?.warnings);
  // Fills since the form was read: the real fields and blanks. Older fills store none and show the pack answers.
  const fill = d.fill;
  const blanks = fill?.blanks || [];
  const failed = fill?.failed || [];
  const why = `Blank on the form: ${blanks.join(" · ")}`;
  const held = d.held;
  slot.innerHTML = String(html`<article class="sheet" data-sheet="${a.jobId}" aria-label="${j.title} at ${j.company}">
    <header class="sheet-head">
      <div style="min-width:0">
        <div class="co">${j.company}</div>
        <h2>${j.title}</h2>
        <div class="meta"><span>${locLine(j)}</span>${salary(j) && html`<span>${salary(j)}</span>`}<span>Filled ${ago(app.updatedAt)}</span>
          ${j.applyUrl && html`<span>via ${host(j.applyUrl)}</span>`}
          ${app.confirmationCode && html`<span title="One-time confirmation code from fill">Code <span class="mono">${app.confirmationCode}</span></span>`}${priorChip(d.priorApplications)}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-start">
        <button class="btn sm" data-action="open-job" data-id="${a.jobId}">Details</button>
        ${j.url && html`<a class="btn sm" href="${j.url}" target="_blank" rel="noopener">Posting ${icon("ext")}</a>`}
      </div>
    </header>
    <div class="sheet-body">
      <div class="shot-col">
        ${shot ? html`<div class="shot-frame" data-action="zoom" data-src="${shot}" role="button" tabindex="0" aria-label="Enlarge form screenshot"><img src="${shot}" alt="Screenshot of the filled application form for ${j.title} at ${j.company}"></div>`
          : html`<div class="empty compact"><p>No screenshot was saved for this fill. The form is still open in the browser window your agent used.</p></div>`}
        <div class="shot-cap"><span>The form as your agent left it, before Submit.</span><span>Click to enlarge</span></div>
      </div>
      <div class="detail-col">
        ${held === false && heldNote(a.jobId)}
        ${blanks.length > 0 && blankSummary(blanks)}
        ${failed.length > 0 && failedSummary(failed)}
        <div class="block"><h4>Truth guard</h4>${pack ? checksBlock(pack) : html`<p class="muted">No pack found for this application.</p>`}</div>
        ${fill ? html`<div class="block"><h4>Answers on the form</h4>${filledList(fill.filled)}</div>`
          : pack && html`<div class="block"><h4>Answers on the form</h4>${answersList(pack.answers)}</div>`}
        ${pack && html`<div class="block"><h4>Attached documents</h4>${packTabs(pack, a.jobId, { noAnswers: true, noChecks: true })}</div>`}
      </div>
    </div>
    <footer class="decide">
      <p class="why"><b>Nothing has been sent.</b> ${d.warning ? html`<b class="warn-t">${d.warning}.</b>` : ""} ${blanks.length ? html`<b class="warn-t">${blankLine(blanks.length)}.</b> Approve unlocks once a new fill has none.` : held === false ? html`<b class="warn-t">The form isn't open here,</b> so approving only records your yes. Re-fill to submit from this dashboard.` : "Approving presses Submit on this exact form."} ${facts.length ? html`You have <b>${plural(facts.length, "unverified fact")}</b> above.` : ""}</p>
      <div class="btns">
        <button class="btn lg danger-ghost" data-action="reject" data-id="${a.jobId}">Not this one <kbd>x</kbd></button>
        ${blanks.length ? html`<button class="btn lg" data-action="approve" data-id="${a.jobId}" aria-disabled="true" aria-describedby="approveWhy" title="${why}">${approveLabel(held)} <kbd>a</kbd></button><span class="sr" id="approveWhy">${why}</span>`
          : held === false ? html`<button class="btn lg" data-action="approve" data-id="${a.jobId}">${approveLabel(held)} <kbd>a</kbd></button><button class="btn lg primary refill" data-action="refill" data-id="${a.jobId}">Re-fill form</button>`
          : html`<button class="btn lg primary" data-action="approve" data-id="${a.jobId}">${approveLabel(held)} <kbd>a</kbd></button>`}
      </div>
    </footer>
  </article>`);
}

// ---------------------------------------------------------------------------
// approve / reject

async function approveJob(jobId) {
  const d = await jobDetail(jobId).catch(() => null);
  const j = d?.job || {};
  const blanks = d?.fill?.blanks || [];
  if (blanks.length) {
    return confirmModal({
      title: "Required fields are blank",
      body: html`<p>The form for <b>${j.title || "this role"}</b> at <b>${j.company || "this company"}</b> can't be approved yet. ${blankLine(blanks.length)}:</p>
        <ul>${blanks.map((l) => html`<li>${l}</li>`)}</ul><p style="margin-top:10px">Answer these in the pack, then fill again.</p>`,
      ok: "Got it",
      cancel: "",
    });
  }
  const { facts } = splitWarnings(d?.pack?.warnings);
  const held = d?.held;
  const r = await confirmModal({
    title: "Approve this application?",
    body: html`${held === false
      ? html`<p>The form for <b>${j.title || "this role"}</b> at <b>${j.company || "this company"}</b> is <b>not open in this dashboard</b>, so nothing is submitted from here. Approving records your yes for this exact fill; only an agent that holds the form in its own window can then submit it.</p>
        <p style="margin-top:10px">To submit from here, cancel and use Re-fill form.</p>`
      : html`<p>OpenApply presses Submit on <b>${j.title || "this role"}</b> at <b>${j.company || "this company"}</b> exactly as filled. Nothing else is sent.</p>`}
      ${facts.length > 0 && html`<ul>${facts.map((f) => html`<li>${f}</li>`)}</ul><p style="margin-top:10px">These facts are not in your master resume. Approve only if they are true.</p>`}`,
    ok: approveLabel(held),
  });
  if (!r.ok) return;
  let res;
  try {
    // Send the code of the fill on screen: the server refuses if the agent filled again since.
    res = await post(jobPath(jobId, "/approve"), { code: d?.application?.confirmationCode });
  } catch (e) { return toast(e.message, { err: true }); }
  S.cache.delete(jobId);
  const sheet = $(`[data-sheet="${CSS.escape(jobId)}"]`);
  if (sheet) {
    $(".decide .btns", sheet).innerHTML = '<span class="stamp">Approved</span>';
    await sleep(650);
    sheet.classList.add("leaving");
    await sleep(380);
  }
  if (res?.run) {
    toast(`Approved. Submitting ${j.company || "it"} now…`);
    await afterMutation();
    return watchSubmit(jobId, j.company || "the company");
  }
  // No submit started: the form is not held in this process. Say so plainly; only an agent holding it can submit.
  toast(`Approved, but nothing was submitted: the ${j.company || "this"} form isn't open in this dashboard. Re-fill to submit from here, or let the agent holding it submit.`, {
    action: "Re-fill", ms: 12000, onAction: () => refill(jobId),
  });
  await afterMutation();
}

/** Follow the Submit press that approval started, then say plainly what happened. */
async function watchSubmit(jobId, company) {
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    let r;
    try { r = (await get(jobPath(jobId, "/run"))).run; } catch { continue; }
    if (!r || r.kind !== "submit" || runBusy(r)) continue;
    S.cache.delete(jobId);
    await afterMutation();
    if (r.state === "failed") return toast(`Not submitted: ${r.error || "unknown error"}`, { err: true });
    return toast(`Submitted to ${company}.`);
  }
}

/**
 * Open and fill a form again because the filled one is no longer held here. A filled (or approved) application goes
 * back to drafted first, since only a drafted pack can be filled; the new fill gets a new code and needs a new Approve.
 */
async function refill(jobId) {
  // Read fresh, never the cache: an agent may have submitted since this page drew. The server refuses past approved too.
  const st = (await jobDetail(jobId, true).catch(() => null))?.application?.status;
  if (st === "filled" || st === "approved") {
    try { await post(jobPath(jobId, "/refill")); } catch (e) { toast(e.message, { err: true }); return afterMutation(); }
    S.cache.delete(jobId);
  } else if (st !== "drafted") {
    toast(st ? `Not re-filled: it is ${(STATUS_LABEL[st] || st).toLowerCase()} now.` : "Could not load this job. Try again.", { err: true });
    return afterMutation();
  }
  return startRun(jobId, "fill");
}

async function rejectJob(jobId) {
  const d = await jobDetail(jobId).catch(() => null);
  const j = d?.job || {};
  const r = await confirmModal({
    title: "Not this one?",
    body: html`<p>The application to <b>${j.company || "this company"}</b> is withdrawn and never submitted. You can move it back from the pipeline later.</p>`,
    input: "What was off? Optional. Saved as a note so your agent can do better next time.",
    ok: "Withdraw it",
    danger: true,
  });
  if (!r.ok) return;
  try {
    await post(jobPath(jobId, "/status"), { status: "withdrawn", ...(r.text ? { note: r.text } : {}) });
  } catch (e) { return toast(e.message, { err: true }); }
  S.cache.delete(jobId);
  toast(`Withdrawn. ${j.company || "It"} will not be submitted.`);
  await afterMutation();
}

async function setStatus(jobId, st) {
  try {
    if (st === "approved") return approveJob(jobId);
    await post(jobPath(jobId, "/status"), { status: st });
    S.cache.delete(jobId);
    toast(`Moved to ${STATUS_LABEL[st]}.`);
  } catch (e) { toast(e.message, { err: true }); }
  await afterMutation();
}

async function saveJob(jobId) {
  try { await post(jobPath(jobId, "/save"), {}); S.cache.delete(jobId); toast("Saved to your pipeline."); }
  catch (e) { return toast(e.message, { err: true }); }
  await afterMutation();
}

async function afterMutation() {
  await refreshGlobals();
  if (S.drawer) await openJob(S.drawer.id, true);
  await VIEWS[S.route.name]();
}

// ---------------------------------------------------------------------------
// Answers to write: every TODO answer across saved and drafted packs, one card per question.
// Each field saves through PUT /api/jobs/:id/pack, so the fact and voice checks run on it again.

const TODO_FIELDS = "textarea[data-todo-job]";
/** Questions whose answer belongs to one company (why us, why this role): never offered as one answer for all. */
const OWN_REASON_Q = /\bwhy\b|\binterest|\bexcit|\bdraws? you|\battracts? you/i;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function viewAnswers() {
  const id = ++S.renderId;
  if (!S.todos.length) paint(id, skeleton(3));
  try { await refreshGlobals(); } catch (e) { return paint(id, errorState(e)); }
  const groups = S.todos;
  const n = todoCount();
  const packs = todoJobs().size;
  paint(id, html`
    <div class="head"><div>
      <div class="eyebrow">Answers to write</div>
      <h1 class="title">${n ? `${plural(n, "answer")} only you can write` : "Every answer is written"}</h1>
      <p class="lede">${n ? html`They hold up <em>${plural(packs, "pack")}</em>: Fill form stays locked until each pack's answers are in. A question asked by more than one company is listed once.` : "No saved or drafted pack is waiting on you. New ones land here when a draft leaves a question for you."}</p>
    </div></div>
    ${n ? html`<div class="answers">${groups.map((g, gi) => html`<section class="acard" id="q-${gi}" data-group>
      <header><h2>${g.question}</h2>${g.jobs.length > 1 && html`<span class="chip outline">${g.jobs.length} packs</span>`}</header>
      ${g.jobs.map((x, i) => {
        const lead = !g.cover && TODO_LEAD.test(x.current);
        const fid = `t-${gi}-${i}`;
        return html`<div class="arow" data-field>
          <div class="arow-h"><label for="${fid}"><a href="#" data-action="open-job" data-id="${x.jobId}">${x.company}</a><span class="muted"> · ${x.title}</span></label>${x.drafted && html`<span class="chip ${x.drafted === "review" ? "accent" : "warn"}" title="Open the job to keep it as drafted">${x.drafted === "review" ? "Drafted, review" : "No honest link: rewrite"}</span>`}<span class="save-state" aria-live="polite"></span></div>
          <textarea class="input" id="${fid}" rows="${g.cover ? 10 : 2}" data-todo-job="${x.jobId}" data-todo-q="${g.question}" ${g.cover ? raw("data-todo-cover") : ""}
            placeholder="${lead ? x.current.replace(TODO_LEAD, "") || "Your answer" : "Your answer"}">${lead ? "" : x.current}</textarea>
          <div data-warns></div>
          ${i === 0 && g.jobs.length > 1 && !g.cover && !OWN_REASON_Q.test(g.question) && html`<div class="arow-acts"><button type="button" class="btn sm ghost" data-action="todo-all">Use this answer for all ${g.jobs.length}</button><span class="muted">Each company still gets its own copy to edit.</span></div>`}
        </div>`;
      })}
    </section>`)}</div>
    <p class="edit-hint">Saves when you leave a field or press <kbd>⌘</kbd> <kbd>↵</kbd>. Write it the way you'd say it: recruiters read every one.</p>`
    : html`<div class="empty"><h3>Nothing to write</h3><p>When a drafted pack leaves a question only you can answer (why this company, relocation, start date), it shows up here.</p></div>`}`);
  for (const t of $$(TODO_FIELDS)) { t.dataset.orig = t.value; autosize(t); }
  const want = S.route.params.q;
  if (want !== undefined) {
    const el = document.getElementById(`q-${want}`);
    if (el) { el.scrollIntoView({ block: "start" }); $("textarea", el)?.focus({ preventScroll: true }); }
  }
}

/** Save one answer field from the Answers view. Unchanged or still empty fields send nothing. */
async function saveTodo(t) {
  if (t.value === t.dataset.orig || t.dataset.pending === t.value || !t.value.trim()) return;
  const v = t.value, jobId = t.dataset.todoJob, q = t.dataset.todoQ;
  t.dataset.pending = v;
  saveState(t, "saving");
  let r;
  try { r = await api("PUT", jobPath(jobId, "/pack"), "todoCover" in t.dataset ? { coverLetter: v } : { answers: { [q]: v } }); }
  catch (e) { delete t.dataset.pending; saveState(t, "error", e.message); toast(`Not saved: ${e.message}`, { err: true }); return; }
  delete t.dataset.pending;
  t.dataset.orig = v;
  S.cache.delete(jobId);
  const open = r.todos.includes(q);
  const row = t.closest(".arow");
  row.classList.toggle("done", !open);
  saveState(t, open ? "" : "saved");
  $("[data-warns]", row).innerHTML = String(fieldWarns(r.pack, "todoCover" in t.dataset ? "the cover letter" : `the answer to "${q}"`));
  if (!r.todos.length) toast(`${$("label a", row)?.textContent || "That pack"} has every answer. Fill form is ready.`);
  await refreshGlobals(); // nav count and Today's numbers; the list itself stays put while you write
  const left = todoCount();
  const title = $("#view .title");
  if (title) title.textContent = left ? `${plural(left, "answer")} only you can write` : "Every answer is written";
}

/** Copy the first company's answer to every other pack that asks the same question, and save each. */
async function useForAll(btn) {
  const g = btn.closest("[data-group]");
  const [first, ...rest] = $$(TODO_FIELDS, g);
  if (!first.value.trim()) { first.focus(); return toast("Write the first answer, then copy it."); }
  const company = (t) => $("label a", t.closest(".arow"))?.textContent.trim() || "";
  const named = [first, ...rest].map(company).filter((n, i, all) => n.length >= 2 && all.indexOf(n) === i
    && new RegExp(`(^|[^\\p{L}\\p{N}])${reEsc(n)}(?![\\p{L}\\p{N}])`, "u").test(first.value));
  if (named.length) { first.focus(); return toast(`This answer names ${named.join(", ")}. Write each company its own, or take the name out first.`, { err: true }); }
  await saveTodo(first);
  const copy = [], kept = [];
  for (const t of rest) { (t.value.trim() && t.value !== first.value ? kept : copy).push(t); }
  for (const t of copy) { t.value = first.value; autosize(t); }
  await Promise.all(copy.map(saveTodo));
  if (kept.length) toast(`Copied to ${plural(copy.length, "other pack")}. Left ${kept.map(company).join(", ")} as written: ${kept.length === 1 ? "it already has" : "they already have"} text, so edit ${kept.length === 1 ? "it" : "them"} yourself.`);
}

// ---------------------------------------------------------------------------
// Matches

async function viewMatches() {
  const id = ++S.renderId;
  const f = S.mf;
  const firstPaint = !$("#mq");
  if (firstPaint) paint(id, html`${matchesHead()}<div id="mlist">${skeleton(5)}</div>`);
  const p = new URLSearchParams({ limit: "80" });
  if (f.q) p.set("q", f.q);
  if (f.days) p.set("days", f.days);
  if (f.remote) p.set("remote", "1");
  let list, pipe;
  try { [list, pipe] = await Promise.all([get(`/api/matches?${p}`), get("/api/pipeline").catch(() => ({ items: [] }))]); }
  catch (e) { if (id === S.renderId) $("#mlist").innerHTML = String(errorState(e)); return; }
  if (id !== S.renderId) return;
  list = (Array.isArray(list) ? list : list?.matches || []).filter((m) => m && m.job);
  if (f.remote) list = list.filter((m) => m.job.remote);
  const apps = new Map((pipe.items || []).map((a) => [a.jobId, a]));
  $("#mcount").textContent = list.length ? `${plural(list.length, "match", "matches")}` : "";
  $("#mlist").innerHTML = String(list.length ? html`<div class="table" role="list">
    <div class="thead cols-match" aria-hidden="true"><span>Score</span><span>Role</span><span>Location</span><span>Salary</span><span>Posted</span><span class="right">Status</span></div>
    ${list.map((m) => matchRow(m, apps.get(m.job.id)))}
  </div>` : html`<div class="empty"><h3>${f.q || f.days || f.remote ? "No matches for these filters" : "No matches yet"}</h3>
    <p>${f.q || f.days || f.remote ? "Loosen a filter, or ask your agent to widen your targets." : "Matches are scored against your profile targets and master resume. Sync the index, then ask your agent to look."}</p>
    ${askAgent("Find me remote product roles posted this week and rank the best ten")}</div>`);
  applySel(false);
}
function matchesHead() {
  const f = S.mf;
  return html`<div class="head"><div>
      <div class="eyebrow">Matches</div>
      <h1 class="title">Ranked for you</h1>
      <p class="lede">Scored against your targets and master resume. Open one to see the posting, company intel and any pack your agent made.</p>
    </div></div>
    <div class="toolbar" role="search">
      <label class="sr" for="mq">Filter matches</label>
      <input class="input grow" id="mq" type="search" placeholder="Filter by title, company or keyword" value="${f.q}" data-bind="mf.q">
      <div class="seg" role="group" aria-label="Remote">
        <button type="button" aria-pressed="${!f.remote}" data-action="mf-remote" data-v="0">Any location</button>
        <button type="button" aria-pressed="${f.remote}" data-action="mf-remote" data-v="1">Remote</button>
      </div>
      <label class="sr" for="mdays">Posted within</label>
      <select class="input" id="mdays" data-bind="mf.days">
        ${[["", "Any time"], ["1", "Past day"], ["3", "Past 3 days"], ["7", "Past week"], ["14", "Past 2 weeks"], ["30", "Past month"]].map(([v, l]) => html`<option value="${v}" ${f.days === v ? "selected" : ""}>${l}</option>`)}
      </select>
      <span class="count-note" id="mcount"></span>
    </div>`;
}
function matchRow(m, app) {
  const j = m.job;
  const sal = salary(j);
  return html`<div class="row cols-match" role="listitem" data-row data-id="${j.id}" data-status="${app?.status || ""}" data-open="drawer">
    <div class="c-score">${scoreRing(m.score)}</div>
    <div class="c-main" style="min-width:0">
      <div class="role"><a href="#" data-action="open-job" data-id="${j.id}">${j.title}</a></div>
      <div class="sub">${j.company}${j.department ? ` · ${j.department}` : ""} ${priorChip(m.priorApplications)}</div>
      <div class="m-line"><span>${locLine(j)}</span>${sal && html`<span>${sal}</span>`}<span>${short(j.postedAt || j.firstSeen)}</span></div>
      ${(m.reasons || []).length > 0 && html`<div class="chips reasons">${m.reasons.slice(0, 3).map((r) => html`<span class="chip">${r}</span>`)}${m.reasons.length > 3 ? html`<span class="chip outline">+${m.reasons.length - 3}</span>` : ""}</div>`}
    </div>
    <div class="c-loc c-hide-m ink2" style="font-size:13.5px">${locLine(j)}</div>
    <div class="c-sal c-hide-m salary ${sal ? "" : "none"}">${sal || "Not posted"}</div>
    <div class="c-age c-hide-m muted num" style="font-size:13px">${short(j.postedAt || j.firstSeen)}</div>
    <div class="c-act right" style="display:flex;justify-content:flex-end">${app ? status(app.status) : html`<button class="btn sm" data-action="save" data-id="${j.id}">${icon("bookmark")} Save</button>`}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Search

async function viewSearch(append = false) {
  const id = ++S.renderId;
  const q = S.route.params.q || "";
  const f = S.sf;
  if (!append) f.offset = 0;
  if (!$("#sq") || !append) {
    paint(id, html`<div class="head"><div><div class="eyebrow">Search</div><h1 class="title">${q ? html`Results for <span style="font-style:italic">${q}</span>` : "Search the whole index"}</h1>
      <p class="lede">Every open role from every board OpenApply syncs, not just your matches.</p></div></div>
      <form class="toolbar" id="searchForm" role="search">
        <label class="sr" for="sq">Keywords</label>
        <input class="input grow" id="sq" name="q" type="search" placeholder="Try: platform product manager" value="${q}">
        <label class="sr" for="sloc">Location</label>
        <input class="input" id="sloc" style="width:170px" placeholder="Location" value="${f.location}" data-bind="sf.location">
        <div class="seg" role="group" aria-label="Remote">
          <button type="button" aria-pressed="${!f.remote}" data-action="sf-remote" data-v="0">Any</button>
          <button type="button" aria-pressed="${f.remote}" data-action="sf-remote" data-v="1">Remote</button>
        </div>
        <label class="sr" for="sdays">Posted within</label>
        <select class="input" id="sdays" data-bind="sf.days">${[["", "Any time"], ["1", "Past day"], ["7", "Past week"], ["30", "Past month"]].map(([v, l]) => html`<option value="${v}" ${f.days === v ? "selected" : ""}>${l}</option>`)}</select>
        <button class="btn primary" type="submit">Search</button>
      </form>
      <div id="slist">${skeleton(4)}</div>`);
  }
  const p = new URLSearchParams({ limit: "25", offset: String(f.offset) });
  if (q) p.set("q", q);
  if (f.location) p.set("location", f.location);
  if (f.remote) p.set("remote", "1");
  if (f.days) p.set("days", f.days);
  let res, pipe;
  try { [res, pipe] = await Promise.all([get(`/api/jobs?${p}`), get("/api/pipeline").catch(() => ({ items: [] }))]); }
  catch (e) { if (id === S.renderId) $("#slist").innerHTML = String(errorState(e)); return; }
  if (id !== S.renderId) return;
  const apps = new Map((pipe.items || []).map((a) => [a.jobId, a]));
  const jobs = res?.jobs || [];
  S.searchJobs = append ? [...(S.searchJobs || []), ...jobs] : jobs;
  const total = res?.total ?? S.searchJobs.length;
  $("#slist").innerHTML = String(S.searchJobs.length ? html`
    <p class="muted" style="font-size:12.5px;margin:-4px 0 10px">${plural(total, "open role")}${q ? ` for "${q}"` : ""}</p>
    <div class="table" role="list">
      <div class="thead cols-search" aria-hidden="true"><span>Role</span><span>Location</span><span>Salary</span><span>Posted</span><span class="right"></span></div>
      ${S.searchJobs.map((j) => searchRow(j, apps.get(j.id)))}
      ${S.searchJobs.length < total && html`<div class="loadmore"><button class="btn" data-action="more">Show ${Math.min(25, total - S.searchJobs.length)} more</button></div>`}
    </div>` : html`<div class="empty"><h3>No roles found</h3><p>Try fewer words, or sync the index if it has been a while.</p>${askAgent(q ? `Search more boards for ${q} roles` : "Sync the job index and tell me what's new")}</div>`);
  applySel(false);
}
function searchRow(j, app) {
  const sal = salary(j);
  return html`<div class="row cols-search" role="listitem" data-row data-id="${j.id}" data-status="${app?.status || ""}" data-open="drawer">
    <div class="c-main" style="min-width:0">
      <div class="role"><a href="#" data-action="open-job" data-id="${j.id}">${j.title}</a></div>
      <div class="sub">${j.company}${j.department ? ` · ${j.department}` : ""} · <span class="muted">${j.ats}</span></div>
      <div class="m-line"><span>${locLine(j)}</span>${sal && html`<span>${sal}</span>`}<span>${short(j.postedAt || j.firstSeen)}</span></div>
    </div>
    <div class="c-loc c-hide-m ink2" style="font-size:13.5px">${locLine(j)}</div>
    <div class="c-sal c-hide-m salary ${sal ? "" : "none"}">${sal || "Not posted"}</div>
    <div class="c-age c-hide-m muted num" style="font-size:13px">${short(j.postedAt || j.firstSeen)}</div>
    <div class="c-act" style="display:flex;justify-content:flex-end">${app ? status(app.status) : html`<button class="btn sm" data-action="save" data-id="${j.id}">${icon("bookmark")} Save</button>`}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Pipeline

const GROUPS = [
  ["Waiting on you", ["filled", "needs_human"]],
  ["In progress", ["saved", "drafted", "approved"]],
  ["Out the door", ["submitted", "interview", "offer"]],
  ["Closed", ["rejected", "withdrawn", "ghosted"]],
];
// Imported history (source "history") is listed apart, so it never crowds the roles in play.
const isPast = (a) => a.source === "history";
const activeCounts = (items) => Object.fromEntries(STATUSES.map((s) => [s, items.filter((a) => !isPast(a) && a.status === s).length]));
const HISTORY_ORDER = ["submitted", "interview", "offer", "rejected", "ghosted", "withdrawn"];

async function viewPipeline() {
  const id = ++S.renderId;
  if (S.route.params.status && STATUSES.includes(S.route.params.status)) S.pipeFilter = S.route.params.status;
  paint(id, skeleton(5));
  let pipe;
  try { pipe = await get("/api/pipeline"); } catch (e) { return paint(id, errorState(e)); }
  const all = pipe.items || [];
  const items = all.filter((a) => !isPast(a));
  const past = all.filter(isPast);
  const counts = activeCounts(items);
  const total = items.length;
  const filt = S.pipeFilter;
  const shown = filt ? items.filter((a) => a.status === filt) : items;
  paint(id, html`
    <div class="head"><div><div class="eyebrow">Pipeline</div><h1 class="title">${plural(total, "application")}</h1>
      <p class="lede">Every role you saved or your agent touched, grouped by where it stands.${past.length ? " Applications from before OpenApply are in History, below." : ""}</p></div>
      ${filt && html`<button class="btn" data-action="pipe-filter" data-v="">Show all</button>`}</div>
    <div class="stages" role="group" aria-label="Filter by status">${STATUSES.map((s) => html`<button class="stage ${counts[s] ? "" : "zero"} ${s === "filled" && counts[s] ? "hot" : ""}" aria-pressed="${filt === s}" data-action="pipe-filter" data-v="${s === filt ? "" : s}">
      <span class="k">${STAGE_LABEL[s]}</span><span class="v">${fmtN(counts[s] || 0)}</span></button>`)}</div>
    <div class="pipe">
      <div>
        ${!total ? html`<div class="empty"><h3>Your pipeline is empty</h3><p>Save a role from Matches, or let your agent draft packs for your best matches.</p>${askAgent("Save my top 5 matches and draft packs for the top 2")}</div>` : ""}
        ${GROUPS.map(([name, sts]) => {
          const g = shown.filter((a) => sts.includes(a.status));
          if (!g.length) return "";
          return html`<section class="group"><div class="group-h"><h3>${name}</h3><span class="n">${g.length}</span></div>
            <div class="table">${g.map((a) => pipeRow(a))}</div></section>`;
        })}
        ${total > 0 && !shown.length ? html`<div class="empty compact"><p>Nothing is ${STATUS_LABEL[filt]?.toLowerCase()} right now.</p></div>` : ""}
        ${historySection(past)}
      </div>
      <aside class="feed card panel" aria-labelledby="feed-h"><h3 id="feed-h">Activity</h3>${activityList((pipe.recent || []).slice(0, 30), all)}</aside>
    </div>`);
}
/** Past applications, collapsed until opened, grouped by how they ended. */
function historySection(past) {
  if (!past.length) return "";
  const when = (a) => a.submittedAt || a.updatedAt;
  const groups = [...HISTORY_ORDER, ...STATUSES.filter((s) => !HISTORY_ORDER.includes(s))]
    .map((s) => [s, past.filter((a) => a.status === s).sort((x, y) => when(y).localeCompare(when(x)))])
    .filter(([, g]) => g.length);
  return html`<details class="history" data-history ${S.historyOpen ? "open" : ""}>
    <summary><h3>History</h3><span class="n">${past.length}</span><span class="aside">Applied before OpenApply, imported</span></summary>
    ${groups.map(([s, g]) => html`<section class="hgroup" aria-label="${STAGE_LABEL[s]}: ${g.length}">
      <div class="hgroup-h">${status(s, STAGE_LABEL)}<span class="n">${g.length}</span></div>
      <div class="table">${g.map((a) => html`<div class="hrow">
        <span class="co">${a.job?.company || a.jobId}</span><span class="ti">${a.job?.title || ""}</span>
        <time datetime="${when(a).slice(0, 10)}" title="Applied ${when(a).slice(0, 10)}">${pday(when(a))}</time></div>`)}</div>
    </section>`)}
  </details>`;
}
function rowRun(a) {
  if (S.blocked.has(a.jobId)) return dupeBlock(a.jobId);
  if (runBusy(a.run)) return html`<div class="row-run muted"><span class="spin" aria-hidden="true"></span>${{ draft: "Drafting pack", whyus: "Drafting why-us", fill: "Filling form", submit: "Submitting" }[a.run.kind]}</div>`;
  const act = a.status === "saved" ? ["draft", html`${icon("spark")} Draft pack`] : a.status === "drafted" ? ["fill", "Fill form"] : notHeld(a) ? ["refill", "Re-fill form"] : null;
  if (!act) return "";
  return html`<div class="row-run"><button class="btn sm" data-action="${act[0]}" data-id="${a.jobId}">${act[1]}</button>${a.run?.state === "failed" && html`<span class="warn-t" title="${a.run.error || ""}">Last ${a.run.kind} failed</span>`}</div>`;
}
function pipeRow(a) {
  const j = a.job || {};
  return html`<div class="prow" data-row data-id="${a.jobId}" data-status="${a.status}" data-open="${a.status === "filled" ? "review" : "drawer"}">
    <div style="min-width:0">
      <div class="role" style="font-weight:600"><a href="#" data-action="open-job" data-id="${a.jobId}" style="text-decoration:none">${j.title || a.jobId}</a></div>
      <div class="sub muted" style="font-size:13px">${j.company || ""}${j.location ? ` · ${j.location}` : ""}${a.submittedAt && !["saved", "drafted", "filled", "approved"].includes(a.status) ? html` · <span title="Submitted ${a.submittedAt.slice(0, 10)}">Applied ${ago(a.submittedAt)}</span>` : ""}</div>
      ${(a.priorApplications?.length > 0 || notHeld(a)) && html`<div class="row-flags">${notHeld(a) && html`<span class="chip warn" title="The filled form is no longer open in the fill browser, so Approve here would not submit it.">Form not open here</span>`}${priorChip(a.priorApplications)}</div>`}
      ${a.notes && html`<div class="note">${a.notes}</div>`}
      ${rowRun(a)}
    </div>
    <div>
      <label class="sr" for="st-${a.jobId}">Status for ${j.title || a.jobId}</label>
      <select class="input" id="st-${a.jobId}" data-action="set-status" data-id="${a.jobId}">${STATUSES.map((s) => html`<option value="${s}" ${s === a.status ? "selected" : ""}>${STAGE_LABEL[s]}</option>`)}</select>
    </div>
    <div class="when" title="${a.updatedAt}">${ago(a.updatedAt)}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Outreach

async function viewOutreach() {
  const id = ++S.renderId;
  paint(id, skeleton(4));
  let list = [], due = [], unavailable = false;
  try {
    const [o, f] = await Promise.all([get("/api/outreach"), get("/api/followups").catch(() => [])]);
    list = Array.isArray(o) ? o : o?.items || [];
    due = Array.isArray(f) ? f : [];
  } catch (e) {
    if (e.status === 404) unavailable = true; else return paint(id, errorState(e));
  }
  S.followups = due;
  S.drafts = list.filter((o) => o.status === "draft");
  list = list.filter((o) => o.status !== "draft");
  renderChrome();
  const drafts = liveDrafts();
  const nag = new Map(dueOf("send_or_close").map((r) => [r.id, r]));
  const closing = dueOf("propose_close");
  const nudges = dueOf("follow_up");
  const f = S.outFilter;
  const shown = f === "all" ? list : list.filter((o) => o.status === f);
  const replied = list.filter((o) => o.status === "replied" || o.status === "meeting").length;
  paint(id, html`
    <div class="head"><div><div class="eyebrow">Outreach</div>
      <h1 class="title">${drafts.length ? `${plural(drafts.length, "message")} ready to send` : nudges.length ? `${plural(nudges.length, "follow-up")} due` : "People, not portals"}</h1>
      <p class="lede">${list.length ? html`${plural(list.length, "person", "people")} contacted, <em>${replied} replied</em>. A short note to the person hiring, then a weekly nudge, outperforms another cold application.` : "Track the recruiters and hiring managers you reach out to, and when to nudge them."}</p>
    </div></div>
    ${unavailable ? html`<div class="empty"><h3>Outreach tracking is not on this server yet</h3><p>Update OpenApply to log touches and get follow-up reminders.</p></div>` : html`
    ${drafts.length > 0 && html`<div class="section" style="margin-top:0">
      <div class="section-head"><h2>Ready to send</h2><span class="aside">Copy, send it yourself, then mark it sent</span></div>
      <div class="due-list">${drafts.map((o) => {
        const n = nag.get(o.id); // set once the draft has waited long enough to nag
        const app = n?.applicationStatus || o.applicationStatus;
        return html`<div class="due draft" data-row data-oid="${o.id}">
        <div style="min-width:0">
          <div><span class="who">${o.person}</span> <span class="muted">${o.role ? `${o.role}, ` : ""}${o.jobId ? html`<a href="#" data-action="open-job" data-id="${o.jobId}">${o.company}</a>` : o.company} · ${o.channel}${o.contact ? html` · ${/^https?:/.test(o.contact) ? html`<a href="${o.contact}" target="_blank" rel="noopener">open profile</a>` : o.contact}` : ""}</span></div>
          ${(n || app) && html`<div class="chips" style="margin-top:6px">
            ${n && html`<span class="chip ${n.waitingOn ? "" : "warn"}">${plural(n.daysSinceTouch ?? 0, "day")} unsent</span>`}
            ${n?.waitingOn === "submit" && html`<span class="chip warn">Hold until the application is submitted</span>`}
            ${app && html`<span class="chip outline">Application: ${STATUS_LABEL[app] || app}</span>`}
          </div>`}
          ${n?.suggestion && html`<p class="sugg">${n.suggestion}</p>`}
          ${o.notes && html`<p class="muted" style="margin-top:4px">${o.notes}</p>`}
          <p class="draft-msg">${o.message}</p>
        </div>
        <div class="acts">
          <button class="btn sm" data-action="copy" data-text="${o.message}" data-msg="Copied. Paste it into ${o.channel}.">Copy</button>
          <button class="btn sm ${n?.waitingOn ? "" : "primary"}" data-action="out-sent" data-id="${o.id}">I sent it</button>
          <button class="btn sm" data-action="out" data-id="${o.id}" data-status="closed">Skip</button>
        </div></div>`;
      })}</div>
    </div>`}
    ${closing.length > 0 && html`<div class="section" style="${drafts.length ? "" : "margin-top:0"}">
      <div class="section-head"><h2>Roles that closed</h2><span class="aside">Close the outreach, or keep it open on purpose</span></div>
      <div class="due-list">${closing.map((o) => html`<div class="due draft" data-row data-oid="${o.id}">
        <div style="min-width:0">
          <div><span class="who">${o.person}</span> <span class="muted">${o.role ? `${o.role}, ` : ""}${o.jobId ? html`<a href="#" data-action="open-job" data-id="${o.jobId}">${o.company}</a>` : o.company} · ${o.channel} · ${o.status === "draft" ? "never sent" : `last touch ${ago(o.lastTouchAt || o.sentAt)}`}</span></div>
          ${o.suggestion && html`<p class="sugg">${o.suggestion}</p>`}
        </div>
        <div class="acts">
          <button class="btn sm" data-action="out" data-id="${o.id}" data-status="closed" data-msg="Closed.">Close</button>
        </div></div>`)}</div>
    </div>`}
    <div class="section" style="${drafts.length || closing.length ? "" : "margin-top:0"}">
      <div class="section-head"><h2>Follow-ups due</h2><span class="aside">A week or more since the last touch</span></div>
      ${nudges.length ? html`<div class="due-list">${nudges.map((o) => html`<div class="due" data-row data-oid="${o.id}">
        <div class="days"><b>${o.daysSinceTouch ?? "?"}</b><span>days</span></div>
        <div style="min-width:0">
          <div><span class="who">${o.person}</span> <span class="muted">${o.role ? `${o.role}, ` : ""}${o.company} · ${o.channel}${o.followUps ? ` · ${plural(o.followUps, "nudge")} so far` : ""}</span></div>
          ${o.suggestion && html`<p class="sugg">${o.suggestion}</p>`}
        </div>
        <div class="acts">
          <button class="btn sm primary" data-action="out" data-id="${o.id}" data-followed="1">Followed up</button>
          <button class="btn sm" data-action="out" data-id="${o.id}" data-status="replied">Replied</button>
          <button class="btn sm" data-action="out" data-id="${o.id}" data-status="meeting">Meeting</button>
        </div></div>`)}</div>`
        : html`<div class="empty compact"><p>Nobody is waiting on a nudge. ${list.length ? "Nice." : ""}</p>${!list.length ? askAgent("Find the hiring manager for my top 3 matches and draft a short note to each") : ""}</div>`}
    </div>
    <div class="section">
      <div class="section-head"><h2>Every touch</h2>
        <div class="seg" role="group" aria-label="Filter by status">${["all", ...OUT_STATUSES].map((s) => html`<button type="button" aria-pressed="${f === s}" data-action="out-filter" data-v="${s}">${s === "all" ? "All" : OUT_LABEL[s]}</button>`)}</div>
      </div>
      ${shown.length ? html`<div class="table">
        <div class="thead cols-out" aria-hidden="true"><span>Person</span><span>Company</span><span>Channel</span><span>Last touch</span><span>Status</span><span>Nudges</span><span class="right">Update</span></div>
        ${shown.map((o) => html`<div class="row cols-out static">
          <div class="c-main" style="min-width:0"><div class="role">${o.person}</div><div class="sub">${o.role || "contact"}${o.notes ? html` · <span style="font-style:italic;font-family:var(--serif)">${o.notes}</span>` : ""}</div>
            <div class="m-line"><span>${o.company}</span><span>${o.channel}</span><span>${short(o.lastTouchAt || o.sentAt)}</span>${status(o.status, OUT_LABEL)}</div></div>
          <div class="c-hide-m" style="min-width:0">${o.jobId ? html`<a href="#" data-action="open-job" data-id="${o.jobId}">${o.company}</a>` : o.company}</div>
          <div class="c-hide-m ink2">${o.channel}</div>
          <div class="c-hide-m muted num" title="Sent ${o.sentAt}">${short(o.lastTouchAt || o.sentAt)}</div>
          <div class="c-hide-m">${status(o.status, OUT_LABEL)}</div>
          <div class="c-hide-m"><span class="ftally" title="${plural(o.followUps || 0, "follow-up")}">${[0, 1, 2].map((i) => html`<i class="${i < (o.followUps || 0) ? "on" : ""}"></i>`)}</span></div>
          <div class="c-act" style="display:flex;gap:6px;justify-content:flex-end">
            <label class="sr" for="os-${o.id}">Status for ${o.person}</label>
            <select class="input" id="os-${o.id}" style="height:30px;font-size:12.5px" data-action="out-status" data-id="${o.id}">${OUT_STATUSES.map((s) => html`<option value="${s}" ${s === o.status ? "selected" : ""}>${OUT_LABEL[s]}</option>`)}</select>
            <button class="btn sm" data-action="out" data-id="${o.id}" data-followed="1" title="Log a follow-up">+1</button>
          </div>
        </div>`)}
      </div>` : html`<div class="empty compact"><p>${list.length ? "No touches with this status." : "No outreach logged yet."}</p>${!list.length ? askAgent("Who is hiring for my top match? Draft a three-sentence note with one piece of proof") : ""}</div>`}
    </div>`}`);
  // #/outreach?oid=N (from the Scoreboard): select and scroll to that message
  const want = S.route.params.oid;
  if (want && id === S.renderId) {
    const i = rowsEls().findIndex((r) => r.dataset.oid === String(want));
    if (i >= 0) { S.sel = i; applySel(true); }
  }
}

async function updateOutreach(id, body, msg) {
  try { await post(`/api/outreach/${enc(id)}`, body); toast(msg); } catch (e) { return toast(e.message, { err: true }); }
  await refreshGlobals();
  if (S.route.name === "outreach") await viewOutreach();
}

// ---------------------------------------------------------------------------
// Scoreboard: sends and conversations against the strategy (strategy.json). Read-only; actions live in Outreach.

let sbZone = "America/New_York"; // the strategy's zone, set from each scoreboard payload
const DAY_FMT = { weekday: "short", month: "short", day: "numeric" };
// a time with a zone is shown on its date in the strategy's zone; a plain date stays that date
const dayLabel = (d) => (!d ? "" : /(?:Z|[+-]\d{2}:?\d{2})$/.test(d)
  ? new Date(d).toLocaleDateString("en-US", { ...DAY_FMT, timeZone: sbZone })
  : new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", DAY_FMT));
const isoDays = (t) => String(t ?? "").replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (m) => dayLabel(m));
const countdown = (n) => (n === 0 ? "today" : n > 0 ? `in ${plural(n, "day")}` : `${plural(-n, "day")} ago`);
function meter(actual, target, tone = "") {
  const pct = target > 0 ? Math.min(100, Math.round((actual / target) * 100)) : 0;
  return html`<span class="sb-meter ${tone}" role="img" aria-label="${actual} of ${target}"><i style="width:${pct}%"></i></span>`;
}

async function viewScoreboard() {
  const id = ++S.renderId;
  paint(id, skeleton(4));
  let sb;
  try { sb = await get("/api/scoreboard"); } catch (e) {
    if (e.status === 404) return paint(id, html`<div class="empty"><h3>This server does not have the scoreboard yet</h3><p>Restart <code>openapply ui</code> to load the scoreboard route (or start it if it is not running). It reads strategy.json and your outreach and applications.</p></div>`);
    return paint(id, errorState(e));
  }
  if (sb.timeZone) sbZone = sb.timeZone;
  const w = sb.week;
  const t = w.targets;
  const under = [w.warmAsks < t.warmAsks && `${t.warmAsks - w.warmAsks} more ${t.warmAsks - w.warmAsks === 1 ? "ask" : "asks"}`,
    w.applications < t.applications && `${t.applications - w.applications} more ${t.applications - w.applications === 1 ? "application" : "applications"}`].filter(Boolean);
  const flags = sb.personFlags || [];
  const open = flags.filter((f) => f.state !== "sent_late");
  const late = flags.filter((f) => f.state === "sent_late");
  const fu = sb.followUpsDue || [];
  const g = sb.gate;
  const gateName = `${dayLabel(g.date)} gate`;
  const past = sb.weeks.filter((x) => !x.current).reverse();

  const stat = (k, a, target, s) => html`<div class="stat sb-stat ${target && a >= target ? "hot" : ""}">
    <div class="k">${k}</div><div class="v">${fmtN(a)}${target ? html`<span class="of"> / ${target}</span>` : ""}</div>
    ${target ? meter(a, target) : ""}<div class="s">${s}</div></div>`;

  // past the 48 hours, count in days: "12 days" reads at a glance, "301 hours" does not
  const elapsed = (h) => (h > 48 ? plural(Math.floor(h / 24), "day") : plural(h, "hour"));
  const outreachLink = (oid) => (oid ? `#/outreach?oid=${encodeURIComponent(oid)}` : "#/outreach");
  const flagCard = (f) => html`<div class="due sb-flag" data-state="${f.state}">
    <div class="days"><b>${f.state === "due" ? f.hoursLeft : f.hoursElapsed > 48 ? Math.floor(f.hoursElapsed / 24) : f.hoursElapsed}</b><span>${f.state === "due" ? "hours left" : f.hoursElapsed > 48 ? "days" : "hours"}</span></div>
    <div style="min-width:0">
      <div><span class="who">${f.company}</span> <span class="muted">${f.title} · applied ${dayLabel(f.submittedAt)}</span></div>
      <div class="chips" style="margin-top:6px">
        ${f.state === "due" ? html`<span class="chip warn">48-hour window open</span>` : f.state === "overdue" ? html`<span class="chip warn">No person after ${elapsed(f.hoursElapsed)}</span>` : html`<span class="chip outline">Note went out after the window</span>`}
        ${f.draft && html`<span class="chip accent">Draft to ${f.draft.person} ready</span>`}
      </div>
      <p class="sugg">${f.state === "sent_late" ? `${f.sentLate.person} was contacted ${dayLabel(f.sentLate.sentAt)}, after the 48 hours. Counted, nothing to do.`
        : f.draft ? `Send the ${f.draft.channel} note to ${f.draft.person}${f.state === "due" ? ` within ${plural(f.hoursLeft, "hour")}` : " today"}.`
        : `Name a person at ${f.company} (recruiter, hiring manager or founder) and send a short note.`}</p>
    </div>
    <div class="acts">${f.state !== "sent_late" && html`<a class="btn sm ${f.draft ? "primary" : ""}" href="${outreachLink(f.draft?.id)}">${f.draft ? "Send in Outreach" : "Outreach"}</a>`}
      <button class="btn sm" data-action="open-job" data-id="${f.jobId}">Role</button></div>
  </div>`;

  const fuCard = (f) => html`<div class="due">
    <div class="days"><b>${f.daysSinceTouch}</b><span>days</span></div>
    <div style="min-width:0">
      <div><span class="who">${f.person}</span> <span class="muted">${f.role ? `${f.role}, ` : ""}${f.company} · ${f.channel} · due ${dayLabel(f.dueSince)}${f.followUps ? ` · ${plural(f.followUps, "nudge")} so far` : ""}</span></div>
      ${f.suggestion && html`<p class="sugg">${f.suggestion}</p>`}
      ${f.notes && html`<details class="sb-notes"><summary>Notes on this message</summary><p>${f.notes}</p></details>`}
    </div>
    <div class="acts"><a class="btn sm primary" href="${outreachLink(f.id)}">Follow up in Outreach</a></div>
  </div>`;

  const yes = (b, label) => html`<span class="sb-yn ${b ? "y" : ""}">${b ? icon("tick") : ""}<span>${label}</span></span>`;
  const coCard = (c) => html`<article class="card sb-co" ${c.nextConversation ? raw('data-live="1"') : ""}>
    <header><h3>${c.company}</h3>${c.applicationStatus ? status(c.applicationStatus) : html`<span class="status"><span class="dot"></span>No application</span>`}</header>
    <p class="seat">${c.seat}</p>
    <div class="sb-yns">${c.inProcess ? yes(true, STAGE_LABEL[c.applicationStatus] ? `In process: ${STAGE_LABEL[c.applicationStatus]}` : "In process")
      : html`${yes(c.applied, c.applied ? `Applied${c.appliedAt ? ` ${dayLabel(c.appliedAt)}` : ""}` : "Not applied")}${yes(c.asked, c.asked ? "Asked" : "Not asked")}`}</div>
    <dl class="sb-facts">
      ${c.applicationTitle && html`<div><dt>On file</dt><dd>${c.applicationTitle}</dd></div>`}
      <div><dt>Person</dt><dd>${c.personNamed ? html`${c.personNamed.person}${c.personNamed.sent ? "" : html` <span class="muted">${c.personNamed.onHold ? "(draft on hold)" : "(draft, unsent)"}</span>`}` : html`<span class="muted">None named</span>`}</dd></div>
      <div><dt>Last touch</dt><dd>${c.lastTouch ? html`<span title="${c.lastTouch}">${dayLabel(c.lastTouch)}</span>` : html`<span class="muted">None</span>`}</dd></div>
    </dl>
    <p class="sb-next"><span class="k">Next</span>${isoDays(c.nextAction)}</p>
    ${c.firstMove && c.firstMove !== c.nextAction && html`<p class="sb-path"><span class="k">Plan</span>${c.firstMove}</p>`}
    ${c.path && html`<p class="sb-path"><span class="k">Path</span>${c.path}</p>`}
  </article>`;

  const progress = [["First conversations held", g.progress.firstConversations], ["Past a first screen", g.progress.pastFirstScreen], ["Warm asks", g.progress.warmAsks], ["Applications", g.progress.applications]];

  paint(id, html`
    <div class="head"><div>
      <div class="eyebrow">Scoreboard · Week ${w.week}, ${dayLabel(w.start)} to ${dayLabel(w.end)}</div>
      <h1 class="title">${under.length ? `${under.join(" and ")} this week` : "This week is on target"}</h1>
      <p class="lede">Counts what went out and who answered, never packs or drafts made. <em>${plural(g.liveProcesses, "live process", "live processes")}</em>; ${g.daysLeft > 0 ? `${plural(g.daysLeft, "day")} to the ${gateName}.` : g.daysLeft === 0 ? `the ${gateName} is today.` : `the ${gateName} has passed.`}</p>
    </div></div>
    ${(sb.warnings || []).map((x) => html`<div class="stale" role="note">${icon("warn")}<div>${x}</div></div>`)}
    <section class="section" style="margin-top:0" aria-labelledby="sb-week">
      <div class="section-head"><h2 id="sb-week">This week</h2><span class="aside">${w.halved ? `Targets halved: ${sb.halving.submittedByWeek1} of the lead companies in by the end of week 1, ${sb.halving.threshold} needed` : `Targets: ${t.warmAsks} warm asks, ${t.applications} applications`}</span></div>
      <div class="stat-row">
        ${stat("Warm asks sent", w.warmAsks, t.warmAsks, "each to a different person")}
        ${stat("Applications sent", w.applications, t.applications, "target: a person within 48 hours")}
        ${stat("First conversations", w.firstConversations, 0, `${w.firstConversations - w.firstConversationsBooked} held, ${w.firstConversationsBooked} booked`)}
        ${stat("Rounds passed", w.roundsPassed, 0, w.possibleRounds ? `${plural(w.possibleRounds, "possible next round")}, not logged` : "logged rounds only")}
      </div>
      <p class="muted sb-bench">Rounds count only when logged, never guessed from dates. Log a round with log_event (JSON round: 2) when a second round is booked.</p>
      ${past.length > 0 && html`<ul class="sb-weeks">${past.map((x) => html`<li>
        <span class="wk">Week ${x.week}<span class="muted"> · ${dayLabel(x.start)}</span></span>
        <span class="num">${x.warmAsks}/${x.targets.warmAsks} asks</span><span class="num">${x.applications}/${x.targets.applications} applications</span>
        <span class="num">${plural(x.firstConversations, "conversation")}</span>
        <span class="chip ${x.slipped ? "warn" : "accent"}">${x.slipped ? "Under target" : "On target"}</span></li>`)}</ul>`}
    </section>
    <section class="section" aria-labelledby="sb-do">
      <div class="section-head"><h2 id="sb-do">Do next</h2><span class="aside">${open.length || fu.length ? `${plural(open.length, "application")} without a person, ${plural(fu.length, "follow-up")} due` : ""}</span></div>
      ${open.length || fu.length ? html`<div class="due-list">${open.map(flagCard)}${fu.map(fuCard)}</div>`
        : html`<div class="empty compact"><p>Every application has a person on it and nobody is waiting on a nudge.</p></div>`}
      ${late.length > 0 && html`<details class="sb-late"><summary>Late but done: ${late.map((f) => f.company).join(", ")}</summary>
        <ul>${late.map((f) => html`<li>${f.company}: ${f.sentLate.person} contacted ${dayLabel(f.sentLate.sentAt)}, after the 48 hours (applied ${dayLabel(f.submittedAt)}).</li>`)}</ul></details>`}
    </section>
    <section class="section" aria-labelledby="sb-five">
      <div class="section-head"><h2 id="sb-five">${sb.companies.length === 5 ? "The five" : "Lead companies"}</h2><span class="aside">${sb.companies.length ? `${sb.companies.filter((c) => c.applied || c.asked).length} of ${sb.companies.length} applied or asked` : ""}</span></div>
      ${sb.companies.length ? html`<div class="sb-five">${sb.companies.map(coCard)}</div>` : html`<div class="empty compact"><p>No lead companies yet. List them in strategy.json.</p></div>`}
      ${(sb.bench || []).length > 0 && html`<p class="muted sb-bench">Also watched for the 48-hour rule: ${sb.bench.join(", ")}</p>`}
    </section>
    <section class="section sb-end" aria-labelledby="sb-miles">
      <div>
        <div class="section-head"><h2 id="sb-miles">Milestones</h2><span class="aside">${dayLabel(sb.today)}</span></div>
        ${!sb.milestones.length ? html`<div class="empty compact"><p>No milestones yet. List them in strategy.json.</p></div>` : ""}
        <ol class="sb-miles">${sb.milestones.map((m) => html`<li data-state="${m.state}" class="${m.gate ? "gate" : ""}">
          <div class="when"><b>${countdown(m.daysLeft)}</b><span>${dayLabel(m.date)}</span></div>
          <div style="min-width:0"><div class="t">${m.title}${m.gate ? html` <span class="chip outline">Gate</span>` : ""}</div><div class="d">${m.doneMeans}</div></div>
        </li>`)}</ol>
      </div>
      <section class="card sb-gate" data-v="${g.verdict}" aria-labelledby="sb-gate-h">
        <div class="k" id="sb-gate-h">${gateName} · ${countdown(g.daysLeft)}</div>
        <div class="v">${g.verdict === "hold" ? "Hold" : "Widen"}</div>
        <div class="s">${g.reached ? "" : "If it were today: "}${plural(g.liveProcesses, "live process", "live processes")}; hold needs ${g.threshold}.</div>
        <div class="sb-dots" aria-hidden="true">${Array.from({ length: Math.max(g.threshold, g.liveProcesses) }, (_, i) => html`<i class="${i < g.liveProcesses ? "on" : ""}"></i>`)}</div>
        <p class="act">${g.action}</p>
        ${g.note && html`<p class="note">${g.note}</p>`}
        ${sb.totals?.possibleRounds > 0 && html`<p class="note">${plural(sb.totals.possibleRounds, "held conversation")} after a first may be a next round: log it with log_event (JSON round: 2) if it was.</p>`}
        <ul class="sb-prog">${progress.map(([k, p]) => html`<li><span>${k}</span><span class="num">${p.actual} / ${p.target}</span>${meter(p.actual, p.target)}</li>`)}</ul>
        ${sb.liveProcesses.length > 0 && html`<p class="live">Live: ${sb.liveProcesses.map((p) => `${p.company} (${STAGE_LABEL[p.status] || p.status})`).join(", ")}</p>`}
      </section>
    </section>`);
}

// ---------------------------------------------------------------------------
// Profile

const EEO_OPTS = {
  gender: ["Decline to self-identify", "Female", "Male", "Non-binary"],
  race: ["Decline to self-identify", "American Indian or Alaska Native", "Asian", "Black or African American", "Native Hawaiian or Other Pacific Islander", "White", "Two or more races"],
  hispanic: ["Decline to self-identify", "Yes", "No"],
  veteran: ["Decline to self-identify", "I am not a protected veteran", "I identify as one or more of the classifications of protected veteran"],
  disability: ["Decline to self-identify", "Yes, I have a disability (or previously had one)", "No, I do not have a disability"],
};
const EEO_LABEL = { gender: "Gender", race: "Race", hispanic: "Hispanic or Latino", veteran: "Veteran status", disability: "Disability status" };

async function viewProfile() {
  const id = ++S.renderId;
  paint(id, skeleton(4));
  let d;
  try { d = await get("/api/profile"); } catch (e) { return paint(id, errorState(e)); }
  S.profileData = d;
  S.profileDirty = false;
  const p = d?.profile || {};
  const t = p.targets || {};
  const missing = d?.status?.missing || [];
  const text = (path, label, v, o = {}) => html`<div class="f ${o.full ? "full" : ""}"><label for="pf-${path}">${label}</label>
    <input class="input" id="pf-${path}" type="${o.type || "text"}" data-path="${path}" data-kind="${o.type === "number" ? "num" : "text"}" value="${v ?? ""}" ${o.ph ? raw(`placeholder="${esc(o.ph)}"`) : ""} autocomplete="${o.ac || "off"}">
    ${o.hint && html`<span class="hint">${o.hint}</span>`}</div>`;
  const tri = (path, label, v) => html`<div class="f"><span class="lbl" id="lb-${path}">${label}</span>
    <div class="tri" role="radiogroup" aria-labelledby="lb-${path}" data-path="${path}" data-kind="tri">
      ${[["yes", "Yes", v === true], ["no", "No", v === false], ["", "Not set", v == null]].map(([val, l, on]) => html`<input type="radio" id="pf-${path}-${val || "unset"}" name="${path}" value="${val}" ${on ? "checked" : ""}><label for="pf-${path}-${val || "unset"}">${l}</label>`)}
    </div></div>`;
  const tags = (path, label, arr, hint) => html`<div class="f full"><span class="lbl" id="lb-${path}">${label}</span>
    <div class="tags" data-path="${path}" data-kind="tags" data-values="${JSON.stringify(arr || [])}" aria-labelledby="lb-${path}">
      ${(arr || []).map((x) => tagChip(x))}<input aria-label="Add to ${label}" placeholder="${(arr || []).length ? "" : "Type and press Enter"}">
    </div>${hint && html`<span class="hint">${hint}</span>`}</div>`;

  paint(id, html`
    <div class="head"><div><div class="eyebrow">Profile</div><h1 class="title">${[p.firstName, p.lastName].filter(Boolean).join(" ") || "Your profile"}</h1>
      <p class="lede">What your agent puts on every form, and what it looks for. Your agent reads this; you have the final say.</p>
      ${missing.length > 0 && html`<div class="profile-missing"><span class="chip warn">Missing</span>${missing.map((m) => html`<span class="chip">${human(m)}</span>`)}</div>`}
    </div></div>
    <div class="profile">
      <form id="profileForm" novalidate>
        <fieldset class="fs"><legend>Contact</legend><p class="help">Used verbatim on applications.</p>
          <div class="fgrid">
            ${text("firstName", "First name", p.firstName, { ac: "given-name" })}${text("lastName", "Last name", p.lastName, { ac: "family-name" })}
            ${text("email", "Email", p.email, { type: "email", ac: "email" })}${text("phone", "Phone", p.phone, { type: "tel", ac: "tel" })}
            ${text("location", "Location", p.location, { ph: "City, region, country", hint: "Written exactly as you want it on forms." })}${text("pronouns", "Pronouns", p.pronouns, { ph: "Optional" })}
          </div></fieldset>
        <fieldset class="fs"><legend>Links</legend><p class="help">Only links you add here are ever used.</p>
          <div class="fgrid">${text("linkedin", "LinkedIn", p.linkedin, { type: "url", full: true })}${text("github", "GitHub", p.github, { type: "url" })}${text("website", "Website or portfolio", p.website, { type: "url" })}</div></fieldset>
        <fieldset class="fs"><legend>Work authorization</legend><p class="help">Asked on nearly every US form. Leave unset and your agent will stop and ask.</p>
          <div class="fgrid">${tri("workAuthorizedUS", "Authorized to work in the US", p.workAuthorizedUS)}${tri("needsSponsorship", "Needs visa sponsorship", p.needsSponsorship)}${tri("willingToRelocate", "Willing to relocate", p.willingToRelocate)}</div></fieldset>
        <fieldset class="fs"><legend>Compensation and timing</legend><p class="help">Your agent never invents a number. If these are empty, salary questions stop for you.</p>
          <div class="fgrid">${text("salaryExpectation", "Salary expectation", p.salaryExpectation, { ph: "e.g. $190,000 base, flexible on equity" })}${text("noticePeriod", "Notice period", p.noticePeriod, { ph: "e.g. Two weeks" })}</div></fieldset>
        <fieldset class="fs"><legend>What you're looking for</legend><p class="help">Drives match scores. Press Enter or comma to add.</p>
          <div class="fgrid">
            ${tags("targets.titles", "Titles", t.titles)}${tags("targets.keywords", "Keywords", t.keywords)}${tags("targets.locations", "Locations", t.locations)}
            ${tags("targets.seniority", "Seniority", t.seniority)}
            ${text("targets.minSalary", "Minimum salary (USD)", t.minSalary, { type: "number", hint: "Roles that post a lower maximum are ranked down." })}
            <div class="f"><span class="lbl">Remote</span><label class="check"><input type="checkbox" data-path="targets.remoteOk" data-kind="bool" ${t.remoteOk ? "checked" : ""}> Remote roles are fine</label></div>
          </div></fieldset>
        <fieldset class="fs"><legend>Exclusions</legend><p class="help">Never shown, never applied to.</p>
          <div class="fgrid">${tags("targets.excludeCompanies", "Companies", t.excludeCompanies)}${tags("targets.excludeKeywords", "Keywords", t.excludeKeywords)}</div></fieldset>
        <fieldset class="fs"><legend>Voluntary self-identification</legend><p class="help">Declined by default. Your agent never guesses these.</p>
          <div class="fgrid">${Object.keys(EEO_OPTS).map((k) => {
            const cur = p.eeo?.[k] || EEO_OPTS[k][0];
            const opts = EEO_OPTS[k].includes(cur) ? EEO_OPTS[k] : [cur, ...EEO_OPTS[k]];
            return html`<div class="f"><label for="pf-eeo-${k}">${EEO_LABEL[k]}</label><select class="input" id="pf-eeo-${k}" data-path="eeo.${k}" data-kind="text">${opts.map((o) => html`<option ${o === cur ? "selected" : ""}>${o}</option>`)}</select></div>`;
          })}</div></fieldset>
        ${Object.keys(p.savedAnswers || {}).length > 0 && html`<fieldset class="fs"><legend>Saved answers</legend><p class="help">Answers you gave once, reused on later forms. Your agent adds to these when you answer a new question.</p>${answersList(p.savedAnswers)}</fieldset>`}
        <div class="savebar" id="savebar" role="region" aria-label="Unsaved changes"><span>Unsaved changes</span>
          <button type="button" class="btn ghost sm" data-action="profile-reset">Discard</button>
          <button type="submit" class="btn primary sm">Save profile</button></div>
      </form>
      <aside class="resume-side">
        <div class="section-head" style="margin-top:0"><h2>Master resume</h2><span class="aside">Read only</span></div>
        <p class="muted" style="font-size:12.5px;margin:-4px 0 12px">The source of truth. Every tailored resume is checked against it, so new numbers, titles or employers get flagged.</p>
        ${resumePaper(d?.resume)}
      </aside>
    </div>`);
}
const tagChip = (x) => html`<span class="tag" data-v="${x}">${x}<button type="button" aria-label="Remove ${x}" data-action="tag-rm">${icon("x")}</button></span>`;

function collectProfile() {
  const patch = {};
  const set = (path, v) => {
    const keys = path.split(".");
    let o = patch;
    keys.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; });
    o[keys[keys.length - 1]] = v;
  };
  for (const el of $$("#profileForm [data-path]")) {
    const kind = el.dataset.kind, path = el.dataset.path;
    if (kind === "text") set(path, el.value.trim());
    else if (kind === "num") { if (el.value !== "") set(path, Number(el.value)); }
    else if (kind === "bool") set(path, el.checked);
    else if (kind === "tags") set(path, JSON.parse(el.dataset.values || "[]"));
    else if (kind === "tri") { const c = $("input:checked", el); if (c && c.value) set(path, c.value === "yes"); }
  }
  return patch;
}
async function saveProfile() {
  const btn = $('#profileForm button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    await api("PUT", "/api/profile", collectProfile());
    S.profileDirty = false;
    $("#savebar")?.classList.remove("on");
    toast("Profile saved. Your agent uses it from the next form on.");
    await refreshGlobals();
  } catch (e) { toast(e.message, { err: true }); }
  if (btn) btn.disabled = false;
}
function markDirty() { S.profileDirty = true; $("#savebar")?.classList.add("on"); }
function addTag(box, v) {
  v = v.trim().replace(/,$/, "").trim();
  if (!v) return;
  const vals = JSON.parse(box.dataset.values || "[]");
  if (vals.some((x) => x.toLowerCase() === v.toLowerCase())) return;
  vals.push(v);
  box.dataset.values = JSON.stringify(vals);
  $("input", box).insertAdjacentHTML("beforebegin", String(tagChip(v)));
  $("input", box).placeholder = "";
  markDirty();
}

// ---------------------------------------------------------------------------
// Drawer

async function openJob(jobId, refresh = false) {
  if (S.drawer) savePackEdits(S.drawer.id); // never drop typed text on a re-render
  const root = $("#drawerRoot");
  const isNew = !S.drawer || S.drawer.id !== jobId;
  if (isNew) S.drawer = { id: jobId, returnFocus: S.drawer?.returnFocus || document.activeElement };
  if (isNew && !refresh) {
    root.innerHTML = String(html`<div class="scrim" data-action="close-drawer"></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="Job details">
        <div class="drawer-top"><span class="crumbs">Loading</span><button class="icon-btn" data-action="close-drawer" aria-label="Close">${icon("x")}</button></div>
        <div class="drawer-body"><div class="skel" style="height:28px;width:60%"></div><div class="skel" style="height:220px;margin-top:20px"></div></div>
      </aside>`);
    $(".drawer .icon-btn").focus();
  }
  let d, intel = null;
  await S.packSaves.get(jobId); // a save still landing for this job updates the cache first, so the drawer never shows older text
  try {
    const [dd, ii] = await Promise.allSettled([jobDetail(jobId, refresh), get(`/api/intel/${enc(jobId)}`)]);
    if (dd.status === "rejected") throw dd.reason;
    d = dd.value;
    intel = ii.status === "fulfilled" ? ii.value : null;
  } catch (e) {
    if (S.drawer?.id === jobId) $(".drawer-body").innerHTML = String(errorState(e));
    return;
  }
  if (S.drawer?.id !== jobId) return;
  const j = d.job || {};
  const app = d.application;
  const pack = d.pack;
  const run = d.run;
  const busy = runBusy(run);
  const sal = salary(j);
  const scrollTop = $(".drawer-body")?.scrollTop || 0;
  const drawer = $(".drawer");
  if (!drawer) return;
  drawer.setAttribute("aria-label", `${j.title} at ${j.company}`);
  drawer.innerHTML = String(html`
    <div class="drawer-top"><span class="crumbs">${j.company} · ${j.ats}${j.open === false ? " · closed" : ""}</span>
      ${d.website && html`<a class="btn sm ghost" href="${d.website}" target="_blank" rel="noopener noreferrer" title="${j.company}'s website">${host(d.website)} ${icon("ext")}</a>`}
      ${j.url && html`<a class="btn sm ghost" href="${j.url}" target="_blank" rel="noopener">Posting ${icon("ext")}</a>`}
      <button class="icon-btn" data-action="close-drawer" aria-label="Close (Esc)">${icon("x")}</button></div>
    <div class="drawer-body">
      <div class="eyebrow">${j.company}${j.department ? ` · ${j.department}` : ""}</div>
      <h2>${j.title}</h2>
      <div class="meta"><span>${locLine(j)}</span>${j.employmentType && html`<span>${j.employmentType}</span>`}${app && status(app.status)}${app?.submittedAt && html`<span title="Submitted ${app.submittedAt.slice(0, 10)}">Applied ${ago(app.submittedAt)}</span>`}${priorChip(d.priorApplications)}</div>
      ${d.priorApplications?.length > 0 && html`<ul class="prior-list">${d.priorApplications.map((p) => html`<li class="${p.similarTitle ? "dup" : ""}">${p.similarTitle ? "Same role" : "Other role"}: ${p.title} · <span class="num">${pday(p.appliedAt)}</span> · ${STAGE_LABEL[p.status] || human(p.status)}${p.imported ? " · imported" : ""}</li>`)}</ul>`}
      <div class="drawer-actions">${drawerActions(j, app, pack, busy, d.held)}</div>
      <div data-dupe>${dupeBlock(j.id)}</div>
      ${!busy && app && notHeld({ ...app, held: d.held }) ? heldNote(j.id, app.status) : runLine(run)}
      ${elsewhereNote(app, d.events)}
      <div class="facts">
        <div><div class="k">Salary</div><div class="v">${sal || "Not posted"}</div></div>
        <div><div class="k">Posted</div><div class="v">${j.postedAt ? ago(j.postedAt) : `seen ${ago(j.firstSeen)}`}</div></div>
        <div><div class="k">Source</div><div class="v">${host(j.url) || j.ats}</div></div>
      </div>
      ${app?.notes && html`<p class="outreach-quote">${app.notes}</p>`}
      ${pack && html`<section class="dsec" id="pack"><h3>Application pack <span class="aside">${pack.needsTailoredCut ? "drafted" : "tailored"} ${ago(pack.createdAt)}${pack.updatedAt ? `, edited ${ago(pack.updatedAt)}` : ""}</span>${pack.needsTailoredCut && html`<span class="chip warn" title="Drafted with your base resume. A tailored cut may be worth making.">Base resume: needs tailored cut?</span>`}</h3>${(app?.status === "filled" || app?.status === "approved") && html`<p class="muted">Editing re-opens the filled form: fill again before you approve.</p>`}${packTabs(pack, j.id, { edit: !busy && !EDIT_LOCKED.has(app?.status), whyUs: d.whyUs })}</section>`}
      ${intel && intelPanel(intel, j)}
      <section class="dsec"><h3>About the role</h3>
        <div class="desc ${String(j.description || "").length > 900 ? "clamp" : ""}" id="desc">${j.description || "No description captured."}</div>
        ${String(j.description || "").length > 900 && html`<button class="btn sm" style="margin-top:10px" data-action="expand-desc">Read the full posting</button>`}
      </section>
      ${(d.events || []).length > 0 && html`<section class="dsec"><h3>Activity</h3><ul class="timeline">${d.events.map((e) => html`<li><span>${describeEvent(e)}</span><time datetime="${e.at}">${short(e.at)}</time></li>`)}</ul></section>`}
    </div>`);
  initPackEditors(drawer);
  restoreUnsaved(jobId, $(".packtabs[data-edit]", drawer));
  if (refresh) $(".drawer-body").scrollTop = scrollTop;
  if (busy) pollRun(jobId, run);
}
function drawerActions(j, app, pack, busy, held) {
  return html`${app?.status === "filled" && html`<button class="btn ${held === false ? "" : "primary"}" data-action="approve" data-id="${j.id}">${approveLabel(held)}</button><button class="btn danger-ghost" data-action="reject" data-id="${j.id}">Not this one</button>`}
    ${!app && html`<button class="btn primary" data-action="save" data-id="${j.id}">${icon("bookmark")} Save to pipeline</button>`}
    ${j.applyUrl && j.applyUrl !== j.url && html`<a class="btn" href="${j.applyUrl}" target="_blank" rel="noopener">Application form ${icon("ext")}</a>`}
    ${!pack && !busy && html`<button class="btn ${app ? "primary" : ""}" data-action="draft" data-id="${j.id}">${icon("spark")} Draft pack</button>`}
    ${pack && app?.status === "drafted" && !busy && fillButton(j.id, pack)}`;
}
/** Fill stays unavailable while the pack has TODO answers; it says which, and a click takes you to the first one. */
function fillButton(id, pack) {
  const todos = packTodoList(pack);
  if (!todos.length) return html`<button class="btn primary" data-action="fill" data-id="${id}">Fill form</button>`;
  const why = `Finish first: ${todos.join(" · ")}`;
  return html`<button class="btn" data-action="fill" data-id="${id}" aria-disabled="true" aria-describedby="fillWhy" title="${why}">Fill form <span class="chip warn">${todos.length} to finish</span></button><span class="sr" id="fillWhy">${why}</span>`;
}

// ---------------------------------------------------------------------------
// Pack editing (drawer): answers and cover letter text, saved on blur, ⌘↵ or close

function autosize(t) {
  if (!t.offsetParent) return; // hidden tab: sized when shown
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight + 2}px`;
}
function initPackEditors(root) {
  for (const t of $$(PACK_FIELDS, root)) { t.dataset.orig = t.value; autosize(t); }
}
const packDirty = () => $$(PACK_FIELDS).some((t) => t.value !== t.dataset.orig)
  || $$(TODO_FIELDS).some((t) => t.value !== t.dataset.orig && t.value.trim()); // an answer field left empty saves nothing
const packUnsaved = () => packDirty() || S.packSaves.size > 0 || S.packFailed.size > 0;
function saveState(t, state, msg = "") {
  const el = t.closest("[data-field]")?.querySelector(".save-state");
  if (!el) return;
  el.dataset.s = state;
  el.textContent = { saving: "Saving…", saved: "Saved", error: `Not saved: ${msg}`, "": "" }[state];
}
/**
 * Sends every edited field of the open drawer's pack, chained after this job's earlier saves. Edits are collected
 * now, so closing right after loses nothing. A field counts as saved (data-orig) only once the server took it.
 * Resolves to null when everything for this job saved, else the error message.
 */
function savePackEdits(jobId) {
  const wrap = $(".drawer .packtabs[data-edit]");
  const fields = wrap && wrap.dataset.job === jobId
    ? $$(PACK_FIELDS, wrap).filter((t) => t.value !== t.dataset.orig && t.value !== t.dataset.pending) : [];
  if (!fields.length) return (S.packSaves.get(jobId) || Promise.resolve(null)).then((err) => err || S.packFailed.get(jobId)?.error || null);
  const patch = {};
  const sent = fields.map((t) => t.value);
  for (const t of fields) {
    if ("packCover" in t.dataset) patch.coverLetter = t.value;
    else (patch.answers ||= {})[t.dataset.packQ] = t.value;
  }
  fields.forEach((t) => { t.dataset.pending = t.value; saveState(t, "saving"); });
  const settle = (t, i) => { if (t.dataset.pending === sent[i]) delete t.dataset.pending; };
  const run = async () => {
    let r;
    try { r = await api("PUT", jobPath(jobId, "/pack"), patch); }
    catch (e) {
      fields.forEach(settle);
      const gone = fields.filter((t) => !t.isConnected);
      fields.filter((t) => t.isConnected).forEach((t) => saveState(t, "error", e.message));
      if (gone.length) { // the drawer closed: keep the text so reopening the job puts it back
        const lost = S.packFailed.get(jobId) || { answers: {} };
        for (const t of gone) { if ("packCover" in t.dataset) lost.coverLetter = t.value; else lost.answers[t.dataset.packQ] = t.value; }
        S.packFailed.set(jobId, { ...lost, error: e.message });
      }
      toast(`Edits not saved: ${e.message}`, { err: true });
      return e.message;
    }
    fields.forEach((t, i) => { t.dataset.orig = sent[i]; settle(t, i); });
    const lost = S.packFailed.get(jobId); // drop only what this save sent: other failed edits stay kept
    if (lost) {
      if ("coverLetter" in patch) delete lost.coverLetter;
      for (const q of Object.keys(patch.answers || {})) delete lost.answers[q];
      if (lost.coverLetter === undefined && !Object.keys(lost.answers).length) S.packFailed.delete(jobId);
    }
    try { onPackSaved(jobId, r, fields); } catch (e) { console.error(e); } // saved either way: a redraw slip must not read as a failed save
    return null;
  };
  const chain = (S.packSaves.get(jobId) || Promise.resolve()).then(run);
  S.packSaves.set(jobId, chain);
  chain.then(() => { if (S.packSaves.get(jobId) === chain) S.packSaves.delete(jobId); });
  return chain;
}
/** Put edits whose save failed after the drawer closed back into the reopened editor, still unsaved. */
function restoreUnsaved(jobId, wrap) {
  const lost = S.packFailed.get(jobId);
  if (!lost || !wrap) return;
  S.packFailed.delete(jobId);
  for (const t of $$(PACK_FIELDS, wrap)) {
    const v = "packCover" in t.dataset ? lost.coverLetter : lost.answers[t.dataset.packQ];
    if (v === undefined || v === t.value) continue;
    t.value = v;
    autosize(t);
    saveState(t, "error", lost.error);
  }
}
function onPackSaved(jobId, r, fields) {
  const d = S.cache.get(jobId);
  if (d && r.status && r.status !== d.application?.status) { // the edit voided a filled form: drafted, Fill again
    S.cache.delete(jobId);
    toast("Saved. The filled form no longer matches, so fill it again before you approve.");
    return afterMutation();
  }
  const before = d?.pack ? packTodoList(d.pack).length : 0;
  if (d) d.pack = r.pack;
  const wrap = $(".drawer .packtabs[data-edit]");
  if (!wrap || wrap.dataset.job !== jobId || !d) {
    toast("Edits saved.");
    return;
  }
  const pack = r.pack, k = wrap.dataset.k;
  fields.forEach((t) => saveState(t, t.value === t.dataset.orig ? "saved" : ""));
  for (const t of $$("textarea[data-pack-q]", wrap)) {
    const row = t.closest(".qa-row"), q = t.dataset.packQ, st = qaState(pack, q);
    for (const c of ["todo", "review", "rewrite"]) row.classList.toggle(c, c === st);
    $(".qa-badges", row).innerHTML = String(qaBadges(pack, q, d.whyUs));
    $("[data-note]", row).innerHTML = String(qaNote(pack, q));
    $("[data-warns]", row).innerHTML = String(fieldWarns(pack, `the answer to "${q}"`));
  }
  const cw = $(".cover-edit [data-warns]", wrap);
  if (cw) cw.innerHTML = String(fieldWarns(pack, "the cover letter"));
  if (fields.some((t) => "packCover" in t.dataset)) $(".cover-preview", wrap).innerHTML = String(coverPreview(pack, jobId, `?v=${Date.now()}`));
  $("[data-todo-sum]", wrap).innerHTML = String(todoSummary(pack, k));
  for (const b of $$("[data-tabname]", wrap)) { const n = $(".n", b); n?.remove(); b.insertAdjacentHTML("beforeend", String(tabCount(b.dataset.tabname, pack))); }
  $('[data-panel="checks"]', wrap).innerHTML = String(checksBlock(pack));
  syncFillButton(pack);
  if (before && !r.todos.length) toast("All to-dos done. Fill form is ready.");
}
/** Update the drawer's Fill button in place: replacing it mid-click (a save landing on blur) would swallow the click. */
function syncFillButton(pack) {
  const b = $('.drawer-actions [data-action="fill"]');
  if (!b) return;
  const todos = packTodoList(pack);
  const why = todos.length ? `Finish first: ${todos.join(" · ")}` : "";
  b.classList.toggle("primary", !todos.length);
  for (const [attr, v] of [["aria-disabled", "true"], ["aria-describedby", "fillWhy"], ["title", why]]) {
    if (todos.length) b.setAttribute(attr, v); else b.removeAttribute(attr);
  }
  const chip = $(".chip", b);
  if (!todos.length) chip?.remove();
  else if (chip) chip.textContent = `${todos.length} to finish`;
  else b.insertAdjacentHTML("beforeend", ` <span class="chip warn">${todos.length} to finish</span>`);
  let sr = $("#fillWhy");
  if (!sr) { b.insertAdjacentHTML("afterend", '<span class="sr" id="fillWhy"></span>'); sr = $("#fillWhy"); }
  sr.textContent = why;
}
/** Show one pack field: switch to its tab (and the letter's edit mode), scroll to it, focus it. */
function jumpPack(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const panel = el.closest('[role="tabpanel"]');
  if (panel?.hidden) $(`[data-tab="${panel.id}"]`)?.click();
  if (el.closest(".cover-edit")?.hidden) coverMode(panel, "edit");
  autosize(el);
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}
function coverMode(panel, v) {
  $$('[data-action="cover-mode"]', panel).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
  $(".cover-preview", panel).hidden = v !== "preview";
  $(".cover-edit", panel).hidden = v !== "edit";
  if (v === "edit") { const t = $("textarea", panel); autosize(t); t.focus(); }
}
/** Fill asked for while TODOs remain: open the job and put the cursor in the first one instead of an error. */
async function showTodos(jobId) {
  if (S.drawer?.id !== jobId) { S.cache.delete(jobId); await openJob(jobId); }
  const first = $('.drawer [data-todo-sum] [data-action="jump-pack"]');
  const n = $$('.drawer [data-todo-sum] [data-action="jump-pack"]').length;
  if (first) jumpPack(first.dataset.target);
  toast(n ? `Finish ${plural(n, "answer")} first. Only you can write ${n === 1 ? "it" : "them"}; then Fill form unlocks.` : "Finish the to-do answers first.");
}

// ---------------------------------------------------------------------------
// Draft / fill runs (started from the drawer or a pipeline row; neither ever submits)

const runBusy = (r) => r && (r.state === "queued" || r.state === "running");
/** The server refused a draft or fill as a repeat application (409): say why, and only an explicit click sends force. */
function dupeBlock(jobId) {
  const b = S.blocked.get(jobId);
  if (!b) return "";
  return html`<div class="dupe" role="alert">${icon("warn")}<div>
    <p><b>You already applied to this role.</b> ${b.kind === "draft" ? "Drafting" : "Filling"} stopped so it doesn't go in twice.</p>
    <ul>${b.priors.map((p) => html`<li>${priorLine(p)}</li>`)}</ul>
    <div class="dupe-acts"><button class="btn sm" data-action="force-run" data-id="${jobId}" data-kind="${b.kind}">Apply anyway</button><button class="btn sm ghost" data-action="unblock" data-id="${jobId}">Cancel</button></div>
  </div></div>`;
}
async function setBlocked(jobId, b) {
  if (b) S.blocked.set(jobId, b); else S.blocked.delete(jobId);
  if (S.drawer?.id === jobId) await openJob(jobId, true);
  if (S.route.name === "pipeline") {
    // The re-render starts from a skeleton and would leave the page at the top, the notice out of sight.
    const y = window.scrollY;
    await viewPipeline();
    window.scrollTo(0, y);
    if (b) $$(".dupe").find((el) => el.closest("[data-row]")?.dataset.id === jobId)?.scrollIntoView({ block: "nearest" });
  }
}
const RUN_VERB = { draft: "Drafting the pack with Claude", whyus: "Drafting your why-us answer from the posting and your resume", fill: "Filling the form in the browser", submit: "Submitting the form" };
function runLine(r) {
  if (!r) return "";
  if (runBusy(r)) return html`<div class="runline" role="status" aria-live="polite"><span class="spin" aria-hidden="true"></span><span>${RUN_VERB[r.kind]}<span class="muted"> · started ${ago(r.startedAt)}${r.kind === "draft" || r.kind === "whyus" ? ", usually a few minutes" : ""}</span></span></div>`;
  if (r.state === "failed") return html`<div class="runline bad" role="status">${icon("warn")}<span>${{ draft: "Draft", whyus: "Why-us draft", fill: "Fill", submit: "Submit" }[r.kind]} failed: ${r.error || "unknown error"}</span></div>`;
  if (r.kind === "submit") return html`<div class="runline ok" role="status">${icon("ok")}<span><b>Submitted.</b></span></div>`;
  if (r.kind === "fill" && r.result) {
    const x = r.result;
    return html`<div class="runline ok" role="status">${icon("ok")}<span><b>${plural(x.filled, "field")} filled</b>${x.missing.length ? html`, <b class="warn-t">${x.missing.length} required missing</b>: ${x.missing.join(", ")}` : ", nothing required missing"}.
      ${x.warnings.length > 0 && html`<span class="muted"> ${x.warnings.join(" · ")}</span>`} Check it in the browser window, then approve. Nothing is submitted until you do.</span></div>`;
  }
  return "";
}
function pollRun(jobId, prev) {
  clearTimeout(S.runPoll);
  S.runPoll = setTimeout(async () => {
    if (S.drawer?.id !== jobId) return;
    let r;
    try { r = (await get(jobPath(jobId, "/run"))).run; } catch { return pollRun(jobId, prev); }
    if (S.drawer?.id !== jobId) return;
    if (runBusy(r)) { const el = $(".runline"); if (el) el.outerHTML = String(runLine(r)); return pollRun(jobId, r); }
    S.cache.delete(jobId);
    if (r?.state === "done") toast(r.kind === "draft" ? "Pack drafted. Review the why-us draft and any to-dos, then fill the form." : r.kind === "whyus" ? "Why-us drafted. Read it, edit or keep it, then fill the form." : "Form filled. Review it, then approve.");
    else if (r?.state === "failed") toast(`${{ draft: "Draft", whyus: "Why-us draft" }[r.kind] || "Fill"} failed: ${r.error}`, { err: true });
    await afterMutation();
  }, 3000);
}
async function startRun(jobId, kind, force = false) {
  if (kind === "draft" && !force) {
    const d = await jobDetail(jobId).catch(() => null);
    const j = d?.job || {};
    const r = await confirmModal({
      title: "Draft a pack with Claude?",
      body: html`<p>Sonnet reads the posting and company brief for <b>${j.title || "this role"}</b> and writes a cover letter and answers in your voice. It runs in the background, usually a few minutes.</p>
        <p style="margin-top:10px">It attaches your base resume PDF as is and drafts <b>why us</b> from one true link between the company and your work, for you to review. Nothing is filled or sent.</p>`,
      ok: "Draft pack",
    });
    if (!r.ok) return;
  }
  if (kind === "fill") {
    const err = await savePackEdits(jobId);
    if (err) return toast(`Not filling: your edits did not save (${err}). Open the job, check them and save again.`, { err: true });
    const pack = S.cache.get(jobId)?.pack;
    if (pack && packTodoList(pack).length) return showTodos(jobId);
  }
  try { await post(jobPath(jobId, `/${kind}`), force ? { force: true } : {}); }
  catch (e) {
    if (e.status === 409 && e.data?.priorApplications?.length) return setBlocked(jobId, { kind, priors: e.data.priorApplications });
    if (kind === "fill" && /TODOs to finish/.test(e.message)) return showTodos(jobId);
    return toast(e.message, { err: true });
  }
  S.blocked.delete(jobId);
  S.cache.delete(jobId);
  toast(kind === "draft" ? "Drafting. You can close this; it keeps going." : "Opening the form in the browser. It fills, then stops before Submit.");
  await afterMutation();
}
/** Draft one why-us answer in the background (pending edits save first); it lands as a draft to review. */
async function draftWhyUs(jobId, q) {
  if (!jobId) return;
  const err = await savePackEdits(jobId);
  if (err) return toast(`Not drafting: your edits did not save (${err}).`, { err: true });
  try { await post(jobPath(jobId, "/why-us"), { question: q }); }
  catch (e) { return toast(e.message, { err: true }); }
  S.cache.delete(jobId);
  toast("Drafting your why-us answer. Nothing is filled or sent.");
  await afterMutation();
}
/** Keep a drafted answer as written: it stops counting as unfinished. */
async function keepDraft(jobId, q) {
  if (!jobId) return;
  const err = await savePackEdits(jobId); // an edit to this answer already reviews it
  if (err) return toast(`Not kept: your edits did not save (${err}).`, { err: true });
  const d = S.cache.get(jobId);
  if (d?.pack && !d.pack.drafted?.[q]) return;
  let r;
  try { r = await api("PUT", jobPath(jobId, "/pack"), { reviewed: [q] }); }
  catch (e) { return toast(`Not kept: ${e.message}`, { err: true }); }
  const wrap = $(".drawer .packtabs[data-edit]");
  onPackSaved(jobId, r, wrap ? $$("textarea[data-pack-q]", wrap).filter((t) => t.dataset.packQ === q) : []);
  if (r.todos.length) toast("Kept.");
}
function closeDrawer() {
  if (!S.drawer) return;
  savePackEdits(S.drawer.id); // collects pending edits before the panel goes; the save lands after
  const rf = S.drawer.returnFocus;
  S.drawer = null;
  clearTimeout(S.runPoll);
  $("#drawerRoot").innerHTML = "";
  if (rf && document.contains(rf)) rf.focus({ preventScroll: true });
}

function intelPanel(intel, j) {
  const s = intel?.signals || {};
  const dept = Object.entries(s.byDepartment || {}).filter(([, n]) => typeof n === "number" && n > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = Math.max(1, ...dept.map(([, n]) => n));
  const list = (arr) => (Array.isArray(arr) ? arr.filter(Boolean) : []);
  const why = list(intel.whyNow), proof = list(intel.proofOfWorkIdeas), qs2 = list(intel.questionsToAsk), notes = list(s.notes);
  const net = typeof s.newLast30d === "number" && typeof s.closedLast30d === "number" ? s.newLast30d - s.closedLast30d : null;
  if (!why.length && !proof.length && !dept.length && s.openRoles == null) return "";
  return html`<section class="dsec"><h3>Company intel <span class="aside">from ${j.company}'s public board</span></h3>
    <div class="intel">
      ${why.length > 0 && html`<div class="card wide"><h4>Why they're hiring now</h4><ul class="whynow">${why.map((w) => html`<li>${w}</li>`)}</ul></div>`}
      <div class="card"><h4>Hiring momentum</h4>
        <div class="momentum">
          ${s.openRoles != null && html`<div><b>${fmtN(s.openRoles)}</b><span>open roles</span></div>`}
          ${s.newLast30d != null && html`<div><b class="${net > 0 ? "up" : ""}">+${fmtN(s.newLast30d)}</b><span>new in 30 days</span></div>`}
          ${typeof s.remoteShare === "number" && html`<div><b>${Math.round(s.remoteShare * 100)}%</b><span>remote</span></div>`}
        </div>
        ${dept.length > 0 && html`<div class="bars" aria-label="Open roles by department">${dept.map(([k, n]) => html`<div class="bar"><span class="lbl" title="${k}">${k}</span><span class="trk"><span class="fill" style="display:block;width:${((n / max) * 100).toFixed(0)}%"></span></span><span class="n">${n}</span></div>`)}</div>`}
        ${notes.length > 0 && html`<ul style="margin-top:12px;font-size:12.5px">${notes.map((n) => html`<li>${n}</li>`)}</ul>`}
      </div>
      ${proof.length > 0 && html`<div class="card"><h4>Proof of work ideas</h4><ul>${proof.map((p) => html`<li>${p}</li>`)}</ul></div>`}
      ${qs2.length > 0 && html`<div class="card ${proof.length ? "wide" : ""}"><h4>Questions to ask</h4><ul>${qs2.map((q) => html`<li>${q}</li>`)}</ul></div>`}
    </div></section>`;
}

// ---------------------------------------------------------------------------
// modal, toast, zoom

let modalOpen = false;
function confirmModal({ title, body, ok = "Confirm", cancel = "Cancel", input, danger = false }) {
  return new Promise((resolve) => {
    modalOpen = true;
    const prev = document.activeElement;
    const root = $("#modalRoot");
    root.innerHTML = String(html`<div class="modal-wrap"><div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="mh" aria-describedby="mb">
      <div class="modal-body"><h2 id="mh">${title}</h2><div id="mb">${body}</div>
        ${input && html`<label class="sr" for="mtext">${input}</label><textarea class="input" id="mtext" rows="3" placeholder="${input}"></textarea>`}</div>
      <div class="modal-foot">${cancel && html`<button class="btn" data-m="cancel">${cancel}</button>`}<button class="btn ${danger ? "" : "primary"}" data-m="ok">${ok} <kbd>↵</kbd></button></div></div></div>`);
    const done = (okv) => {
      const text = $("#mtext")?.value.trim() || "";
      root.innerHTML = "";
      modalOpen = false;
      document.removeEventListener("keydown", onKey, true);
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
      resolve({ ok: okv, text });
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === "Enter" && !(e.target.tagName === "TEXTAREA" && !e.metaKey && !e.ctrlKey) && !(e.target.tagName === "BUTTON" && e.target.dataset.m === "cancel")) { e.preventDefault(); e.stopPropagation(); done(true); }
      else if (e.key === "Tab") {
        const f = $$("button, textarea", root);
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      } else e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    root.querySelector(".modal-wrap").addEventListener("click", (e) => {
      if (e.target.classList.contains("modal-wrap")) done(false);
      const m = e.target.closest("[data-m]");
      if (m) done(m.dataset.m === "ok");
    });
    ($("#mtext") || $('[data-m="ok"]', root)).focus();
  });
}

function toast(msg, { action, onAction, err = false, ms = 5200 } = {}) {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${err ? "err" : ""}`;
  el.innerHTML = String(html`<span>${msg}</span>${action && html`<button type="button">${action}</button>`}`);
  box.append(el);
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 200); };
  const t = setTimeout(kill, ms);
  if (action) $("button", el).addEventListener("click", async () => { clearTimeout(t); kill(); try { await onAction(); } catch (e) { toast(e.message, { err: true }); } });
}

function zoom(src) {
  const root = $("#modalRoot");
  modalOpen = true;
  root.innerHTML = String(html`<div class="zoom-wrap" role="dialog" aria-modal="true" aria-label="Form screenshot" tabindex="-1"><img src="${src}" alt="Form screenshot, enlarged"></div>`);
  const w = $(".zoom-wrap", root);
  const close = () => { root.innerHTML = ""; modalOpen = false; document.removeEventListener("keydown", k, true); };
  const k = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", k, true);
  w.addEventListener("click", close);
  w.focus();
}

function shortcuts() {
  const rows = [[["/"], "Search every role"], [["j"], "Next item"], [["k"], "Previous item"], [["↵"], "Open selected"], [["a"], "Approve selected application"], [["x"], "Not this one"], [["s"], "Save selected role"], [["g", "t"], "Today"], [["g", "b"], "Scoreboard"], [["g", "r"], "Review"], [["g", "w"], "Answers to write"], [["g", "m"], "Matches"], [["g", "o"], "Outreach"], [["g", "p"], "Pipeline"], [["g", "f"], "Profile"], [["Esc"], "Close panel"]];
  confirmModal({ title: "Keyboard shortcuts", body: html`<dl class="shortcuts">${rows.map(([keys, l]) => html`<dt>${keys.map((k) => html`<kbd>${k}</kbd>`)}</dt><dd>${l}</dd>`)}</dl>`, ok: "Got it", cancel: "Close" });
}

// ---------------------------------------------------------------------------
// sync

async function syncNow() {
  if (S.syncing) return;
  try { await post("/api/sync"); } catch (e) { return toast(e.message, { err: true }); }
  S.syncing = true;
  renderChrome();
  if (S.route.name === "today") await viewToday();
  toast("Syncing every board in the background.");
  let st = { running: true };
  for (let i = 0; i < 400 && st.running; i++) {
    await sleep(1500);
    try { st = await get("/api/sync"); } catch { break; }
  }
  S.syncing = false;
  const r = st?.lastReport;
  toast(r ? `Sync done: ${plural(r.newJobs ?? 0, "new role")}, ${fmtN(r.closed ?? 0)} closed${r.failed ? `, ${r.failed} boards failed` : ""}.` : "Sync finished.");
  await refreshGlobals();
  if (["today", "matches", "search"].includes(S.route.name)) await VIEWS[S.route.name]();
}

// ---------------------------------------------------------------------------
// selection + keyboard

function rowsEls() { return $$("#view [data-row]"); }
function applySel(scroll = true) {
  const rows = rowsEls();
  if (!rows.length) return;
  S.sel = Math.min(Math.max(0, S.sel), rows.length - 1);
  rows.forEach((r, i) => r.classList.toggle("is-sel", i === S.sel));
  if (scroll) rows[S.sel].scrollIntoView({ block: "nearest", behavior: "smooth" });
}
async function moveSel(delta) {
  const rows = rowsEls();
  if (!rows.length) return;
  S.sel = Math.min(Math.max(0, S.sel + delta), rows.length - 1);
  if (S.route.name === "review") { await pickReview(S.sel); return; }
  applySel(true);
}
async function pickReview(i) {
  S.reviewSel = i;
  S.sel = i;
  $$(".rail-item").forEach((el, k) => { el.classList.toggle("is-sel", k === i); el.setAttribute("aria-selected", String(k === i)); });
  $$(".rail-item")[i]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  await renderSheet();
}
function selected() {
  if (S.drawer) {
    const d = S.cache.get(S.drawer.id);
    return { id: S.drawer.id, status: d?.application?.status || "" };
  }
  const r = rowsEls()[S.sel];
  return r ? { id: r.dataset.id, status: r.dataset.status, el: r } : null;
}

let gPending = 0;
document.addEventListener("keydown", async (e) => {
  if (modalOpen) return;
  const tag = e.target.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && S.route.name === "profile") { e.preventDefault(); if (S.profileDirty) saveProfile(); return; }
  if (e.key === "Escape") {
    if (S.drawer) { e.preventDefault(); closeDrawer(); return; }
    if (typing) e.target.blur();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (gPending && Date.now() - gPending < 1200) {
    gPending = 0;
    const map = { t: "today", b: "scoreboard", r: "review", w: "answers", m: "matches", o: "outreach", p: "pipeline", s: "search", f: "profile" };
    if (map[k]) { e.preventDefault(); closeDrawer(); go(map[k]); }
    return;
  }
  if (k === "g") { gPending = Date.now(); return; }
  if (k === "/") {
    e.preventDefault();
    closeDrawer();
    const local = S.route.name === "search" ? $("#sq") : S.route.name === "matches" ? $("#mq") : null;
    (local || $("#q")).focus();
    (local || $("#q")).select();
    return;
  }
  if (k === "?") { e.preventDefault(); shortcuts(); return; }
  if (S.drawer && (k === "j" || k === "k")) return;
  if (k === "j" || k === "ArrowDown" && !S.drawer && rowsEls().length) { if (k === "ArrowDown") e.preventDefault(); return moveSel(1); }
  if (k === "k" || k === "ArrowUp" && !S.drawer && rowsEls().length) { if (k === "ArrowUp") e.preventDefault(); return moveSel(-1); }
  const cur = selected();
  if (k === "Enter" && cur?.el && !S.drawer && document.activeElement === document.body) {
    e.preventDefault();
    if (cur.el.dataset.open === "review") go("review", { job: cur.id });
    else if (cur.el.dataset.open === "drawer") openJob(cur.id);
    return;
  }
  if (k === "a" && cur) {
    if (cur.status === "filled") { e.preventDefault(); return approveJob(cur.id); }
    if (cur.status) toast(`Only filled applications can be approved. This one is ${(STATUS_LABEL[cur.status] || cur.status).toLowerCase()}.`);
    return;
  }
  if (k === "x" && cur?.status === "filled") { e.preventDefault(); return rejectJob(cur.id); }
  if (k === "s" && cur && !cur.status && (S.drawer || ["matches", "search"].includes(S.route.name))) { e.preventDefault(); return saveJob(cur.id); }
});

// ---------------------------------------------------------------------------
// delegated events

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  const row = e.target.closest("[data-row]");
  if (!a && row && !e.target.closest("a, button, select, input, label")) {
    S.sel = rowsEls().indexOf(row);
    applySel(false);
    if (row.dataset.open === "drawer") openJob(row.dataset.id);
    else if (row.dataset.open === "review") go("review", { job: row.dataset.id });
    return;
  }
  if (!a) return;
  const act = a.dataset.action;
  if (a.tagName === "SELECT") return;
  if (row) { S.sel = rowsEls().indexOf(row); }
  switch (act) {
    case "open-job": e.preventDefault(); openJob(a.dataset.id); break;
    case "close-drawer": closeDrawer(); break;
    case "approve": approveJob(a.dataset.id); break;
    case "draft": case "fill": e.stopPropagation(); startRun(a.dataset.id, act); break;
    case "whyus": draftWhyUs(a.closest(".packtabs")?.dataset.job, a.dataset.q); break;
    case "keep-draft": keepDraft(a.closest(".packtabs")?.dataset.job, a.dataset.q); break;
    case "refill": e.stopPropagation(); e.preventDefault(); refill(a.dataset.id); break;
    case "todo-all": useForAll(a); break;
    case "force-run": e.stopPropagation(); startRun(a.dataset.id, a.dataset.kind, true); break;
    case "unblock": e.stopPropagation(); setBlocked(a.dataset.id, null); break;
    case "reject": rejectJob(a.dataset.id); break;
    case "save": e.stopPropagation(); saveJob(a.dataset.id); break;
    case "sync": syncNow(); break;
    case "shortcuts": shortcuts(); break;
    case "reload": route(); break;
    case "pick": pickReview(Number(a.dataset.i)); break;
    case "zoom": zoom(a.dataset.src); break;
    case "more": S.sf.offset = (S.searchJobs || []).length; viewSearch(true); break;
    case "pipe-filter": S.pipeFilter = a.dataset.v || null; history.replaceState(null, "", "#/pipeline"); S.route.params = {}; viewPipeline(); break;
    case "out-filter": S.outFilter = a.dataset.v; viewOutreach(); break;
    case "out":
      if (a.dataset.followed) updateOutreach(a.dataset.id, { followedUp: true }, "Logged. Next nudge in a week.");
      else updateOutreach(a.dataset.id, { status: a.dataset.status }, a.dataset.status === "meeting" ? "Meeting logged. Nice." : a.dataset.status === "closed" ? (a.dataset.msg || "Skipped.") : "Marked as replied.");
      break;
    case "out-sent": updateOutreach(a.dataset.id, { status: "sent" }, "Logged as sent. First nudge due in a week."); break;
    case "mf-remote": S.mf.remote = a.dataset.v === "1"; $$('[data-action="mf-remote"]').forEach((b) => b.setAttribute("aria-pressed", String(b === a))); viewMatches(); break;
    case "sf-remote": S.sf.remote = a.dataset.v === "1"; $$('[data-action="sf-remote"]').forEach((b) => b.setAttribute("aria-pressed", String(b === a))); viewSearch(); break;
    case "jump-pack": jumpPack(a.dataset.target); break;
    case "cover-mode": coverMode(a.closest('[role="tabpanel"]'), a.dataset.v); break;
    case "expand-desc": $("#desc")?.classList.remove("clamp"); a.remove(); break;
    case "copy": {
      const text = a.dataset.text || "";
      try { await navigator.clipboard.writeText(text); toast(a.dataset.msg || "Copied. Paste it to your agent."); }
      catch { toast("Copy failed. Select the text and copy it."); }
      break;
    }
    case "tag-rm": {
      const box = a.closest(".tags");
      const v = a.closest(".tag").dataset.v;
      box.dataset.values = JSON.stringify(JSON.parse(box.dataset.values || "[]").filter((x) => x !== v));
      a.closest(".tag").remove();
      markDirty();
      break;
    }
    case "profile-reset": S.profileDirty = false; viewProfile(); break;
  }
  if (e.target.closest("[data-tab]")) { /* handled below */ }
});

// tabs
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab]");
  if (!t) return;
  const wrap = t.closest(".packtabs");
  $$("[data-tab]", wrap).forEach((b) => b.setAttribute("aria-selected", String(b === t)));
  $$('[role="tabpanel"]', wrap).forEach((p) => { p.hidden = p.id !== t.dataset.tab; });
  $$(PACK_FIELDS, wrap).forEach(autosize);
});
document.addEventListener("keydown", (e) => {
  const t = e.target.closest?.("[data-tab]");
  if (!t || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
  const tabs = $$("[data-tab]", t.closest(".tabs"));
  const n = tabs[(tabs.indexOf(t) + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
  n.focus(); n.click();
});
document.addEventListener("click", (e) => { const t = e.target.closest(".tags"); if (t && e.target === t) $("input", t).focus(); });
document.addEventListener("toggle", (e) => { if (e.target.matches?.("[data-history]")) S.historyOpen = e.target.open; }, true);

// pack editors: grow with the text, save on blur or ⌘↵ / Ctrl+Enter
document.addEventListener("input", (e) => { if (e.target.matches?.(`${PACK_FIELDS}, ${TODO_FIELDS}`)) { autosize(e.target); saveState(e.target, ""); } });
document.addEventListener("focusout", (e) => { if (e.target.matches?.(TODO_FIELDS)) saveTodo(e.target); });
document.addEventListener("focusout", (e) => { if (e.target.matches?.(PACK_FIELDS) && S.drawer) savePackEdits(S.drawer.id); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.matches?.(PACK_FIELDS) && S.drawer) { e.preventDefault(); savePackEdits(S.drawer.id); }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.matches?.(TODO_FIELDS)) { e.preventDefault(); saveTodo(e.target); }
});

let debounce;
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.closest("#profileForm")) { if (!el.closest(".tags")) markDirty(); return; }
  const b = el.dataset.bind;
  if (!b) return;
  const [obj, key] = b.split(".");
  S[obj][key] = el.value;
  clearTimeout(debounce);
  debounce = setTimeout(() => (obj === "mf" ? viewMatches() : null), 220);
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.closest("#profileForm")) { markDirty(); return; }
  if (el.dataset.action === "set-status") return setStatus(el.dataset.id, el.value);
  if (el.dataset.action === "out-status") return updateOutreach(el.dataset.id, { status: el.value }, `Marked ${OUT_LABEL[el.value].toLowerCase()}.`);
  const b = el.dataset.bind;
  if (!b) return;
  const [obj, key] = b.split(".");
  S[obj][key] = el.value;
  if (obj === "mf") viewMatches();
  if (obj === "sf") viewSearch();
});
document.addEventListener("keydown", (e) => {
  const box = e.target.closest?.(".tags");
  if (!box || e.target.tagName !== "INPUT") return;
  if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(box, e.target.value); e.target.value = ""; }
  else if (e.key === "Backspace" && !e.target.value) {
    const last = $$(".tag", box).pop();
    if (last) { last.querySelector("button").click(); }
  }
});
document.addEventListener("focusout", (e) => {
  const box = e.target.closest?.(".tags");
  if (box && e.target.tagName === "INPUT" && e.target.value.trim()) { addTag(box, e.target.value); e.target.value = ""; }
});
document.addEventListener("submit", (e) => {
  if (e.target.id === "profileForm") { e.preventDefault(); saveProfile(); }
  if (e.target.id === "searchForm") { e.preventDefault(); const q = $("#sq").value.trim(); go("search", q ? { q } : undefined); }
  if (e.target.id === "globalSearch") { e.preventDefault(); const q = $("#q").value.trim(); $("#q").blur(); closeDrawer(); go("search", q ? { q } : undefined); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList?.contains("shot-frame")) zoom(e.target.dataset.src);
});
window.addEventListener("scroll", () => $(".top").classList.toggle("scrolled", window.scrollY > 4), { passive: true });
window.addEventListener("beforeunload", (e) => { if (S.profileDirty || packUnsaved()) { e.preventDefault(); e.returnValue = ""; } });

// ---------------------------------------------------------------------------
// boot

/** The server's stats, or a throw when nothing answers here or what answers is not OpenApply. */
async function probe() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const res = await fetch("/api/stats", { signal: ctl.signal, cache: "no-store", headers: { Accept: "application/json" } });
    const data = await res.json();
    if (!res.ok || !data || typeof data !== "object" || !data.jobs) throw new Error("not an OpenApply server");
    return data;
  } finally { clearTimeout(timer); }
}

async function boot() {
  if (qs.has("demo") && qs.get("demo") !== "0") startDemo("forced");
  else {
    view.innerHTML = String(skeleton(3));
    // A server that is still starting gets about 6 s before the page falls back to demo data.
    for (const wait of [0, 400, 800, 1600, 3200]) {
      await sleep(wait);
      try { S.stats = await probe(); break; } catch { /* not answering yet */ }
    }
    if (!S.stats) startDemo("offline");
  }
  await refreshGlobals();
  window.addEventListener("hashchange", route);
  await route();
  if (!S.demo) liveRefresh();
  // Offline demo keeps asking, and loads the real dashboard as soon as the server answers.
  else if (S.demoReason === "offline") {
    const t = setInterval(async () => { try { await probe(); clearInterval(t); location.reload(); } catch { /* still down */ } }, 3000);
  }
}

/* Your agent works in another window: re-render when its changes land, without
   interrupting an open panel, a modal, a focused field or unsaved profile edits. */
function liveRefresh() {
  let sig = "";
  const read = async () => {
    const [pipe, out] = await Promise.all([get("/api/pipeline"), get("/api/outreach")]);
    return JSON.stringify([pipe?.counts, pipe?.recent?.[0], (Array.isArray(out) ? out : []).map((o) => o.id + o.status)]);
  };
  const tick = async () => {
    if (document.hidden) return;
    let next;
    try { next = await read(); } catch { return; }
    const busy = S.drawer || S.profileDirty || $(".modal") || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (!sig || next === sig || busy) { if (!busy) sig = next; return; }
    sig = next;
    const y = window.scrollY;
    await refreshGlobals();
    await VIEWS[S.route.name]();
    window.scrollTo(0, y);
  };
  tick();
  setInterval(tick, 5000);
  document.addEventListener("visibilitychange", tick);
}
boot();
