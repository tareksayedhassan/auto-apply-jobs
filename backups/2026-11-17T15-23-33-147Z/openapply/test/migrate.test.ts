import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "oa-migrate-"));
process.env.OPENAPPLY_HOME = home;

// the schema as shipped before the lean index: full descriptions, no desc_full, trigger without WHEN
const OLD = `
CREATE TABLE jobs (id TEXT PRIMARY KEY, ats TEXT NOT NULL, board_slug TEXT NOT NULL, company TEXT NOT NULL,
  title TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', remote INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, apply_url TEXT NOT NULL, department TEXT,
  employment_type TEXT, salary_min REAL, salary_max REAL, salary_currency TEXT, posted_at TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, open INTEGER NOT NULL DEFAULT 1);
CREATE INDEX jobs_board ON jobs(ats, board_slug);
CREATE INDEX jobs_open ON jobs(open, posted_at);
CREATE VIRTUAL TABLE jobs_fts USING fts5(title, company, location, description, content='jobs', content_rowid='rowid', tokenize='porter unicode61');
CREATE TRIGGER jobs_ai AFTER INSERT ON jobs BEGIN INSERT INTO jobs_fts(rowid, title, company, location, description) VALUES (new.rowid, new.title, new.company, new.location, new.description); END;
CREATE TRIGGER jobs_ad AFTER DELETE ON jobs BEGIN INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location, description) VALUES ('delete', old.rowid, old.title, old.company, old.location, old.description); END;
CREATE TRIGGER jobs_au AFTER UPDATE OF title, company, location, description ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location, description) VALUES ('delete', old.rowid, old.title, old.company, old.location, old.description);
  INSERT INTO jobs_fts(rowid, title, company, location, description) VALUES (new.rowid, new.title, new.company, new.location, new.description); END;
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE applications (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, confirmation_code TEXT, submitted_at TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;
const filler = Array.from({ length: 1500 }, (_, i) => `tailword${i}`).join(" ");
const longText = `Lead the platform migration. ${filler} zebracrossing`;

const old = new DatabaseSync(join(home, "openapply.db"));
old.exec("PRAGMA journal_mode=WAL");
old.exec(OLD);
const ins = old.prepare("INSERT INTO jobs (id, ats, board_slug, company, title, location, description, url, apply_url, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
const t = "2026-01-01T00:00:00.000Z";
for (let i = 0; i < 50; i++) ins.run(`greenhouse:old:${i}`, "greenhouse", "old", "Old Co", `Engineer ${i}`, "NYC", longText, "u", "u", t, t);
ins.run("greenhouse:old:short", "greenhouse", "old", "Old Co", "Designer", "NYC", "Short and whole.", "u", "u", t, t);
ins.run("smartrecruiters:old:sr", "smartrecruiters", "old", "Old Co", "Analyst", "NYC", "Analyst at Old Co. Location: NYC.", "u", "u", t, t);
old.prepare("INSERT INTO applications (job_id, status, created_at, updated_at) VALUES (?,?,?,?)").run("greenhouse:old:3", "saved", t, t);
old.close();
const before = statSync(join(home, "openapply.db")).size;

const db = await import("../src/db.js");

test("opening an old DB adds desc_full, truncates long descriptions to snippets and rebuilds FTS", () => {
  const d = db.getDb();
  assert.ok((d.prepare("PRAGMA table_info(jobs)").all() as any[]).some(c => c.name === "desc_full"));
  const j = db.getJob("greenhouse:old:3")!;
  assert.equal(j.descriptionComplete, false);
  assert.ok(j.description.length <= db.SNIPPET_CHARS + 3 && j.description.endsWith("..."));
  assert.ok(j.description.startsWith("Lead the platform migration. tailword0 tailword1"));
  assert.equal(j.title, "Engineer 3");
  assert.equal(db.getJob("greenhouse:old:short")!.description, "Short and whole.");
  assert.equal(db.getJob("greenhouse:old:short")!.descriptionComplete, true);
  assert.equal(db.getJob("smartrecruiters:old:sr")!.descriptionComplete, false); // stub: details.ts must fetch it
  assert.equal(db.getApplication("greenhouse:old:3")!.status, "saved"); // nothing else touched
  assert.equal(db.jobStats().total, 52);
});

test("FTS works after the rebuild: head text matches, dropped tail does not", () => {
  assert.equal(db.searchJobs({ query: "platform migration" }).total, 50);
  assert.equal(db.searchJobs({ query: "tailword3" }).total, 50);
  assert.equal(db.searchJobs({ query: "zebracrossing" }).total, 0);
  assert.equal(db.searchJobs({ query: "designer" }).total, 1);
  assert.equal(db.searchJobs({ query: "whole" }).total, 1);
  // triggers are live again after the migration
  db.setFullDescription("greenhouse:old:3", longText);
  assert.equal(db.searchJobs({ query: "zebracrossing" }).total, 1);
  assert.equal(db.getJob("greenhouse:old:3")!.descriptionComplete, true);
});

test("the migration is recorded, runs once and the file shrank", () => {
  const d = db.getDb();
  assert.ok(db.kvGet("lean_index_v1"));
  db.closeDb();
  const after = statSync(join(home, "openapply.db")).size;
  assert.ok(after < before / 3, `${before} -> ${after}`);
  // reopening must not re-truncate the hydrated row
  assert.equal(db.getJob("greenhouse:old:3")!.descriptionComplete, true);
  assert.ok(db.getJob("greenhouse:old:3")!.description.length > 5000);
  void d;
});
