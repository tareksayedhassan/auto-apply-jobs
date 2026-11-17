const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
function environment(extra = {}) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'browser.config.json'), 'utf8'));
  process.env.OPENAPPLY_AUTOSYNC = '0';
  return { ...process.env, OPENAPPLY_HOME: path.join(root, 'data', 'openapply'), OPENAPPLY_DB: path.join(root, 'data', 'jobs.sqlite'), OPENAPPLY_BROWSER_PATH: cfg.executablePath, OPENAPPLY_STRICT_PERSONAL: '1', OPENAPPLY_POLICY_MODULE: require('node:url').pathToFileURL(path.join(root,'extensions/policy.mjs')).href, ...extra };
}
module.exports = { root, environment };
