'use strict';
const crypto = require('node:crypto');

const FAILURE_BINS = 40;
const METRICS = new Set(['rating', 'bestPp', 'totalScore', 'accuracy', 'clears']);
const eligible = score => Array.isArray(score.mods) && !score.mods.some(m => /^(auto|mirror|random)$/i.test(m));
const ranked = score => score.passed === true && eligible(score);
const versionOf = score => score.scoreVersion === 2 ? 2 : 1;

function announcementOf(config, env = process.env) {
  const configured = config?.announcement;
  const body = typeof env.NF_ANNOUNCEMENT === 'string' ? env.NF_ANNOUNCEMENT.replace(/\\n/g, '\n')
    : typeof configured?.body === 'string' ? configured.body : '欢迎来到 NEONFALL！登录后，游玩成绩会自动同步到此服务器。';
  const title = typeof env.NF_ANNOUNCEMENT_TITLE === 'string' ? env.NF_ANNOUNCEMENT_TITLE
    : typeof configured?.title === 'string' ? configured.title : '服务器公告';
  return { title: title.slice(0, 120), body: body.slice(0, 8000), ...(typeof configured?.updatedAt === 'string' ? { updatedAt: configured.updatedAt.slice(0, 80) } : {}) };
}

function receiptOf(score) {
  // Only validated gameplay values are included. Server timestamps and rating
  // changes must not turn a retry into a new attempt.
  const payload = [score.chartId, score.keys, score.scoreVersion, score.score, score.acc, score.maxCombo,
    ...['perfect', 'great', 'good', 'ok', 'bad', 'miss', 'holdTicks'].map(k => score.counts[k]),
    [...score.mods].sort(), score.passed, score.failedAtMs ?? null];
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function attemptKey(score) { return score.username.toLowerCase() + ':' + score.playId; }
function checkReceipt(state, score) {
  if (score.scoreVersion !== 2 || !eligible(score)) return false;
  const receipt = state.receipts[attemptKey(score)];
  if (!receipt) return false;
  if (receipt !== receiptOf(score)) { const error = new Error('playId already belongs to a different attempt'); error.status = 409; throw error; }
  return true;
}

function recordAttempt(state, score, durationMs) {
  if (score.scoreVersion !== 2 || !eligible(score)) return false;
  if (checkReceipt(state, score)) return false;
  const key = score.chartId + ':' + score.keys;
  const entry = state.charts[key] || (state.charts[key] = { attempts: 0, passes: 0, failureBins: Array(FAILURE_BINS).fill(0), failureSamples: 0 });
  entry.attempts++;
  if (score.passed) entry.passes++;
  else if (Number.isFinite(score.failedAtMs) && durationMs > 0) {
    const bin = Math.max(0, Math.min(FAILURE_BINS - 1, Math.floor(score.failedAtMs / durationMs * FAILURE_BINS)));
    entry.failureBins[bin]++; entry.failureSamples++;
  }
  state.receipts[attemptKey(score)] = receiptOf(score);
  return true;
}

function chartStatistics(state, chartId, keys) {
  const entry = state.charts[chartId + ':' + keys];
  const attempts = entry?.attempts || 0, passes = entry?.passes || 0;
  return { chartId, keys, attempts, passes, passRate: attempts ? passes / attempts : null,
    failureBins: entry ? [...entry.failureBins] : Array(FAILURE_BINS).fill(0), failureSamples: entry?.failureSamples || 0 };
}

function globalLeaderboard(users, scores, metric, avatarUrl) {
  const validMetric = METRICS.has(metric) ? metric : 'rating';
  const aggregates = new Map();
  for (const score of scores) {
    if (!ranked(score) || versionOf(score) !== 2) continue;
    let charts = aggregates.get(score.username);
    if (!charts) aggregates.set(score.username, charts = new Map());
    const key = score.chartId + ':' + score.keys;
    const old = charts.get(key) || { score: 0, acc: 0 };
    old.score = Math.max(old.score, score.score || 0);
    old.acc = Math.max(old.acc, score.bestAcc ?? score.acc ?? 0);
    charts.set(key, old);
  }
  return Object.values(users).map(user => {
    const charts = [...(aggregates.get(user.username)?.values() || [])];
    return { username: user.username, nickname: user.nickname, rating: user.rating || 0, bestPp: user.bestPp || 0,
      avatar: avatarUrl(user), totalScore: charts.reduce((sum, score) => sum + score.score, 0),
      accuracy: charts.length ? charts.reduce((sum, score) => sum + score.acc, 0) / charts.length : 0,
      clears: charts.length };
  }).sort((a, b) => b[validMetric] - a[validMetric] || b.rating - a.rating || a.username.localeCompare(b.username, 'en'))
    .slice(0, 100).map((entry, i) => ({ rank: i + 1, ...entry }));
}

module.exports = { announcementOf, eligible, versionOf, checkReceipt, recordAttempt, chartStatistics, globalLeaderboard };
