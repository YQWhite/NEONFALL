// Runs the actual browser API client against the actual server, using an isolated test repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { ServerApi, ApiError } from '../src/api/client.ts';
import { buildNFM, readNFM } from '../src/core/nfm.ts';

const output = path.resolve('test-results/online-client'); fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(output, 'repository-'));
process.env.NF_DATA_DIR = data;
process.env.NF_SEED_DIR = path.join(data, 'no-seed');
process.env.HOST = '127.0.0.1'; process.env.PORT = '0';
process.env.NF_UPLOADS = 'authenticated';
const require = createRequire(import.meta.url);
const { server } = require('../server/server.js');
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const client = new ServerApi(base);
  assert.equal(await client.ping(), true);
  assert.equal(client.uploadsEnabled, true);
  const { user } = await client.register('client_test', 'Client integration', 'test-only-password', 'client@example.invalid');
  assert.equal(user.username, 'client_test');
  assert.equal((await client.me()).nickname, 'Client integration');
  const chart = {
    format: 'neonfall-chart', version: 1, keys: 4, od: 8, stars: 1.5, offset: 0,
    meta: { title: 'API integration chart', artist: 'Test', creator: 'Test', version: '4K test', audio: 'audio.wav', audioLeadIn: 0, previewTime: 0, lengthMs: 4000 },
    timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [], notes: [{ t: 1000, col: 0 }, { t: 2000, col: 1, end: 3000 }],
  };
  const bytes = buildNFM(chart, { 'audio.wav': new Uint8Array(64) });
  const entry = await client.uploadChart(bytes, 'integration.nfm');
  assert.equal(entry.server, true); assert.equal(entry.canDelete, true);
  assert.equal((await client.listCharts())[0].server, true);
  assert.equal(readNFM(await client.downloadChart(entry.id)).chart.meta.title, chart.meta.title);
  const result = {
    chartId: entry.id, keys: 4, score: 10000, acc: 1, maxCombo: 22,
    counts: { perfect: 22, great: 0, good: 0, ok: 0, bad: 0, miss: 0, holdTicks: 19 },
    stars: 1.5, pp: 99999, grade: 'SS', passed: true, mods: [], playedAt: Date.now(),
    title: chart.meta.title, version: chart.meta.version, durationMs: 4000,
  };
  const submitted = await client.submitScore(result);
  assert.equal(submitted.rank, 1); assert.ok(submitted.rating > 0 && submitted.rating < 100, 'server recomputes rating');
  assert.equal((await client.scores(entry.id, 4, 1))[0].username, 'client_test');
  assert.equal((await client.myScores())[0].title, chart.meta.title);
  assert.equal((await client.leaderboard())[0].nickname, 'Client integration');
  const visitor = new ServerApi(base);
  assert.equal((await visitor.listCharts())[0].canDelete, false);
  await assert.rejects(visitor.deleteChartServer(entry.id), error => error instanceof ApiError && error.status === 401);
  await client.deleteChartServer(entry.id);
  assert.equal((await client.listCharts()).length, 0);
  await client.logout();
  await assert.rejects(client.me(), error => error instanceof ApiError && error.status === 401);
  fs.writeFileSync(path.join(output, 'integration-result.json'), JSON.stringify({ ok: true, checked: ['register', 'session', 'upload', 'central-list', 'download', 'score', 'chart-ranking', 'my-plays', 'global-ranking', 'delete-ownership', 'logout'], testedAt: new Date().toISOString() }, null, 2));
  console.log('PASS actual ServerApi → central server: register/login session, upload/list/download, score/rankings, ownership, deletion and logout');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
