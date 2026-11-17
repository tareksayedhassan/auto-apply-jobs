import {DatabaseSync} from 'node:sqlite';
import {assess} from '../dist/index.mjs';
/** Write externally observed evidence; this module never guesses sponsorship or performs discovery. */
export function recordAssessment(file, input) {
 const result=assess({country:input.country,evidence:input.evidence});
 const db=new DatabaseSync(file);
 try {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  if(!db.prepare('SELECT 1 FROM jobs WHERE id=?').get(input.jobId))throw new Error('Unknown OpenApply job id');
  db.prepare(`INSERT INTO international_assessments VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET country=excluded.country,decision=excluded.decision,evidence_json=excluded.evidence_json,assessed_at=excluded.assessed_at`).run(input.jobId,input.country,result.state,JSON.stringify(result.evidence),result.assessedAt);
  db.prepare('INSERT INTO events(job_id,at,kind,detail) VALUES(?,?,?,?)').run(input.jobId,result.assessedAt,'international_assessment',JSON.stringify(result));
  db.exec('COMMIT');return result;
 }catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
}
export function recordOfficialVerification(file,input) {
 const db=new DatabaseSync(file);
 try{
  const job=db.prepare('SELECT * FROM jobs WHERE id=?').get(input.jobId);
  if(!job || input.applicationUrl!==job.apply_url)throw new Error('Application URL must equal canonical job URL');
  for(const u of [input.applicationUrl,input.employerSourceUrl])if(new URL(u).protocol!=='https:')throw new Error('HTTPS official source URLs required');
  const timestamp=Date.parse(input.checkedAt);
  if(!Number.isFinite(timestamp)||timestamp>Date.now()+60000||Date.now()-timestamp>86400000)throw new Error('Current observed verification timestamp required');
  if(!input.linkObserved || !input.liveObserved)throw new Error('Must observe employer-to-ATS link and live vacancy; discovery alone is insufficient');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO official_job_verifications VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET employer_source_url=excluded.employer_source_url,application_url=excluded.application_url,checked_at=excluded.checked_at').run(input.jobId,input.employerSourceUrl,input.applicationUrl,input.checkedAt);
  db.prepare('UPDATE jobs SET open=1,last_seen=? WHERE id=?').run(input.checkedAt,input.jobId);
  db.prepare('INSERT INTO events(job_id,at,kind,detail) VALUES(?,?,?,?)').run(input.jobId,input.checkedAt,'official_job_verification',JSON.stringify(input));
  db.exec('COMMIT');
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
}
