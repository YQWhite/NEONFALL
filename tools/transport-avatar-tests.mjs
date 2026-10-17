// Real HTTP integration in isolated storage; no live accounts or remote writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createCanvas } from '@napi-rs/canvas';
import { zipSync, strToU8 } from 'fflate';
import { ServerApi } from '../src/api/client.ts';

const require = createRequire(import.meta.url);
const { inspectAvatar, MAX_AVATAR_BYTES } = require('../server/avatar.js');
const output = path.resolve('test-results/transport-avatar'); fs.mkdirSync(output, { recursive: true });
const run = fs.mkdtempSync(path.join(output, 'test-'));
const check = (value, expected, message) => { assert.deepEqual(value, expected, message); checks++; };
let checks = 0, server, base;
const nativeFetch = globalThis.fetch;
const picture = createCanvas(128, 128), ctx = picture.getContext('2d');
ctx.fillStyle = '#77a8b9'; ctx.fillRect(0, 0, 128, 128); ctx.fillStyle = '#ebf1e4'; ctx.fillRect(32, 24, 64, 80);
const png = picture.toBuffer('image/png'), jpeg = picture.toBuffer('image/jpeg'), webp = picture.toBuffer('image/webp');
for (const [bytes, mime, ext] of [[png, 'image/png', 'png'], [jpeg, 'image/jpeg', 'jpg'], [webp, 'image/webp', 'webp']]) {
  check(inspectAvatar(bytes, mime), { mime, ext, width: 128, height: 128 }, 'actual raster dimensions and type');
}
assert.throws(() => inspectAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'), /PNG, JPEG or WebP/); checks++;
assert.throws(() => inspectAvatar(png, 'image/jpeg'), /does not match/); checks++;
assert.throws(() => inspectAvatar(png.subarray(0, -1), 'image/png'), /PNG/); checks++;
assert.throws(() => inspectAvatar(webp.subarray(0, -1), 'image/webp'), /WebP/); checks++;
const huge = Buffer.from(png); huge.writeUInt32BE(65535, 16);
assert.throws(() => inspectAvatar(huge, 'image/png'), /dimensions/); checks++;
assert.throws(() => inspectAvatar(Buffer.alloc(MAX_AVATAR_BYTES + 1), 'image/png'), error => error.status === 413); checks++;

Object.assign(process.env, { HOST: '127.0.0.1', PORT: '0', NF_DATA_DIR: path.join(run, 'data'), NF_DIST_DIR: path.join(run, 'dist'), NF_SEED_DIR: path.join(run, 'no-seed'), NF_CORS_ORIGINS: '', NF_ADMIN_TOKEN: '', SMTP_HOST: '' });
async function start() {
  const module = require.resolve('../server/server.js'); delete require.cache[module];
  server = require(module).server; if (!server.listening) await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
}
async function stop() { if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
async function request(route, method = 'GET', body, token, mime) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token;
  if (mime) headers['Content-Type'] = mime;
  else if (body) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const response = await nativeFetch(base + route, { method, headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
try {
  await start();
  const api = new ServerApi(base);
  check(await api.ping(), true, 'server identity'); check(api.avatarsEnabled, true, 'avatar capability');
  check((await nativeFetch(base + '/api/ping')).headers.get('vary'), 'Origin', 'no-Origin response still varies by Origin');
  const preflight = await nativeFetch(base + '/api/me/avatar', { method: 'OPTIONS', headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  check(preflight.status, 204, 'native avatar preflight'); assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/); checks++;
  const first = await api.register('AvatarOne', 'First avatar', 'test-only-password', 'first@example.invalid');
  const other = new ServerApi(base), second = await other.register('AvatarTwo', 'Other avatar', 'test-only-password', 'second@example.invalid');
  check((await request('/api/me/avatar', 'PUT', png, '', 'image/png')).status, 401, 'anonymous upload denied');
  check((await request('/api/me/avatar', 'DELETE')).status, 401, 'anonymous removal denied');
  check((await request('/api/me/avatar', 'PUT', Buffer.from('<svg/>'), first.token, 'image/svg+xml')).status, 415, 'SVG rejected');
  check((await request('/api/me/avatar', 'PUT', png, first.token, 'image/jpeg')).status, 415, 'forged MIME rejected');
  check((await request('/api/me/avatar', 'PUT', Buffer.alloc(MAX_AVATAR_BYTES + 1), first.token, 'image/png')).status, 413, 'HTTP size limit');
  check((await request('/api/me/avatar', 'PUT', huge, first.token, 'image/png')).status, 400, 'dimension limit');
  const uploaded = await request('/api/me/avatar', 'PUT', png, first.token, 'image/png');
  check(uploaded.status, 200, 'authenticated upload'); check(uploaded.body.username, 'AvatarOne', 'avatar bound to authenticated account');
  const firstPath = uploaded.body.avatar; assert.match(firstPath, /^\/api\/avatars\/avatarone\/[a-f0-9]{64}\.png$/); checks++;
  check((await api.me()).avatar, firstPath, 'profile contains stable avatar URL'); check((await other.me()).avatar, undefined, 'other user unchanged');
  const publicImage = await nativeFetch(base + firstPath, { headers: { Origin: 'neonfall://index.html' } });
  check(Buffer.from(await publicImage.arrayBuffer()).equals(png), true, 'public download exact bytes');
  check(publicImage.headers.get('content-type'), 'image/png', 'image MIME'); check(publicImage.headers.get('access-control-allow-origin'), '*', 'avatar public CORS');
  assert.match(publicImage.headers.get('cache-control'), /immutable/); checks++;
  check((await request('/api/avatars/AvatarOne/avatar', 'PUT', jpeg, second.token, 'image/jpeg')).status, 404, 'no endpoint to mutate another user');
  await request('/api/me/avatar', 'PUT', webp, second.token, 'image/webp'); check((await api.me()).avatar, firstPath, 'other user upload isolated');
  await stop(); await start();
  const recovered = new ServerApi(base); recovered.setToken(first.token);
  check((await recovered.me()).avatar, firstPath, 'avatar and login persist after restart');
  check((await nativeFetch(base + firstPath)).status, 200, 'avatar bytes persist after restart');
  const replacement = await request('/api/me/avatar', 'POST', jpeg, first.token, 'image/jpeg');
  check(replacement.status, 200, 'POST upload compatibility alias'); assert.notEqual(replacement.body.avatar, firstPath); checks++;
  check((await nativeFetch(base + firstPath)).status, 404, 'replaced image removed');
  check(fs.readdirSync(path.join(run, 'data/avatars/avatarone')).length, 1, 'one avatar stored per user');
  check((await recovered.leaderboard()).find(user => user.username === 'AvatarOne').avatar, replacement.body.avatar, 'public profile provides avatar');
  check((await request('/api/me/avatar', 'DELETE', undefined, first.token)).body.avatar, undefined, 'removal clears profile');
  check((await nativeFetch(base + replacement.body.avatar)).status, 404, 'removed image inaccessible');
  check((await recovered.me()).avatar, undefined, 'removal persisted');
  const chart = { format: 'neonfall-chart', version: 1, meta: { title: 'Cache', artist: 'Test', creator: 'Test', version: '4K', audio: 'audio.ogg', lengthMs: 2000 }, keys: 4, notes: [{ t: 1000, col: 0 }], timing: [], sv: [], stars: 1 };
  const nfm = zipSync({ 'chart.nf': strToU8(JSON.stringify(chart)), 'audio.ogg': new Uint8Array([1]) });
  const entry = await recovered.uploadChart(nfm, 'cache.nfm');
  for (const origin of ['', 'neonfall://index.html', 'https://localhost', 'https://different-web.example']) {
    const response = await nativeFetch(base + '/api/charts/' + entry.id, { headers: origin ? { Origin: origin } : {} });
    check(response.headers.get('access-control-allow-origin'), '*', 'public binary origin independent: ' + origin);
    check(response.headers.get('vary'), 'Origin', 'proxy variation for all requests');
    check(createHash('sha1').update(Buffer.from(await response.arrayBuffer())).digest('hex'), entry.id, 'download integrity');
  }
} finally { await stop(); }

// An old reverse proxy cached a bare URL without CORS. Emulate browser CORS
// checks and show that all native/separate-web origins avoid this stale entry.
const requests = [], payload = Buffer.from('content-addressed sample');
const proxy = http.createServer((req, res) => {
  requests.push(req.url); const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('nf_origin') === req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Content-Type', 'application/octet-stream'); res.end(payload);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyBase = 'http://127.0.0.1:' + proxy.address().port;
const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
try {
  for (const origin of ['neonfall://index.html', 'https://localhost', 'null', 'https://separate-web.example']) {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
    globalThis.fetch = async (url, options = {}) => {
      const headers = new Headers(options.headers); headers.set('Origin', origin);
      const response = await nativeFetch(url, { ...options, headers });
      if (!['*', origin].includes(response.headers.get('access-control-allow-origin'))) throw new TypeError('Failed to fetch');
      return response;
    };
    await assert.rejects(fetch(proxyBase + '/api/charts/example'), /Failed to fetch/); checks++;
    check(Buffer.from(await new ServerApi(proxyBase).downloadChart('example')).equals(payload), true, 'origin-keyed URL bypasses old CORS-less proxy response');
    check(new URL(requests.at(-1), proxyBase).searchParams.get('nf_origin'), origin, 'cache identity includes client origin');
  }
} finally {
  globalThis.fetch = nativeFetch;
  if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete globalThis.location;
  await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
}
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ ok: true, checks, testedAt: new Date().toISOString(), isolatedData: run, coverage: ['real raster validation', 'authentication and account ownership', 'restart persistence', 'replace/delete cleanup', 'public image and chart CORS', 'old reverse-proxy cache regression'] }, null, 2));
console.log(`PASS transport/avatar: ${checks} checks; isolated HTTP server and stale reverse-proxy cache regression`);
