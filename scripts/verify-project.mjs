import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Client } from '../openapply/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../openapply/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import runtime from './runtime.cjs';
const results=[];
for (const [name,args] of [['strict-build',['scripts/build.cjs']],['integration-tests',['--test','tests/consolidation.test.mjs']]]) {
 const p=spawnSync(process.execPath,args,{cwd:runtime.root,encoding:'utf8',windowsHide:true,timeout:120000});
 fs.mkdirSync(path.join(runtime.root,'reports'),{recursive:true});
 fs.writeFileSync(path.join(runtime.root,`reports/${name}.log`),(p.stdout||'')+(p.stderr||''));
 results.push({name,passed:p.status===0,error:p.error?.message});
}
const client=new Client({name:'global-job-hunter-verification',version:'1'});
try {
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(runtime.root,'scripts/openapply.cjs'),'mcp'],env:runtime.environment(),stderr:'pipe'}));
 const {tools}=await client.listTools();
 const names=tools.map(t=>t.name);
 for(const name of ['get_profile','search_jobs','list_matches','inspect_application','fill_application','submit_application','list_applications','pipeline_summary'])assert.ok(names.includes(name),`${name} not exposed`);
 for(const name of ['get_profile','search_jobs','list_matches','list_applications','pipeline_summary']) {
  const r=await client.callTool({name,arguments:{}});assert.ok(!r.isError,`${name} returned error`);
 }
 results.push({name:'mcp-stdio',passed:true,tools:names});
}catch(e){results.push({name:'mcp-stdio',passed:false,error:e.message});}
finally{await client.close();}
const {report}=await import('../extensions/reporting/index.mjs');
const snapshot=report();
results.push({name:'canonical-db-integrity',passed:snapshot.integrity[0].integrity_check==='ok'&&snapshot.foreignKeyErrors.length===0});
fs.writeFileSync(path.join(runtime.root,'reports/verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
console.log(JSON.stringify(results.map(({tools,...r})=>r),null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
