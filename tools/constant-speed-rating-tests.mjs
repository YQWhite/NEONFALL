import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import http from 'node:http';
import { createCanvas } from '@napi-rs/canvas';
import { computePP, computeRating, resultPP, isRankedResult } from '../src/core/rating.ts';
import { buildNFM } from '../src/core/nfm.ts';
import { sha1Hex } from '../src/core/zip.ts';
import { Store } from '../src/core/store.ts';
import { ApiError, ServerApi } from '../src/api/client.ts';
import { ScoreSync } from '../src/api/score-sync.ts';
import { ResultScreen } from '../src/ui/screens/result.ts';
import { AccountScreen } from '../src/ui/screens/account.ts';
import { UI } from '../src/ui/widgets.ts';
import { modsLabel } from '../src/ui/mod-labels.ts';
import { setLanguage } from '../src/ui/i18n.ts';

const output = path.resolve('test-results/constant-speed'); fs.mkdirSync(output, { recursive: true });
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { documentElement: {}, activeElement: null, addEventListener() {}, removeEventListener() {}, body: { appendChild() {} },
  createElement(tag) { return tag === 'canvas' ? createCanvas(1, 1) : { tagName: tag.toUpperCase(), value: '', style: {}, addEventListener() {}, remove() {}, setAttribute() {}, focus() { document.activeElement = this; }, blur() { document.activeElement = null; } }; } };

const chart = { format: 'neonfall-chart', version: 1, keys: 4, od: 8, stars: 8, offset: 0,
  meta: { title: 'Constant speed test', artist: 'Test', creator: 'Test', version: '4K', audio: 'audio.wav', audioLeadIn: 0, previewTime: 0, lengthMs: 120000 },
  timing: [{ t: 0, bpm: 120 }, { t: 2000, bpm: 240 }], sv: [{ t: 2500, sv: .5 }], breaks: [],
  notes: Array.from({ length: 10 }, (_, i) => ({ t: 1000 + i * 500, col: i % 4 })) };
const bytes = buildNFM(chart, { 'audio.wav': new Uint8Array(64) }), chartId = await sha1Hex(bytes);
const result = { chartId, keys: 4, score: 30000, acc: 1, maxCombo: 10, counts: { perfect: 10, great: 0, good: 0, ok: 0, bad: 0, miss: 0, holdTicks: 0 },
  stars: 8, pp: 999999, grade: 'SS', passed: true, mods: ['ConstantSpeed'], playedAt: 1700000000000, title: chart.meta.title, version: '4K', durationMs: 120000 };
const normalPP = computePP(8, 1, 120000), constantPP = computePP(8, 1, 120000, ['ConstantSpeed']);
assert.equal(normalPP, 158.4); assert.equal(constantPP, 142.56);
assert.equal(computePP(8, 1, 120000, ['constantspeed', 'ConstantSpeed']), constantPP, 'duplicate/case variant only converts once');
assert.equal(resultPP(result), constantPP); assert.equal(isRankedResult(result), true);
for (const mod of ['Auto', 'Mirror', 'Random']) assert.equal(resultPP({ ...result, mods: ['ConstantSpeed', mod] }), 0);
assert.equal(resultPP({ ...result, passed: false }), 0);
const store = new Store(); store.createLocalProfile('cs_local', 'CS local', '');
assert.equal(store.submitLocalScore({ ...result }).rating, computeRating([constantPP]));
assert.equal(store.getBest(chartId).pp, constantPP, 'local store recomputes submitted pp');
const standard = { ...result, mods: [], score: 29000 };
assert.equal(store.submitLocalScore(standard).improved, true, 'best per chart compares converted pp');
assert.equal(store.submitLocalScore({ ...result, score: 31000 }).improved, false, 'raw CS score cannot replace better no-mod pp');
assert.equal(store.getBest(chartId).score, 29000);
console.log('PASS ConstantSpeed 90% pp, exclusions, duplicate handling and local best/rating comparison');

