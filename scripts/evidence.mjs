import fs from 'node:fs';
import runtime from './runtime.cjs';
import {recordAssessment,recordOfficialVerification} from '../extensions/employer-research/index.mjs';
const [command,file]=process.argv.slice(2);
if(!file || !['assess','verify-official'].includes(command))throw new Error('Usage: node scripts/evidence.mjs assess|verify-official input.json');
const input=JSON.parse(fs.readFileSync(file,'utf8'));
console.log(JSON.stringify(command==='assess'?recordAssessment(runtime.environment().OPENAPPLY_DB,input):recordOfficialVerification(runtime.environment().OPENAPPLY_DB,input),null,2));
