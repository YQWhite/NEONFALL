import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync, strToU8 } from 'fflate';

const root = fileURLToPath(new URL('..', import.meta.url));
const release = path.join(root, 'release');
fs.mkdirSync(release, { recursive: true });
const html = fs.readFileSync(path.join(root, 'dist/index.html'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const report = { generatedAt: new Date().toISOString(), htmlSha256: sha256(html), packages: {} };
const web = { 'index.html': new Uint8Array(html) };
const server = { 'dist/index.html': new Uint8Array(html) };

function addFile(entries, source, destination) {
  entries[destination] = new Uint8Array(fs.readFileSync(source));
}
function walk(directory, callback, relative = '') {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error(`Refusing symlink: ${item.name}`);
    const name = path.posix.join(relative, item.name);
    if (item.isDirectory()) walk(path.join(directory, item.name), callback, name);
    else if (item.isFile()) callback(path.join(directory, item.name), name);
  }
}
for (const name of ['server-deployment.md', 'web-client.md', 'performance.md', 'malody-skins.md', 'DELIVERY.md']) {
  const source = path.join(root, 'docs', name);
  if (fs.existsSync(source)) {
    addFile(server, source, `docs/${name}`);
    if (name !== 'performance.md') addFile(web, source, `docs/${name}`);
  }
}
walk(path.join(root, 'server'), (source, name) => {
  if (name.split('/').some(part => ['data', 'node_modules', 'tests', 'test-results'].includes(part))) return;
  if (/(?:^|\/)(?:test[^/]*|[^/]*\.test\.[^/]+)$/i.test(name)) return;
  if (!/\.(?:js|cjs|json|md|service|conf|example|sh)$/i.test(name)) return;
  addFile(server, source, `server/${name}`);
});
// Only the platform-independent runtime dependency is included. Electron,
// Android tooling, credentials and the development dependency tree stay out.
const fflateRoot = path.join(root, 'node_modules/fflate');
for (const name of ['package.json', 'LICENSE']) addFile(server, path.join(fflateRoot, name), `node_modules/fflate/${name}`);
walk(path.join(fflateRoot, 'lib'), (source, name) => addFile(server, source, `node_modules/fflate/lib/${name}`));
const fflateVersion = JSON.parse(fs.readFileSync(path.join(fflateRoot, 'package.json'), 'utf8')).version;
server['package.json'] = strToU8(JSON.stringify({
  name: 'neonfall-server', private: true, version: '0.2.10',
  description: 'NEONFALL Web and central chart server deployment',
  scripts: { start: 'node server/server.js' },
  engines: { node: '>=22.18.0' },
  dependencies: { fflate: fflateVersion },
}, null, 2) + '\n');
const samples = path.resolve(root, '../samples-converted');
for (const name of fs.readdirSync(samples).filter(name => name.endsWith('.nfm'))) {
  addFile(server, path.join(samples, name), `samples-converted/${name}`);
}
if (!Object.keys(server).some(name => name.startsWith('samples-converted/'))) throw new Error('No bundled charts');
server['README.txt'] = strToU8('NEONFALL Web + central chart server\nNode.js 22.18+ or 24 LTS required.\nStart: node server/server.js\nOpen: http://127.0.0.1:8787\nDebian / BaoTa deployment: docs/server-deployment.md\nRuntime fflate dependency is included; no npm install is required.\nKeep persistent data outside this release directory using NF_DATA_DIR.\n');
web['README.txt'] = strToU8('NEONFALL Web build\nServe index.html with HTTP(S). Online features also require the central chart API.\nRecommended: use NEONFALL-server.zip for the complete Web + API deployment.\nSee docs/server-deployment.md and docs/web-client.md.\n');

for (const [name, entries, htmlPath] of [
  ['NEONFALL-web.zip', web, 'index.html'],
  ['NEONFALL-server.zip', server, 'dist/index.html'],
]) {
  const bytes = zipSync(entries, { level: 6 });
  const extracted = unzipSync(bytes);
  if (sha256(extracted[htmlPath]) !== report.htmlSha256) throw new Error(`${name}: HTML mismatch`);
  if (Object.keys(extracted).some(name => /(?:^|\/)(?:data|auth\.json|.*\.keystore|.*\.apk)(?:\/|$)/i.test(name))) {
    throw new Error(`${name}: unexpected private or unrelated payload`);
  }
  fs.writeFileSync(path.join(release, name), bytes);
  report.packages[name] = { bytes: bytes.length, entries: Object.keys(entries).length, sha256: sha256(bytes) };
}
fs.writeFileSync(path.join(release, 'online-package-manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
