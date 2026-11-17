import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const open = () => new DatabaseSync(process.env.OPENAPPLY_DB);
function check(db, id) {
  if (db.prepare('SELECT 1 FROM application_holds WHERE job_id=?').get(id)) throw new Error('Unknown submission outcome: reconcile employer evidence before any retry');
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (job && db.prepare('SELECT 1 FROM applications a JOIN jobs j ON j.id=a.job_id WHERE j.url=? AND a.job_id<>?').get(job.url,id)) throw new Error('Another application record uses this vacancy URL; reconcile the historical id before filling');
  const proof = db.prepare('SELECT * FROM official_job_verifications WHERE job_id=?').get(id);
  if (!job?.open || !proof || proof.application_url !== job.apply_url || Date.now() - Date.parse(proof.checked_at) > 86400000 || !Number.isFinite(Date.parse(proof.checked_at))) throw new Error('Official employer link and live job verification within 24 hours required');
  if (!/^https:/.test(job.apply_url) || !/^https:/.test(proof.employer_source_url)) throw new Error('HTTPS official sources required');
  const assessment = db.prepare('SELECT * FROM international_assessments WHERE job_id=?').get(id);
  if (!assessment || assessment.decision !== 'CONFIRMED_ELIGIBLE' || !Number.isFinite(Date.parse(assessment.assessed_at)) || Date.now()-Date.parse(assessment.assessed_at)>86400000 || Date.parse(assessment.assessed_at)>Date.now()+60000) throw new Error('Complete, current international eligibility evidence required before filling/submitting');
  if (db.prepare('SELECT 1 FROM submission_evidence WHERE job_id=?').get(id)) throw new Error('Application already has confirmation evidence; no retry');
}
export function beforeFill(id) { const db=open(); try { check(db,id); } finally { db.close(); } }
export const beforeSubmit = beforeFill;
export function markAttempt(id) {
  const db=open();
  try {
    db.exec('BEGIN IMMEDIATE');
    const now=new Date().toISOString();
    db.prepare('INSERT INTO application_holds(job_id,reason,created_at) VALUES(?,?,?)').run(id,'Submit attempt started; employer outcome must be reconciled',now);
    db.prepare('INSERT INTO events(job_id,at,kind,detail) VALUES(?,?,?,?)').run(id,now,'submit_attempt','Durable hold created before clicking submit');
    db.exec('COMMIT');
  } catch(e) { if(db.isTransaction)db.exec('ROLLBACK');throw e; } finally { db.close(); }
}
export async function afterOutcome(id, outcome, page, screenshot) {
  const db=open();
  try {
    if (outcome !== 'submitted') return; // Keep durable hold for every uncertain outcome.
    const text = await page.locator('body').innerText();
    if (!screenshot || !fs.existsSync(screenshot) || !/application (?:has been |was |successfully )?(?:submitted|received)|thank you for (?:applying|your application)|thanks for applying/i.test(text)) throw new Error('Employer confirmation text and screenshot required; attempt remains on hold');
    const job=db.prepare('SELECT apply_url FROM jobs WHERE id=?').get(id);
    const proof=db.prepare('SELECT employer_source_url FROM official_job_verifications WHERE job_id=?').get(id);
    const final=new URL(page.url());
    if(final.protocol!=='https:' || ![new URL(job.apply_url).hostname,new URL(proof.employer_source_url).hostname].includes(final.hostname))throw new Error('Confirmation must remain on the verified employer or ATS domain; reconcile the held attempt');
    const resolved = fs.realpathSync(screenshot), base=fs.realpathSync(path.join(process.env.OPENAPPLY_HOME,'screenshots')) + path.sep;
    if (!resolved.toLowerCase().startsWith(base.toLowerCase())) throw new Error('Evidence path outside project screenshots');
    const bytes=fs.readFileSync(resolved);
    if (!bytes.length) throw new Error('Empty confirmation evidence');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO submission_evidence(job_id,confirmation_text,confirmation_url,evidence_path,sha256,recorded_at) VALUES(?,?,?,?,?,?)').run(id,text,page.url(),resolved,crypto.createHash('sha256').update(bytes).digest('hex'),new Date().toISOString());
      db.prepare('DELETE FROM application_holds WHERE job_id=?').run(id);
      db.prepare('INSERT INTO events(job_id,at,kind,detail) VALUES(?,?,?,?)').run(id,new Date().toISOString(),'confirmation_evidence',JSON.stringify({url:page.url(),evidence:resolved}));
      db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.close(); }
}
