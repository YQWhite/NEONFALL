import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { buildNFM } from '../src/core/nfm.ts';
import { ServerApi, ApiError } from '../src/api/client.ts';
import { scoreFromCounts, accuracyFromCounts, gradeFromAccuracy } from '../src/core/scoring.ts';
import { computePP, computeRating } from '../src/core/rating.ts';
const require = createRequire(import.meta.url);
const serverRules = require('../server/scoring.js');
const { globalLeaderboard } = require('../server/community.js');
const output = path.resolve('test-results/v029'); fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, 'server-'));
let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const counts = (perfect = 0, great = 0, good = 0, ok = 0, bad = 0, miss = 0, holdTicks = 0) => ({ perfect, great, good, ok, bad, miss, holdTicks });
for (let n = 1; n <= 400; n++) {
  const c = counts(n % 13, n % 11, n % 7, n % 5, n % 3, n % 2, n % 17), total = Object.values(c).slice(0, 6).reduce((a, b) => a + b, 0);
  for (const mods of [[], ['NoTail'], ['ConstantSpeed'], ['NoTail', 'ConstantSpeed']]) {
    check(serverRules.scoreFromCounts(c, Math.max(1, total), mods), scoreFromCounts(c, Math.max(1, total), mods), 'client/server normalized score agreement');
    check(serverRules.accuracyFromCounts(c), accuracyFromCounts(c), 'client/server accuracy agreement');
    check(serverRules.gradeFromAccuracy(accuracyFromCounts(c)), gradeFromAccuracy(accuracyFromCounts(c)), 'client/server grade agreement');
  }
}
for (const acc of [0, .7, .700001, .8, .800001, .9, .900001, .95, .950001, 1]) check(serverRules.gradeFromAccuracy(acc), gradeFromAccuracy(acc), 'grade threshold boundaries');

