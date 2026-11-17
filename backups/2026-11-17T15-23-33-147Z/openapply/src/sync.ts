import type { Board } from "./types.js";
import { closeMissing, closeUnseenSince, kvSet, LAST_FULL_SYNC_KEY, recordBoardSync, upsertBoards, upsertJobs } from "./db.js";
import { BOARD_SOURCES, FEED_SOURCES, loadBoards } from "./sources/index.js";
import { isTruncated, NotFoundError, pool } from "./sources/http.js";

export interface SyncReport {
  boards: number; ok: number; failed: number; notFound: string[];
  jobsSeen: number; newJobs: number; closed: number;
  feeds: Record<string, number | string>; ms: number;
}

/** A truncated list never closes by absence: a row there closes once no sync has seen it for this long. */
const UNSEEN_CLOSE_MS = 7 * 86_400_000;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function sync(opts: {
  boards?: Board[]; feeds?: boolean; concurrency?: number; onProgress?: (done: number, total: number) => void;
} = {}): Promise<SyncReport> {
  const t0 = Date.now();
  const boards = opts.boards ?? loadBoards();
  upsertBoards(boards);
  const r: SyncReport = { boards: boards.length, ok: 0, failed: 0, notFound: [], jobsSeen: 0, newJobs: 0, closed: 0, feeds: {}, ms: 0 };

  // 16 in flight: 32 and 48 measured the same (network-bound), and bursts above that drew 403s from Greenhouse
  let done = 0;
  const runBoards = pool(boards, opts.concurrency ?? 16, async b => {
    try {
      const fetchBoard = BOARD_SOURCES[b.ats];
      if (!fetchBoard) throw new Error(`no source for ${b.ats}`);
      const jobs = await fetchBoard(b.slug);
      if (b.company) for (const j of jobs) j.company = b.company;
      r.jobsSeen += jobs.length;
      r.newJobs += upsertJobs(jobs);
      // a capped fetch only saw part of the board: closing "missing" jobs would close the rest
      if (!isTruncated(jobs)) r.closed += closeMissing(b.ats, b.slug, jobs.map(j => j.id));
      else r.closed += closeUnseenSince(b.ats, b.slug, new Date(Date.now() - UNSEEN_CLOSE_MS).toISOString());
      recordBoardSync(b.ats, b.slug, "ok", jobs.length);
      r.ok++;
    } catch (e) {
      r.failed++;
      if (e instanceof NotFoundError) r.notFound.push(`${b.ats}:${b.slug}`);
      recordBoardSync(b.ats, b.slug, e instanceof NotFoundError ? "not_found" : `error: ${msg(e).slice(0, 200)}`, null);
    }
    opts.onProgress?.(++done, boards.length);
  });

  const runFeeds = opts.feeds === false ? Promise.resolve() : Promise.all(
    Object.entries(FEED_SOURCES).map(async ([name, fetchFeed]) => {
      try {
        const jobs = await fetchFeed!();
        // an empty answer is more likely a broken feed than a truly empty one: keep what we have
        if (jobs.length) {
          r.newJobs += upsertJobs(jobs);
          r.closed += closeMissing(name, name, jobs.map(j => j.id));
          r.jobsSeen += jobs.length;
        }
        r.feeds[name] = jobs.length;
      } catch (e) {
        r.feeds[name] = `error: ${msg(e).slice(0, 120)}`;
      }
    }),
  );

  await Promise.all([runBoards, runFeeds]);
  r.ms = Date.now() - t0;
  // boards.last_sync moves on failures and on discover_company's one-board syncs; only a real full run counts as fresh
  if (!opts.boards && r.ok > 0 && r.ok * 2 >= r.boards) kvSet(LAST_FULL_SYNC_KEY, new Date().toISOString());
  return r;
}
