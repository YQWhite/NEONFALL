import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
const hash = data => createHash('sha256').update(data).digest('hex');
const release = path.resolve(process.argv[2] || 'release/NEONFALL-win-x64'), seed = path.resolve('../samples-converted');
const zipFile = path.resolve('release/NEONFALL-win-x64.zip');
const entries = [];
const raw = unzipSync(fs.readFileSync(zipFile), { filter(file) { const name = file.name.replaceAll('\\', '/'); entries.push(name); return name.includes('/resources/app/'); } });
const zip = Object.fromEntries(Object.entries(raw).map(([name, bytes]) => [name.replaceAll('\\', '/'), bytes]));
assert.ok(entries.some(name => name.endsWith('/NEONFALL.exe')));
assert.ok(!entries.some(name => /\/(tools|test-results|\.bundled-backup)\//.test(name)), 'Release must contain no test runners, diagnostics, or backups');
const sources = [
  ['dist/index.html', 'dist/index.html'], ['electron/main.cjs', 'main.cjs'],
  ['electron/preload.cjs', 'preload.cjs'], ['electron/bundled-assets.cjs', 'bundled-assets.cjs'],
  ...fs.readdirSync(seed).filter(name => /\.(nfm|nfsk)$/.test(name) || name === 'bundle-manifest.json').map(name => [path.join(seed, name), 'seed-charts/' + name]),
];
const files = {};
for (const [source, packaged] of sources) {
  const expected = hash(fs.readFileSync(source)), actual = hash(fs.readFileSync(path.join(release, 'resources/app', packaged)));
  const inZip = zip[path.basename(release) + '/resources/app/' + packaged];
  assert.ok(inZip, 'ZIP entry missing: ' + packaged); assert.equal(actual, expected); assert.equal(hash(inZip), expected);
  files[packaged] = expected;
}
const report = { zipBytes: fs.statSync(zipFile).size, entries: entries.length, verifiedFiles: files, executableLaunch: 'Not attempted; prior handoff records the environment ACL/IPC launch failure.' };
fs.writeFileSync('test-results/ui-refresh/package-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('PASS: source, Windows folder and ZIP payload hashes agree; rebuilt charts/skin and migration manifest present; no diagnostics shipped.');
