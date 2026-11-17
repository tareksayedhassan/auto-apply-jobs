import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./offline.js";

const home = mkdtempSync(join(tmpdir(), "oa-http-"));
process.env.OPENAPPLY_HOME = home;
const db = await import("../src/db.js");
const { startServer, packFile } = await import("../src/server/http.js");
const { packDir } = await import("../src/paths.js");

const ID = "greenhouse:acme:1";
const job = (n: string, extra: any = {}) => ({
  id: `greenhouse:acme:${n}`, ats: "greenhouse" as const, boardSlug: "acme", company: "Acme",
  title: `Engineer ${n}`, location: "NYC", remote: false, description: "x".repeat(900), url: "https://x", applyUrl: "https://x", ...extra,
});
db.upsertJobs([job("1"), job("2", { remote: true, company: "Globex" })]);

const uiDir = mkdtempSync(join(tmpdir(), "oa-ui-"));
writeFileSync(join(uiDir, "index.html"), "<h1>hi</h1>");
writeFileSync(join(uiDir, "app.js"), "1");
mkdirSync(join(uiDir, "sub"));
writeFileSync(join(uiDir, "sub", "logo.svg"), "<svg/>");
writeFileSync(join(home, "secret.txt"), "secret");
writeFileSync(join(packDir(ID), "resume.pdf"), "%PDF-fake");
writeFileSync(join(packDir(ID), "notes.txt"), "private");
writeFileSync(join(home, "screenshots", "a.png"), "png");

const H = { "x-openapply": "1", "content-type": "application/json" };
let srv: Awaited<ReturnType<typeof startServer>>;
let missing: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer(0, { uiDir });
  // loader that fails for every sibling module, as if the parallel work had not landed
  missing = await startServer(0, { uiDir, importer: async () => { throw new Error("nope"); } });
});
after(async () => { await srv.close(); await missing.close(); });

const j = async (path: string, init?: RequestInit, base = srv.url) => {
  const r = await fetch(base + path, init);
  return { status: r.status, body: await r.json() as any };
};
const post = (path: string, body?: unknown, headers = H) =>
  j(path, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
const enc = encodeURIComponent;

/** Send an exact request path (fetch would normalise `..`). */
const raw = (path: string) => new Promise<{ status: number; body: string }>((ok, fail) => {
  const u = new URL(srv.url);
  const req = request({ host: u.hostname, port: u.port, path, method: "GET" }, res => {
    let b = ""; res.on("data", c => b += c); res.on("end", () => ok({ status: res.statusCode!, body: b }));
  });
  req.on("error", fail); req.end();
});

test("listens on an ephemeral loopback port", () => {
  assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(new URL(srv.url).port, "0");
});

test("GET /api/jobs: filters, truncation, bad input", async () => {
  const all = await j("/api/jobs");
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 2);
  assert.equal(all.body.jobs[0].description.length, 400);
  assert.equal((await j("/api/jobs?remote=1")).body.total, 1);
  assert.equal((await j("/api/jobs?company=globex")).body.jobs[0].company, "Globex");
  assert.equal((await j("/api/jobs?q=engineer&limit=1")).body.jobs.length, 1);
  assert.equal((await j("/api/jobs?limit=abc")).status, 400);
});

