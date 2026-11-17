import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import runtime from '../../scripts/runtime.cjs';
export function report() {
 const db=new DatabaseSync(path.join(runtime.root,'data/jobs.sqlite'),{readOnly:true});
 try {
  const count=sql=>db.prepare(sql).get().n;
  const metrics={
   employers_indexed:count('SELECT count(*) n FROM (SELECT lower(name) FROM legacy_companies UNION SELECT lower(company) FROM jobs)'),
   historical_employer_lookups:count('SELECT count(*) n FROM legacy_companies WHERE checked_at IS NOT NULL'),
   historical_readable_official_portals:count("SELECT count(*) n FROM legacy_companies WHERE checked_at IS NOT NULL AND official_verified=1 AND status='researched'"),
   historical_vacancies:count('SELECT count(*) n FROM legacy_jobs'),
   historical_preliminary_assessments:count("SELECT count(*) n FROM legacy_jobs WHERE assessment IS NOT NULL AND assessment<>''"),
   unique_active_vacancies:count('SELECT count(DISTINCT url) n FROM jobs WHERE open=1'),
   technical_matches:count("SELECT count(*) n FROM international_assessments WHERE EXISTS(SELECT 1 FROM json_each(evidence_json) WHERE json_extract(value,'$.dimension')='technical' AND json_extract(value,'$.finding')='met')"),
   visa_feasible_opportunities:count("SELECT count(*) n FROM international_assessments WHERE decision IN ('CONFIRMED_ELIGIBLE','POTENTIALLY_ELIGIBLE')"),
   applications_prepared:count("SELECT count(*) n FROM applications WHERE status='drafted'"),
   awaiting_approval:count("SELECT count(*) n FROM applications WHERE status='filled'"),
   approved:count("SELECT count(*) n FROM applications WHERE status='approved'"),
   applications_submitted:count('SELECT count(*) n FROM applications WHERE submitted_at IS NOT NULL'),
   employer_confirmed_submissions:count('SELECT count(*) n FROM submission_evidence'),
   blocked:count("SELECT count(*) n FROM applications WHERE status='needs_human'"),
   failed:count("SELECT count(DISTINCT job_id) n FROM events WHERE kind IN ('failed','verification_failed')"),
   unknown_outcomes:count('SELECT count(*) n FROM application_holds'),
   interviews:count("SELECT count(*) n FROM applications WHERE status='interview'"),
   responses:count("SELECT count(DISTINCT job_id) n FROM events WHERE kind IN ('ack','interview','rejected','offer')")};
  const snapshot={generatedAt:new Date().toISOString(),metrics,
   historicalCountryDistribution:db.prepare("SELECT coalesce(country,'Unknown') country,count(*) vacancies FROM legacy_jobs GROUP BY country ORDER BY vacancies DESC").all(),
   companyDistribution:db.prepare('SELECT company,count(*) vacancies FROM jobs GROUP BY company ORDER BY vacancies DESC').all(),
   applications:db.prepare('SELECT a.*,j.company,j.title,j.url,e.confirmation_text,e.confirmation_reference,e.confirmation_url,e.evidence_path,e.sha256 FROM applications a JOIN jobs j ON j.id=a.job_id LEFT JOIN submission_evidence e ON e.job_id=a.job_id').all(),
   integrity:db.prepare('PRAGMA integrity_check').all(),foreignKeyErrors:db.prepare('PRAGMA foreign_key_check').all()};
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  fs.mkdirSync(path.join(runtime.root,'reports'),{recursive:true});
  fs.writeFileSync(path.join(runtime.root,'reports/summary.json'),JSON.stringify(snapshot,null,2));
  const table=(rows,keys)=>`<table><tr>${keys.map(k=>`<th>${esc(k)}</th>`).join('')}</tr>${rows.map(r=>`<tr>${keys.map(k=>`<td>${esc(r[k])}</td>`).join('')}</tr>`).join('')}</table>`;
  fs.writeFileSync(path.join(runtime.root,'dashboard.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Global AI Job Hunter</title><style>body{font:16px system-ui;background:#101826;color:#e5edf9;margin:3vw}h1{color:#78d9c1}.cards{display:flex;gap:15px;flex-wrap:wrap}.card{padding:20px;background:#1d2b40;border-radius:12px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:12px;border-bottom:1px solid #39506d}a{color:#8fcfff}</style><h1>Global AI Job Hunter</h1><p>Private report generated ${esc(snapshot.generatedAt)}. Historical research is separate from active vacancies. Live research is paused pending Chrome connectivity.</p><p>Run <code>npm.cmd run dashboard</code> for OpenApply's review dashboard at <a href="http://127.0.0.1:4646">127.0.0.1:4646</a>.</p><div class="cards">${Object.entries(metrics).map(([k,v])=>`<div class="card"><b>${v}</b><br>${esc(k.replaceAll('_',' '))}</div>`).join('')}</div><h2>Applications</h2>${table(snapshot.applications,['company','title','status','notes','confirmation_url'])}<h2>Historical country distribution</h2>${table(snapshot.historicalCountryDistribution,['country','vacancies'])}<h2>Employer distribution</h2>${table(snapshot.companyDistribution,['company','vacancies'])}</html>`);
  fs.writeFileSync(path.join(runtime.root,'pending_actions.md'),`# Pending actions\n\n- Google Chrome navigation failed with ERR_NETWORK_ACCESS_DENIED. Live discovery and applications remain paused. Evidence: data/evidence/recovery-google.json.\n- Personal Chrome Profile 4 is untouched. OpenApply uses its dedicated project profile.\n- Run npm.cmd run verify; review TEST_RESULTS.md.\n- Add the reviewed config/codex-mcp.toml entry to Codex user configuration when write access is available; current session does not expose OpenApply tools.\n- All ${metrics.historical_vacancies} imported vacancies are historical and closed until revalidated.\n- Confirmed applications: ${metrics.employer_confirmed_submissions}; blocked: ${metrics.blocked}; unknown outcomes: ${metrics.unknown_outcomes}.\n- Mandatory numeric salary requires a researched recommendation and candidate confirmation. Graduation month, citizenship, legal declarations, demographic choices and login/MFA/CAPTCHA need candidate input where asked.\n`);
  console.log(JSON.stringify(metrics,null,2));return snapshot;
 } finally {db.close();}
}
