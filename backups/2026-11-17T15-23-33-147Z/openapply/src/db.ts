import { DatabaseSync } from "node:sqlite";
import { ensureHome, paths } from "./paths.js";
import { truncateWords } from "./text.js";
import type {
  Application, ApplicationEvent, ApplicationStatus, Board, Job, JobFilters, NormalizedJob,
} from "./types.js";

let db: DatabaseSync | null = null;

/** board_slug of the placeholder jobs that history import creates (ats "other"). */
const HISTORY_BOARD = "history";
/** SQL condition matching those placeholders, to leave them out of counts and company signals. Hits the jobs_board index. */
export const HISTORY_JOB = `ats = 'other' AND board_slug = '${HISTORY_BOARD}'`;

/** Descriptions longer than this are stored as a snippet; the full text is fetched on demand (details.ts). */
export const SNIPPET_CHARS = 700;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  ats TEXT NOT NULL,
  board_slug TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  remote INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  desc_full INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL,
  apply_url TEXT NOT NULL,
  department TEXT, employment_type TEXT,
  salary_min REAL, salary_max REAL, salary_currency TEXT,
  posted_at TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  open INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS jobs_board ON jobs(ats, board_slug);
CREATE INDEX IF NOT EXISTS jobs_open ON jobs(open, posted_at);
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  title, company, location, description, content='jobs', content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS boards (
  ats TEXT NOT NULL, slug TEXT NOT NULL, company TEXT,
  last_sync TEXT, last_status TEXT, job_count INTEGER,
  PRIMARY KEY (ats, slug)
);
CREATE TABLE IF NOT EXISTS applications (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  confirmation_code TEXT,
  submitted_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id, at);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  job_id TEXT,
  person TEXT NOT NULL,
  role TEXT, channel TEXT NOT NULL, contact TEXT, message TEXT,
  sent_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  follow_ups INTEGER NOT NULL DEFAULT 0,
  last_touch_at TEXT NOT NULL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS outreach_company ON outreach(lower(company));
`;

/* Kept apart from SCHEMA: the compaction migration runs between the tables and the triggers. */
const TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS jobs_ai AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company, location, description)
  VALUES (new.rowid, new.title, new.company, new.location, new.description);
END;
CREATE TRIGGER IF NOT EXISTS jobs_ad AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location, description)
  VALUES ('delete', old.rowid, old.title, old.company, old.location, old.description);
END;
CREATE TRIGGER IF NOT EXISTS jobs_au AFTER UPDATE OF title, company, location, description ON jobs
WHEN old.title IS NOT new.title OR old.company IS NOT new.company OR old.location IS NOT new.location
  OR old.description IS NOT new.description BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location, description)
  VALUES ('delete', old.rowid, old.title, old.company, old.location, old.description);
  INSERT INTO jobs_fts(rowid, title, company, location, description)
  VALUES (new.rowid, new.title, new.company, new.location, new.description);
END;
`;

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureHome();
  const d = new DatabaseSync(paths.db);
  try {
    d.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    d.exec(SCHEMA);
    migrate(d);
    d.exec(TRIGGERS);
  } catch (e) { d.close(); throw e; }
  db = d;
  return d;
}

/**
 * Bring an older DB to the lean-index layout, once. Adds desc_full, cuts long descriptions to snippets
 * (the DB keeps its rows, only the text shrinks), rebuilds the FTS index without the dropped text and
 * VACUUMs to give the disk space back. Completion is recorded in kv, so an interrupted run just restarts.
 */
