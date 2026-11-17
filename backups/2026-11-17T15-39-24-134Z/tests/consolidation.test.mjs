import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import runtime from '../scripts/runtime.cjs';
import {assess} from '../extensions/dist/index.mjs';
const root=runtime.root;
fs.mkdirSync(path.join(root,'data/test-runs'),{recursive:true});
const dir=fs.mkdtempSync(path.join(root,'data/test-runs/integration-'));
Object.assign(process.env,runtime.environment({OPENAPPLY_HOME:dir,OPENAPPLY_DB:path.join(dir,'test.sqlite'),OPENAPPLY_POLICY_MODULE:'',OPENAPPLY_HEADLESS:'1'}));
const core=await import('../openapply/dist/db.js');
const profiles=await import('../openapply/dist/profile.js');
after(()=>core.closeDb());
test('migration preserved every original record and source timestamp',()=>{
 const recovery=JSON.parse(fs.readFileSync(path.join(root,'reports/recovery.json'),'utf8'));
 const original=new DatabaseSync(path.join(recovery.backup,'data/jobs.sqlite'),{readOnly:true});
 const canonical=new DatabaseSync(path.join(root,'data/jobs.sqlite'),{readOnly:true});
 try {
  for(const t of ['companies','jobs','applications','events'])assert.deepEqual(canonical.prepare(`SELECT * FROM legacy_${t} ORDER BY id`).all(),original.prepare(`SELECT * FROM ${t} ORDER BY id`).all(),t);
  assert.equal(canonical.prepare('SELECT count(*) n FROM migration_map').get().n,365);
  assert.equal(canonical.prepare('SELECT count(*) n FROM jobs WHERE open=1').get().n,0);
  assert.equal(canonical.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(canonical.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{original.close();canonical.close();}
});
test('original PDF hash and verified candidate projection preserve facts',async()=>{
 const candidate=JSON.parse(fs.readFileSync(path.join(root,'data/candidate_profile.json'),'utf8'));
 const pdf=path.join(root,'Tarek-Elsayed-Resume.pdf');
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(pdf)).digest('hex'),candidate.source_metadata.sha256);
 const {extractText}=await import('../openapply/dist/resume-import.js');
 const text=await extractText(pdf);assert.match(text,/1,000\+/);assert.match(text,/70\+/);assert.match(text,/2024/);
 const resume=JSON.parse(fs.readFileSync(path.join(root,'data/openapply/resume.json'),'utf8'));
 assert.equal(resume.education[0].end,'2024');assert.equal(resume.experience[0].start,'2026-01');assert.match(resume.experience[0].bullets[0],/1,000\+/);
 const profile=JSON.parse(fs.readFileSync(path.join(root,'data/openapply/profile.json'),'utf8'));
 assert.equal(profile.workAuthorizedUS,false);assert.equal(profile.needsSponsorship,true);assert.equal(profile.salaryExpectation,undefined);
});
test('international screening leaves missing evidence unknown and rejects explicit restrictions',()=>{
 assert.equal(assess({country:'Germany',evidence:[]}).state,'NEEDS_VERIFICATION');
 const e={dimension:'visa',finding:'met',quote:'Employer explicitly offers immigration assistance',url:'https://example.test/jobs/1',checkedAt:new Date().toISOString()};
 assert.equal(assess({country:'Germany',evidence:[e]}).state,'POTENTIALLY_ELIGIBLE');
 assert.equal(assess({country:'USA',evidence:[{...e,dimension:'authorization',finding:'not_met',quote:'Existing unrestricted work authorization is mandatory; no sponsorship'}]}).state,'INELIGIBLE');
 assert.throws(()=>assess({country:'USA',evidence:[{...e,url:'http://invalid.test'}]}));
});
test('strict personal mode leaves demographics and legal consent unanswered',async()=>{
 const {suggest}=await import('../openapply/dist/apply/fieldmap.js');
 const ctx={answers:{},files:{},profile:{firstName:'Fixture',lastName:'Only',email:'test@example.test'}};
 assert.equal(suggest({key:'gender',label:'Gender',type:'select',required:true,options:['Male','Female','Decline to answer']},ctx),undefined);
 assert.equal(suggest({key:'consent',label:'I agree to a background check',type:'checkbox',required:true},ctx),undefined);
 const auth={key:'auth',label:'Are you authorized to work in this country?',type:'select',required:true,options:['Yes','No']};
 const candidate={...ctx,profile:{...ctx.profile,workAuthorizedUS:false,needsSponsorship:true},job:{location:'Berlin, Germany',remote:false}};
 assert.equal(suggest(auth,candidate),undefined);
 assert.equal(suggest(auth,{...candidate,job:{location:'United States',remote:false}}).value,'No');
});
test('supported source discovery and matching work with a recorded upstream fixture',async()=>{
 const real=globalThis.fetch;
 const fx=JSON.parse(fs.readFileSync(path.join(root,'openapply/test/fixtures/sources/greenhouse-jobs.json'),'utf8'));
 globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes('/jobs')?fx:{name:'Fixture Company'}),{status:200,headers:{'content-type':'application/json'}});
 try{
  const {fetchBoard}=await import('../openapply/dist/sources/greenhouse.js');
  const jobs=await fetchBoard('fixture');assert.ok(jobs.length>0);core.upsertJobs(jobs);
  profiles.saveProfile({firstName:'Fixture',lastName:'Only',email:'test@example.test',targets:{titles:[jobs[0].title],keywords:[],locations:[jobs[0].location]}});
  const {listMatches}=await import('../openapply/dist/match.js');assert.ok(listMatches({minScore:0}).length>0);
 }finally{globalThis.fetch=real;}
});
test('OpenApply dashboard returns its UI',async()=>{
 const {startServer}=await import('../openapply/dist/server/http.js');
 const server=await startServer(0);
 try{const r=await fetch(server.url);assert.equal(r.status,200);assert.match(await r.text(),/OpenApply/i);}finally{await server.close();}
});
test('submission policy persists unknown outcomes and requires confirmation bytes',async()=>{
 const original=new DatabaseSync(path.join(root,'data/jobs.sqlite'),{readOnly:true});
 const file=path.join(dir,'policy.sqlite');
 try{await backup(original,file);}finally{original.close();}
 const previous=process.env.OPENAPPLY_DB;process.env.OPENAPPLY_DB=file;
 const db=new DatabaseSync(file);
 const id='fixture:policy:1',now=new Date().toISOString();
 try{
  db.prepare("INSERT INTO jobs(id,ats,board_slug,company,title,url,apply_url,first_seen,last_seen,open) VALUES(?,'other','fixture','Fixture Only','Engineer','https://example.test/job','https://example.test/job',?,?,1)").run(id,now,now);
  db.prepare("INSERT INTO applications(job_id,status,created_at,updated_at) VALUES(?,'filled',?,?)").run(id,now,now);
  assert.throws(()=>db.prepare("UPDATE applications SET status='submitted' WHERE job_id=?").run(id),/confirmation evidence/);
  const policy=await import('../extensions/policy.mjs');
  assert.throws(()=>policy.beforeFill(id),/Official employer/);
  db.prepare('INSERT INTO official_job_verifications VALUES(?,?,?,?)').run(id,'https://example.test/careers','https://example.test/job',now);
  db.prepare('INSERT INTO international_assessments VALUES(?,?,?,?,?)').run(id,'Germany','CONFIRMED_ELIGIBLE','[]',now);
  policy.beforeFill(id);policy.markAttempt(id);
  assert.throws(()=>policy.beforeFill(id),/Unknown submission outcome/);
  await policy.afterOutcome(id,'failed',{},undefined);
  assert.throws(()=>policy.beforeSubmit(id),/Unknown submission outcome/);
  await assert.rejects(()=>policy.afterOutcome(id,'submitted',{locator:()=>({innerText:async()=>'Application submitted!'})},undefined),/screenshot required/);
  assert.equal(db.prepare('SELECT count(*) n FROM submission_evidence').get().n,0);
  const screenshots=path.join(dir,'screenshots');fs.mkdirSync(screenshots,{recursive:true});
  const image=path.join(screenshots,'SYNTHETIC-TEST-ONLY.png');
  fs.writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHd0AAAAASUVORK5CYII=','base64'));
  await policy.afterOutcome(id,'submitted',{locator:()=>({innerText:async()=>'Application submitted! SYNTHETIC FIXTURE ONLY'}),url:()=> 'https://example.test/thanks'},image);
  assert.equal(db.prepare('SELECT count(*) n FROM application_holds WHERE job_id=?').get(id).n,0);
  const receipt=db.prepare('SELECT * FROM submission_evidence WHERE job_id=?').get(id);
  assert.equal(receipt.sha256,crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex'));
  db.prepare("UPDATE applications SET status='submitted',submitted_at=? WHERE job_id=?").run(now,id);
  assert.throws(()=>db.prepare('DELETE FROM submission_evidence WHERE job_id=?').run(id),/immutable/);
  assert.throws(()=>db.prepare("UPDATE applications SET status='drafted' WHERE job_id=?").run(id),/cannot be reset/);
  assert.throws(()=>policy.beforeFill(id),/already has confirmation evidence/);
 }finally{db.close();process.env.OPENAPPLY_DB=previous;}
});