Object.assign(process.env, { HOST: '127.0.0.1', PORT: '0', NF_DATA_DIR: directory, NF_DIST_DIR: path.join(directory, 'dist'), NF_SEED_DIR: path.join(directory, 'no-seed'), NF_UPLOADS: 'authenticated', SMTP_HOST: '' });
delete process.env.NF_ANNOUNCEMENT; delete process.env.NF_ANNOUNCEMENT_TITLE;
let server, oldServer;
const serverPath = require.resolve('../server/server.js');
async function start() { delete require.cache[serverPath]; server = require(serverPath).server; if (!server.listening) await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function stop(s) { if (!s?.listening) return; s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
const chart = { format: 'neonfall-chart', version: 1, keys: 4, od: 8, hp: 5, stars: 5, offset: 0,
  meta: { title: 'Community tests', artist: 'Synthetic', creator: 'Tests', version: '4K', audio: 'test.wav', audioLeadIn: 0, previewTime: 0, lengthMs: 4000 },
  timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [], notes: [{ t: 0, col: 0 }, { t: 500, col: 1, end: 1500 }, { t: 2000, col: 2 }] };
try {
  const base = await start(), api = new ServerApi(base);
  check(await api.ping(), true, 'ping'); check(api.serverVersion, require('../package.json').version, 'server version');
  check(api.scoreVersion, 2, 'score capability'); check(api.ratingVersion, 4, 'rating capability'); check(api.statisticsVersion, 1, 'statistics capability');
  check(api.announcement.title, '服务器公告', 'default announcement');
  fs.writeFileSync(path.join(directory, 'server-info.json'), JSON.stringify({ announcement: { title: '更新公告', body: '欢迎\n这是纯文本 <b>内容</b>', updatedAt: '2026-10-18' } }));
  await api.ping(); check(api.announcement.body, '欢迎\n这是纯文本 <b>内容</b>', 'announcement reloads without restart');
  fs.writeFileSync(path.join(directory, 'server-info.json'), '{'); check(await api.ping(), true, 'partially edited announcement does not disconnect API');
  check(api.announcement.title, '更新公告', 'invalid notice keeps last readable announcement');
  fs.writeFileSync(path.join(directory, 'server-info.json'), '{}');
  process.env.NF_ANNOUNCEMENT = 'Environment\\nAnnouncement'; await api.ping(); check(api.announcement.body, 'Environment\nAnnouncement', 'environment announcement newline'); delete process.env.NF_ANNOUNCEMENT;
  await api.register('community_a', 'Community A', 'test-password-only', 'a@example.invalid');
  const bytes = buildNFM(chart, { 'test.wav': new Uint8Array([1, 2, 3]) }), entry = await api.uploadChart(bytes, 'community.nfm'), chartId = entry.id;
  const make = (playId, c = counts(4, 0, 0, 0, 0, 0, 19), mods = [], passed = true) => ({ chartId, keys: 4, scoreVersion: 2, playId,
    score: scoreFromCounts(c, 4, mods), acc: accuracyFromCounts(c), counts: c, maxCombo: Math.min(4, c.perfect + c.great), mods, passed,
    stars: 999, pp: 99999, grade: 'SS', title: 'spoofed', version: 'spoofed', durationMs: 1, playedAt: 1 });
  check((await api.chartStats(chartId, 4)).passRate, null, 'unknown historical success rate is not invented');
  const perfect = make('attempt-perfect-001');
  check((await api.submitScore(perfect)).ranked, true, 'million point score accepted');
  check((await api.myScores())[0].pp, computePP(5, 1, 4000), 'server verifies chart difficulty and pp');
  check((await api.myScores())[0].score, 1000000, 'one million maximum');
  check((await api.scores(chartId, 4))[0].grade, 'SS', 'chart rank grade');
  const duplicate = await api.submitScore(perfect); check(duplicate.ok, true, 'retry acknowledged'); check((await api.chartStats(chartId, 4)).attempts, 1, 'retry not counted twice');
  await assert.rejects(api.submitScore({ ...perfect, counts: counts(0, 4, 0, 0, 0, 0, 19), score: 937500, acc: 300 / 305 }), error => error.status === 409); checks++;
  await api.submitScore(make('attempt-greats-002', counts(0, 4, 0, 0, 0, 0, 19)));
  await api.submitScore(make('attempt-notail-003', undefined, ['NoTail']));
  const failure = { ...make('attempt-failure-004', counts(1, 0, 0, 0, 0, 1, 0), [], false), failedAtMs: 1000 };
  check((await api.submitScore(failure)).ranked, false, 'failure accepted for statistics without rating');
  let stats = await api.chartStats(chartId, 4);
  check([stats.attempts, stats.passes, stats.passRate], [4, 3, .75], 'lower scores and failures all count');
  check(stats.failureBins[10], 1, 'failure at 25 percent uses proper bin'); check(stats.failureSamples, 1, 'failure sample count');
  check(stats.personalBest.score, 1000000, 'personal best returned');
  check((await api.myScores()).length, 1, 'attempt stats do not flood PB store');
  await api.submitScore(make('attempt-auto-005', undefined, ['Auto']));
  check((await api.chartStats(chartId, 4)).attempts, 4, 'unranked automatic attempts excluded');
  await assert.rejects(api.submitScore({ ...make('attempt-forged-006'), score: 999999 }), error => error.status === 400); checks++;
  await assert.rejects(api.submitScore({ ...make('attempt-forged-007', undefined, ['NoTail']), score: 1000000 }), error => error.status === 400); checks++;
  await assert.rejects(api.submitScore({ ...failure, playId: 'attempt-forged-008', failedAtMs: 4001 }), error => error.status === 400); checks++;
  const legacy = { ...perfect, scoreVersion: undefined, playId: undefined, counts: counts(23, 0, 0, 0, 0, 0, 19), score: 5000 };
  check((await api.submitScore(legacy)).ok, true, 'older clients remain supported');
  check((await api.scores(chartId, 4, 1))[0].score, 5000, 'old score independently readable');
  check((await api.scores(chartId, 4)).length, 1, 'old and new scores never share chart ranking');
  check((await api.chartStats(chartId, 4)).attempts, 4, 'unknown legacy attempt history not invented');
  const other = new ServerApi(base); await other.register('community_b', 'Community B', 'test-password-only', 'b@example.invalid');
  await other.submitScore(make('attempt-other-001', undefined, ['NoTail', 'ConstantSpeed']));
  check((await other.myScores())[0].pp, computePP(5, 1, 4000, ['NoTail', 'ConstantSpeed']), 'both mod pp conversions match client');
  check((await other.myScores())[0].score, 900000, 'NoTail score conversion');
  const board = await api.leaderboard('totalScore');
  check(board.map(row => [row.username, row.totalScore, row.clears]), [['community_a', 1000000, 1], ['community_b', 900000, 1]], 'total score uses best new score per difficulty');
  for (const metric of ['rating', 'bestPp', 'accuracy', 'clears']) {
    const rows = await api.leaderboard(metric); check(rows.length, 2, 'detailed ranking available');
    check(rows.every(row => !('email' in row) && !('token' in row) && !('counts' in row)), true, 'public ranking has no private account fields');
  }
  check((await new ServerApi(base).chartStats(chartId, 4)).personalBest, null, 'anonymous does not see a personal best');
  check((await api.me()).rating, computeRating([computePP(5, 1, 4000)]), 'legacy and new versions do not double rating');
  // Avatar forwarding and all metric orderings use the same pure aggregation as HTTP.
  const users = { a: { username: 'a', nickname: 'A', rating: 20, bestPp: 30 }, b: { username: 'b', nickname: 'B', rating: 10, bestPp: 50 } };
  const s = [{ username: 'a', chartId: 'one', keys: 4, scoreVersion: 2, score: 100, acc: .8, passed: true, mods: [] }, { username: 'b', chartId: 'one', keys: 4, scoreVersion: 2, score: 200, acc: .9, passed: true, mods: [] },
    { username: 'a', chartId: 'historical', keys: 4, score: 99999999, acc: 1, passed: true, mods: [] }];
  for (const [metric, first] of [['rating', 'a'], ['bestPp', 'b'], ['totalScore', 'b'], ['accuracy', 'b'], ['clears', 'a']]) {
    const rows = globalLeaderboard(users, s, metric, user => '/api/avatars/' + user.username); check(rows[0].username, first, 'metric sorting'); check(rows[0].avatar, '/api/avatars/' + first, 'avatars forwarded');
  }
  const aDetail = globalLeaderboard(users, s, 'accuracy', () => undefined).find(row => row.username === 'a');
  check([aDetail.totalScore, aDetail.accuracy, aDetail.clears], [100, .8, 1], 'detail metrics exclude all legacy results');
  await stop(server); const restarted = new ServerApi(await start());
  await restarted.login('community_a', 'test-password-only');
  const before = await restarted.chartStats(chartId, 4); await restarted.submitScore(perfect);
  check((await restarted.chartStats(chartId, 4)).attempts, before.attempts, 'receipt survives restart');
  check((await restarted.scores(chartId, 4))[0].score, 1000000, 'normalized score survives restart');

  let posted = 0;
  oldServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/ping')) return res.end(JSON.stringify({ ok: true, name: 'neonfall-server', version: '0.2.8', ratingVersion: 3 }));
    if (req.url.startsWith('/api/scores') && req.method === 'POST') posted++;
    if (req.url.startsWith('/api/scores')) return res.end(JSON.stringify([{ score: 99999999, username: 'old' }]));
    res.end(JSON.stringify([]));
  }).listen(0, '127.0.0.1'); await once(oldServer, 'listening');
  const oldApi = new ServerApi(`http://127.0.0.1:${oldServer.address().port}`);
  check(await oldApi.ping(), true, 'different version remains connected'); check(oldApi.serverVersion, '0.2.8', 'old server version visible');
  await assert.rejects(oldApi.submitScore(perfect), error => error instanceof ApiError && error.status === 426); checks++;
  check(posted, 0, 'new score is not sent to incompatible server'); check(oldApi.online, true, 'upload capability warning does not disconnect');
  check((await oldApi.scores(chartId, 4)).length, 0, 'legacy server cannot contaminate million-point table');
  check((await oldApi.scores(chartId, 4, 1)).length, 1, 'legacy table stays readable');
  check((await oldApi.leaderboard()).length, 0, 'legacy overall ranking still available');
  await assert.rejects(oldApi.leaderboard('totalScore'), error => error.status === 426); checks++;
  fs.writeFileSync(path.join(output, 'server-results.json'), JSON.stringify({ ok: true, checks, isolation: 'Temporary synthetic local database and HTTP server only; no real account, SMTP or remote service accessed.' }, null, 2));
  console.log(`PASS server v0.2.9: ${checks} checks`);
} finally { await stop(server); await stop(oldServer); }