function migrate(d: DatabaseSync): void {
  const cols = d.prepare("PRAGMA table_info(jobs)").all() as Row[];
  if (!cols.some(c => c.name === "desc_full")) d.exec("ALTER TABLE jobs ADD COLUMN desc_full INTEGER NOT NULL DEFAULT 0");
  const appCols = d.prepare("PRAGMA table_info(applications)").all() as Row[];
  if (!appCols.some(c => c.name === "source")) d.exec("ALTER TABLE applications ADD COLUMN source TEXT");
  const done = d.prepare("SELECT 1 FROM kv WHERE k = 'lean_index_v1'").get();
  if (done) return;
  const long = (d.prepare("SELECT count(*) AS n FROM jobs WHERE length(description) > ?").get(SNIPPET_CHARS) as Row).n as number;
  // short descriptions are whole, except sources that only ever store a stub (decided before truncating adds snippets)
  d.exec("UPDATE jobs SET desc_full = 1 WHERE desc_full = 0 AND length(description) <= " + SNIPPET_CHARS + " AND ats NOT IN ('smartrecruiters')");
  // the per-row FTS maintenance trigger would be slower than one rebuild at the end; TRIGGERS recreates it
  d.exec("DROP TRIGGER IF EXISTS jobs_au");
  if (long > 0) {
    const page = d.prepare("SELECT rowid AS rid, substr(description, 1, ?) AS head FROM jobs WHERE rowid > ? AND length(description) > ? ORDER BY rowid LIMIT 5000");
    const upd = d.prepare("UPDATE jobs SET description = ?, desc_full = 0 WHERE rowid = ?");
    d.exec("BEGIN");
    try {
      for (let last = 0, rows: Row[]; (rows = page.all(SNIPPET_CHARS + 1, last, SNIPPET_CHARS) as Row[]).length; last = rows[rows.length - 1].rid) {
        for (const r of rows) upd.run(truncateWords(r.head, SNIPPET_CHARS), r.rid);
      }
      d.exec("COMMIT");
    } catch (e) { d.exec("ROLLBACK"); throw e; }
    d.exec("INSERT INTO jobs_fts(jobs_fts) VALUES('rebuild')");
    d.exec("VACUUM");
    d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  d.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('lean_index_v1', ?)").run(now());
}

/** Tests: drop the cached handle after changing OPENAPPLY_HOME. */
export function closeDb(): void {
  db?.close();
  db = null;
}

const now = () => new Date().toISOString();

type Row = Record<string, any>;

function rowToJob(r: Row): Job {
  return {
    id: r.id, ats: r.ats, boardSlug: r.board_slug, company: r.company, title: r.title,
    location: r.location, remote: !!r.remote, description: r.description, descriptionComplete: !!r.desc_full, url: r.url,
    applyUrl: r.apply_url, department: r.department ?? undefined,
    employmentType: r.employment_type ?? undefined, salaryMin: r.salary_min ?? undefined,
    salaryMax: r.salary_max ?? undefined, salaryCurrency: r.salary_currency ?? undefined,
    postedAt: r.posted_at ?? undefined, firstSeen: r.first_seen, lastSeen: r.last_seen,
    open: !!r.open,
  };
}

/** What the index stores for a description: whole when it fits the snippet length, else a word-boundary snippet. */
function storedDescription(j: NormalizedJob): { text: string; full: number } {
  const text = j.description ?? "";
  const fits = text.length <= SNIPPET_CHARS;
  return { text: fits ? text : truncateWords(text.slice(0, SNIPPET_CHARS + 100), SNIPPET_CHARS), full: fits && j.descriptionComplete !== false ? 1 : 0 };
}

/**
 * Insert or refresh postings. Returns how many were new. Long descriptions are stored as snippets
 * (desc_full = 0); a description fetched in full (desc_full = 1) is never replaced by a snippet.
 */
export function upsertJobs(jobs: NormalizedJob[]): number {
  const d = getDb();
  const t = now();
  const exists = d.prepare("SELECT 1 FROM jobs WHERE id = ?");
  const ins = d.prepare(`INSERT INTO jobs (id, ats, board_slug, company, title, location, remote, description, desc_full,
      url, apply_url, department, employment_type, salary_min, salary_max, salary_currency, posted_at,
      first_seen, last_seen, open)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET company=excluded.company, title=excluded.title,
      location=excluded.location, remote=excluded.remote,
      description=CASE WHEN jobs.desc_full = 1 AND excluded.desc_full = 0 THEN jobs.description ELSE excluded.description END,
      desc_full=CASE WHEN jobs.desc_full = 1 AND excluded.desc_full = 0 THEN 1 ELSE excluded.desc_full END,
      url=excluded.url, apply_url=excluded.apply_url, department=excluded.department,
      employment_type=excluded.employment_type, salary_min=excluded.salary_min,
      salary_max=excluded.salary_max, salary_currency=excluded.salary_currency,
      posted_at=CASE WHEN jobs.ats = 'workday' AND jobs.posted_at < excluded.posted_at THEN jobs.posted_at
        ELSE COALESCE(excluded.posted_at, jobs.posted_at) END, last_seen=excluded.last_seen, open=1`);
  let fresh = 0;
  d.exec("BEGIN");
  try {
    for (const j of jobs) {
      if (!exists.get(j.id)) fresh++;
      const desc = storedDescription(j);
      ins.run(j.id, j.ats, j.boardSlug, j.company, j.title, j.location ?? "", j.remote ? 1 : 0,
        desc.text, desc.full, j.url, j.applyUrl || j.url, j.department ?? null, j.employmentType ?? null,
        j.salaryMin ?? null, j.salaryMax ?? null, j.salaryCurrency ?? null, j.postedAt ?? null, t, t);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return fresh;
}

/**
 * A closed placeholder for an application made before OpenApply (history import). open = 0 keeps it out of
 * search, matches and the sync's closeMissing (board "other:history" is never fetched). False when the id exists.
 */
export function insertHistoryJob(id: string, company: string, title: string, url = ""): boolean {
  const t = now();
  return getDb().prepare(`INSERT OR IGNORE INTO jobs (id, ats, board_slug, company, title, url, apply_url, desc_full, first_seen, last_seen, open)
    VALUES (?, 'other', ?, ?, ?, ?, ?, 1, ?, ?, 0)`).run(id, HISTORY_BOARD, company, title, url, url, t, t).changes > 0;
}

/** Store the complete posting text fetched on demand. */
export function setFullDescription(id: string, text: string): void {
  getDb().prepare("UPDATE jobs SET description = ?, desc_full = 1 WHERE id = ?").run(text, id);
}

/** A posting that 404s on its ATS is gone. */
export function closeJob(id: string): void {
  getDb().prepare("UPDATE jobs SET open = 0 WHERE id = ?").run(id);
}

/** After a successful board fetch: close anything on that board not in `seenIds`. */
export function closeMissing(ats: string, slug: string, seenIds: string[]): number {
  const d = getDb();
  // `open = 1` stays out of the SQL: with it the planner picks jobs_open and scans every open job per board
  const rows = d.prepare("SELECT id, open FROM jobs WHERE ats = ? AND board_slug = ?").all(ats, slug) as Row[];
  const seen = new Set(seenIds);
  const gone = rows.filter(r => r.open && !seen.has(r.id));
  if (!gone.length) return 0;
  const upd = d.prepare("UPDATE jobs SET open = 0 WHERE id = ?");
  d.exec("BEGIN");
  try { for (const r of gone) upd.run(r.id); d.exec("COMMIT"); } catch (e) { d.exec("ROLLBACK"); throw e; }
  return gone.length;
}

/**
 * After a truncated board fetch (it saw only part of the board): close what no sync has seen since `before`.
 * Returns how many closed.
 */
export function closeUnseenSince(ats: string, slug: string, before: string): number {
  const d = getDb();
  // same shape as closeMissing: `open = 1` stays out of the SQL so the planner keeps the board index
  const rows = d.prepare("SELECT id, open, last_seen FROM jobs WHERE ats = ? AND board_slug = ?").all(ats, slug) as Row[];
  const gone = rows.filter(r => r.open && r.last_seen < before);
  if (!gone.length) return 0;
  const upd = d.prepare("UPDATE jobs SET open = 0 WHERE id = ?");
  d.exec("BEGIN");
  try { for (const r of gone) upd.run(r.id); d.exec("COMMIT"); } catch (e) { d.exec("ROLLBACK"); throw e; }
  return gone.length;
}

export function getJob(id: string): Job | undefined {
  const r = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToJob(r) : undefined;
}

/** Turn arbitrary user text into a safe FTS5 query: each word becomes a quoted prefix term. */
export function ftsQuery(q: string): string {
  const words = q.toLowerCase().match(/[\p{L}\p{N}+#.]+/gu) ?? [];
  return words.filter(w => !["and", "or", "not", "near"].includes(w))
    .map(w => `"${w.replace(/"/g, "")}"*`).join(" ");
}

export function searchJobs(f: JobFilters = {}): { total: number; jobs: Job[] } {
  const d = getDb();
  const where: string[] = [];
  const args: any[] = [];
  let from = "jobs";
  let order = "COALESCE(jobs.posted_at, jobs.first_seen) DESC";
  const fts = f.query ? ftsQuery(f.query) : "";
  if (fts) {
    from = "jobs JOIN jobs_fts ON jobs_fts.rowid = jobs.rowid";
    where.push("jobs_fts MATCH ?");
    args.push(fts);
    order = "bm25(jobs_fts, 10.0, 4.0, 2.0, 1.0)";
  } else if (f.query?.trim()) {
    return { total: 0, jobs: [] }; // only stopwords / punctuation: matching everything would be wrong
  }
  if (!f.includeClosed) where.push("jobs.open = 1");
  if (f.company) { where.push("lower(jobs.company) LIKE ?"); args.push(`%${f.company.toLowerCase()}%`); }
  if (f.location) { where.push("lower(jobs.location) LIKE ?"); args.push(`%${f.location.toLowerCase()}%`); }
  if (f.remote !== undefined) { where.push("jobs.remote = ?"); args.push(f.remote ? 1 : 0); }
  if (f.ats) { where.push("jobs.ats = ?"); args.push(f.ats); }
  if (f.postedWithinDays != null && Number.isFinite(f.postedWithinDays)) {
    const days = Math.min(Math.max(f.postedWithinDays, 1), 3650);
    where.push("COALESCE(jobs.posted_at, jobs.first_seen) >= ?");
    args.push(new Date(Date.now() - days * 86400e3).toISOString());
  }
  if (f.minSalary) { where.push("COALESCE(jobs.salary_max, jobs.salary_min) >= ?"); args.push(f.minSalary); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (d.prepare(`SELECT count(*) AS n FROM ${from} ${w}`).get(...args) as Row).n as number;
  const limit = Math.min(Math.max(Math.trunc(Number.isFinite(f.limit) ? f.limit! : 20), 1), 200);
  const offset = Math.max(Math.trunc(Number.isFinite(f.offset) ? f.offset! : 0), 0);
  const rows = d.prepare(`SELECT jobs.* FROM ${from} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as Row[];
  return { total, jobs: rows.map(rowToJob) };
}

export function jobStats(): { open: number; total: number; companies: number; boards: number; lastSync?: string } {
  const d = getDb();
  const r = d.prepare(`SELECT
      (SELECT count(*) FROM jobs WHERE open = 1) AS open,
      (SELECT count(*) FROM jobs) - (SELECT count(*) FROM jobs WHERE ${HISTORY_JOB}) AS total,
      (SELECT count(DISTINCT company) FROM jobs WHERE open = 1) AS companies,
      (SELECT count(*) FROM boards) AS boards,
      (SELECT max(last_sync) FROM boards) AS last_sync`).get() as Row;
  return { open: r.open, total: r.total, companies: r.companies, boards: r.boards, lastSync: r.last_sync ?? undefined };
}

// ---- boards ----

export function upsertBoards(boards: Board[]): void {
  const d = getDb();
  const st = d.prepare(`INSERT INTO boards (ats, slug, company) VALUES (?,?,?)
    ON CONFLICT(ats, slug) DO UPDATE SET company = COALESCE(excluded.company, boards.company)`);
  d.exec("BEGIN");
  for (const b of boards) st.run(b.ats, b.slug, b.company ?? null);
  d.exec("COMMIT");
}

export function recordBoardSync(ats: string, slug: string, status: string, jobCount: number | null): void {
  getDb().prepare(`INSERT INTO boards (ats, slug, last_sync, last_status, job_count) VALUES (?,?,?,?,?)
    ON CONFLICT(ats, slug) DO UPDATE SET last_sync=excluded.last_sync, last_status=excluded.last_status,
    job_count=excluded.job_count`).run(ats, slug, now(), status, jobCount);
}

export function listBoards(): Array<Board & { lastSync?: string; lastStatus?: string; jobCount?: number }> {
  return (getDb().prepare("SELECT * FROM boards ORDER BY ats, slug").all() as Row[]).map(r => ({
    ats: r.ats, slug: r.slug, company: r.company ?? undefined, lastSync: r.last_sync ?? undefined,
    lastStatus: r.last_status ?? undefined, jobCount: r.job_count ?? undefined,
  }));
}

// ---- applications ----

function rowToApp(r: Row): Application {
  return {
    jobId: r.job_id, status: r.status, confirmationCode: r.confirmation_code ?? undefined,
    submittedAt: r.submitted_at ?? undefined, notes: r.notes ?? undefined, source: r.source ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function getApplication(jobId: string): Application | undefined {
  const r = getDb().prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId) as Row | undefined;
  return r ? rowToApp(r) : undefined;
}

/** Create or update; only the provided fields change. Logs a status event when status moves. */
export function setApplication(jobId: string, patch: Partial<Omit<Application, "jobId" | "createdAt" | "updatedAt">>): Application {
  const d = getDb();
  const t = now();
  const prev = getApplication(jobId);
  const next: Application = {
    jobId, status: "saved", createdAt: t, ...prev, ...patch, updatedAt: t,
  } as Application;
  d.prepare(`INSERT INTO applications (job_id, status, confirmation_code, submitted_at, notes, created_at, updated_at, source)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,
    confirmation_code=excluded.confirmation_code, submitted_at=excluded.submitted_at, notes=excluded.notes,
    updated_at=excluded.updated_at, source=excluded.source`).run(jobId, next.status, next.confirmationCode ?? null,
    next.submittedAt ?? null, next.notes ?? null, next.createdAt, next.updatedAt, next.source ?? null);
  if (!prev || prev.status !== next.status) addEvent(jobId, "status", next.status);
  return next;
}

export function listApplications(status?: ApplicationStatus | ApplicationStatus[]): Array<Application & { job?: Job }> {
  const d = getDb();
  const sts = status ? (Array.isArray(status) ? status : [status]) : [];
  const w = sts.length ? `WHERE a.status IN (${sts.map(() => "?").join(",")})` : "";
  const rows = d.prepare(`SELECT a.*, j.id AS jid FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
    ${w} ORDER BY a.updated_at DESC`).all(...sts) as Row[];
  return rows.map(r => ({ ...rowToApp(r), job: r.jid ? getJob(r.jid) : undefined }));
}

export function addEvent(jobId: string, kind: string, detail?: string): void {
  getDb().prepare("INSERT INTO events (job_id, at, kind, detail) VALUES (?,?,?,?)")
    .run(jobId, now(), kind, detail ?? null);
}

/** One job's events, or (no jobId) the newest across jobs without a history import's rows, which would crowd out real activity. */
export function listEvents(jobId?: string, limit = 100): ApplicationEvent[] {
  const d = getDb();
  const rows = (jobId
    ? d.prepare("SELECT * FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(jobId, limit)
    : d.prepare(`SELECT * FROM events e WHERE e.kind != 'imported' AND NOT (e.kind = 'status' AND EXISTS (
        SELECT 1 FROM events i WHERE i.job_id = e.job_id AND i.kind = 'imported' AND abs(julianday(i.at) - julianday(e.at)) < 2 / 86400.0))
      ORDER BY e.id DESC LIMIT ?`).all(limit)) as Row[];
  return rows.map(r => ({ id: r.id, jobId: r.job_id, at: r.at, kind: r.kind, detail: r.detail ?? undefined }));
}

// ---- kv ----

export function kvGet(k: string): string | undefined {
  return (getDb().prepare("SELECT v FROM kv WHERE k = ?").get(k) as Row | undefined)?.v;
}
export function kvSet(k: string, v: string): void {
  getDb().prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}
/** A JSON value from kv; undefined when missing or unreadable. */
export function kvGetJson<T>(k: string): T | undefined {
  const v = kvGet(k);
  try { return v === undefined ? undefined : JSON.parse(v) as T; } catch { return undefined; }
}
export const kvSetJson = (k: string, v: unknown): void => kvSet(k, JSON.stringify(v));
/** End time of the last sync over every board that mostly worked; single-board syncs and failed runs leave it alone. */
export const LAST_FULL_SYNC_KEY = "lastFullSync";
