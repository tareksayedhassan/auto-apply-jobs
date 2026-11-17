const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { root }=require('./runtime.cjs');
for (const config of ['openapply/tsconfig.json','extensions/tsconfig.json']) {
  const p=spawnSync(process.execPath,[path.join(root,'openapply/node_modules/typescript/bin/tsc'),'-p',path.join(root,config)],{stdio:'inherit',windowsHide:true});
  if (p.status !== 0) process.exit(p.status || 1);
}
