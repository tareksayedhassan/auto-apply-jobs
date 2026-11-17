const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {root}=require('./runtime.cjs');
const snapshot=JSON.parse(fs.readFileSync(path.join(root,'reports/recovery.json'),'utf8'));
const deletes={
 'scripts/seed.cjs':'Target queue already preserved; OpenApply owns discovery',
 'scripts/research.cjs':'Abandoned parallel researcher depends on retired legacy writer',
 'scripts/report-state.cjs':'Superseded report rewriter hardcodes obsolete browser outcomes',
 'scripts/connectivity-report.cjs':'Superseded diagnostic report generator hardcodes old network results',
 'scripts/connectivity-diagnostics.cjs':'Old multi-browser diagnostics replaced by one Chrome capture entry point',
 'scripts/finalize-chrome.cjs':'One-time historical report rewriting',
 'scripts/chrome-configure.cjs':'One-time browser config mutation',
 'scripts/chrome-smoke.cjs':'Repeated historical portal smoke loop replaced by targeted capture',
 'scripts/update-confirmed.cjs':'One-time answer patch; confirmed answers preserved',
 'scripts/profile.cjs':'Old candidate/variant generator superseded by checked OpenApply projection',
 'scripts/resume-pdf.cjs':'Parallel PDF generator superseded by OpenApply',
 'scripts/verify.cjs':'Checks obsolete exports and legacy database schema',
 'scripts/xlsx.cjs':'Old generated export utility; workbook retained as historical',
 'tests/agent.test.cjs':'Tests removed writer; replaced by migration and upstream integration tests',
 'agent/instructions.md':'Obsolete instructions to resume research; consolidated AGENTS.md owns workflow'
};
const moves=['applications.xlsx','companies.csv','jobs.csv','final_report.md','browser_diagnostic_report.md','chrome_browser_report.md'];
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const actions=[];
function checked(rel) {
 const full=path.resolve(root,rel),base=root+path.sep;
 if(!full.startsWith(base)||!fs.statSync(full).isFile())throw Error('Unsafe cleanup target: '+rel);
 const record=snapshot.inventory.find(i=>i.path.replaceAll('\\','/')===rel);
 const saved=path.join(snapshot.backup,record?.path||'MISSING');
 if(!record||!fs.existsSync(saved)||sha(saved)!==record.sha256||sha(full)!==record.sha256)throw Error('Original recovery hash mismatch: '+rel);
 return full;
}
// Validate the entire explicit list before changing files. Never recursively deletes.
for(const rel of [...Object.keys(deletes),...moves])checked(rel);
for(const [rel,reason]of Object.entries(deletes)){fs.unlinkSync(checked(rel));actions.push({action:'DELETE',path:rel,reason,recovery:snapshot.backup});}
fs.mkdirSync(path.join(root,'reports/historical'),{recursive:true});
for(const rel of moves){const from=checked(rel),to=path.join(root,'reports/historical',rel);if(fs.existsSync(to))throw Error('Archive destination exists');fs.renameSync(from,to);actions.push({action:'MIGRATE',path:rel,to:path.relative(root,to),reason:'Historical export/report; contents retained'});}
fs.writeFileSync(path.join(root,'reports/cleanup-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),actions,keep:['Tarek-Elsayed-Resume.pdf','candidate_answers.json','data/candidate_profile.json','data/resume.txt','data/jobs.sqlite','openapply/.git','data/* research inputs and evidence'],regenerate:['openapply/dist','extensions/dist','dashboard.html'],merge:['Original tracker history into OpenApply tables; legacy rows retained']},null,2));
console.log(JSON.stringify(actions,null,2));