test("GET /api/jobs/:id with encoded colons returns the full text, fetched once", async () => {
  // the index holds a snippet; the detail view pulls the whole posting from the ATS
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = String(input);
    if (!u.startsWith("http://127.0.0.1")) { urls.push(u); return new Response(JSON.stringify({ content: "&lt;p&gt;" + "y".repeat(900) + "&lt;/p&gt;" })); }
    return real(input, init);
  }) as typeof fetch;
  try {
    assert.equal(db.getJob(ID)!.descriptionComplete, false);
    const r = await j(`/api/jobs/${enc(ID)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.job.id, ID);
    assert.equal(r.body.job.description.length, 900);
    assert.equal(r.body.job.descriptionComplete, true);
    assert.deepEqual(urls, ["https://boards-api.greenhouse.io/v1/boards/acme/jobs/1"]);
    await j(`/api/jobs/${enc(ID)}`);
    assert.equal(urls.length, 1);
    const l = await j("/api/jobs?q=engineer");
    assert.ok(l.body.jobs.every((x: any) => x.description.length <= 400));
    assert.ok(Array.isArray(r.body.events));
    assert.equal(r.body.application, undefined);
  } finally { globalThis.fetch = real; }
  assert.equal((await j(`/api/jobs/${enc("nope:x:1")}`)).status, 404);
});

test("save / status / approve flow and pipeline", async () => {
  assert.equal((await post(`/api/jobs/${enc(ID)}/save`, { notes: "hello" })).body.status, "saved");
  assert.equal((await post(`/api/jobs/${enc(ID)}/approve`)).status, 400);      // saved can't be approved
  assert.equal((await post(`/api/jobs/${enc(ID)}/status`, { status: "bogus" })).status, 400);
  assert.equal((await post(`/api/jobs/${enc(ID)}/status`, {})).status, 400);
  const bad = await j(`/api/jobs/${enc(ID)}/status`, { method: "POST", headers: H, body: "{oops" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /JSON/);
  assert.equal((await post(`/api/jobs/${enc("nope:x:1")}/save`)).status, 404);
  assert.equal((await post(`/api/jobs/${enc(ID)}/status`, { status: "approved" })).status, 400); // no back door
  assert.equal((await post(`/api/jobs/${enc(ID)}/status`, { status: "filled", note: "ok" })).body.status, "filled");
  db.setApplication(ID, { confirmationCode: "QWE234" }); // what a real fill stores
  assert.equal((await post(`/api/jobs/${enc(ID)}/approve`, { code: "STALE1" })).status, 400);
  assert.equal((await j(`/api/jobs/${enc(ID)}/approve`, { method: "POST", headers: H, body: "null" })).status, 400);
  const ap = await post(`/api/jobs/${enc(ID)}/approve`, { code: "QWE234" });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.status, "approved");
  assert.match(ap.body.notes, /hello[\s\S]*ok/);
  const p = await j("/api/pipeline");
  assert.equal(p.body.counts.approved, 1);
  assert.equal(p.body.items[0].job.id, ID);
  assert.ok(p.body.recent.length > 0);
  const d = await j(`/api/jobs/${enc(ID)}`);
  assert.equal(d.body.application.status, "approved");
  assert.ok(d.body.events.length >= 3);
});

test("GET /api/stats", async () => {
  const r = await j("/api/stats");
  assert.equal(r.status, 200);
  assert.equal(r.body.jobs.open, 2);
  assert.equal(r.body.pipeline.approved, 1);
  assert.ok("profile" in r.body);
  const m = await j("/api/stats", undefined, missing.url);
  assert.equal(m.status, 200);
  assert.equal(m.body.profile, null);
});

test("module-backed routes answer 503 when the module is missing", async () => {
  for (const [path, init] of [
    ["/api/matches", undefined], ["/api/profile", undefined],
    ["/api/profile", { method: "PUT", headers: H, body: "{}" }],
    ["/api/sync", { method: "POST", headers: H }],
  ] as const) {
    const r = await j(path, init, missing.url);
    assert.equal(r.status, 503, path);
    assert.deepEqual(r.body, { error: "module not ready" });
  }
  // job detail and pipeline still work without the pack or engine module: nothing is held
  const d = await j(`/api/jobs/${enc(ID)}`, undefined, missing.url);
  assert.equal(d.status, 200);
  assert.equal(d.body.pack, undefined);
  assert.equal(d.body.held, false);
  const p = await j("/api/pipeline", undefined, missing.url);
  assert.equal(p.status, 200);
  assert.ok((p.body.items as any[]).every(a => a.held === false));
  assert.deepEqual((await j("/api/sync", undefined, missing.url)).body, { running: false });
});

test("module-backed routes use the module when present", async () => {
  let ran = 0;
  const fake = await startServer(0, {
    uiDir,
    importer: async (name: string) => {
      if (name.endsWith("match.js")) return { listMatches: (o: any) => [{ job: job("1"), score: 9, reasons: [String(o.limit)] }] };
      if (name.endsWith("profile.js")) return {
        loadProfile: () => ({ firstName: "A" }), loadResume: () => undefined,
        profileStatus: () => ({ hasProfile: true, hasResume: false, missing: ["resume"] }),
        saveProfile: (p: any) => ({ firstName: "A", ...p }),
      };
      if (name.endsWith("tailor.js")) return { loadPack: (id: string) => ({ jobId: id }) };
      if (name.endsWith("sync.js")) return { sync: async () => { ran++; await new Promise(r => setTimeout(r, 50)); return { newJobs: 3 }; } };
      throw new Error("unexpected " + name);
    },
  });
  try {
    const m = await j("/api/matches?limit=5", undefined, fake.url);
    assert.equal(m.body[0].score, 9);
    assert.deepEqual(m.body[0].reasons, ["5"]);
    assert.equal(m.body[0].job.description.length, 400);
    const p = await j("/api/profile", undefined, fake.url);
    assert.deepEqual(p.body, { profile: { firstName: "A" }, resume: null, status: { hasProfile: true, hasResume: false, missing: ["resume"] } });
    const put = await j("/api/profile", { method: "PUT", headers: H, body: JSON.stringify({ lastName: "B" }) }, fake.url);
    assert.deepEqual(put.body, { firstName: "A", lastName: "B" });
    assert.equal((await j("/api/stats", undefined, fake.url)).body.profile.hasProfile, true);
    assert.equal((await j(`/api/jobs/${enc(ID)}`, undefined, fake.url)).body.pack.jobId, ID);

    const hdr = { method: "POST", headers: H };
    assert.deepEqual((await j("/api/sync", hdr, fake.url)).body, { started: true });
    assert.equal((await j("/api/sync", hdr, fake.url)).body.started, false);   // already running
    assert.equal((await j("/api/sync", undefined, fake.url)).body.running, true);
    await new Promise(r => setTimeout(r, 150));
    const done = await j("/api/sync", undefined, fake.url);
    assert.deepEqual(done.body, { running: false, lastReport: { newJobs: 3 } });
    assert.equal(ran, 1);
    assert.equal(db.kvGet("lastSyncReport"), '{"newJobs":3}');
  } finally { await fake.close(); }
});

test("a fresh auto-sync lock: GET /api/sync reports running and POST starts nothing", async () => {
  let ran = 0;
  const fake = await startServer(0, {
    uiDir,
    importer: async (name: string) => {
      if (name.endsWith("sync.js")) return { sync: async () => { ran++; return {}; } };
      throw new Error("unexpected " + name);
    },
  });
  try {
    db.kvSetJson("autosync:running", { startedAt: new Date().toISOString(), pid: 1 });
    assert.equal((await j("/api/sync", undefined, fake.url)).body.running, true);
    assert.deepEqual((await j("/api/sync", { method: "POST", headers: H }, fake.url)).body, { started: false, running: true });
    assert.equal(ran, 0);
    db.kvSetJson("autosync:running", { startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), pid: 1 }); // a run that died
    assert.equal((await j("/api/sync", undefined, fake.url)).body.running, false);
  } finally { db.kvSetJson("autosync:running", null); await fake.close(); }
});

test("CSRF guard on mutating routes", async () => {
  const url = `/api/jobs/${enc(ID)}/save`;
  const noHeader = await j(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noHeader.status, 403);
  const evil = await j(url, { method: "POST", headers: { ...H, origin: "http://evil.example" }, body: "{}" });
  assert.equal(evil.status, 403);
  const wrongPort = await j(url, { method: "POST", headers: { ...H, origin: "http://localhost:1" }, body: "{}" });
  assert.equal(wrongPort.status, 403);
  const okLocal = await j(url, { method: "POST", headers: { ...H, origin: `http://localhost:${srv.port}` }, body: "{}" });
  assert.equal(okLocal.status, 200);
  const okIp = await j(url, { method: "POST", headers: { ...H, origin: srv.url }, body: "{}" });
  assert.equal(okIp.status, 200);
  assert.equal((await j("/api/profile", { method: "PUT", body: "{}" })).status, 403);
  // reads need no header
  assert.equal((await j("/api/pipeline")).status, 200);
});

