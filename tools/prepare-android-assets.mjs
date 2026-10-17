import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(root, '../samples-converted');
const target = path.join(root, 'android/app/src/main/assets/public/bundled-charts');
fs.mkdirSync(target, { recursive: true });
const manifest = fs.readdirSync(source).filter(name => name.endsWith('.nfm')).sort().map(name => {
  const bytes = fs.readFileSync(path.join(source, name));
  const sha1 = createHash('sha1').update(bytes).digest('hex');
  const file = `${sha1}.nfm`;
  fs.writeFileSync(path.join(target, file), bytes);
  return { name, file, sha1 };
});
if (!manifest.length) throw new Error('No bundled charts found');
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${manifest.length} current Android example charts`);
