const fs=require('node:fs'),path=require('node:path');
function library(){return require('../openapply/node_modules/playwright');}
function launchOptions(){const config=JSON.parse(fs.readFileSync('browser.config.json'));return {executablePath:config.executablePath,headless:config.headless};}
function automationProfilePath(config=JSON.parse(fs.readFileSync('browser.config.json'))){const target=path.resolve(config.automationUserDataDir),root=path.resolve('.')+path.sep,personal=path.resolve(config.personalUserDataDir).toLowerCase();if(!target.toLowerCase().startsWith(root.toLowerCase())||target.toLowerCase()===personal||target.toLowerCase().startsWith(personal+path.sep))throw Error('Automation profile must stay inside this project and outside personal Chrome user data');return target;}
async function launchContext(headless=true){return library().chromium.launchPersistentContext(automationProfilePath(),{...launchOptions(),headless});}
async function capture(url,name='capture'){
 fs.mkdirSync('data/evidence',{recursive:true});let browser;
 const result={url,checked_at:new Date().toISOString(),status:'failed'};
 try{browser=await launchContext();const page=await browser.newPage();const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});result.http_status=response?.status();result.final_url=page.url();result.title=await page.title();result.text=await page.locator('body').innerText();result.links=await page.locator('a[href]').evaluateAll(as=>as.map(a=>({text:a.innerText,url:a.href})));result.status=response?.ok()?'captured':'blocked';await page.screenshot({path:`data/evidence/${name}.png`,fullPage:true});}catch(e){result.error=e.message;}finally{await browser?.close();fs.writeFileSync(`data/evidence/${name}.json`,JSON.stringify(result,null,2));}return result;
}
module.exports={capture,library,launchOptions,launchContext,automationProfilePath};
if(require.main===module)capture(process.argv[2]||'https://www.google.com/',process.argv[3]||'connectivity-google').then(r=>{console.log(JSON.stringify({...r,text:r.text?.slice(0,1500),links:r.links?.slice(0,5)},null,2));if(r.status!=='captured')process.exitCode=1;});