test("static serving and traversal", async () => {
  const idx = await fetch(srv.url + "/");
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get("content-type")!, /text\/html/);
  assert.equal(await idx.text(), "<h1>hi</h1>");
  assert.match((await fetch(srv.url + "/app.js")).headers.get("content-type")!, /javascript/);
  assert.equal((await fetch(srv.url + "/sub/logo.svg")).headers.get("content-type"), "image/svg+xml");
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/%2e%2e%2fpackage.json", "/sub/..%2f..%2fpackage.json",
    "/..%5cpackage.json", "/%00", "/missing.html", "/sub/../../secret.txt", "/files/packs/x/../../secret.txt"]) {
    const r = await raw(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /secret|"name"/, p);
  }
  const bad = await raw("/%E0%A4%A");
  assert.equal(bad.status, 400);
  const unknown = await j("/api/nope");
  assert.equal(unknown.status, 404);
  assert.ok(unknown.body.error);
});

test("generated files: packs and screenshots", async () => {
  const pdf = await fetch(`${srv.url}/files/packs/${enc(ID)}/resume.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(await pdf.text(), "%PDF-fake");
  assert.equal((await fetch(`${srv.url}/files/packs/${enc(ID)}/notes.txt`)).status, 404);        // not allow-listed
  assert.equal((await fetch(`${srv.url}/files/packs/${enc(ID)}/cover-letter.pdf`)).status, 404); // absent
  assert.equal((await raw(`/files/packs/..%2f..%2f/resume.pdf`)).status, 404);
  // a pack saved with resume_pdf keeps the user's file name; serve exactly that one
  const own = "ashby:soylent:9", dir = packDir(own);
  writeFileSync(join(dir, "Jane_Doe_Resume.pdf"), "%PDF-own");
  writeFileSync(join(dir, "Other.pdf"), "%PDF-other");
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ resumePdf: join(dir, "Jane_Doe_Resume.pdf") }));
  const mine = await fetch(`${srv.url}/files/packs/${enc(own)}/Jane_Doe_Resume.pdf`);
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get("content-type"), "application/pdf");
  assert.equal(await mine.text(), "%PDF-own");
  assert.equal((await fetch(`${srv.url}/files/packs/${enc(own)}/Other.pdf`)).status, 404); // not the pack's file
  const png = await fetch(`${srv.url}/files/screenshots/a.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.equal((await raw(`/files/screenshots/..%2fsecret.png`)).status, 404);
  assert.equal((await raw(`/files/screenshots/a.txt`)).status, 404);
});

test("pack files: non-ASCII and quoted names get a safe content-disposition", async () => {
  const id = "ashby:soylent:10", dir = packDir(id);
  for (const [name, ascii, utf8] of [
    ["Noël Résumé.pdf", "No_l R_sum_.pdf", "No%C3%ABl%20R%C3%A9sum%C3%A9.pdf"],
    ["简历 2026.pdf", "__ 2026.pdf", "%E7%AE%80%E5%8E%86%202026.pdf"], // not even latin1: a raw header throws (500)
    ['Jane "JD" O\'Doe.pdf', "Jane _JD_ O'Doe.pdf", "Jane%20%22JD%22%20O%27Doe.pdf"],
  ]) {
    writeFileSync(join(dir, name), "%PDF-x");
    writeFileSync(join(dir, "pack.json"), JSON.stringify({ resumePdf: join(dir, name) }));
    const r = await fetch(`${srv.url}/files/packs/${enc(id)}/${enc(name)}`);
    assert.equal(r.status, 200, name);
    assert.equal(r.headers.get("content-disposition"), `inline; filename="${ascii}"; filename*=UTF-8''${utf8}`);
    assert.equal(await r.text(), "%PDF-x");
  }
});

test("pack files: '.', '..', empty and path names are never served, even when pack.json lists them", async () => {
  const id = "ashby:soylent:11", dir = packDir(id);
  writeFileSync(join(dir, "resume.pdf"), "%PDF-x");
  for (const bad of ["..", ".", "/tmp/.."]) {
    writeFileSync(join(dir, "pack.json"), JSON.stringify({ resumePdf: bad, coverLetterPdf: "." }));
    for (const name of ["..", ".", "", "a/b.pdf", "a\\b.pdf"]) assert.equal(await packFile(id, name), undefined, `${bad} ${name}`);
  }
  assert.equal(await packFile(id, "resume.pdf"), join(dir, "resume.pdf"));
});

test("Host header must be loopback (DNS rebinding)", async () => {
  const u = new URL(srv.url);
  const status = await new Promise<number>((ok, fail) => {
    const req = request({ host: u.hostname, port: u.port, path: "/api/pipeline", headers: { host: "evil.example" } },
      res => { res.resume(); ok(res.statusCode!); });
    req.on("error", fail); req.end();
  });
  assert.equal(status, 403);
});

test("PUT /api/jobs/:id/pack: header guard, validation, merge, TODO list, locked statuses", async () => {
  const { saveResume } = await import("../src/profile.js");
  saveResume({ name: "Jane Doe", contact: { email: "jane@example.com" }, experience: [{ company: "Acme", title: "Engineer", bullets: ["Built 3 tools"] }], education: [] });
  const id = "greenhouse:acme:2", url = `/api/jobs/${enc(id)}/pack`;
  const put = (body: unknown, headers: Record<string, string> = H) => j(url, { method: "PUT", headers, body: JSON.stringify(body) });

  assert.equal((await put({ answers: { "Why us?": "x" } })).status, 400);                // no pack yet
  writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ jobId: id, resume: { name: "Jane Doe", contact: {}, experience: [], education: [] },
    answers: { "Why us?": "TODO (you): one specific, true reason.", "Salary?": "TODO (you): number", "Start?": "Two weeks" },
    warnings: [], createdAt: "2026-10-13T00:00:00.000Z", needsTailoredCut: true }));

  assert.equal((await put({ answers: { "Why us?": "x" } }, { "content-type": "application/json" })).status, 403);
  for (const bad of [{}, { answers: "x" }, { answers: ["x"] }, { answers: { q: 1 } }, { answers: { "": "x" } }, { coverLetter: 5 }]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await j(`/api/jobs/${enc("nope:x:1")}/pack`, { method: "PUT", headers: H, body: "{}" })).status, 404);

  const r = await put({ answers: { "Why us?": "I run my own integrations every week." } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pack.answers["Why us?"], "I run my own integrations every week.");
  assert.equal(r.body.pack.answers["Start?"], "Two weeks");
  assert.equal(r.body.pack.needsTailoredCut, true);
  assert.ok(Array.isArray(r.body.pack.warnings));
  assert.deepEqual(r.body.todos, ["Salary?"]);
  const done = await put({ answers: { "Salary?": "Open, around the posted range" } });
  assert.deepEqual(done.body.todos, []);
  assert.ok((await j(`/api/jobs/${enc(id)}`)).body.events.some((e: any) => e.kind === "pack" && /Edited in dashboard/.test(e.text)));

  const unknown = await put({ answers: { "Start?": "Now", "Not asked?": "x" } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /not a question in this pack: Not asked\?/);
  assert.equal((await j(`/api/jobs/${enc(id)}`)).body.pack.answers["Start?"], "Two weeks"); // nothing applied

  db.setApplication(id, { status: "submitted" });
  const locked = await put({ answers: { "Start?": "Now" } });
  assert.equal(locked.status, 400);
  assert.match(locked.body.error, /Cannot edit .*submitted/);
  assert.equal((await j(`/api/jobs/${enc(id)}`)).body.pack.answers["Start?"], "Two weeks");
  db.setApplication(id, { status: "filled", confirmationCode: "ABC234" }); // editing a filled form voids the fill
  assert.equal((await put({ answers: { "Start?": "Now" } })).status, 200);
  assert.equal(db.getApplication(id)?.status, "drafted");
});

