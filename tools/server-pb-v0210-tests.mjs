// Isolated persisted synthetic scores + the real HTTP server and API client.
// Does not read user authentication files, contact SMTP or access a remote host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { ServerApi, ApiError } from '../src/api/client.ts';

const require = createRequire(import.meta.url);
const output = path.resolve('test-results/v0210');
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, 'server-pb-'));
const names = ['fixture_alpha', 'fixture_beta', 'fixture_empty', 'fixture_expired'];
const tokens = names.map(name => 'synthetic-session-only-' + name);
const users = Object.fromEntries(names.map((username, i) => [username, {
  username, nickname: 'Synthetic ' + i, email: `${username}@example.invalid`,
  tokenHash: createHash('sha256').update(tokens[i]).digest('hex'),
  tokenExpiresAt: i === 3 ? 1 : Date.now() + 60000, createdAt: 1, ratingVersion: 4,
}]));
const score = (username, index, scoreVersion = 2) => ({
  username, chartId: createHash('sha1').update('synthetic-chart-' + index).digest('hex'),
  keys: index % 2 ? 4 : 7, title: `Synthetic song ${index}`, version: 'Difficulty',
  scoreVersion, score: scoreVersion === 2 ? 1000000 - index : 9000000 + index,
  acc: 1, maxCombo: 10, passed: true, mods: index % 3 ? [] : ['ConstantSpeed'],
  grade: 'SS', stars: 3, pp: 20, durationMs: 60000,
  playedAt: 1600000000000 + index,
  counts: { perfect: 10, great: 0, good: 0, ok: 0, bad: 0, miss: 0, holdTicks: 0 },
});
const alpha = Array.from({ length: 143 }, (_, i) => score(names[0], i));
// The same chart can have separate old and million-point records. The endpoint
// must preserve their explicit version rather than compare incompatible scores.
alpha.push({ ...score(names[0], 3, 1), playedAt: 1700000000000 });
alpha.push({ ...score(names[0], 6, undefined), playedAt: 1700000000001 });
delete alpha.at(-1).scoreVersion;
const beta = Array.from({ length: 117 }, (_, i) => ({ ...score(names[1], i), playedAt: 1800000000000 + i }));
// Deliberately shuffled and interleaved so filtering must precede the 100 cap.
const persisted = [...alpha.map((entry, i) => [entry, beta[i]].filter(Boolean)).flat(), ...beta.slice(alpha.length)].reverse();
fs.writeFileSync(path.join(directory, 'users.json'), JSON.stringify(users));
fs.writeFileSync(path.join(directory, 'scores.json'), JSON.stringify(persisted));
Object.assign(process.env, {
  HOST: '127.0.0.1', PORT: '0', NF_DATA_DIR: directory,
  NF_DIST_DIR: path.join(directory, 'no-dist'), NF_SEED_DIR: path.join(directory, 'no-seed'),
  NF_ADMIN_TOKEN: '', NF_UPLOADS: 'disabled', SMTP_HOST: '',
});
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
let server;
try {
  server = require('../server/server.js').server;
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const paths = [];
  server.on('request', req => paths.push({ path: req.url, method: req.method }));
  const apis = names.map((_, i) => { const api = new ServerApi(base); api.setToken(tokens[i]); return api; });
  const expected = rows => [...rows].sort((a, b) => b.playedAt - a.playedAt);

  for (const [index, rows] of [[0, alpha], [1, beta]]) {
    const api = apis[index];
    const recent = await api.myScores();
    equal(paths.at(-1), { path: '/api/scores/mine', method: 'GET' }, 'Default client preserves the old query');
    equal(recent, expected(rows).slice(0, 100), 'Default endpoint returns the latest 100 of this account only');
    const all = await api.myScores(true);
    equal(paths.at(-1), { path: '/api/scores/mine?all=1', method: 'GET' }, 'Full-library client sends all=1');
    equal(all, expected(rows), 'All endpoint returns every personal best in descending play time');
    check(all.length > 100, 'An account with more than 100 scores is not truncated');
    check(all.every(row => row.username === names[index]), 'Returned results belong only to the authenticated account');
    equal(await api.myScores(false), recent, 'Explicit false keeps the legacy cap');
  }
  const allAlpha = await apis[0].myScores(true);
  equal(allAlpha.filter(row => row.chartId === alpha[3].chartId).map(row => row.scoreVersion), [1, 2],
    'Legacy and million-point personal records retain separate version markers');
  check(allAlpha.some(row => row.scoreVersion === undefined), 'Records predating version markers remain readable');
  equal(await apis[2].myScores(true), [], 'An authenticated account without scores gets an empty list');

  const raw = await fetch(base + '/api/scores/mine?all=1&username=' + names[1], { headers: { Authorization: 'Bearer ' + tokens[0] } });
  equal(raw.status, 200, 'Authenticated full query succeeds');
  equal(raw.headers.get('cache-control'), 'no-store', 'Personal results cannot be cached across account changes');
  equal(await raw.json(), expected(alpha), 'A supplied username cannot request another account\'s scores');
  const notAll = await fetch(base + '/api/scores/mine?all=0', { headers: { Authorization: 'Bearer ' + tokens[0] } });
  equal((await notAll.json()).length, 100, 'Only the explicit all=1 request removes the cap');

  for (const suffix of ['', '?all=1']) {
    const anonymous = await fetch(base + '/api/scores/mine' + suffix);
    equal(anonymous.status, 401, 'Anonymous callers cannot access either personal endpoint');
    const body = await anonymous.json();
    check(!Array.isArray(body) && typeof body.error === 'string', 'Anonymous failure contains no score list');
  }
  const invalid = new ServerApi(base); invalid.setToken('invalid-synthetic-session');
  for (const api of [new ServerApi(base), invalid, apis[3]]) {
    await assert.rejects(api.myScores(true), error => error instanceof ApiError && error.status === 401,
      'Client surfaces missing, invalid and expired authentication as 401'); checks++;
  }
  const switching = new ServerApi(base); switching.setToken(tokens[0]);
  equal((await switching.myScores(true)).length, alpha.length, 'First account is selected by its session');
  switching.setToken(tokens[1]);
  equal(await switching.myScores(true), expected(beta), 'Changing the client session returns only the second account');
  await apis[0].logout();
  await assert.rejects(apis[0].myScores(true), error => error instanceof ApiError && error.status === 401,
    'Logout revokes access to the full personal-score query'); checks++;
  equal((await apis[1].myScores(true)).length, beta.length, 'Logging out one account does not affect another');

  fs.writeFileSync(path.join(output, 'server-pb-results.json'), JSON.stringify({
    ok: true, checks, alphaRecords: alpha.length, betaRecords: beta.length,
    isolation: 'Temporary synthetic database, loopback HTTP, no real authentication files or external servers.',
  }, null, 2));
  console.log(`PASS server personal-best library: ${checks} checks, full ${alpha.length}/${beta.length} account records, default 100, version preservation, session isolation and auth rejection`);
} finally {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
