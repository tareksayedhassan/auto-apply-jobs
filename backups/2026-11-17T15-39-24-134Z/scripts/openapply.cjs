const { spawn } = require('node:child_process');
const { root, environment } = require('./runtime.cjs');
const path = require('node:path');
const args = process.argv.slice(2);
const mcp = args[0] === 'mcp';
const child = spawn(process.execPath, [path.join(root, 'openapply', 'dist', mcp ? 'mcp.js' : 'cli.js'), ...(mcp ? [] : args)], { cwd: path.join(root, 'openapply'), env: environment(), stdio: 'inherit', windowsHide: true });
child.on('error', e => { console.error(e); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
