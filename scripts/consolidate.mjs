import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import runtime from './runtime.cjs';
Object.assign(process.env, runtime.environment());
const root = runtime.root;
const file = path.join(root, 'data/jobs.sqlite');
const old = new DatabaseSync(file);
old.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
const exists = name => !!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
if (!exists('legacy_jobs')) {
  const dir = path.join(root, 'backups', `pre-migration-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  await backup(old, path.join(dir, 'jobs.sqlite'));
  old.exec('BEGIN IMMEDIATE');
  try {
    for (const name of ['companies', 'jobs', 'applications', 'events']) old.exec(`ALTER TABLE ${name} RENAME TO legacy_${name}`);
    old.exec('COMMIT');
  } catch (e) { old.exec('ROLLBACK'); throw e; }
}
old.close();
const core = await import('../openapply/dist/db.js');
const db = core.getDb();
db.exec(`CREATE TABLE IF NOT EXISTS international_assessments(job_id TEXT PRIMARY KEY REFERENCES jobs(id), country TEXT NOT NULL, decision TEXT NOT NULL, evidence_json TEXT NOT NULL, assessed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submission_evidence(job_id TEXT PRIMARY KEY REFERENCES applications(job_id), confirmation_text TEXT NOT NULL, confirmation_url TEXT NOT NULL, confirmation_reference TEXT, evidence_path TEXT NOT NULL, sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS migration_map(legacy_id INTEGER PRIMARY KEY, job_id TEXT UNIQUE NOT NULL REFERENCES jobs(id));
CREATE TABLE IF NOT EXISTS migration_runs(id TEXT PRIMARY KEY, completed_at TEXT NOT NULL, summary TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS official_job_verifications(job_id TEXT PRIMARY KEY REFERENCES jobs(id), employer_source_url TEXT NOT NULL, application_url TEXT NOT NULL, checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS application_holds(job_id TEXT PRIMARY KEY REFERENCES jobs(id), reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS evidence_before_submission_update BEFORE UPDATE OF status ON applications WHEN NEW.status='submitted' AND NOT EXISTS(SELECT 1 FROM submission_evidence WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'Employer confirmation evidence required'); END;
CREATE TRIGGER IF NOT EXISTS evidence_before_submission_insert BEFORE INSERT ON applications WHEN NEW.status='submitted' AND NOT EXISTS(SELECT 1 FROM submission_evidence WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'Employer confirmation evidence required'); END;
CREATE TRIGGER IF NOT EXISTS preserve_submission_time BEFORE UPDATE ON applications WHEN OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NOT OLD.submitted_at BEGIN SELECT RAISE(ABORT,'Submission timestamp is immutable'); END;
CREATE TRIGGER IF NOT EXISTS preserve_confirmed_application BEFORE DELETE ON applications WHEN EXISTS(SELECT 1 FROM submission_evidence WHERE job_id=OLD.job_id) BEGIN SELECT RAISE(ABORT,'Confirmed application cannot be deleted'); END;`);
db.exec(`CREATE TRIGGER IF NOT EXISTS evidence_before_timestamp_update BEFORE UPDATE OF submitted_at ON applications WHEN NEW.submitted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM submission_evidence WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'Submission timestamp requires employer evidence'); END;
CREATE TRIGGER IF NOT EXISTS evidence_before_timestamp_insert BEFORE INSERT ON applications WHEN NEW.submitted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM submission_evidence WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'Submission timestamp requires employer evidence'); END;
CREATE TRIGGER IF NOT EXISTS no_confirmed_downgrade BEFORE UPDATE OF status ON applications WHEN OLD.submitted_at IS NOT NULL AND NEW.status IN ('saved','drafted','filled','approved','needs_human') BEGIN SELECT RAISE(ABORT,'Confirmed submission cannot be reset'); END;
CREATE TRIGGER IF NOT EXISTS immutable_evidence_update BEFORE UPDATE ON submission_evidence BEGIN SELECT RAISE(ABORT,'Confirmation evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS immutable_evidence_delete BEFORE DELETE ON submission_evidence BEGIN SELECT RAISE(ABORT,'Confirmation evidence is immutable'); END;`);
const key = 'legacy-v1';
if (!db.prepare('SELECT 1 FROM migration_runs WHERE id=?').get(key)) {
  const jobs = db.prepare('SELECT j.*, c.name AS company FROM legacy_jobs j JOIN legacy_companies c ON c.id=j.company_id').all();
  const apps = db.prepare('SELECT * FROM legacy_applications').all();
  const events = db.prepare('SELECT * FROM legacy_events').all();
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(`INSERT INTO jobs(id,ats,board_slug,company,title,location,description,desc_full,url,apply_url,first_seen,last_seen,open) VALUES(?,'other','legacy-research',?,?,?,?,0,?,?,?,?,0)`);
    const map = db.prepare('INSERT INTO migration_map VALUES(?,?)');
    for (const j of jobs) {
      const id = `legacy:${j.id}`;
      insert.run(id,j.company,j.title,j.location || j.country || '',j.requirements || '',j.url,j.url,j.checked_at || 'unknown',j.checked_at || 'unknown');
      map.run(j.id,id);
    }
    for (const a of apps) {
      // No historical status is promoted to an employer-confirmed submission.
      const state = a.status === 'prepared' ? 'drafted' : 'needs_human';
      db.prepare('INSERT INTO applications(job_id,status,notes,created_at,updated_at) VALUES(?,?,?,?,?)').run(`legacy:${a.job_id}`,state,JSON.stringify({legacyStatus:a.status,blocker:a.blocker,resumePath:a.resume_path}),a.updated_at,a.updated_at);
    }
    for (const e of events) db.prepare('INSERT INTO events(job_id,at,kind,detail) VALUES(?,?,?,?)').run(e.job_id == null ? 'legacy:unassigned' : `legacy:${e.job_id}`,e.created_at,`legacy:${e.type}`,e.detail);
    const summary = {jobs:jobs.length,applications:apps.length,events:events.length,historicalClosed:true};
    db.prepare('INSERT INTO migration_runs VALUES(?,?,?)').run(key,new Date().toISOString(),JSON.stringify(summary));
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}
// Preserve the canonical PDF and verified text; generate an upstream-compatible projection.
db.exec("UPDATE jobs SET desc_full=0 WHERE board_slug='legacy-research' AND open=0");
const candidate = JSON.parse(fs.readFileSync(path.join(root,'data/candidate_profile.json'),'utf8'));
const answers = JSON.parse(fs.readFileSync(path.join(root,'candidate_answers.json'),'utf8'));
const pdf = path.join(root,'Tarek-Elsayed-Resume.pdf');
const sha = crypto.createHash('sha256').update(fs.readFileSync(pdf)).digest('hex');
if (sha !== candidate.source_metadata.sha256) throw new Error('PDF source hash changed; candidate review required');
const { saveProfile, saveResume } = await import('../openapply/dist/profile.js');
const stateDir = process.env.OPENAPPLY_HOME;
if (!fs.existsSync(path.join(stateDir,'profile.json'))) saveProfile({firstName:'Tarek',lastName:'Elsayed',email:candidate.email,phone:candidate.phone,location:candidate.location,website:candidate.website,github:candidate.github,workAuthorizedUS:false,needsSponsorship:true,willingToRelocate:answers.willing_to_relocate_internationally,noticePeriod:answers.earliest_start,resumePdf:pdf,education:[{school:answers.education.university,degree:"Bachelor's Degree",discipline:'Management Information Systems',startYear:2020,endYear:2024}],targets:{titles:candidate.search_titles,keywords:['Node.js','NestJS','TypeScript','ERP'],locations:['United States','USA','Germany'],seniority:['junior','mid']}});
if (!fs.existsSync(path.join(stateDir,'resume.json'))) {
  const bullets = (text, starts, ends) => {
    const from = text.indexOf(starts); const to = ends ? text.indexOf(ends,from+starts.length) : text.length;
    if (from < 0 || to < 0) throw new Error('Resume section cannot be mapped');
    return text.slice(from,to).split('•').slice(1).map(s=>s.trim());
  };
  saveResume({name:candidate.name,headline:candidate.headline,contact:{email:candidate.email,phone:candidate.phone,location:candidate.location,links:[candidate.website,candidate.github]},summary:candidate.summary,experience:candidate.experience.map((e,i)=>({...e,end:e.end || 'Present',bullets:bullets(candidate.experience_source,e.company,candidate.experience[i+1]?.company)})),projects:candidate.projects.map((p,i)=>({name:p.name,description:`${p.role}; ${p.start} - ${p.end || 'Present'}`,bullets:bullets(candidate.projects_source,p.name,candidate.projects[i+1]?.name)})),education:[{school:answers.education.university,degree:answers.education.degree,start:'2020',end:'2024'}],skills:candidate.skills.flatMap(s=>s.items),extras:[{heading:'Languages',items:['Arabic: Native','English: Intermediate, not formally certified']}]});
  fs.copyFileSync(path.join(root,'data/resume.txt'),path.join(stateDir,'resume-source.txt'));
}
console.log(JSON.stringify(db.prepare('SELECT * FROM migration_runs').all(),null,2));
core.closeDb();
