import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync as runNode } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./offline.js";

const home = mkdtempSync(join(tmpdir(), "oa-autosync-"));
process.env.OPENAPPLY_HOME = home;
const db = await import("../src/db.js");
const { pkgRoot } = await import("../src/paths.js");
const { startAutoSync, autoSyncWanted, LOCK_KEY, LAST_KEY } = await import("../src/autosync.js");
const { sync } = await import("../src/sync.js");
const { BOARD_SOURCES } = await import("../src/sources/index.js");

const H = 3_600_000;
const T0 = Date.parse("2026-11-02T12:00:00.000Z");

/** A fake sync child: records each spawn; the test decides when it exits. */
function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
  const children: Array<EventEmitter & { pid: number; unref(): void }> = [];
  const spawnSync = (cmd: string, args: string[], opts: object) => {
    calls.push({ cmd, args, opts });
    const c = Object.assign(new EventEmitter(), { pid: 4242, unref() {} });
    children.push(c);
    return c as any;
  };
  return {
    spawnSync, calls,
    exit: (code: number) => children.at(-1)!.emit("exit", code),
    fail: (e: Error) => children.at(-1)!.emit("error", e),
  };
}
const clock = (t: number) => { const c = { t, now: () => c.t }; return c; };
/** Record a full sync that ended `ms` before the clock, the way sync() does. */
const fullSyncAgo = (ms: number, c: { t: number }) => db.kvSet(db.LAST_FULL_SYNC_KEY, new Date(c.t - ms).toISOString());

/** Swap every board source for `fetch` while `run` goes, so sync() runs over the real board list with no network. */
async function withSources<T>(fetch: (slug: string) => Promise<any[]>, run: () => Promise<T>): Promise<T> {
  const saved = { ...BOARD_SOURCES };
  for (const k of Object.keys(BOARD_SOURCES)) (BOARD_SOURCES as any)[k] = fetch;
  try { return await run(); } finally { Object.assign(BOARD_SOURCES, saved); }
}

afterEach(() => {
  mock.timers.reset();
  db.kvSetJson(LOCK_KEY, null);
  db.getDb().prepare("DELETE FROM kv WHERE k = ?").run(db.LAST_FULL_SYNC_KEY);
  delete process.env.OPENAPPLY_AUTOSYNC;
});

test("fresh index: no spawn", () => {
  const c = clock(T0), f = fakeSpawn();
  fullSyncAgo(2 * H, c);
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync });
  assert.equal(h.tick(), false);
  assert.equal(f.calls.length, 0);
  h.stop();
});

test("stale index: exactly one detached `node dist/cli.js sync`, logged to runs/autosync-<date>.log", () => {
  const c = clock(T0), f = fakeSpawn();
  fullSyncAgo(25 * H, c);
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync });
  assert.equal(h.tick(), true);
  assert.equal(f.calls.length, 1);
  const { cmd, args, opts } = f.calls[0];
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, [join(pkgRoot, "dist", "cli.js"), "sync"]);
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio[0], "ignore");
  assert.equal(typeof opts.stdio[1], "number"); // log file fd
  assert.equal(opts.stdio[1], opts.stdio[2]);
  assert.ok(existsSync(join(home, "runs", "autosync-2026-11-02.log")));
  assert.deepEqual(db.kvGetJson(LOCK_KEY), { startedAt: new Date(T0).toISOString(), pid: 4242 });
  assert.deepEqual(db.kvGetJson(LAST_KEY), { startedAt: new Date(T0).toISOString() });

  c.t += 4 * 60_000;
  f.exit(0);
  assert.equal(db.kvGetJson(LOCK_KEY), null); // released
  assert.deepEqual(db.kvGetJson(LAST_KEY), { startedAt: new Date(T0).toISOString(), endedAt: new Date(c.t).toISOString(), code: 0 });
  h.stop();
});

test("a never-synced index counts as stale", () => {
  const c = clock(T0), f = fakeSpawn();
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync, });
  assert.equal(h.tick(), true);
  assert.equal(f.calls.length, 1);
  h.stop();
});

test("a second tick while the lock is fresh: no spawn", () => {
  const c = clock(T0), f = fakeSpawn();
  fullSyncAgo(25 * H, c);
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync });
  assert.equal(h.tick(), true);
  c.t += 1.5 * H; // sync still running, index still stale
  assert.equal(h.tick(), false);
  assert.equal(f.calls.length, 1);
  h.stop();
});

test("a lock from another dashboard process (fresh) also blocks; an expired one lets it spawn again", () => {
  const c = clock(T0), f = fakeSpawn();
  db.kvSetJson(LOCK_KEY, { startedAt: new Date(T0 - 30 * 60_000).toISOString(), pid: 1 });
  fullSyncAgo(25 * H, c);
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync });
  assert.equal(h.tick(), false);
  assert.equal(f.calls.length, 0);
  c.t += 2 * H; // lock now 2.5 h old: the run died without releasing it
  assert.equal(h.tick(), true);
  assert.equal(f.calls.length, 1);
  h.stop();
});