test("job detail: fill lists what the current fill put on the form and its blanks; approve refuses them", async () => {
  db.upsertJobs([job("4", { description: "short" })]);
  const id = "greenhouse:acme:4";
  const { saveFill } = await import("../src/track.js");
  const detail = async () => (await j(`/api/jobs/${enc(id)}`)).body;
  assert.equal((await detail()).fill, undefined); // never filled
  db.setApplication(id, { status: "filled", confirmationCode: "FIL234" });
  saveFill(id, {
    at: "2026-10-14T12:00:00.000Z", code: "FIL234", filled: [{ key: "first_name", label: "First Name", value: "Test" }],
    blanks: ["Country"], failed: ["Location"],
  });
  const d = await detail();
  assert.deepEqual(d.fill.blanks, ["Country"]);
  assert.deepEqual(d.fill.filled, [{ key: "first_name", label: "First Name", value: "Test" }]);
  assert.deepEqual(d.fill.failed, ["Location"]); // the dashboard shows fields the filler could not enter
  assert.equal(d.fill.code, undefined);
  const ap = await post(`/api/jobs/${enc(id)}/approve`, { code: "FIL234" });
  assert.equal(ap.status, 400);
  assert.match(ap.body.error, /required fields are blank on the form: Country/);
  db.setApplication(id, { status: "drafted", confirmationCode: undefined }); // voided: the old fill is not shown as current
  assert.equal((await detail()).fill, undefined);
});

