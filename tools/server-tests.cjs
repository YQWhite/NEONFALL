'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { zipSync, strToU8 } = require('fflate');
const ROOT = path.resolve(__dirname, '..');
const runDir = fs.mkdtempSync(path.join(ROOT, 'test-results', 'server-'));
let dataDir = path.join(runDir, 'data'); const distDir = path.join(runDir, 'dist');
fs.mkdirSync(distDir); fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>NEONFALL test</title>');
const adminToken = crypto.randomBytes(32).toString('hex');
let child, base, token = '', checks = 0, output = '';
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
async function start(seedDir = path.join(runDir, 'no-seed')) {
  Object.assign(process.env, { HOST: '127.0.0.1', PORT: '0', NF_DATA_DIR: dataDir, NF_DIST_DIR: distDir, NF_SEED_DIR: seedDir, NF_ADMIN_TOKEN: adminToken, NF_CORS_ORIGINS: 'https://example.test', NF_MAX_UPLOAD_MB: '1', NF_UPLOADS: '', SMTP_HOST: '', NF_TRUST_PROXY: '' });
  const modulePath = require.resolve('../server/server.js'); delete require.cache[modulePath]; child = require(modulePath).server;
  await new Promise((resolve, reject) => { child.once('listening', resolve); child.once('error', reject); }); base = 'http://127.0.0.1:' + child.address().port;
}
async function stop() { if (!child || !child.listening) return; await new Promise(resolve => { child.close(resolve); child.closeAllConnections(); }); }
async function req(url, method = 'GET', body, auth = token, raw = false) {
  const headers = auth ? { Authorization: 'Bearer ' + auth } : {};
  if (body && !Buffer.isBuffer(body)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const response = await fetch(base + url, { method, headers, body });
  const data = raw ? Buffer.from(await response.arrayBuffer()) : await response.json(); return { status: response.status, data, headers: response.headers };
}
function chart(title = 'Integration', hold = true) {
  const c = { format: 'neonfall-chart', version: 1, meta: { title, artist: 'Test', creator: 'Test', version: '4K', audio: 'audio.ogg', lengthMs: 2000 }, keys: 4, notes: hold ? [{ t: 0, col: 0, end: 1000 }] : [{ t: 0, col: 0 }], timing: [{ t: 0, bpm: 120 }], sv: [], stars: 5 };
  return zipSync({ 'chart.nf': strToU8(JSON.stringify(c)), 'audio.ogg': new Uint8Array([1, 2, 3]) });
}
async function run() {
  await start();
  check((await req('/api/ping')).data.uploadPolicy, 'authenticated', 'upload policy');
  check((await req('/api/not-found')).status, 404, 'unknown API is JSON 404');
  check((await req('/missing.js', 'GET', undefined, '', true)).status, 404, 'missing static file');
  const html = await req('/', 'GET', undefined, '', true); check(html.status, 200, 'web host'); check(html.data.includes(Buffer.from('NEONFALL test')), true, 'serves configured dist');
  const cors = await fetch(base + '/api/ping', { headers: { Origin: 'https://example.test' } }); check(cors.headers.get('access-control-allow-origin'), 'https://example.test', 'CORS allowed');
  const blocked = await fetch(base + '/api/ping', { headers: { Origin: 'https://other.test' } }); check(blocked.headers.get('access-control-allow-origin'), null, 'CORS other origin');
  const nfm = Buffer.from(chart()), id = crypto.createHash('sha1').update(nfm).digest('hex');
  check((await req('/api/charts/upload', 'POST', nfm, '')).status, 401, 'anonymous upload denied');
  check((await req('/api/register', 'POST', { username: 'constructor', nickname: 'bad', email: 'test@example.test', password: 'integration-test-password' }, '')).status, 409, 'reserved username');
  const register = await req('/api/register', 'POST', { username: 'PlayerOne', nickname: 'Nickname One', email: 'test@example.test', password: 'integration-test-password' }, ''); check(register.status, 201, 'registration'); token = register.data.token;
  check((await req('/api/register', 'POST', { username: 'playerone', nickname: 'duplicate', email: 'test@example.test', password: 'integration-test-password' }, '')).status, 409, 'case insensitive duplicate');
  check((await req('/api/me')).data.username, 'PlayerOne', 'current user');
  check((await req('/api/verify-email/send', 'POST')).status, 503, 'unconfigured mail is truthful');
  check((await req('/api/charts/upload', 'POST', Buffer.from('invalid zip'))).status, 400, 'invalid zip denied'); check(fs.readdirSync(path.join(dataDir, 'charts')).length, 0, 'invalid zip never persisted');
  const uploaded = await req('/api/charts/upload', 'POST', nfm); check(uploaded.status, 201, 'valid upload'); check(uploaded.data.id, id, 'content hash ID'); check(uploaded.data.entry.canDelete, true, 'owner permission');
  check((await req('/api/charts/upload', 'POST', nfm)).data.duplicate, true, 'deduplication');
  const download = await req('/api/charts/' + id, 'GET', undefined, '', true); check(download.data.equals(nfm), true, 'download exact bytes'); check(download.headers.get('etag'), '"' + id + '"', 'download ETag');
  check((await fetch(base + '/api/charts/' + id, { headers: { 'If-None-Match': '"' + id + '"' } })).status, 304, 'download cache');
  check((await req('/api/charts/' + id, 'DELETE', undefined, '')).status, 401, 'anonymous deletion denied');
  const second = await req('/api/register', 'POST', { username: 'PlayerTwo', nickname: 'Other', email: 'other@example.test', password: 'integration-test-password' }, '');
  check((await req('/api/charts/' + id, 'DELETE', undefined, second.data.token)).status, 403, 'other user deletion denied');
  check((await req('/api/charts/%2e%2e%2fusers', 'DELETE')).status, 400, 'path traversal rejected');
  const score = { chartId: id, keys: 4, score: 1000, acc: 1, maxCombo: 21, counts: { perfect: 21, great: 0, good: 0, ok: 0, bad: 0, miss: 0, holdTicks: 19 }, passed: true, mods: [], pp: 999999, stars: 999999 };
  const submitted = await req('/api/scores', 'POST', score); check(submitted.status, 200, 'hold judgments and ticks accepted'); check(submitted.data.rating < 100, true, 'server recalculates pp');
  const leaderboard = await req('/api/scores?chart=' + id + '&keys=4'); check(leaderboard.data[0].nickname, 'Nickname One', 'nickname case lookup');
  check((await req('/api/scores', 'POST', { ...score, acc: .5 })).status, 400, 'forged accuracy rejected');
  check((await req('/api/scores', 'POST', { ...score, score: 999999999 })).status, 400, 'impossible score rejected');
  check((await req('/api/scores', 'POST', { ...score, counts: { ...score.counts, holdTicks: 99 } })).status, 400, 'impossible hold ticks rejected');
  const userFile = fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'); check(userFile.includes(token), false, 'session token is hashed at rest'); check(userFile.includes('integration-test-password'), false, 'password is hashed at rest');
  await stop(); await start(); check((await req('/api/me')).status, 200, 'session survives restart'); check((await req('/api/scores/mine')).data.length, 1, 'score survives restart');
  const login = await req('/api/login', 'POST', { username: 'PLAYERONE', password: 'integration-test-password' }, ''); check(login.status, 200, 'case insensitive login'); check((await req('/api/me')).status, 401, 'old token revoked on login'); token = login.data.token;
  check((await req('/api/charts/' + id, 'DELETE')).status, 200, 'owner deletion after restart');
  const seeded = await req('/api/charts/upload', 'POST', Buffer.from(chart('Admin', false)), adminToken); check(seeded.status, 201, 'admin upload');
  check((await req('/api/charts/' + seeded.data.id, 'DELETE')).status, 403, 'admin chart cannot be deleted by user'); check((await req('/api/charts/' + seeded.data.id, 'DELETE', undefined, adminToken)).status, 200, 'admin deletion');
  check((await req('/api/logout', 'POST')).status, 200, 'logout'); check((await req('/api/me')).status, 401, 'logged out session invalid');
  const large = await req('/api/charts/upload', 'POST', Buffer.alloc(1024 * 1024 + 1), adminToken); check(large.status, 413, 'upload size limited with JSON response');
  await stop();
  dataDir = path.join(runDir, 'seed-data'); token = '';
  const seedDir = path.resolve(ROOT, '..', 'samples-converted');
  if (fs.existsSync(seedDir)) {
    await start(seedDir); const entries = (await req('/api/charts')).data;
    check(entries.length, fs.readdirSync(seedDir).filter(f => f.endsWith('.nfm')).length, 'all bundled charts seeded');
    for (const e of entries) { const bytes = (await req('/api/charts/' + e.id, 'GET', undefined, '', true)).data; check(crypto.createHash('sha1').update(bytes).digest('hex'), e.id, 'real seeded chart download'); }
    await stop(); await start(seedDir); check((await req('/api/charts')).data.length, entries.length, 'seed restart is idempotent'); await stop();
  }
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({ ok: true, checks, dataDir, note: 'isolated test database; no live user data or SMTP service used' }, null, 2));
  console.log('Server integration: ' + checks + ' checks passed. Report: ' + path.relative(ROOT, path.join(runDir, 'report.json')));
}
run().catch(async e => { console.error(e.stack || e); await stop(); process.exitCode = 1; });
