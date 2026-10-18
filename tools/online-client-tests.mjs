import assert from 'node:assert/strict';
import http from 'node:http';
import { ServerApi, ApiError, normalizeServerUrl } from '../src/api/client.ts';
import { listPlaybackCharts } from '../src/api/library.ts';
import { App } from '../src/ui/app.ts';
import { Store } from '../src/core/store.ts';
import { createHash, randomBytes } from 'node:crypto';
import { sha1Fallback } from '../src/core/sha1.ts';
import { sha1Hex } from '../src/core/zip.ts';

for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 127, 128, 10000, 1000000]) {
  const bytes = randomBytes(length + 5).subarray(3, length + 3);
  assert.equal(sha1Fallback(bytes), createHash('sha1').update(bytes).digest('hex'), 'LAN HTTP package identifier: ' + length);
}
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
assert.equal(await sha1Hex(new TextEncoder().encode('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto;
console.log('PASS LAN HTTP SHA-1 fallback agrees with Node crypto across padding boundaries and offset buffers');

const calls = new Map();
const payload = new Uint8Array([80, 75, 3, 4, 17, 25, 33]);
let authorization = '';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  calls.set(url.pathname, (calls.get(url.pathname) || 0) + 1);
  authorization = req.headers.authorization || '';
  const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/ping') return json({ ok: true, name: 'neonfall-server' });
  if (url.pathname === '/other/api/ping') return json({ ok: true, name: 'other-service' });
  if (url.pathname === '/api/charts') return json([{ id: 'abcd', name: 'Central chart', title: 'Song', keys: 4 }]);
  if (url.pathname === '/api/charts/abcd' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(payload); }
  if (url.pathname === '/api/charts/abcd' && req.method === 'DELETE') return json({ ok: true });
  if (url.pathname === '/api/unauthorized') return json({ error: 'not signed in' }, 401);
  if (url.pathname === '/api/slow') { const timer = setTimeout(() => json({ ok: true }), 200); res.on('close', () => clearTimeout(timer)); return; }
  if (url.pathname === '/api/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>Wrong service</html>'); }
  return json({ error: 'not found' }, 404);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal(normalizeServerUrl(' ' + base + '/// '), base);
  assert.throws(() => normalizeServerUrl('javascript:alert(1)'));
  assert.throws(() => normalizeServerUrl('http://user:password@localhost'));
  const stored = new Map(); let cacheWrites = 0;
  const cache = {
    async getChartBytes(id) { return stored.get(id) || null; },
    async putChart(bytes, name) { assert.equal(name, 'Central chart'); stored.set('abcd', bytes); cacheWrites++; },
    async deleteChart(id) { stored.delete(id); },
  };
  const api = new ServerApi(base, cache);
  assert.equal(await api.ping(), true);
  assert.equal(await new ServerApi(base + '/other').ping(), false, 'another JSON service must not count as NEONFALL');
  const charts = await api.listCharts();
  assert.equal(charts[0].server, true, 'central charts must use the server download path');
  assert.equal(charts[0].name, 'Central chart');
  const downloads = await Promise.all(Array.from({ length: 8 }, () => api.downloadChart('abcd')));
  downloads.forEach(bytes => assert.deepEqual(bytes, payload));
  assert.equal(calls.get('/api/charts/abcd'), 1, 'cover/preview/play concurrent requests share one transfer');
  assert.equal(cacheWrites, 1);
  await api.downloadChart('abcd');
  assert.equal(calls.get('/api/charts/abcd'), 1, 'repeat reads use memory');
  const restarted = new ServerApi(base, cache);
  await restarted.downloadChart('abcd');
  assert.equal(calls.get('/api/charts/abcd'), 1, 'fresh client uses persistent browser cache');
  api.setToken('test-token');
  await assert.rejects(api.req('/api/unauthorized'), error => error instanceof ApiError && error.status === 401);
  assert.equal(authorization, 'Bearer test-token');
  await assert.rejects(api.req('/api/html'), /NEONFALL API response/);
  await assert.rejects(new ServerApi(base, undefined, 25).req('/api/slow'), /timed out/);
  await api.deleteChartServer('abcd'); assert.equal(stored.size, 1, 'remote deletion preserves offline downloads');
  console.log('PASS HTTP API identity, central chart routing, transfer deduplication, persistent cache, errors and timeout');

  const local = [{ id: 'abcd', name: 'Cached chart' }, { id: 'private', name: 'Local import' }];
  const app = { settings: {}, centralLibrary: true, serverOnline: true, server: api, store: { listCharts: async () => local } };
  const merged = await listPlaybackCharts(app);
  assert.deepEqual(merged.map(entry => entry.id), ['abcd', 'private']);
  assert.equal(merged[0].server, true);
  assert.equal(merged[0].downloaded, true);
  app.store.listCharts = async () => [{ id: 'windows-seed-filename', contentHash: 'abcd' }, { id: 'private', name: 'Local import' }];
  assert.deepEqual((await listPlaybackCharts(app)).map(entry => entry.id), ['abcd', 'private'], 'desktop seed aliases merge with server content IDs');
  app.store.listCharts = async () => local;
  app.server = { listCharts: async () => { throw new Error('offline'); } };
  assert.deepEqual(await listPlaybackCharts(app), local);
  assert.equal(app.serverOnline, false);
  app.centralLibrary = false; app.serverOnline = true;
  assert.deepEqual(await listPlaybackCharts(app), local, 'unconfigured clients retain their device library');
  const centralGetter = Object.getOwnPropertyDescriptor(App.prototype, 'centralLibrary').get;
  for (const platform of ['desktop', 'android']) {
    assert.equal(centralGetter.call({ platform, settings: { serverUrl: base } }), true, 'native clients use the configured central catalogue');
    assert.equal(centralGetter.call({ platform, settings: { serverUrl: '' } }), false, 'native clients do not request a localhost WebView origin as a server');
  }
  console.log('PASS explicit central URL, imported-local merge, offline fallback and native server-library behavior');

  let savedToken = 'saved-session';
  const account = {
    settings: {},
    store: { getToken: () => savedToken, setToken: value => { savedToken = value; }, getProfile: () => ({ username: 'local' }) },
    server: { setToken() {}, async me() { throw new Error('offline'); } },
  };
  await App.prototype.refreshAccount.call(account);
  assert.equal(savedToken, 'saved-session', 'network failures must preserve saved sessions');
  assert.equal(account.account.server, false);
  account.server.me = async () => { throw new ApiError('not signed in', 401); };
  await App.prototype.refreshAccount.call(account);
  assert.equal(savedToken, '', 'invalid sessions are cleared only after explicit authentication rejection');
  console.log('PASS temporary outages preserve sessions and HTTP 401 expires sessions');

  globalThis.document = { body: { appendChild() {} }, createElement: () => ({ value: '', style: {}, addEventListener() {}, remove() {} }) };
  const { AccountScreen } = await import('../src/ui/screens/account.ts');
  const fakeApp = {
    platform: 'web', settings: { serverUrl: base }, server: api, serverOnline: true,
    store: { getToken: () => '', setToken() {}, getProfile: () => null },
    account: { server: true, user: { username: 'existing-account' } }, saveSettings() {}, toast() {},
  };
  const accountScreen = new AccountScreen(fakeApp);
  accountScreen.serverUrl.value = base + '/other';
  await accountScreen.connectServer();
  assert.equal(fakeApp.server, api, 'failed candidate connections preserve the current API instance');
  assert.equal(fakeApp.account.user.username, 'existing-account', 'failed candidate connections preserve the current account');
  accountScreen.leave();
  console.log('PASS invalid candidate server preserves the existing connection and account');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

// Exercise the real desktop cache path after the HTTP server is closed.
const offlineHash = await sha1Hex(payload);
const desktopEntry = { id: 'old-desktop-filename', contentHash: offlineHash };
globalThis.localStorage = { getItem: key => key === 'nf.chartMeta.v1' ? JSON.stringify({ [desktopEntry.id]: desktopEntry }) : null };
const desktopReads = [];
globalThis.window = { neonfallBridge: {
  readChart: async id => { desktopReads.push(id); return id === desktopEntry.id ? Buffer.from(payload).toString('base64') : null; },
} };
const offlineStore = new Store();
const offlineApi = new ServerApi(base, offlineStore, 25);
assert.deepEqual(await offlineApi.downloadChart(offlineHash), payload, 'server hash resolves the existing filename copy without a network connection');
assert.ok(desktopReads.includes(desktopEntry.id), 'desktop bridge reads the existing offline file');
assert.deepEqual(await offlineStore.getChartBytes(desktopEntry.id), payload, 'original filename IDs remain readable');
assert.equal(await offlineStore.getChartBytes('a'.repeat(40)), null, 'unknown content cannot read another local chart');
console.log('PASS Windows content-hash aliases use existing local downloads while the server is offline');
