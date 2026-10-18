// NEONFALL central repository and web host. Node.js 22+, only fflate is required.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { unzipSync, strFromU8 } = require('fflate');
const { sendVerificationMail } = require('./smtp.js');
const { inspectAvatar, MAX_AVATAR_BYTES } = require('./avatar.js');
const { announcementOf, versionOf, checkReceipt, recordAttempt, chartStatistics, globalLeaderboard } = require('./community.js');
const { scoreFromCounts, accuracyFromCounts, gradeFromAccuracy } = require('./scoring.js');
const scrypt = promisify(crypto.scrypt);
const ROOT = path.resolve(__dirname, '..');
const DATA = path.resolve(process.env.NF_DATA_DIR || path.join(__dirname, 'data'));
const DIST = path.resolve(process.env.NF_DIST_DIR || path.join(ROOT, 'dist'));
const CHARTS = path.join(DATA, 'charts');
const AVATARS = path.join(DATA, 'avatars');
const SEED = path.resolve(process.env.NF_SEED_DIR || [path.join(ROOT, 'samples-converted'), path.join(ROOT, 'seed'), path.join(ROOT, '..', 'samples-converted')].find(dir => fs.existsSync(dir)) || path.join(ROOT, 'samples-converted'));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const MAX_UPLOAD = Number(process.env.NF_MAX_UPLOAD_MB || 256) * 1024 * 1024;
const MAX_STORAGE = Number(process.env.NF_MAX_STORAGE_MB || 20480) * 1024 * 1024;
const ADMIN_TOKEN = process.env.NF_ADMIN_TOKEN || '';
const UPLOADS = process.env.NF_UPLOADS !== 'disabled';
const ORIGINS = (process.env.NF_CORS_ORIGINS || 'neonfall://index.html,null,http://localhost,http://localhost:5173,http://127.0.0.1:5173,https://localhost,capacitor://localhost').split(',').map(s => s.trim()).filter(Boolean);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535 || !Number.isFinite(MAX_UPLOAD) || MAX_UPLOAD <= 0 || !Number.isFinite(MAX_STORAGE) || MAX_STORAGE <= 0) throw new Error('Invalid server port or storage limits');
fs.mkdirSync(CHARTS, { recursive: true });
fs.mkdirSync(AVATARS, { recursive: true });
function load(name, fallback) {
  const file = path.join(DATA, name + '.json');
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Cannot read ' + name + '.json; restore a valid backup before starting'); }
}
function save(name, obj) {
  const file = path.join(DATA, name + '.json'), tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 }); fs.renameSync(tmp, file);
}
const users = load('users', {}), scores = load('scores', []), owners = load('chart-owners', {});
const community = load('community', { charts: {}, receipts: {} });
if (!users || typeof users !== 'object' || Array.isArray(users) || !Array.isArray(scores) || !owners || typeof owners !== 'object') throw new Error('Invalid server database structure');
if (!community || typeof community.charts !== 'object' || !community.charts || typeof community.receipts !== 'object' || !community.receipts) throw new Error('Invalid community database structure');
const chartCache = new Map(), verification = new Map(), attempts = new Map();
let currentAnnouncement = announcementOf({});
function serverAnnouncement() {
  // Editing this optional text file must not briefly take the API offline.
  try { currentAnnouncement = announcementOf(load('server-info', {})); } catch { /* retain the last readable announcement */ }
  return currentAnnouncement;
}
const ID = /^[a-f0-9]{40}$/i;
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest('hex');
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function avatarUrl(u) { return u.avatar && /^[a-f0-9]{64}\.(png|jpg|webp)$/.test(u.avatar.file) ? '/api/avatars/' + encodeURIComponent(u.username.toLowerCase()) + '/' + u.avatar.file : undefined; }
function publicUser(u) { return { username: u.username, nickname: u.nickname, email: u.email, emailVerified: !!u.emailVerified, rating: u.rating || 0, bestPp: u.bestPp || 0, plays: u.plays || 0, createdAt: u.createdAt, avatar: avatarUrl(u) }; }
function authenticate(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7), hash = tokenHash(token);
  return Object.values(users).find(u => (u.tokenExpiresAt || Infinity) > Date.now() && (safeEqual(u.tokenHash || '', hash) || safeEqual(u.token || '', token))) || null;
}
function isAdmin(req) { return !!ADMIN_TOKEN && safeEqual(String(req.headers.authorization || ''), 'Bearer ' + ADMIN_TOKEN); }
function newSession(u) {
  const token = crypto.randomBytes(32).toString('hex'); delete u.token;
  u.tokenHash = tokenHash(token); u.tokenExpiresAt = Date.now() + 30 * 86400000; return token;
}
function rateLimit(req, key, max, windowMs) {
  const address = process.env.NF_TRUST_PROXY === '1' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ? String(req.headers['x-real-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress;
  const id = (address || '') + ':' + key, now = Date.now(); let r = attempts.get(id);
  if (!r || r.until <= now) { r = { n: 0, until: now + windowMs }; attempts.set(id, r); } return ++r.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (v.until < now) attempts.delete(k); for (const [k, v] of verification) if (v.until < now) verification.delete(k); }, 60000).unref();
function chartInfo(bytes, id) {
  const entries = new Set(); let expanded = 0, count = 0;
  const zip = unzipSync(bytes, { filter(file) {
    const name = file.name.replace(/\\/g, '/');
    if (++count > 20000 || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw new Error('Unsafe archive paths or too many files');
    expanded += file.originalSize;
    if (expanded > 512 * 1024 * 1024 || file.originalSize > 256 * 1024 * 1024) throw new Error('Archive expands beyond the allowed limit');
    entries.add(name.toLowerCase());
    if (name.toLowerCase() !== 'chart.nf') return false;
    if (file.originalSize > 16 * 1024 * 1024) throw new Error('Chart metadata is too large'); return true;
  } });
  const raw = Object.entries(zip).find(([name]) => name.toLowerCase() === 'chart.nf')?.[1];
  if (!raw) throw new Error('Missing chart.nf'); const c = JSON.parse(strFromU8(raw));
  if (c.format !== 'neonfall-chart' || c.version !== 1 || !c.meta || !Array.isArray(c.notes) || !c.notes.length || c.notes.length > 1000000 || !Number.isInteger(c.keys) || c.keys < 4 || c.keys > 8 || !Array.isArray(c.timing) || !Array.isArray(c.sv)) throw new Error('Invalid chart format');
  for (const field of ['title', 'artist', 'creator', 'version', 'audio']) if (typeof c.meta[field] !== 'string' || c.meta[field].length > 1000) throw new Error('Invalid chart metadata');
  if (!entries.has(c.meta.audio.replace(/\\/g, '/').toLowerCase())) throw new Error('Missing chart audio');
  for (const n of c.notes) if (!n || !Number.isFinite(n.t) || !Number.isInteger(n.col) || n.col < 0 || n.col >= c.keys || (n.end !== undefined && (!Number.isFinite(n.end) || n.end <= n.t))) throw new Error('Invalid note');
  if (!Number.isFinite(c.meta.lengthMs) || c.meta.lengthMs < 0 || c.meta.lengthMs > 86400000) throw new Error('Invalid chart duration');
  const judgments = c.notes.reduce((n, note) => n + (note.end !== undefined ? 2 : 1), 0);
  const maxHoldTicks = c.notes.reduce((n, note) => n + (note.end !== undefined ? Math.max(0, Math.ceil((note.end - note.t) / 50) - 1) : 0), 0);
  return { id, name: `${c.meta.title} [${c.meta.version}]`, title: c.meta.title, artist: c.meta.artist, creator: c.meta.creator, version: c.meta.version, keys: c.keys, stars: Number.isFinite(c.stars) ? Math.max(.5, Math.min(13, c.stars)) : 0, notes: c.notes.length, lengthMs: c.meta.lengthMs, size: bytes.length, source: c.source?.type, bg: c.meta.bg, judgments, maxHoldTicks };
}
function chartMeta(id) {
  if (!ID.test(id)) return null; const file = path.join(CHARTS, id + '.nfm');
  if (!fs.existsSync(file)) return null; const stat = fs.statSync(file), old = chartCache.get(id);
  if (old && old.mtime === stat.mtimeMs && old.size === stat.size) return old.meta;
  try { const meta = { ...chartInfo(fs.readFileSync(file), id), addedAt: stat.mtimeMs }; chartCache.set(id, { mtime: stat.mtimeMs, size: stat.size, meta }); return meta; } catch { return null; }
}
function listCharts(user, admin) {
  return fs.readdirSync(CHARTS).filter(f => ID.test(f.slice(0, -4)) && f.endsWith('.nfm')).map(f => chartMeta(f.slice(0, -4))).filter(Boolean).map(meta => { const { judgments, maxHoldTicks, ...entry } = meta; return { ...entry, canDelete: !!admin || !!user && owners[meta.id] === user.username.toLowerCase() }; }).sort((a, b) => b.addedAt - a.addedAt);
}
function rankedScore(score) { return score.passed === true && Array.isArray(score.mods) && !score.mods.some(m => /^(auto|mirror|random)$/i.test(m)); }
// Keep in sync with src/core/rating.ts. osu! decay, normalized over a fixed
// 100-slot portfolio; missing slots contribute zero and there is no play-count bonus.
const RATING_WEIGHT = (1 - .95 ** 100) / (1 - .95);
function performancePoints(stars, acc, durationMs, mods = []) {
  if (![stars, acc, durationMs].every(Number.isFinite) || stars <= 0) return 0;
  const curve = Math.max(0, Math.min(1, (acc - .8) / .2)) ** 2;
  const modFactor = (mods.some(mod => /^constantspeed$/i.test(mod)) ? .9 : 1) * (mods.some(mod => /^notail$/i.test(mod)) ? .9 : 1);
  return Math.round(2.2 * Math.max(0, Math.min(13, stars)) ** 2 * curve * (1 + Math.max(0, Math.min(durationMs / 240000, 1)) * .25) * modFactor * 100) / 100;
}
function recompute(u) {
  const best = new Map();
  for (const score of scores.filter(s => s.username === u.username && rankedScore(s))) {
    const key = score.chartId + ':' + score.keys;
    best.set(key, Math.max(best.get(key) || 0, Number.isFinite(score.ratingPp) ? score.ratingPp : Number.isFinite(score.pp) ? score.pp : 0));
  }
  const pp = [...best.values()].sort((a, b) => b - a);
  u.rating = Math.round(pp.slice(0, 100).reduce((sum, p, i) => sum + p * .95 ** i, 0) / RATING_WEIGHT * 100) / 100; u.bestPp = pp[0] || 0; u.plays = best.size;
}
function mailConfig() {
  const old = load('mailer-config', {}), smtp = old.smtp || {};
  return { enabled: process.env.SMTP_HOST ? true : !!old.enabled, from: process.env.MAIL_FROM || old.from || '', host: process.env.SMTP_HOST || smtp.host || '', port: Number(process.env.SMTP_PORT || smtp.port || 465), secure: process.env.SMTP_SECURE === undefined ? smtp.secure !== false : process.env.SMTP_SECURE === 'true', user: process.env.SMTP_USER || smtp.user || '', pass: process.env.SMTP_PASS || smtp.pass || '' };
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
async function readBody(req, limit) {
  const chunks = []; let size = 0, tooLarge = Number(req.headers['content-length'] || 0) > limit;
  for await (const chunk of req) { size += chunk.length; if (size > limit) tooLarge = true; if (!tooLarge) chunks.push(chunk); }
  if (tooLarge) throw httpError(413, 'payload too large'); return Buffer.concat(chunks);
}
async function readJson(req) { const buf = await readBody(req, 65536); try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'invalid JSON body'); } }
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function scoreOf(body, meta, u) {
  const modern = body?.scoreVersion === 2;
  if (!body || body.scoreVersion !== undefined && body.scoreVersion !== 1 && !modern || body.keys !== meta.keys || !Number.isInteger(body.score) || body.score < 0 || body.score > (modern ? 1000000 : meta.judgments * 3200 + meta.maxHoldTicks * 320) || !Number.isFinite(body.acc) || body.acc < 0 || body.acc > 1 || !Number.isInteger(body.maxCombo) || body.maxCombo < 0 || body.maxCombo > meta.judgments + meta.maxHoldTicks || typeof body.passed !== 'boolean' || !Array.isArray(body.mods) || body.mods.length > 16 || body.mods.some(m => typeof m !== 'string' || m.length > 40)) throw httpError(400, 'invalid score fields');
  if (modern && (typeof body.playId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.playId))) throw httpError(400, 'normalized scores require a valid playId');
  if (!modern && body.mods.some(mod => /^notail$/i.test(mod))) throw httpError(400, 'NoTail requires scoreVersion 2');
  if (body.failedAtMs !== undefined && (!modern || body.passed || !Number.isFinite(body.failedAtMs) || body.failedAtMs < 0 || body.failedAtMs > meta.lengthMs)) throw httpError(400, 'invalid failure position');
  if (!body.counts || ['perfect', 'great', 'good', 'ok', 'bad', 'miss', 'holdTicks'].some(k => !Number.isInteger(body.counts[k]) || body.counts[k] < 0 || body.counts[k] > 100000000)) throw httpError(400, 'invalid judgment counts');
  const total = ['perfect', 'great', 'good', 'ok', 'bad', 'miss'].reduce((n, k) => n + body.counts[k], 0);
  const judgmentTotal = total - (modern ? 0 : body.counts.holdTicks);
  if (body.counts.holdTicks > meta.maxHoldTicks || !modern && body.counts.perfect < body.counts.holdTicks || judgmentTotal > meta.judgments || body.passed && judgmentTotal !== meta.judgments) throw httpError(400, 'judgment count does not match chart');
  const actualAcc = modern ? accuracyFromCounts(body.counts) : total ? (body.counts.perfect * 320 + body.counts.great * 300 + body.counts.good * 200 + body.counts.ok * 100 + body.counts.bad * 50) / (total * 320) : 1;
  if (Math.abs(actualAcc - body.acc) > .000001) throw httpError(400, 'accuracy does not match judgment counts');
  if (modern && scoreFromCounts(body.counts, meta.judgments, body.mods) !== body.score) throw httpError(400, 'normalized score does not match judgment counts');
  const ranked = body.passed && !body.mods.some(m => /^(auto|mirror|random)$/i.test(m));
  const pp = ranked ? performancePoints(meta.stars, body.acc, meta.lengthMs, body.mods) : 0;
  const grade = modern ? gradeFromAccuracy(body.acc, body.passed) : !body.passed ? 'F' : body.acc >= .9999 && !body.counts.miss && !body.counts.bad && !body.counts.ok ? 'SS' : body.acc >= .95 ? 'S' : body.acc >= .9 ? 'A' : body.acc >= .8 ? 'B' : body.acc >= .7 ? 'C' : 'D';
  return { username: u.username, chartId: meta.id, keys: meta.keys, title: meta.title, version: meta.version, stars: meta.stars, durationMs: meta.lengthMs, score: body.score, acc: body.acc, maxCombo: body.maxCombo, counts: body.counts, pp, grade, mods: body.mods, passed: body.passed, playedAt: Date.now(), scoreVersion: modern ? 2 : 1, ...(modern ? { playId: body.playId } : {}), ...(body.failedAtMs !== undefined ? { failedAtMs: body.failedAtMs } : {}) };
}
function scoreTable(chart, keys, version) { return scores.filter(s => s.chartId === chart && s.keys === keys && versionOf(s) === version && rankedScore(s)).sort((a, b) => b.score - a.score || b.acc - a.acc || a.playedAt - b.playedAt); }
function publicScore(score, index, user) {
  const owner = users[score.username.toLowerCase()];
  return { rank: index + 1, username: score.username, nickname: owner?.nickname || score.username, avatar: owner ? avatarUrl(owner) : undefined,
    score: score.score, acc: score.acc, maxCombo: score.maxCombo, playedAt: score.playedAt, mods: [...score.mods], grade: score.grade, scoreVersion: versionOf(score), isSelf: score.username === user?.username };
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
  // Also vary anonymous/same-origin responses: otherwise a reverse proxy can cache
  // a response without CORS and later serve it to the desktop/Android client.
  res.setHeader('Vary', 'Origin');
  const origin = String(req.headers.origin || '');
  if (origin && (ORIGINS.includes('*') || ORIGINS.includes(origin))) { res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes('*') ? '*' : origin); res.setHeader('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Max-Age': '600' }); return res.end(); }
  try {
    const url = new URL(req.url, 'http://localhost'), p = decodeURIComponent(url.pathname), method = req.method;
    const u = authenticate(req), admin = isAdmin(req); const ok = (data, status = 200) => json(res, status, data);
    if (p === '/api/ping' && method === 'GET') return ok({ ok: true, name: 'neonfall-server', version: '0.2.10', ratingVersion: 4, scoreVersion: 2, statisticsVersion: 1, announcement: serverAnnouncement(), charts: listCharts().length, users: Object.keys(users).length, uploadPolicy: UPLOADS ? 'authenticated' : 'disabled', emailVerification: !!(mailConfig().enabled && mailConfig().host), avatars: true });
    if (p === '/api/register' && method === 'POST') {
      if (rateLimit(req, 'register', 10, 3600000)) throw httpError(429, 'too many registration attempts; try later'); const b = await readJson(req);
      if (!b || typeof b.username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(b.username)) throw httpError(400, 'username: 3-16 letters, digits or underscores');
      if (typeof b.nickname !== 'string' || !b.nickname.trim() || b.nickname.length > 24) throw httpError(400, 'nickname required (max 24 chars)');
      if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 256) throw httpError(400, 'password: 8-256 characters');
      if (typeof b.email !== 'string' || b.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) throw httpError(400, 'invalid email address');
      const key = b.username.toLowerCase(); if (Object.hasOwn(users, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw httpError(409, 'username already taken');
      const salt = crypto.randomBytes(16).toString('hex'), passHash = (await scrypt(b.password, salt, 64)).toString('hex');
      if (Object.hasOwn(users, key)) throw httpError(409, 'username already taken');
      const user = { username: b.username, nickname: b.nickname.trim(), email: b.email, emailVerified: false, passSalt: salt, passHash, createdAt: Date.now(), rating: 0, bestPp: 0, plays: 0, ratingVersion: 4 };
      const token = newSession(user); users[key] = user; save('users', users); return ok({ ok: true, token, user: publicUser(user) }, 201);
    }
    if (p === '/api/login' && method === 'POST') {
      if (rateLimit(req, 'login', 30, 900000)) throw httpError(429, 'too many login attempts; try later'); const b = await readJson(req);
      if (!b || typeof b.username !== 'string' || typeof b.password !== 'string' || b.password.length > 256) throw httpError(400, 'invalid login fields');
      const user = users[b.username.toLowerCase()], h = (await scrypt(b.password, user?.passSalt || 'neonfall-invalid-user', 64)).toString('hex');
      if (!user || !safeEqual(h, user.passHash)) throw httpError(401, 'invalid username or password');
      const token = newSession(user); save('users', users); return ok({ ok: true, token, user: publicUser(user) });
    }
    if (p === '/api/me' && method === 'GET') { if (!u) throw httpError(401, 'not signed in'); return ok(publicUser(u)); }
    if (p === '/api/me/avatar' && (method === 'PUT' || method === 'POST' || method === 'DELETE')) {
      if (!u) throw httpError(401, 'sign in before changing your avatar');
      if (rateLimit(req, 'avatar', 30, 3600000)) throw httpError(429, 'too many avatar changes; try later');
      const directory = path.join(AVATARS, u.username.toLowerCase()), previous = u.avatar?.file;
      if (method === 'DELETE') {
        delete u.avatar; save('users', users);
      } else {
        const bytes = await readBody(req, MAX_AVATAR_BYTES), image = inspectAvatar(bytes, req.headers['content-type']);
        const file = crypto.createHash('sha256').update(bytes).digest('hex') + '.' + image.ext;
        fs.mkdirSync(directory, { recursive: true });
        const target = path.join(directory, file), tmp = target + '.tmp';
        fs.writeFileSync(tmp, bytes, { mode: 0o600 }); fs.renameSync(tmp, target);
        u.avatar = { file, mime: image.mime }; save('users', users);
      }
      if (previous && previous !== u.avatar?.file && /^[a-f0-9]{64}\.(png|jpg|webp)$/.test(previous)) {
        try { fs.unlinkSync(path.join(directory, previous)); } catch { /* stale file cleanup is best effort */ }
      }
      return ok(publicUser(u));
    }
    if (p.startsWith('/api/avatars/') && (method === 'GET' || method === 'HEAD')) {
      const match = /^\/api\/avatars\/([a-z0-9_]{3,16})\/([a-f0-9]{64}\.(png|jpg|webp))$/i.exec(p);
      const owner = match && users[match[1].toLowerCase()];
      if (!owner || owner.avatar?.file !== match[2]) throw httpError(404, 'avatar not found');
      const file = path.join(AVATARS, owner.username.toLowerCase(), owner.avatar.file);
      if (!fs.existsSync(file)) throw httpError(404, 'avatar not found');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200, { 'Content-Type': owner.avatar.mime, 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      if (method === 'HEAD') return res.end();
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
    if (p === '/api/logout' && method === 'POST') { if (u) { delete u.token; delete u.tokenHash; delete u.tokenExpiresAt; save('users', users); } return ok({ ok: true }); }
    if (p === '/api/verify-email/send' && method === 'POST') {
      if (!u) throw httpError(401, 'not signed in'); const config = mailConfig(); if (!config.enabled || !config.host || !config.from) throw httpError(503, 'email service is not configured');
      if (rateLimit(req, 'email', 5, 900000)) throw httpError(429, 'too many verification requests; try later'); const code = String(crypto.randomInt(100000, 1000000));
      try { await sendVerificationMail(config, u.email, code); } catch { throw httpError(502, 'email delivery failed; contact the server administrator'); }
      verification.set(u.username, { hash: tokenHash(code), until: Date.now() + 900000, tries: 0 }); return ok({ ok: true, note: 'verification code sent' });
    }
    if (p === '/api/verify-email' && method === 'POST') {
      if (!u) throw httpError(401, 'not signed in'); const b = await readJson(req), rec = verification.get(u.username);
      if (!rec || rec.until <= Date.now() || ++rec.tries > 5 || !safeEqual(rec.hash, tokenHash(String(b?.code || '')))) throw httpError(400, 'invalid or expired code');
      u.emailVerified = true; verification.delete(u.username); save('users', users); return ok({ ok: true, note: 'email verified' });
    }
    if (p === '/api/charts' && method === 'GET') return ok(listCharts(u, admin));
    if (p === '/api/charts/upload' && method === 'POST') {
      if (!UPLOADS && !admin) throw httpError(403, 'chart uploads are disabled'); if (!u && !admin) throw httpError(401, 'sign in before uploading charts');
      if (!admin && rateLimit(req, 'upload', 30, 3600000)) throw httpError(429, 'too many uploads; try later');
      const bytes = await readBody(req, MAX_UPLOAD), id = sha1(bytes), file = path.join(CHARTS, id + '.nfm');
      try { chartInfo(bytes, id); } catch (e) { throw httpError(400, 'invalid .nfm package: ' + e.message); } const exists = fs.existsSync(file);
      if (!exists) {
        const used = fs.readdirSync(CHARTS).filter(f => f.endsWith('.nfm')).reduce((n, f) => n + fs.statSync(path.join(CHARTS, f)).size, 0);
        if (used + bytes.length > MAX_STORAGE) throw httpError(507, 'chart storage quota exceeded');
        const tmp = file + '.tmp'; fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, file); owners[id] = u ? u.username.toLowerCase() : '$admin'; save('chart-owners', owners);
      }
      const entry = listCharts(u, admin).find(c => c.id === id); return ok({ ok: true, id, entry, duplicate: exists }, exists ? 200 : 201);
    }
    if (p.startsWith('/api/charts/') && (method === 'GET' || method === 'HEAD' || method === 'DELETE')) {
      const id = p.slice('/api/charts/'.length).toLowerCase(); if (!ID.test(id)) throw httpError(400, 'bad chart id'); const meta = chartMeta(id); if (!meta) throw httpError(404, 'chart not found'); const file = path.join(CHARTS, id + '.nfm');
      if (method === 'DELETE') {
        if (!u && !admin) throw httpError(401, 'not signed in'); if (!admin && owners[id] !== u.username.toLowerCase()) throw httpError(403, 'only the uploader or administrator can delete this chart');
        fs.unlinkSync(file); chartCache.delete(id); delete owners[id]; save('chart-owners', owners); return ok({ ok: true });
      }
      // Chart bytes are public and contain no account-specific response data.
      // A wildcard also makes reverse-proxy cache hits independent of Origin.
      res.setHeader('Access-Control-Allow-Origin', '*');
      const etag = '"' + id + '"'; if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': meta.size, 'Content-Disposition': "attachment; filename=\"" + id + ".nfm\"; filename*=UTF-8''" + encodeURIComponent(meta.name + '.nfm'), 'ETag': etag, 'Cache-Control': 'public, max-age=3600' });
      if (method === 'HEAD') return res.end(); return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
    if (p === '/api/scores' && method === 'POST') {
      if (!u) throw httpError(401, 'not signed in'); if (rateLimit(req, 'score', 120, 3600000)) throw httpError(429, 'too many score submissions; try later');
      const b = await readJson(req), meta = chartMeta(String(b?.chartId || '')); if (!meta) throw httpError(404, 'chart is not in this repository');
      const score = scoreOf(b, meta, u);
      if (checkReceipt(community, score)) return ok({ ok: true, rating: u.rating || 0, ranked: rankedScore(score), duplicate: true });
      if (!rankedScore(score)) {
        if (recordAttempt(community, score, meta.lengthMs)) save('community', community);
        return ok({ ok: true, rating: u.rating || 0, ranked: false });
      }
      const prev = scores.find(s => s.username === u.username && s.chartId === meta.id && s.keys === meta.keys && versionOf(s) === versionOf(score));
      if (!prev) scores.push(score);
      else {
        const ratingPp = Math.max(prev.ratingPp ?? prev.pp, score.pp), bestAcc = Math.max(prev.bestAcc ?? prev.acc, score.acc);
        const better = score.scoreVersion === 2
          ? score.score > prev.score || score.score === prev.score && score.acc > prev.acc
          : score.pp > prev.pp || score.pp === prev.pp && (score.acc > prev.acc || score.acc === prev.acc && score.score > prev.score);
        if (!rankedScore(prev) || better) Object.assign(prev, score);
        prev.ratingPp = ratingPp; prev.bestAcc = bestAcc;
      }
      recompute(u); save('scores', scores); save('users', users);
      if (recordAttempt(community, score, meta.lengthMs)) save('community', community);
      const ranked = scoreTable(meta.id, meta.keys, versionOf(score)); return ok({ ok: true, rating: u.rating, ranked: true, rank: ranked.findIndex(s => s.username === u.username) + 1 });
    }
    if (p === '/api/scores' && method === 'GET') {
      const chart = url.searchParams.get('chart') || '', keys = Number(url.searchParams.get('keys') || 4);
      // Missing filter preserves the old API contract for older clients.
      const version = url.searchParams.get('scoreVersion') === '2' ? 2 : 1;
      return ok(scoreTable(chart, keys, version).slice(0, 20).map((s, i) => publicScore(s, i, u)));
    }
    if (p === '/api/chart-stats' && method === 'GET') {
      const chart = url.searchParams.get('chart') || '', keys = Number(url.searchParams.get('keys') || 4), meta = chartMeta(chart);
      if (!meta || meta.keys !== keys) throw httpError(404, 'chart is not in this repository');
      const table = scoreTable(chart, keys, 2), ownIndex = u ? table.findIndex(s => s.username === u.username) : -1;
      return ok({ ...chartStatistics(community, chart, keys), personalBest: ownIndex >= 0 ? publicScore(table[ownIndex], ownIndex, u) : null });
    }
    if (p === '/api/scores/mine' && method === 'GET') {
      if (!u) throw httpError(401, 'not signed in');
      const own = scores.filter(s => s.username === u.username).sort((a, b) => b.playedAt - a.playedAt);
      return ok(url.searchParams.get('all') === '1' ? own : own.slice(0, 100));
    }
    if (p === '/api/leaderboard' && method === 'GET') return ok(globalLeaderboard(users, scores, url.searchParams.get('metric'), avatarUrl));
    if (p.startsWith('/api/')) throw httpError(404, 'API route not found'); if (method !== 'GET' && method !== 'HEAD') throw httpError(405, 'method not allowed');
    if (p.includes('\0') || p.includes('\\')) throw httpError(400, 'invalid path'); let full = path.resolve(DIST, '.' + (p === '/' ? '/index.html' : p));
    if (full !== DIST && !full.startsWith(DIST + path.sep)) throw httpError(403, 'forbidden path');
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) { if (path.extname(p)) throw httpError(404, 'file not found'); full = path.join(DIST, 'index.html'); }
    if (!fs.existsSync(full)) throw httpError(404, 'web build missing; build dist first'); const real = fs.realpathSync(full), rootReal = fs.realpathSync(DIST);
    if (!real.startsWith(rootReal + path.sep)) throw httpError(403, 'forbidden path');
    const ext = path.extname(full).toLowerCase(), mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fs.statSync(full).size, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    if (method === 'HEAD') return res.end(); fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    const status = e.status || (e instanceof URIError ? 400 : 500);
    if (status === 500) console.error('[server] request failed:', e.code || e.name);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'internal server error' : e.message }); else res.end();
  }
});
server.requestTimeout = 120000; server.headersTimeout = 30000; server.keepAliveTimeout = 5000;
if (fs.existsSync(SEED) && !fs.readdirSync(CHARTS).some(f => f.endsWith('.nfm'))) {
  for (const name of fs.readdirSync(SEED).filter(f => f.toLowerCase().endsWith('.nfm'))) {
    try { const bytes = fs.readFileSync(path.join(SEED, name)), id = sha1(bytes); chartInfo(bytes, id); fs.writeFileSync(path.join(CHARTS, id + '.nfm'), bytes); } catch { console.warn('[seed] skipped invalid chart package'); }
  }
}
// Re-rate historical scores at startup without changing their judgments or timestamps.
// Deleted charts retain their last server-validated difficulty and length.
if (Object.values(users).some(user => user.ratingVersion !== 4)) {
  for (const score of scores) {
    const meta = chartMeta(String(score.chartId || ''));
    score.pp = rankedScore(score) ? performancePoints(meta?.stars ?? score.stars, score.acc, meta?.lengthMs ?? score.durationMs, score.mods) : 0;
  }
  for (const user of Object.values(users)) { recompute(user); user.ratingVersion = 4; }
  save('scores', scores); save('users', users);
}
server.on('error', e => { console.error('[server] could not listen:', e.code || e.name); process.exitCode = 1; });
server.listen(PORT, HOST, () => { console.log(`NEONFALL server ready at http://${HOST}:${server.address().port}`); console.log(`Charts: ${listCharts().length}; uploads: ${UPLOADS ? 'signed-in users' : 'disabled'}; data: ${DATA}`); });
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); }
if (require.main === module) { process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); }
module.exports = { server };
