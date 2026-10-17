// Exercise the actual API client, chart repository and gameplay score format
// together, using an isolated database and no audio hardware or browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { zipSync, strToU8 } from 'fflate';
import { ServerApi } from '../src/api/client.ts';
import { PlaySession } from '../src/engine/play.ts';
import { computePP, computeRating } from '../src/core/rating.ts';
import { DEFAULT_SETTINGS, DEFAULT_MODS } from '../src/core/types.ts';

const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
const run = fs.mkdtempSync(path.join(root, 'test-results', 'online-integration-'));
Object.assign(process.env, {
  HOST: '127.0.0.1', PORT: '0', NF_DATA_DIR: path.join(run, 'data'),
  NF_DIST_DIR: path.join(root, 'dist'), NF_SEED_DIR: path.join(run, 'no-seed'),
  NF_ADMIN_TOKEN: '', SMTP_HOST: '', NF_UPLOADS: 'authenticated', NF_CORS_ORIGINS: '',
});
const require = createRequire(import.meta.url);
const { server } = require('../server/server.js');
try {
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = new ServerApi(base);
  assert.equal(await api.ping(), true);
  for (const origin of ['neonfall://index.html', 'https://localhost']) {
    const preflight = await fetch(base + '/api/charts/upload', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  }
  await api.register('GameplayTest', 'Gameplay integration', 'local-test-password', 'gameplay@example.test');
  const chart = {
    format: 'neonfall-chart', version: 1, keys: 4, od: 8, offset: 0, stars: 5,
    meta: { title: 'Gameplay API integration', artist: 'Test', creator: 'Test', version: '4K', audio: 'audio.ogg', lengthMs: 3500 },
    notes: [{ t: 1000, col: 0, end: 2000 }, { t: 2500, col: 1 }],
    timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [],
  };
  const files = new Map([['audio.ogg', new Uint8Array([1, 2, 3])]]);
  const bytes = zipSync({ 'chart.nf': strToU8(JSON.stringify(chart)), 'audio.ogg': files.get('audio.ogg') });
  const entry = await api.uploadChart(bytes, 'Gameplay.nfm');
  chart.id = entry.id;
  assert.equal(entry.server, true);
  assert.deepEqual(await api.downloadChart(entry.id), bytes);
  let clock = 0, held = false;
  const audio = { songTimeMs: () => clock, playSynth() {}, pauseMusic() {}, stopMusic() {}, stopPreview() {}, playMusic() {} };
  const session = new PlaySession(chart, { chart, files }, { skin: null, getAsset: () => undefined },
    { ...DEFAULT_MODS, noFail: true }, { ...DEFAULT_SETTINGS, audioOffset: 0, inputOffset: 0, particles: false }, audio);
  session.phase = 'playing'; session.input.isDown = col => col === 0 && held;
  clock = 1000; held = true; session.press(0, clock);
  clock = 2000; held = false; session.release(0, clock);
  clock = 2500; session.press(1, clock);
  session.finish();
  const result = session.buildResult();
  assert.equal(result.counts.holdTicks, 19);
  assert.equal(result.counts.perfect, 22);
  assert.equal(result.acc, 1);
  const submitted = await api.submitScore(result);
  assert.equal(submitted.rating, computeRating([computePP(chart.stars, result.acc, chart.meta.lengthMs)]));
  assert.equal(submitted.rank, 1);
  const board = await api.scores(entry.id, 4);
  assert.equal(board[0].score, result.score);
  assert.equal(board[0].isSelf, true);
  const mine = await api.myScores();
  assert.deepEqual(mine[0].counts, result.counts);
  assert.equal(mine[0].pp, result.pp);
  assert.equal((await api.leaderboard())[0].rating, submitted.rating);
  for (const changed of [{ mods: ['Auto'] }, { passed: false }]) {
    const unranked = await api.submitScore({ ...result, ...changed, score: result.score + 1 });
    assert.equal(unranked.ranked, false);
    assert.equal(unranked.rating, submitted.rating, 'unranked play must not replace a ranked best');
    assert.equal((await api.scores(entry.id, 4))[0].score, result.score);
  }
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8'));
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify({
    ok: true, count: result.counts, score: result.score, rating: submitted.rating,
    report: 'Real ServerApi + server + PlaySession press/release; isolated database; browser and audio hardware not exercised.',
  }, null, 2));
  console.log('PASS actual ServerApi + chart upload/download + PlaySession 20Hz hold result + score/rating/leaderboard + current Web HTML');
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