test("job detail: the screenshot is the latest fill's or newer, never an empty file", async () => {
  db.upsertJobs([job("3", { description: "short" })]);
  const id = "greenhouse:acme:3";
  writeFileSync(join(home, "screenshots", "empty.png"), "");
  const shot = async () => (await j(`/api/jobs/${enc(id)}`)).body.screenshot;
  db.addEvent(id, "filled", JSON.stringify({ screenshot: "a.png" }));
  assert.equal(await shot(), "a.png");
  db.addEvent(id, "submitted", JSON.stringify({ screenshot: "gone.png" }));
  assert.equal(await shot(), "a.png"); // missing file: fall back to the fill's
  db.addEvent(id, "filled", JSON.stringify({ screenshot: "empty.png" }));
  assert.equal(await shot(), undefined); // a 0-byte capture shows nothing, not the older fill
  db.addEvent(id, "filled", JSON.stringify({ summary: "no screenshot" }));
  assert.equal(await shot(), undefined);
});

test("GET /api/scoreboard: the strategy scoreboard as JSON, and the dashboard has a Scoreboard view", async () => {
  const r = await j("/api/scoreboard");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.week.targets, { warmAsks: 4, applications: 5 });
  assert.deepEqual([r.body.companies, r.body.milestones, r.body.configExists], [[], [], false], "no strategy.json: the generic defaults");
  assert.match(r.body.warnings.join(" "), /No strategy\.json yet/);
  assert.equal(existsSync(join(home, "strategy.json")), false, "a GET never writes strategy.json");
  assert.equal((await j("/api/scoreboard", undefined, missing.url)).status, 503, "module not ready");
  const app = readFileSync(join(import.meta.dirname, "..", "ui", "app.js"), "utf8");
  assert.ok(app.includes('get("/api/scoreboard")'), "ui/app.js reads the scoreboard");
});

test("GET /api/followups: every row carries its kind, and the dashboard handles each kind", async () => {
  const o = await import("../src/outreach.js");
  const mk = (n: string, status: "rejected" | "drafted" | "submitted") => {
    const id = `greenhouse:fu:${n}`;
    db.upsertJobs([{ ...job(n), id, boardSlug: "fu", company: `Fu ${n}` }]);
    db.setApplication(id, { status });
    return id;
  };
  const back = (id: number, days: number) => db.getDb().prepare("UPDATE outreach SET last_touch_at = ? WHERE id = ?")
    .run(new Date(Date.now() - days * 86400e3).toISOString(), id);
  const draft = o.draftOutreach({ company: "Fu 1", jobId: mk("1", "submitted"), person: "A", channel: "email", message: "hi" });
  const held = o.draftOutreach({ company: "Fu 2", jobId: mk("2", "drafted"), person: "B", channel: "email", message: "hi" });
  const dead = o.logOutreach({ company: "Fu 3", jobId: mk("3", "rejected"), person: "C", channel: "email" });
  const sent = o.logOutreach({ company: "Fu 4", person: "D", channel: "email" });
  back(draft.id, 3); back(held.id, 3); back(sent.id, 8);

  const r = await j("/api/followups");
  assert.equal(r.status, 200);
  const kind = Object.fromEntries(r.body.map((x: any) => [x.id, x.kind]));
  assert.deepEqual(kind, { [draft.id]: "send_or_close", [held.id]: "send_or_close", [dead.id]: "propose_close", [sent.id]: "follow_up" });
  assert.equal(r.body.find((x: any) => x.id === held.id).waitingOn, "submit");
  assert.equal(r.body.find((x: any) => x.id === dead.id).applicationStatus, "rejected");

  const followedDraft = await post(`/api/outreach/${draft.id}`, { followedUp: true });
  assert.equal(followedDraft.status, 400, "the dashboard cannot log a follow-up on an unsent draft");
  assert.match(followedDraft.body.error, /unsent draft/);

  // the dashboard reads the same kinds the server sends
  const app = readFileSync(join(import.meta.dirname, "..", "ui", "app.js"), "utf8");
  for (const k of ["send_or_close", "propose_close", "follow_up"]) assert.ok(app.includes(`"${k}"`), `ui/app.js handles kind ${k}`);
  for (const id of [draft.id, held.id, dead.id, sent.id]) o.updateOutreach(id, { status: "closed" });
});

