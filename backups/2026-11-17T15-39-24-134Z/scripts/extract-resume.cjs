const fs=require('node:fs'),z=require('node:zlib'),crypto=require('node:crypto');
fs.mkdirSync('data',{recursive:true});
const b=fs.readFileSync('Tarek-Elsayed-Resume.pdf'),s=b.toString('latin1'),objects={};
for(const m of s.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)){let t=m[2];if(t.includes('stream')){try{t=z.inflateSync(Buffer.from(t.split(/stream\r?\n/)[1].split('endstream')[0],'latin1')).toString('utf8');}catch{}}objects[m[1]]=t;}
const maps=[6,11,16].map(id=>Object.fromEntries([...objects[id].split('beginbfchar')[1].split('endbfchar')[0].matchAll(/<([0-9A-F]+)>\s*<([0-9A-F]+)>/g)].map(m=>[m[1],[...m[2].matchAll(/.{4}/g)].map(x=>String.fromCharCode(parseInt(x[0],16))).join('')])));
let font=0,out=[];
for(const bt of objects[18].matchAll(/BT([\s\S]*?)ET/g)){let line='';for(const tok of bt[1].matchAll(/\/F(\d)\s+[\d.]+\s+Tf|<([0-9A-F]+)>/g)){if(tok[1]!==undefined)font=+tok[1];else line += [...tok[2].matchAll(/.{4}/g)].map(x=>maps[font][x[0]]??'�').join('');}out.push(line);}
const links=[...s.matchAll(/\/URI \(([^)]+)\)/g)].map(m=>m[1]);
fs.writeFileSync('data/resume.txt',out.join('\n')+'\n\nLINKS\n'+links.join('\n'));
fs.writeFileSync('data/resume-source.json',JSON.stringify({sha256:crypto.createHash('sha256').update(b).digest('hex'),pages:1,method:'Embedded ToUnicode maps and all BT/ET text in page contents',links},null,2));
console.log(out.join('\n'));