const require = createRequire(import.meta.url), serverPath = require.resolve('../server/server.js');
const data = fs.mkdtempSync(path.join(output, 'rating-repository-'));
Object.assign(process.env, { NF_DATA_DIR: data, NF_SEED_DIR: path.join(data, 'no-seed'), HOST: '127.0.0.1', PORT: '0', NF_UPLOADS: 'authenticated' });
const running = [];
async function start(directory) {
  process.env.NF_DATA_DIR = directory; delete require.cache[serverPath];
  const server = require(serverPath).server; running.push(server);
  if (!server.listening) await once(server, 'listening');
  return { server, api: new ServerApi(`http://127.0.0.1:${server.address().port}`) };
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); running.splice(running.indexOf(server), 1); }
let leaderboard;
try {
  const { server, api } = await start(data);
  await api.register('cs_user', 'Constant player', 'test-only-password', 'cs@example.invalid');
  await api.uploadChart(bytes, 'constant-speed.nfm');
  const accepted = await api.submitScore({ ...result, stars: 9999 });
  assert.equal(accepted.ranked, true); assert.equal(accepted.rating, computeRating([constantPP]));
  let saved = (await api.myScores())[0];
  assert.equal(saved.pp, constantPP, 'server ignores spoofed client pp and stars');
  assert.equal(saved.score, result.score); assert.equal(saved.acc, result.acc); assert.deepEqual(saved.counts, result.counts);
  assert.deepEqual((await api.scores(chartId, 4))[0].mods, ['ConstantSpeed']);
  for (const excluded of ['Auto', 'Mirror', 'Random']) {
    assert.equal((await api.submitScore({ ...result, mods: ['ConstantSpeed', excluded] })).ranked, false);
    assert.equal((await api.myScores())[0].pp, constantPP);
  }
  await api.submitScore({ ...standard });
  assert.equal((await api.myScores())[0].pp, normalPP);
  await api.submitScore({ ...result, score: 31000 });
  assert.deepEqual((await api.myScores())[0].mods, [], 'lower converted pp leaves original best intact');
  const second = new ServerApi(api.base);
  await second.register('cs_other', 'CS other', 'test-only-password', 'other@example.invalid');
  await second.submitScore({ ...result, score: 31000 });
  leaderboard = await second.scores(chartId, 4);
  assert.equal(leaderboard.length, 2); assert.deepEqual(leaderboard.map(row => row.mods), [['ConstantSpeed'], []]);
  assert.equal(leaderboard[0].score, 31000, 'leaderboard retains raw score');
  assert.ok((await second.leaderboard()).every(row => !Object.hasOwn(row, 'mods')), 'profile rating is not falsely attributed to one mod');
  await close(server);
  console.log('PASS actual HTTP ranked submission, authoritative conversion, exclusions, best replacement and per-play leaderboard mods');

  const legacyData = fs.mkdtempSync(path.join(output, 'rating-v2-'));
  fs.mkdirSync(path.join(legacyData, 'charts')); fs.writeFileSync(path.join(legacyData, 'charts', chartId + '.nfm'), bytes);
  fs.writeFileSync(path.join(legacyData, 'users.json'), JSON.stringify({ legacy_cs: { username: 'legacy_cs', nickname: 'Legacy', ratingVersion: 2, rating: 9999, bestPp: 9999 } }));
  fs.writeFileSync(path.join(legacyData, 'scores.json'), JSON.stringify([{ ...result, username: 'legacy_cs' }]));
  let migrated = await start(legacyData);
  assert.equal((await migrated.api.leaderboard())[0].rating, computeRating([constantPP]));
  saved = JSON.parse(fs.readFileSync(path.join(legacyData, 'scores.json'), 'utf8'))[0];
  assert.equal(saved.pp, constantPP); assert.equal(saved.playedAt, result.playedAt); assert.equal(saved.score, result.score);
  assert.deepEqual(saved.counts, result.counts); assert.deepEqual(saved.mods, result.mods);
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacyData, 'users.json'), 'utf8')).legacy_cs.ratingVersion, 3);
  await close(migrated.server); migrated = await start(legacyData);
  assert.equal((await migrated.api.leaderboard())[0].rating, computeRating([constantPP]), 'restarting never compounds the multiplier');
  await close(migrated.server);
  console.log('PASS persisted v2 migration and restart idempotence preserve raw scores, counts, mods and timestamps');
} finally { for (const server of [...running]) await close(server); }

