const fs=require('node:fs');
for(const p of ['scripts/resume-pdf.cjs','scripts/research.cjs']){let s=fs.readFileSync(p,'utf8');s=s.replaceAll("{channel:'msedge',headless:true}","require('./browser.cjs').launchOptions()");fs.writeFileSync(p,s);}
console.log('All browser scripts now use Chrome configuration.');
