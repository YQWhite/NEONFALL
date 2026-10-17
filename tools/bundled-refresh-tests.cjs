'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { refreshBundledAssets } = require('../electron/bundled-assets.cjs');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(root, 'test-results/ui-refresh/migration-'));
const charts = path.join(temp, 'charts'), skins = path.join(temp, 'skins');
fs.mkdirSync(charts); fs.mkdirSync(skins);
const seed = path.resolve(root, '../samples-converted');
const manifest = JSON.parse(fs.readFileSync(path.join(seed, 'bundle-manifest.json')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let total = 0;
for (const item of manifest.files) {
  const ext = path.extname(item.name), dir = ext === '.nfm' ? charts : skins;
  const old = fs.readFileSync(path.join(root, 'test-results/menu-refresh-final/user-data', ext === '.nfm' ? 'charts' : 'skins', item.name));
  assert.ok(item.replaces.includes(sha(old)));
  fs.writeFileSync(path.join(dir, item.name), old);
  fs.writeFileSync(path.join(dir, sha(old).slice(0, 40) + ext), old);
  total += 2;
}
fs.writeFileSync(path.join(charts, 'custom.nfm'), 'user customized chart');
fs.writeFileSync(path.join(charts, 'scores.json'), '{"untouched":true}');
assert.equal(refreshBundledAssets(seed, charts, skins).length, total);
for (const item of manifest.files) {
  const dir = item.name.endsWith('.nfm') ? charts : skins;
  assert.equal(sha(fs.readFileSync(path.join(dir, item.name))), item.sha256);
}
assert.equal(fs.readFileSync(path.join(charts, 'custom.nfm'), 'utf8'), 'user customized chart');
assert.equal(fs.readFileSync(path.join(charts, 'scores.json'), 'utf8'), '{"untouched":true}');
assert.equal(refreshBundledAssets(seed, charts, skins).length, 0, 'upgrade is idempotent');
assert.ok(fs.readdirSync(path.join(charts, '.bundled-backup')).length >= 4);
const altered = path.join(temp, 'invalid-seed'); fs.mkdirSync(altered);
fs.writeFileSync(path.join(altered, 'bundle-manifest.json'), JSON.stringify({ files: [{ name: '../outside.nfm', replaces: [] }, { ...manifest.files[0], sha256: 'wrong' }] }));
fs.copyFileSync(path.join(seed, manifest.files[0].name), path.join(altered, manifest.files[0].name));
assert.deepEqual(refreshBundledAssets(altered, charts, skins), []);
console.log('PASS verified demo refresh / name and hash IDs preserved / backup / custom files and scores untouched / repeat launch / invalid source rejection');
