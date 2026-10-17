// Real client/server score sync, durable queue, account boundaries and rating progression.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { ServerApi } from '../src/api/client.ts';
import { ScoreSync } from '../src/api/score-sync.ts';
import { Store } from '../src/core/store.ts';
import { computePP, computeRating, RATING_WEIGHT } from '../src/core/rating.ts';
import { buildNFM } from '../src/core/nfm.ts';
import { sha1Hex } from '../src/core/zip.ts';
import { ResultScreen } from '../src/ui/screens/result.ts';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const output = path.resolve('test-results/score-sync'); fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(output, 'repository-'));
Object.assign(process.env, { NF_DATA_DIR: data, NF_SEED_DIR: path.join(data, 'no-seed'), HOST: '127.0.0.1', PORT: '0', NF_UPLOADS: 'authenticated' });
const require = createRequire(import.meta.url);
const { server } = require('../server/server.js');
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let sync;
try {
  assert.equal(computeRating([100]), Math.round(100 / RATING_WEIGHT * 100) / 100);
  assert.ok(computeRating([100]) < 6, 'one best play fills only one of 100 fixed weighted slots');
  assert.equal(computeRating(Array(100).fill(100)), 100);
  assert.equal(computeRating(Array(120).fill(100)), 100, 'scores below top 100 cannot farm rating');
  assert.equal(computeRating([NaN, Infinity, -50, 0, 100]), computeRating([100]));
  assert.equal(computePP(8, .8, 120000), 0);
  assert.ok(computePP(8, .9, 120000) < computePP(8, 1, 120000) * .26);
  console.log('PASS osu decay, fixed portfolio denominator, top-100 cap and stricter accuracy curve');

  const api = new ServerApi(base), store = new Store();
  const auth = await api.register('sync_test', 'Sync test', 'test-only-password', 'sync@example.invalid');
  store.setToken(auth.token);
  store.createLocalProfile('local_test', 'Local', '');
  const app = { server: api, store, settings: { serverUrl: base }, centralLibrary: false, serverOnline: true, account: { server: true, user: auth.user }, screen: { name: 'result' }, toast() {} };
  sync = new ScoreSync(app);
  const chart = {
    format: 'neonfall-chart', version: 1, keys: 4, od: 8, stars: 8, offset: 0,
    meta: { title: 'Sync chart', artist: 'Test', creator: 'Test', version: '4K test', audio: 'audio.wav', audioLeadIn: 0, previewTime: 0, lengthMs: 120000 },
    timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [], notes: Array.from({ length: 10 }, (_, i) => ({ t: 1000 + i * 500, col: i % 4 })),
  };
  const bytes = buildNFM(chart, { 'audio.wav': new Uint8Array(64) });
  const chartId = await sha1Hex(bytes);
  const result = { chartId, keys: 4, score: 30000, acc: 1, maxCombo: 10, counts: { perfect: 10, great: 0, good: 0, ok: 0, bad: 0, miss: 0, holdTicks: 0 }, stars: 8, pp: 999999, grade: 'SS', passed: true, mods: [], playedAt: Date.now(), title: chart.meta.title, version: chart.meta.version, durationMs: 120000 };

  // A private local chart is queued without being automatically published.
  const initial = sync.submit({ ...result });
  assert.equal(initial.rating, 0);
  assert.equal(sync.pendingCount, 1);
  await sync.sync();
  assert.equal(sync.status(result).state, 'missing-chart');
  assert.equal((await api.listCharts()).length, 0);
  await api.uploadChart(bytes, 'sync.nfm');
  await sync.sync();
  assert.equal(sync.pendingCount, 0);
  assert.equal(sync.status(result).state, 'synced');
  assert.equal(app.account.user.rating, computeRating([computePP(8, 1, 120000)]));

  // Desktop bundled charts keep filename IDs locally, while the API uses SHA1.
  const originalRead = store.getChartBytes.bind(store);
  store.getChartBytes = async id => id === 'seed-chart-file-name' ? bytes : originalRead(id);
  const legacyResult = { ...result, chartId: 'seed-chart-file-name', playedAt: result.playedAt + 1 };
  sync.submit(legacyResult); await sync.sync();
  assert.equal(sync.status(legacyResult).state, 'synced', 'desktop filename ID resolves to existing server chart');
  assert.equal(legacyResult.chartId, 'seed-chart-file-name', 'local score identity remains intact');
  assert.equal((await api.myScores()).filter(score => score.chartId === chartId).length, 1, 'content aliases cannot add duplicate rating slots');
  console.log('PASS desktop filename IDs synchronize using content hashes without changing local identities');
  const resultScreen = new ResultScreen(app);
  resultScreen.result = legacyResult;
  resultScreen.entry = { id: legacyResult.chartId };
  await resultScreen.loadLeaderboard();
  assert.equal(resultScreen.leaderboard.length, 1, 'legacy filename result loads the content-hash leaderboard');
  assert.equal(resultScreen.leaderboard[0].username, 'sync_test');
  const realScores = api.scores.bind(api);
  let resolveScores, scoresStarted;
  const scoresRequest = new Promise(resolve => { scoresStarted = resolve; });
  api.scores = () => { scoresStarted(); return new Promise(resolve => { resolveScores = resolve; }); };
  const delayedLeaderboard = resultScreen.loadLeaderboard();
  await scoresRequest;
  resultScreen.leave();
  resultScreen.leaderboard = [];
  resolveScores([{ username: 'stale' }]);
  await delayedLeaderboard;
  assert.deepEqual(resultScreen.leaderboard, [], 'leaving the result screen ignores stale leaderboard replies');
  api.scores = realScores;
  console.log('PASS legacy result leaderboard mapping and stale-response guard');
  assert.equal((await api.myScores())[0].pp, computePP(8, 1, 120000));
  console.log('PASS immediate durable score queue, private-chart boundary, server ACK and profile refresh');

  const originalRating = app.account.user.rating;
  const replay = { ...result, playedAt: result.playedAt + 1 };
  sync.submit(replay);
  for (let i = 0; i < 200 && sync.status(replay)?.state !== 'synced'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sync.status(replay)?.state, 'synced', 'finish-event submission works without a manual sync call');
  assert.equal(app.account.user.rating, originalRating, 'replaying the same chart cannot farm rating');
  const auto = { ...result, mods: ['Auto'], playedAt: result.playedAt + 2 };
  const failed = { ...result, passed: false, playedAt: result.playedAt + 3 };
  sync.submit(auto); sync.submit(failed);
  assert.equal(auto.pp, 0); assert.equal(failed.pp, 0);
  assert.equal(store.getBest(chartId).mods.length, 0, 'Auto never replaces a ranked local best');
  assert.equal(store.getBest(chartId).passed, true, 'failure never replaces a ranked local best');
  assert.equal(store.getProfile().rating, originalRating);
  console.log('PASS repeat deduplication, old pp recalculation and failed/Auto exclusion locally and online');

  const second = buildNFM({ ...chart, meta: { ...chart.meta, title: 'Outage chart' } }, { 'audio.wav': new Uint8Array(64) });
  const secondEntry = await api.uploadChart(second, 'outage.nfm');
  const retry = { ...result, chartId: secondEntry.id, playedAt: result.playedAt + 4 };
  const realSubmit = api.submitScore.bind(api);
  api.submitScore = async () => { throw new Error('simulated network outage'); };
  sync.submit(retry);
  await sync.sync();
  assert.equal(sync.pendingCount, 1);
  assert.equal(app.account.server, true);
  assert.equal(app.serverOnline, false);
  assert.equal(store.getToken(), auth.token);
  assert.equal(store.getBest(secondEntry.id).passed, true, 'outage never loses local result');
  sync.stop();
  app.account = { server: false, user: store.getProfile() };
  sync = new ScoreSync(app);
  sync.restoreCachedAccount();
  assert.equal(app.account.user.username, 'sync_test', 'offline restart restores signed-in identity');
  assert.equal(sync.pendingCount, 1, 'pending result survives application restart');
  api.submitScore = realSubmit;

  const other = await api.register('other_test', 'Other', 'test-only-password', 'other@example.invalid');
  store.setToken(other.token); app.account = { server: true, user: other.user };
  await sync.sync();
  assert.equal((await api.myScores()).length, 0, 'pending results never move to another account');
  const login = await api.login('sync_test', 'test-only-password'); store.setToken(login.token);
  app.account = { server: true, user: login.user };
  await sync.sync();
  assert.equal(sync.pendingCount, 0);
  assert.equal((await api.myScores()).length, 2);
  assert.equal(app.account.user.rating, computeRating([computePP(8, 1, 120000), computePP(8, 1, 120000)]));
  console.log('PASS restart recovery, automatic retry and account-isolated synchronization');

  // Server identity is part of queue ownership even if two addresses reach the same host.
  api.submitScore = async () => { throw new Error('outage'); };
  const later = { ...retry, playedAt: result.playedAt + 5, score: 31000 };
  sync.submit(later); await sync.sync();
  const originalBase = api.base; api.base += '/different-server';
  let crossServerSubmits = 0;
  const realMe = api.me.bind(api); api.me = async () => login.user;
  api.submitScore = async () => { crossServerSubmits++; return { ok: true, rating: 999 }; };
  await sync.sync();
  assert.equal(crossServerSubmits, 0);
  api.base = originalBase; api.me = realMe;

  let release, started;
  const requested = new Promise(resolve => { started = resolve; });
  api.submitScore = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const stale = sync.sync(); await requested;
  store.setToken(''); api.setToken(''); app.account = { server: false, user: null };
  release({ ok: true, rating: 999 }); await stale;
  assert.equal(app.account.server, false);
  assert.equal(app.account.user, null, 'late response cannot sign the user back in');
  console.log('PASS server isolation and logout during in-flight upload');

  const legacyData = fs.mkdtempSync(path.join(output, 'legacy-'));
  fs.mkdirSync(path.join(legacyData, 'charts'));
  fs.writeFileSync(path.join(legacyData, 'charts', chartId + '.nfm'), bytes);
  fs.writeFileSync(path.join(legacyData, 'users.json'), JSON.stringify({ legacy_test: { username: 'legacy_test', nickname: 'Legacy', rating: 9999, bestPp: 9999 } }));
  fs.writeFileSync(path.join(legacyData, 'scores.json'), JSON.stringify([{ ...result, username: 'legacy_test', pp: 9999 }, { ...auto, username: 'legacy_test', pp: 9999 }]));
  process.env.NF_DATA_DIR = legacyData;
  delete require.cache[require.resolve('../server/server.js')];
  const migrated = require('../server/server.js').server;
  try {
    if (!migrated.listening) await once(migrated, 'listening');
    const migratedApi = new ServerApi(`http://127.0.0.1:${migrated.address().port}`);
    assert.equal((await migratedApi.leaderboard())[0].rating, computeRating([computePP(8, 1, 120000)]));
    const saved = JSON.parse(fs.readFileSync(path.join(legacyData, 'scores.json'), 'utf8'));
    assert.equal(saved[0].playedAt, result.playedAt, 'migration preserves score timestamps');
    assert.deepEqual(saved[0].counts, result.counts, 'migration preserves judgments');
    assert.equal(saved[1].pp, 0, 'historical Auto result is excluded during migration');
    console.log('PASS old server rating migration preserves scores and removes unranked pp');
  } finally {
    migrated.closeAllConnections(); await new Promise(resolve => migrated.close(resolve));
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checked: ['rating-weights', 'accuracy-curve', 'durable-queue', 'automatic-finish-trigger', 'server-ack', 'repeat-dedup', 'unranked-filter', 'offline-restart', 'account-isolation', 'server-isolation', 'logout-race', 'legacy-rating-migration'], testedAt: new Date().toISOString() }, null, 2));
} finally {
  sync?.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
