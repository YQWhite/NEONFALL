import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { unzipSync } from 'fflate';

const root = path.resolve(import.meta.dirname, '..');
const release = path.join(root, 'release');
const out = path.join(root, 'test-results/online-delivery');
fs.mkdirSync(out, { recursive: true });
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const expected = hash(fs.readFileSync(path.join(root, 'dist/index.html')));
const artifacts = {};
for (const [name, entry] of [
  ['NEONFALL-web.zip', 'index.html'],
  ['NEONFALL-server.zip', 'dist/index.html'],
  ['NEONFALL-debug.apk', 'assets/public/index.html'],
]) {
  const bytes = fs.readFileSync(path.join(release, name));
  const contents = unzipSync(bytes, { filter(file) { return file.name === entry; } });
  assert.ok(contents[entry], `${name}: missing ${entry}`);
  assert.equal(hash(contents[entry]), expected, `${name}: stale Web build`);
  artifacts[name] = { bytes: bytes.length, sha256: hash(bytes), htmlSha256: expected };
}
assert.equal(hash(fs.readFileSync(path.join(release, 'NEONFALL-win-x64/resources/app/dist/index.html'))), expected);
const stage = fs.mkdtempSync(path.join(out, 'deployment-'));
const contents = unzipSync(fs.readFileSync(path.join(release, 'NEONFALL-server.zip')));
for (const [name, data] of Object.entries(contents)) {
  const target = path.resolve(stage, name);
  assert.ok(target.startsWith(stage + path.sep), 'Archive entry outside staging directory');
  assert.ok(!/(?:^|\/)(?:data|auth\.json|.*\.keystore)(?:\/|$)/i.test(name), 'Unexpected private payload');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
}
const deployedRequire = createRequire(path.join(stage, 'package.json'));
assert.ok(deployedRequire.resolve('fflate').startsWith(path.join(stage, 'node_modules') + path.sep));
Object.assign(process.env, { HOST: '127.0.0.1', PORT: '0', NF_DATA_DIR: path.join(stage, 'smoke-data') });
delete process.env.NF_SEED_DIR; delete process.env.NF_DIST_DIR;
// Load the entry point from the extracted package, using its own dependency
// resolution. This also works when Node child-process creation is restricted.
const { server } = deployedRequire('./server/server.js');
try {
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const ping = await fetch(base + '/api/ping').then(r => r.json());
  assert.equal(ping.ok, true); assert.equal(ping.charts, 4, 'Packaged seed discovery failed');
  const html = new Uint8Array(await fetch(base + '/').then(r => r.arrayBuffer()));
  assert.equal(hash(html), expected);
  const charts = await fetch(base + '/api/charts').then(r => r.json());
  for (const chart of charts) {
    const bytes = Buffer.from(await fetch(base + '/api/charts/' + chart.id).then(r => r.arrayBuffer()));
    assert.equal(crypto.createHash('sha1').update(bytes).digest('hex'), chart.id);
  }
  const report = { ok: true, verifiedAt: new Date().toISOString(), htmlSha256: expected, artifacts,
    deploymentSmoke: { startedFromExtractedPackage: true, bundledRuntimeDependency: true, seededCharts: charts.length, allChartDownloadsVerified: true, execution: 'Extracted server entry point loaded in this isolated verification process.' },
    limitations: ['APK signature is checked separately with apksigner.', 'Windows GUI, Android installation and external SMTP were not exercised.'] };
  fs.writeFileSync(path.join(out, 'release-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