test("a spawn error (e.g. dist/cli.js missing) releases the lock and records it; a throwing check never escapes the timer", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const c = clock(T0), f = fakeSpawn();
  fullSyncAgo(25 * H, c);
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync });
  assert.equal(h.tick(), true);
  f.fail(new Error("spawn ENOENT"));
  assert.equal(db.kvGetJson(LOCK_KEY), null);
  assert.deepEqual(db.kvGetJson(LAST_KEY), { startedAt: new Date(T0).toISOString(), endedAt: new Date(T0).toISOString(), code: null, error: "spawn ENOENT" });
  h.stop();

  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    const h2 = startAutoSync({ now: c.now, spawnSync: f.spawnSync, lastFullSync: () => { throw new Error("db locked"); } });
    assert.doesNotThrow(() => mock.timers.tick(60_000));
    assert.equal(errors.length, 1);
    h2.stop();
  } finally { console.error = orig; }
});

test("timers: first check after 60 s, then every interval; stop() clears both", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const c = clock(T0), f = fakeSpawn();
  let checks = 0;
  const lastFullSync = () => { checks++; return new Date(c.t - 2 * H).toISOString(); };
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync, lastFullSync, intervalMs: 6 * H });
  mock.timers.tick(59_000);
  assert.equal(checks, 0);
  mock.timers.tick(1_000);
  assert.equal(checks, 1);
  mock.timers.tick(6 * H);
  assert.equal(checks, 2);
  h.stop();
  mock.timers.tick(24 * H);
  assert.equal(checks, 2);
});

test("stale index found by the timer spawns once across ticks", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const c = clock(T0), f = fakeSpawn();
  fullSyncAgo(30 * H, c);
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync, intervalMs: H });
  mock.timers.tick(60_000);
  assert.equal(f.calls.length, 1);
  mock.timers.tick(H); // lock fresh
  assert.equal(f.calls.length, 1);
  h.stop();
});

test("OPENAPPLY_AUTOSYNC=0: no timer, no spawn", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  process.env.OPENAPPLY_AUTOSYNC = "0";
  const c = clock(T0), f = fakeSpawn();
  let checks = 0;
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync, lastFullSync: () => { checks++; return undefined; } });
  assert.equal(h.enabled, false);
  mock.timers.tick(48 * H);
  assert.equal(checks, 0);
  assert.equal(f.calls.length, 0);
  h.stop(); // harmless
});

test("timers are unref'd: a process holding only the autosync timers exits on its own", () => {
  const r = runNode(process.execPath, ["--import", "tsx", "-e",
    `import("./src/autosync.ts").then(m => { m.startAutoSync(); console.log("started"); })`],
    { cwd: pkgRoot, env: { ...process.env, OPENAPPLY_HOME: home }, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.signal, null, "killed by the timeout: a timer kept the process alive");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /started/);
});

// ---- against what a real sync() writes (no stubbed staleness check) ----

test("a one-board sync (discover_company) moves boards.last_sync but leaves a stale index stale", async () => {
  const c = clock(Date.now()), f = fakeSpawn();
  fullSyncAgo(25 * H, c);
  db.getDb().prepare(`INSERT INTO boards (ats, slug, last_sync) VALUES ('greenhouse', 'old', ?)
    ON CONFLICT(ats, slug) DO UPDATE SET last_sync = excluded.last_sync`).run(new Date(c.t - 25 * H).toISOString());
  await withSources(async () => [], () => sync({ boards: [{ ats: "greenhouse", slug: "acme" }], feeds: false }));
  assert.ok(c.t - Date.parse(db.jobStats().lastSync!) < 60_000, "the one board stamped last_sync");
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync });
  assert.equal(h.tick(), true);
  h.stop();
});

test("a full run where every board failed (offline at login) does not count as fresh", async () => {
  const c = clock(Date.now()), f = fakeSpawn();
  fullSyncAgo(25 * H, c);
  const r = await withSources(async () => { throw new Error("getaddrinfo ENOTFOUND"); }, () => sync({ feeds: false }));
  assert.ok(r.boards > 100);
  assert.equal(r.ok, 0);
  assert.ok(c.t - Date.parse(db.jobStats().lastSync!) < 60_000, "failures stamp last_sync too");
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync });
  assert.equal(h.tick(), true);
  h.stop();
});

test("a full run that worked counts as fresh", async () => {
  const r = await withSources(async () => [], () => sync({ feeds: false }));
  assert.equal(r.ok, r.boards);
  const c = clock(Date.now()), f = fakeSpawn();
  const h = startAutoSync({ now: c.now, spawnSync: f.spawnSync });
  assert.equal(h.tick(), false);
  assert.equal(f.calls.length, 0);
  h.stop();
});

test("a spawn that throws releases the lock at once", () => {
  const c = clock(T0);
  fullSyncAgo(25 * H, c);
  const h = startAutoSync({ now: c.now, spawnSync: () => { throw new Error("EAGAIN"); } });
  assert.throws(() => h.tick(), /EAGAIN/);
  assert.equal(db.kvGetJson(LOCK_KEY), null);
  h.stop();
});

test("only the main dashboard (default port) auto-syncs, unless OPENAPPLY_AUTOSYNC=1", () => {
  assert.equal(autoSyncWanted(4646, {}), true); // the LaunchAgent runs `ui 4646`
  assert.equal(autoSyncWanted(4647, {}), false); // a preview on another port
  assert.equal(autoSyncWanted(4647, { OPENAPPLY_AUTOSYNC: "1" }), true);
  assert.equal(autoSyncWanted(4646, { OPENAPPLY_AUTOSYNC: "0" }), false);
});
