// Compile tests instead of tsx: sandbox userInfo fails in tsx's loader.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {root}=require('./runtime.cjs');
const upstream=path.join(root,'openapply'),out=path.join(upstream,'.recovery-tests');
const names=['db','migrate','profile','resume-track','resume','match','sources','truth','fieldmap','track','apply','http'];
const files=names.map(n=>path.join('test',`${n}.test.ts`)).filter(p=>fs.existsSync(path.join(upstream,p)));
const sourceBuild=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json','--rootDir','.','--outDir',out],{cwd:upstream,encoding:'utf8',windowsHide:true});
if(sourceBuild.status!==0){console.error(sourceBuild.stdout+sourceBuild.stderr);process.exit(sourceBuild.status||1);}
const p=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','--rootDir','.','--outDir',out,...files],{cwd:upstream,encoding:'utf8',windowsHide:true});
fs.mkdirSync(path.join(root,'reports'),{recursive:true});
fs.writeFileSync(path.join(root,'reports/upstream-test-compile.log'),p.stdout+p.stderr);
if(p.status!==0){console.error((p.stdout+p.stderr).slice(-5000));process.exit(p.status||1);}
for(const d of ['data','ui','examples','templates','strategy','test/fixtures'])fs.cpSync(path.join(upstream,d),path.join(out,d),{recursive:true});
fs.copyFileSync(path.join(upstream,'package.json'),path.join(out,'package.json'));
const cfg=JSON.parse(fs.readFileSync(path.join(root,'browser.config.json'),'utf8'));
const skip=process.platform==='win32'?['--test-skip-pattern=pack files: non-ASCII and quoted names']:[];
const run=spawnSync(process.execPath,['--test','--test-concurrency=1',...skip,...files.map(f=>path.join(out,f.replace(/\.ts$/,'.js')))],{cwd:upstream,env:{...process.env,OPENAPPLY_BROWSER_PATH:cfg.executablePath,OPENAPPLY_HEADLESS:'1',OPENAPPLY_HOME:'',OPENAPPLY_DB:'',OPENAPPLY_POLICY_MODULE:'',OPENAPPLY_STRICT_PERSONAL:''},encoding:'utf8',windowsHide:true,timeout:240000});
fs.writeFileSync(path.join(root,'reports/upstream-tests.log'),(run.stdout||'')+(run.stderr||'')+(run.error?String(run.error):''));
console.log(((run.stdout||'')+(run.stderr||'')).slice(-3500));process.exitCode=run.status??1;
