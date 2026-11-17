import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { getDb, kvGet, kvGetJson, kvSetJson, LAST_FULL_SYNC_KEY } from "./db.js";
import { home, pkgRoot } from "./paths.js";

/**
 * Daily index refresh from the dashboard process (the LaunchAgent keeps it alive). A timer checks the index age;
 * when the last full sync (kv lastFullSync, written by sync() only for a run over every board that mostly worked)
 * is older than maxAgeMs it starts `node dist/cli.js sync` as a detached child, so the minutes-long sync never
 * runs on the HTTP server's event loop. A kv lock, taken in one statement, keeps two dashboards (or a restart
 * mid-sync) from starting a second one, and tells the dashboard Sync button and sync_jobs a run is going;
 * a lock older than LOCK_TTL_MS is taken as a run that died.
 */
export const LOCK_KEY = "autosync:running";
export const LAST_KEY = "autosync:last";
export const LOCK_TTL_MS = 2 * 3_600_000;
const FIRST_CHECK_MS = 60_000;
export const DEFAULT_PORT = 4646;

interface Lock { startedAt: string; pid?: number }
export interface LastRun { startedAt: string; endedAt?: string; code?: number | null; error?: string }

export interface AutoSyncOptions {
  intervalMs?: number;
  maxAgeMs?: number;
  now?: () => number;
  /** Starts the sync child (child_process.spawn's signature); tests pass a fake. Not node's spawnSync. */
  spawnSync?: (cmd: string, args: string[], opts: object) => ChildProcess;
  /** ISO end time of the last full sync (default: kv lastFullSync). */
  lastFullSync?: () => string | undefined;
}

export interface AutoSyncHandle {
  /** False when OPENAPPLY_AUTOSYNC=0: no timers were set. */
  enabled: boolean;
  /** Run one check now; true when it started a sync. */
  tick(): boolean;
  stop(): void;
}

/** Only the main dashboard (default port, which a second one cannot bind) syncs on its own, unless OPENAPPLY_AUTOSYNC=1. */
export function autoSyncWanted(port: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENAPPLY_AUTOSYNC === "1" || (port === DEFAULT_PORT && env.OPENAPPLY_AUTOSYNC !== "0");
}

/** True while an auto-sync child holds a lock younger than LOCK_TTL_MS (any process on this OPENAPPLY_HOME). */
export function autoSyncRunning(t = Date.now()): boolean {
  const lock = kvGetJson<Lock | null>(LOCK_KEY);
  return !!lock?.startedAt && t - Date.parse(lock.startedAt) < LOCK_TTL_MS;
}

/** Takes the lock when it is free or expired, in one statement, so two checks at the same moment cannot both win. */
function takeLock(startedAt: string, t: number): boolean {
  const r = getDb().prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v
    WHERE json_extract(kv.v, '$.startedAt') IS NULL OR json_extract(kv.v, '$.startedAt') <= ?`)
    .run(LOCK_KEY, JSON.stringify({ startedAt } satisfies Lock), new Date(t - LOCK_TTL_MS).toISOString());
  return Number(r.changes) === 1;
}

export function startAutoSync(o: AutoSyncOptions = {}): AutoSyncHandle {
  // Short on purpose: timers count only awake time on macOS, and a check is one kv read; maxAgeMs decides when to sync.
  const intervalMs = o.intervalMs ?? 20 * 60_000;
  const maxAgeMs = o.maxAgeMs ?? 24 * 3_600_000;
  const now = o.now ?? Date.now;
  const lastFullSync = o.lastFullSync ?? (() => kvGet(LAST_FULL_SYNC_KEY));
  const start = o.spawnSync ?? spawn;

  const tick = (): boolean => {
    const t = now();
    const last = lastFullSync();
    if (last && t - Date.parse(last) < maxAgeMs) return false;
    const startedAt = new Date(t).toISOString();
    if (!takeLock(startedAt, t)) return false;

    let child: ChildProcess;
    try {
      const dir = join(home(), "runs");
      mkdirSync(dir, { recursive: true });
      const log = openSync(join(dir, `autosync-${startedAt.slice(0, 10)}.log`), "a");
      try {
        child = start(process.execPath, [join(pkgRoot, "dist", "cli.js"), "sync"], {
          detached: true, stdio: ["ignore", log, log], env: process.env, cwd: pkgRoot,
        });
      } finally { closeSync(log); } // the child holds its own copy of the fd
    } catch (e) { kvSetJson(LOCK_KEY, null); throw e; } // nothing started: don't hold the lock for 2 h
    kvSetJson(LOCK_KEY, { startedAt, pid: child.pid } satisfies Lock);
    kvSetJson(LAST_KEY, { startedAt } satisfies LastRun);
    let settled = false;
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      kvSetJson(LOCK_KEY, null);
      kvSetJson(LAST_KEY, { startedAt, endedAt: new Date(now()).toISOString(), code, ...(error ? { error } : {}) } satisfies LastRun);
    };
    child.on("error", e => finish(null, e.message));
    child.on("exit", code => finish(code));
    child.unref();
    return true;
  };

  if (process.env.OPENAPPLY_AUTOSYNC === "0") return { enabled: false, tick, stop() {} };

  // A timer callback that throws would take the dashboard (and its held fills) down with it.
  const safeTick = () => {
    try { tick(); } catch (e) { console.error("autosync:", e instanceof Error ? e.message : e); }
  };
  const first = setTimeout(safeTick, FIRST_CHECK_MS);
  const every = setInterval(safeTick, intervalMs);
  first.unref();
  every.unref();
  return {
    enabled: true,
    tick,
    stop() { clearTimeout(first); clearInterval(every); },
  };
}