test("POST /api/outreach/:id message edits a draft, the list shows it, and a sent row refuses with 400", async () => {
  const o = await import("../src/outreach.js");
  const d = o.draftOutreach({ company: "Acme", jobId: ID, person: "Webb", channel: "email", message: "v1" });
  const r = await post(`/api/outreach/${d.id}`, { message: "v2 from the dashboard" });
  assert.equal(r.status, 200);
  assert.equal(r.body.message, "v2 from the dashboard");
  assert.ok(Array.isArray(r.body.warnings));
  const row = (await j("/api/outreach")).body.find((x: any) => x.id === d.id);
  assert.equal(row.message, "v2 from the dashboard", "the Ready to send card reads this row");
  assert.equal(row.status, "draft");
  const empty = await post(`/api/outreach/${d.id}`, { message: " " });
  assert.equal(empty.status, 400, "a draft-rule refusal is the user's to fix, not a server error");
  o.updateOutreach(d.id, { status: "sent" });
  const bad = await post(`/api/outreach/${d.id}`, { message: "v3" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /already sent/);
  assert.equal((await j("/api/outreach")).body.find((x: any) => x.id === d.id).message, "v2 from the dashboard");
  o.updateOutreach(d.id, { status: "closed" });
});

test("POST /api/outreach/:id: reopening a sent row as a draft, an unknown status and a non-string message are 400s that write nothing", async () => {
  const o = await import("../src/outreach.js");
  const s = o.logOutreach({ company: "Acme", jobId: ID, person: "Reo", channel: "email", message: "what went out" });
  const reopen = await post(`/api/outreach/${s.id}`, { status: "draft" });
  assert.equal(reopen.status, 400);
  assert.match(reopen.body.error, /back to a draft/);
  const edit = await post(`/api/outreach/${s.id}`, { message: "rewritten" });
  assert.equal(edit.status, 400);
  let row = (await j("/api/outreach")).body.find((x: any) => x.id === s.id);
  assert.equal(row.status, "sent");
  assert.equal(row.message, "what went out");

  const d = o.draftOutreach({ company: "Acme", jobId: ID, person: "Bog", channel: "email", message: "v1" });
  const bogus = await post(`/api/outreach/${d.id}`, { message: "v2", status: "bogus" });
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /Unknown status/);
  const num = await post(`/api/outreach/${d.id}`, { message: 5 });
  assert.equal(num.status, 400, "a wrong type is the caller's to fix, not a server error");
  row = (await j("/api/outreach")).body.find((x: any) => x.id === d.id);
  assert.equal(row.status, "draft");
  assert.equal(row.message, "v1");
  for (const id of [s.id, d.id]) o.updateOutreach(id, { status: "closed" });
});

// ---- held fills, answers to write, fill browser (dashboard upgrade 2026-11-02) ----

test("held: job detail and pipeline say whether this process holds the filled form", async () => {
  db.upsertJobs([job("5", { description: "short" }), job("6", { description: "short", company: "Initech" })]);
  const held = "greenhouse:acme:5", gone = "greenhouse:acme:6";
  db.setApplication(held, { status: "filled", confirmationCode: "HLD234" });
  db.setApplication(gone, { status: "filled", confirmationCode: "GON234" });
  const s = await startServer(0, { uiDir, runDeps: { hasPage: id => id === held } });
  try {
    assert.equal((await j(`/api/jobs/${enc(held)}`, undefined, s.url)).body.held, true);
    assert.equal((await j(`/api/jobs/${enc(gone)}`, undefined, s.url)).body.held, false);
    const items = (await j("/api/pipeline", undefined, s.url)).body.items as any[];
    assert.equal(items.find(a => a.jobId === held).held, true);
    assert.equal(items.find(a => a.jobId === gone).held, false);
    assert.ok(items.every(a => typeof a.held === "boolean"));
  } finally { await s.close(); }
});