// A hosted older server may accept unknown mods at full pp. A real HTTP fixture
// proves the client never POSTs CS until capability is upgraded, without holding
// back ordinary scores queued behind it or permanently rejecting the CS result.
storage.clear();
let fixtureVersion, pingCount = 0, holdPing, fixtureRating = 0;
const posted = [], fixtureBest = new Map();
const fixtureUser = () => ({ username: 'compat_user', nickname: 'Compatibility', email: '', rating: fixtureRating, bestPp: 0, plays: fixtureBest.size, createdAt: 1 });
const send = (response, body) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
const fixture = http.createServer(async (request, response) => {
  if (request.url === '/api/ping') {
    pingCount++;
    if (holdPing) { holdPing(response); return; }
    return send(response, { ok: true, name: 'neonfall-server', ratingVersion: fixtureVersion });
  }
  if (request.url === '/api/me') return send(response, fixtureUser());
  if (request.url === '/api/scores' && request.method === 'POST') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const score = JSON.parse(Buffer.concat(chunks)); posted.push(score);
    fixtureBest.set(score.chartId, fixtureVersion >= 3 ? resultPP(score) : computePP(score.stars, score.acc, score.durationMs));
    fixtureRating = computeRating([...fixtureBest.values()]);
    return send(response, { ok: true, ranked: true, rating: fixtureRating, rank: 1 });
  }
  response.writeHead(404); response.end();
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
let pendingSync;
try {
  const api = new ServerApi(`http://127.0.0.1:${fixture.address().port}`), store = new Store();
  store.setToken('fixture-token'); api.setToken(store.getToken());
  await assert.rejects(api.submitScore(result), error => error instanceof ApiError && error.status === 426);
  assert.equal(posted.length, 0, 'unknown/old capability prevents any CS score POST');
  assert.equal(api.ratingVersion, 0);
  const compatApp = { server: api, store, settings: { serverUrl: api.base }, centralLibrary: true, serverOnline: true,
    account: { server: true, user: fixtureUser() }, screen: { name: 'play' }, toast() {} };
  pendingSync = new ScoreSync(compatApp);
  const normal = { ...result, chartId: 'b'.repeat(40), mods: [], playedAt: result.playedAt + 1 };
  pendingSync.submit({ ...result }); pendingSync.submit(normal); await Promise.resolve();
  compatApp.screen.name = 'result'; await pendingSync.sync();
  assert.equal(pendingSync.status(result).state, 'update-required');
  assert.equal(pendingSync.status(normal).state, 'synced');
  assert.equal(pendingSync.pendingCount, 1);
  assert.deepEqual(posted.map(score => score.mods), [[]], 'normal score behind blocked CS still uploads');
  assert.equal(compatApp.serverOnline, true, 'old capability is not an outage');
  const preserved = JSON.parse(storage.get('nf.score-sync.v1')).pending[0];
  assert.equal(preserved.updateRequired, true); assert.notEqual(preserved.rejected, true);
  assert.equal(preserved.result.score, result.score); assert.deepEqual(preserved.result.counts, result.counts);
  pendingSync.stop(); pendingSync = new ScoreSync(compatApp);
  assert.equal(pendingSync.status(result).state, 'update-required', 'restart retains actionable pending status');
  fixtureVersion = 2; const previousPings = pingCount;
  pendingSync.start(); await pendingSync.sync();
  assert.ok(pingCount > previousPings, 'retry rechecks older capability');
  assert.equal(pendingSync.pendingCount, 1); assert.equal(posted.length, 1);
  fixtureVersion = 3; pendingSync.wake(); await pendingSync.sync();
  assert.equal(pendingSync.pendingCount, 0); assert.equal(pendingSync.status(result).state, 'synced');
  assert.equal(posted.length, 2); assert.deepEqual(posted[1].mods, ['ConstantSpeed']);
  assert.equal(posted[1].score, result.score); assert.equal(posted[1].acc, result.acc);
  assert.equal(posted[1].pp, constantPP, 'upgraded server gets original score with converted pp');
  assert.equal(compatApp.account.user.rating, computeRating([normalPP, constantPP]));
  pendingSync.stop();

  let resolvePing; const pingWaiting = new Promise(resolve => { resolvePing = resolve; });
  holdPing = resolvePing;
  const switchedApi = new ServerApi(api.base); switchedApi.setToken('first-fixture-token');
  const cancelled = switchedApi.submitScore(result); const response = await pingWaiting;
  switchedApi.setToken('second-fixture-token'); send(response, { ok: true, name: 'neonfall-server', ratingVersion: 3 });
  await assert.rejects(cancelled, /connection changed/);
  assert.equal(posted.length, 2, 'changing account during capability check cannot submit under new credentials');
  console.log('PASS old-server CS upload hold, normal-score progress, durable upgrade status, automatic retry after upgrade and account-switch race');
} finally { pendingSync?.stop(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }

setLanguage('en');
assert.equal(modsLabel(undefined), 'Mods unavailable'); assert.equal(modsLabel([]), 'NO MODS');
assert.equal(modsLabel(['ConstantSpeed', 'Hidden']), 'CONSTANT SPEED · HIDDEN');
let transitions = 0;
const app = { w: 1280, h: 800, settings: { serverUrl: '' }, serverOnline: true,
  account: { server: false, user: null }, server: { scores: async () => [], leaderboard: async () => [] },
  store: { getBestScores: () => ({}) }, canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
  animateViewChange(change) { transitions++; change(); }, gotoScreen() {}, uiSound() {} };
app.ui = new UI(app);
const textCalls = [];
function draw(screen, name) {
  const canvas = createCanvas(app.w, app.h), ctx = canvas.getContext('2d'); app.ctx = ctx;
  ctx.fillStyle = '#0d1218'; ctx.fillRect(0, 0, app.w, app.h); textCalls.length = 0;
  const fillText = ctx.fillText.bind(ctx); ctx.fillText = (value, ...args) => { textCalls.push(String(value)); fillText(value, ...args); };
  app.ui.beginFrame({ x: -1, y: -1, down: false }); screen.draw(ctx); app.ui.endFrame();
  if (name) fs.writeFileSync(path.join(output, name + '.png'), canvas.toBuffer('image/png'));
}
const summary = new ResultScreen(app); summary.result = { ...result, pp: constantPP }; summary.leaderboard = leaderboard;
summary.setLeaderboard(true); assert.equal(transitions, 1);
for (const [w, h] of [[1280, 800], [640, 400]]) {
  app.w = w; app.h = h; draw(summary, `rankings-${w}x${h}`);
  assert.ok(textCalls.includes('CONSTANT SPEED'), 'chart rankings show enabled mod');
  assert.ok(textCalls.includes('NO MODS'), 'chart rankings explicitly show no-mod play');
}
summary.setLeaderboard(false); assert.equal(transitions, 2); summary.setLeaderboard(false); assert.equal(transitions, 2, 'unchanged pane does not animate');
const account = new AccountScreen(app); account.myPlays = [{ ...result, pp: constantPP }];
account.changeMode('register'); assert.equal(transitions, 3); account.changeMode('login'); assert.equal(transitions, 4);
app.w = 1280; app.h = 800; draw(account); account.scroll = account.maxScroll; draw(account, 'account-mod-history');
assert.ok(textCalls.some(text => text.startsWith('CONSTANT SPEED')), 'personal history includes mods before difficulty text');
account.leave();
fs.writeFileSync(path.join(output, 'rating-tests.json'), JSON.stringify({ ok: true, normalPP, constantPP, checked: ['local-best', 'http-conversion', 'ranked-exclusions', 'leaderboard-mods', 'v2-migration', 'restart-idempotence', 'old-server-upload-hold', 'upgrade-auto-retry', 'capability-account-race', 'canvas-labels', 'pane-transitions'] }, null, 2));
console.log('PASS real Result/Account Canvas mod labels, older-server fallback and local-pane transition hooks');
