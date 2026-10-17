import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

const root = path.resolve(import.meta.dirname, '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const html = fs.readFileSync(path.join(root, 'dist/index.html'));
const synced = fs.readFileSync(path.join(root, 'android/app/src/main/assets/public/index.html'));
const bytes = fs.readFileSync(path.join(root, 'release/NEONFALL.apk'));
const archive = unzipSync(bytes, { filter: entry => entry.name.startsWith('assets/public/') });
assert.ok(archive['assets/public/index.html'], 'APK contains the web entry');
assert.equal(digest(synced), digest(html), 'Capacitor assets match dist');
assert.equal(digest(archive['assets/public/index.html']), digest(html), 'APK matches latest dist');
assert.equal(digest(bytes), digest(fs.readFileSync(path.join(root, 'release/NEONFALL-debug.apk'))), 'APK aliases agree');
const chartManifest = JSON.parse(new TextDecoder().decode(archive['assets/public/bundled-charts/manifest.json']));
assert.ok(chartManifest.length > 0, 'fresh Android installs have playable examples');
for (const chart of chartManifest) {
  const data = archive['assets/public/bundled-charts/' + chart.file];
  assert.ok(data, 'example chart exists: ' + chart.file);
  assert.equal(createHash('sha1').update(data).digest('hex'), chart.sha1);
  assert.equal(digest(data), digest(fs.readFileSync(path.resolve(root, '../samples-converted', chart.name))), 'bundled chart matches current source');
}
const report = { generatedAt: new Date().toISOString(), htmlSha256: digest(html), apkSha256: digest(bytes), apkBytes: bytes.length, aliases: ['NEONFALL.apk', 'NEONFALL-debug.apk'], bundledCharts: chartManifest.length, checks: ['dist = Capacitor assets = APK HTML', 'both installation paths contain identical current APK', 'bundled example charts match current source'] };
fs.writeFileSync(path.join(root, 'release/android-build-manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