test("held: a submit running here counts as held, so the dashboard never says nothing was submitted", async () => {
  db.upsertJobs([job("11", { description: "short", company: "Hooli" })]);
  const id = "greenhouse:acme:11";
  db.setApplication(id, { status: "approved", confirmationCode: "SUB234" });
  db.kvSet(`run:${id}`, JSON.stringify({ kind: "submit", state: "running", startedAt: new Date().toISOString(), pid: process.pid }));
  const s = await startServer(0, { uiDir, runDeps: { hasPage: () => false } }); // the ticket is spent once Submit is pressed
  try {
    assert.equal((await j(`/api/jobs/${enc(id)}`, undefined, s.url)).body.held, true);
    assert.equal(((await j("/api/pipeline", undefined, s.url)).body.items as any[]).find(a => a.jobId === id).held, true);
    db.kvSet(`run:${id}`, JSON.stringify({ kind: "submit", state: "failed", startedAt: new Date().toISOString(), error: "x" }));
    assert.equal((await j(`/api/jobs/${enc(id)}`, undefined, s.url)).body.held, false);
  } finally { await s.close(); }
});

test("refill: voids a filled or approved form, refuses a submitted one and a busy job", async () => {
  db.upsertJobs([job("12", { description: "short", company: "Pied Piper" })]);
  const id = "greenhouse:acme:12";
  const refill = () => post(`/api/jobs/${enc(id)}/refill`);
  for (const status of ["filled", "approved"] as const) {
    db.setApplication(id, { status, confirmationCode: "REF234" });
    const r = await refill();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "drafted");
    assert.equal(db.getApplication(id)?.confirmationCode, undefined);
  }
  // an agent submitted while the page showed a stale "filled": never back to drafted, so no second submit
  db.setApplication(id, { status: "submitted", submittedAt: "2026-11-02T00:00:00.000Z" });
  for (const status of ["submitted", "drafted", "interview"] as const) {
    if (status !== "submitted") db.setApplication(id, { status });
    const r = await refill();
    assert.equal(r.status, 409, status);
    assert.match(r.body.error, /Cannot re-fill .*expected "filled" or "approved"/);
    assert.equal(db.getApplication(id)?.status, status);
  }
  db.setApplication(id, { status: "approved", confirmationCode: "REF345" });
  db.kvSet(`run:${id}`, JSON.stringify({ kind: "submit", state: "running", startedAt: new Date().toISOString(), pid: process.pid }));
  const busy = await refill();
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /Busy: a submit run is running/);
  assert.equal(db.getApplication(id)?.status, "approved");
  assert.equal(db.getApplication(id)?.confirmationCode, "REF345");
  db.kvSet(`run:${id}`, JSON.stringify({ kind: "submit", state: "failed", startedAt: new Date().toISOString(), error: "x" }));
  assert.equal((await post(`/api/jobs/${enc(id)}/refill`, undefined, { "content-type": "application/json" })).status, 403); // CSRF guard
});

test("approve: refuses a wrong code or blanks exactly as before, and says held:false with no run when no form is held", async () => {
  const { saveFill } = await import("../src/track.js");
  const { getRun } = await import("../src/runs.js");
  const held = "greenhouse:acme:5", gone = "greenhouse:acme:6";
  let submits = 0;
  const s = await startServer(0, { uiDir, runDeps: {
    hasPage: id => id === held,
    submit: async jobId => { submits++; return { jobId, outcome: "submitted", detail: "Submitted (stub)" }; },
  } });
  try {
    // regression: a stale code and required blanks still refuse, and nothing starts
    const wrong = await j(`/api/jobs/${enc(held)}/approve`, { method: "POST", headers: H, body: JSON.stringify({ code: "WRONG9" }) }, s.url);
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /filled again since you looked/);
    const none = await j(`/api/jobs/${enc(held)}/approve`, { method: "POST", headers: H, body: "{}" }, s.url);
    assert.equal(none.status, 400);
    saveFill(held, { at: "2026-11-02T00:00:00.000Z", code: "HLD234", filled: [], blanks: ["Phone"], failed: [] });
    const blank = await j(`/api/jobs/${enc(held)}/approve`, { method: "POST", headers: H, body: JSON.stringify({ code: "HLD234" }) }, s.url);
    assert.equal(blank.status, 400);
    assert.match(blank.body.error, /required fields are blank on the form: Phone/);
    assert.equal(db.getApplication(held)?.status, "filled");
    assert.equal(getRun(held), undefined);
    assert.equal(submits, 0);

    // not held: approve() still records the yes, but no submit starts and the response says so
    const ap = await j(`/api/jobs/${enc(gone)}/approve`, { method: "POST", headers: H, body: JSON.stringify({ code: "GON234" }) }, s.url);
    assert.equal(ap.status, 200);
    assert.equal(ap.body.status, "approved");
    assert.equal(ap.body.held, false);
    assert.equal(ap.body.run, undefined);
    assert.equal(getRun(gone), undefined);
    assert.equal(submits, 0);

    // held: the dashboard presses Submit on the form it holds
    saveFill(held, { at: "2026-11-02T00:00:00.000Z", code: "HLD234", filled: [], blanks: [], failed: [] });
    const go = await j(`/api/jobs/${enc(held)}/approve`, { method: "POST", headers: H, body: JSON.stringify({ code: "HLD234" }) }, s.url);
    assert.equal(go.status, 200);
    assert.equal(go.body.held, true);
    assert.equal(go.body.run.kind, "submit");
    await new Promise(r => setTimeout(r, 20));
    assert.equal(submits, 1);
  } finally { await s.close(); }
});

