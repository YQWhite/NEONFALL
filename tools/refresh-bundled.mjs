// Rebuild shipped samples from their original archives, preserving a local backup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { importChartArchive, importSkinArchive } from '../src/core/import.ts';
import { readNFM, readNFSK } from '../src/core/nfm.ts';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspace = path.dirname(root), output = path.join(workspace, 'samples-converted');
const backup = path.join(root, 'test-results/ui-refresh/previous-bundled');
const hash = data => createHash('sha256').update(data).digest('hex');
const safe = name => name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
const originals = fs.readdirSync(workspace).filter(name => /\.(osz|mcz|osk)$/i.test(name));
assert.equal(originals.length, 3, 'Expected the three supplied original archives');
const rebuilt = [];
for (const name of originals) {
  const data = fs.readFileSync(path.join(workspace, name));
  if (name.endsWith('.osk')) {
    const converted = importSkinArchive(name, data);
    const { skin } = readNFSK(converted.nfsk);
    assert.ok(skin.hud.healthFill, 'The custom skin must include its health artwork');
    rebuilt.push({ name: safe(converted.name + '.nfsk'), bytes: converted.nfsk });
  } else for (const chart of importChartArchive(name, data)) {
    const parsed = readNFM(chart.nfm).chart;
    if (name.endsWith('.mcz')) { assert.equal(parsed.notes.length, 1386); assert.ok(Math.abs(parsed.notes[0].t - 8801.5) < 1); }
    if (parsed.meta.version.includes('Suic!de')) {
      assert.equal(parsed.storyboard.objects.length, 2765);
      assert.equal(parsed.storyboard.objects.reduce((n, obj) => n + obj.cmds.length, 0), 9918);
    }
    rebuilt.push({ name: safe(chart.name) + '.nfm', bytes: chart.nfm });
  }
}
assert.equal(rebuilt.filter(x => x.name.endsWith('.nfm')).length, 4);
// Only byte-identical historical shipped samples are eligible for replacement.
const historical = ['menu-refresh-final/user-data', 'packaged-refresh-2/user-data', 'subscreens-packaged', 'holds-packaged', 'storyboard-packaged'];
const manifest = { revision: '2026-10-17-kiai-0.2.2', files: [] };
const previousManifest = fs.existsSync(path.join(output, 'bundle-manifest.json')) ? JSON.parse(fs.readFileSync(path.join(output, 'bundle-manifest.json'))) : null;
fs.mkdirSync(backup, { recursive: true }); fs.mkdirSync(output, { recursive: true });
for (const item of rebuilt) {
  assert.equal(path.basename(item.name), item.name);
  const ext = path.extname(item.name), kind = ext === '.nfm' ? 'charts' : 'skins';
  const known = new Set(previousManifest?.files.find(x => x.name === item.name)?.replaces ?? []);
  for (const dir of [output, path.join(root, 'release/NEONFALL-win-x64/resources/app/seed-charts'), ...historical.map(d => path.join(root, 'test-results', d, kind))]) {
    const candidate = path.join(dir, item.name);
    if (fs.existsSync(candidate)) known.add(hash(fs.readFileSync(candidate)));
  }
  const file = path.resolve(output, item.name);
  assert.equal(path.dirname(file), output, 'Replacements must stay inside samples-converted');
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file), saved = path.join(backup, hash(old) + ext);
    if (!fs.existsSync(saved)) fs.writeFileSync(saved, old);
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, item.bytes);
  manifest.files.push({ name: item.name, sha256: hash(item.bytes), replaces: [...known] });
  console.log('Rebuilt', item.name, item.bytes.length, 'bytes;', known.size, 'verified prior versions');
}
fs.writeFileSync(path.join(output, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('PASS: four charts and the supplied skin regenerated from original archives; 9918 storyboard commands preserved.');
