// Private, reproducible inventory and recovery snapshot. Never copies browser sessions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(root, 'backups', stamp);
  const inventory = [], excluded = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), rel = path.relative(root, p);
      if (e.isSymbolicLink()) { excluded.push({ path: rel, reason: 'link; not followed' }); continue; }
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'backups', 'test-runs', '.recovery-tests'].includes(e.name) || /chrome-.*profile|chrome-direct-diagnostic|browser-profile/.test(e.name)) {
          excluded.push({ path: rel, reason: e.name === '.git' ? 'Git history retained in place' : 'regenerable dependencies, backup tree or private browser state retained in place' });
        } else walk(p);
      } else inventory.push({ path: rel, bytes: fs.statSync(p).size, sha256: hash(p) });
    }
  }
  walk(root);
  fs.mkdirSync(dest, { recursive: true });
  for (const item of inventory) {
    if (/-(wal|shm)$/.test(item.path)) continue;
    const src = path.join(root, item.path), out = path.join(dest, item.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (/\.(sqlite|db|sqlite3)$/i.test(item.path)) {
      const db = new DatabaseSync(src, { readOnly: true });
      try { await backup(db, out); } finally { db.close(); }
    } else fs.copyFileSync(src, out);
    item.backupSha256 = hash(out);
  }
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ root, createdAt: stamp, inventory, excluded }, null, 2));
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  const initial = path.join(root, 'reports', 'recovery.json');
  fs.writeFileSync(fs.existsSync(initial) ? path.join(root,'reports','recovery-latest.json') : initial, JSON.stringify({ backup: dest, inventory, excluded }, null, 2));
  console.log(JSON.stringify({ backup: dest, files: inventory.length, excluded }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