test("GET /api/todos groups one question across packs and leaves out filled and submitted ones", async () => {
  db.upsertJobs([7, 8, 9, 10].map(n => job(String(n), { description: "short", company: `Co${n}` })));
  const ids = [7, 8, 9, 10].map(n => `greenhouse:acme:${n}`);
  const pack = (id: string, answers: Record<string, string>, coverLetter?: string) =>
    writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ jobId: id, resume: { name: "Jane Doe", contact: {}, experience: [], education: [] },
      answers, ...(coverLetter ? { coverLetter } : {}), warnings: [], createdAt: "2026-11-01T00:00:00.000Z" }));
  pack(ids[0], { "Why us?": "TODO (you): one true reason.", "Start?": "Two weeks", "Relocate?": "" });
  pack(ids[1], { "Why us?": "TODO (you): why this team.", "Start?": "Two weeks" }, "Dear Co8,\nTODO (you): opening line");
  pack(ids[2], { "Why us?": "TODO (you): left over" }); // filled: its form is open, not a to-do here
  pack(ids[3], { "Why us?": "TODO (you): left over" }); // submitted
  db.setApplication(ids[0], { status: "drafted" });
  db.setApplication(ids[1], { status: "saved" });
  db.setApplication(ids[2], { status: "filled", confirmationCode: "TOD234" });
  db.setApplication(ids[3], { status: "submitted" });

  const r = await j("/api/todos");
  assert.equal(r.status, 200);
  const mine = (r.body as any[]).map(g => ({ ...g, jobs: g.jobs.filter((x: any) => ids.includes(x.jobId)) })).filter(g => g.jobs.length);
  const why = mine.find(g => g.question === "Why us?");
  assert.deepEqual(why.jobs.map((x: any) => x.jobId).sort(), [ids[0], ids[1]]);
  const first = why.jobs.find((x: any) => x.jobId === ids[0]);
  assert.equal(first.company, "Co7");
  assert.equal(first.title, "Engineer 7");
  assert.equal(first.current, "TODO (you): one true reason.");
  assert.deepEqual(mine.find(g => g.question === "Relocate?").jobs.map((x: any) => x.jobId), [ids[0]]);
  const cover = mine.find(g => g.question === "Cover letter");
  assert.equal(cover.cover, true);
  assert.equal(cover.jobs[0].jobId, ids[1]);
  assert.match(cover.jobs[0].current, /opening line/);
  assert.ok(!mine.some(g => g.question === "Start?"));
  assert.ok(!(r.body as any[]).some(g => g.jobs.some((x: any) => x.jobId === ids[2] || x.jobId === ids[3])));

  // answering goes through the existing PUT pack: the question drops out of the list
  const put = await j(`/api/jobs/${enc(ids[0])}/pack`, { method: "PUT", headers: H, body: JSON.stringify({ answers: { "Why us?": "I use your product every week." } }) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const after = (await j("/api/todos")).body as any[];
  assert.deepEqual(after.find(g => g.question === "Why us?").jobs.filter((x: any) => ids.includes(x.jobId)).map((x: any) => x.jobId), [ids[1]]);
  assert.equal((await j("/api/todos", undefined, missing.url)).status, 503);
});

test("GET /api/browser: one probe of the fill browser's DevTools port, cached", async () => {
  const prev = process.env.OPENAPPLY_CDP_PORT;
  const { createServer } = await import("node:http");
  const fake = createServer((req, res) => { res.writeHead(req.url === "/json/version" ? 200 : 404); res.end("{}"); });
  await new Promise<void>(ok => fake.listen(0, "127.0.0.1", () => ok()));
  const fakePort = (fake.address() as any).port as number;
  try {
    process.env.OPENAPPLY_CDP_PORT = "9444"; // closed: nothing listens there in tests
    const closed = await startServer(0, { uiDir });
    try {
      const r = await j("/api/browser", undefined, closed.url);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { up: false, port: 9444 });
    } finally { await closed.close(); }

    process.env.OPENAPPLY_CDP_PORT = String(fakePort);
    const s = await startServer(0, { uiDir });
    try {
      assert.deepEqual((await j("/api/browser", undefined, s.url)).body, { up: true, port: fakePort });
      await new Promise<void>(ok => fake.close(() => ok()));
      assert.deepEqual((await j("/api/browser", undefined, s.url)).body, { up: true, port: fakePort }); // cached for 10 s
    } finally { await s.close(); }
  } finally {
    if (prev === undefined) delete process.env.OPENAPPLY_CDP_PORT; else process.env.OPENAPPLY_CDP_PORT = prev;
    fake.close();
  }
});
