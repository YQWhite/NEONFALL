'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Upgrade only known shipped bytes, including copies imported under a hashed ID.
// Stable filenames keep scores and the active skin selection attached to the item.
function refreshBundledAssets(seedDir, chartsDir, skinsDir) {
  const manifestFile = path.join(seedDir, 'bundle-manifest.json');
  if (!fs.existsSync(manifestFile)) return [];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { return []; }
  const changed = [];
  const digests = new Map();
  for (const item of manifest.files ?? []) {
    if (typeof item.name !== 'string' || /[\\/:]/.test(item.name) || !/\.(nfm|nfsk)$/.test(item.name) || !Array.isArray(item.replaces)) continue;
    const source = path.join(seedDir, item.name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const bytes = fs.readFileSync(source);
    if (hash(bytes) !== item.sha256) continue;
    const extension = path.extname(item.name), targetDir = extension === '.nfm' ? chartsDir : skinsDir;
    const known = new Set(item.replaces);
    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
      const target = path.join(targetDir, entry.name);
      let digest = digests.get(target);
      if (!digest) { digest = hash(fs.readFileSync(target)); digests.set(target, digest); }
      if (digest === item.sha256 || !known.has(digest)) continue;
      const current = fs.readFileSync(target);
      // Preserve a verified rollback copy before replacing the old demo file.
      const backupDir = path.join(targetDir, '.bundled-backup');
      fs.mkdirSync(backupDir, { recursive: true });
      const backupFile = path.join(backupDir, digest + extension);
      if (!fs.existsSync(backupFile)) fs.writeFileSync(backupFile, current, { flag: 'wx' });
      const temp = target + '.bundled-next';
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, target);
      digests.set(target, item.sha256);
      changed.push(entry.name);
    }
  }
  return changed;
}
module.exports = { refreshBundledAssets };
