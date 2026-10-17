// Isolated real client/UI state checks: all HTTP is intercepted, storage is memory-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const memory = new Map(), events = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
globalThis.location = new URL('https://client.example.invalid');
globalThis.window = { addEventListener(name, fn) { const set = events.get(name) || new Set(); set.add(fn); events.set(name, set); },
  removeEventListener(name, fn) { events.get(name)?.delete(fn); }, matchMedia: () => ({ matches: false }) };
globalThis.document = { visibilityState: 'visible', activeElement: null, documentElement: {},
  addEventListener: window.addEventListener, removeEventListener: window.removeEventListener,
  body: { appendChild(el) { el.isConnected = true; } },
  createElement(tag) { if (tag === 'canvas') return createCanvas(1, 1); return { style: {}, value: '', type: 'text', disabled: false,
    addEventListener() {}, setAttribute() {}, remove() { this.isConnected = false; },
    focus() { document.activeElement = this; }, blur() { document.activeElement = null; } }; },
};
const { App } = await import('../src/ui/app.ts');
const { AccountScreen } = await import('../src/ui/screens/account.ts');
const { UI } = await import('../src/ui/widgets.ts');
const { Store } = await import('../src/core/store.ts');
const { ServerApi } = await import('../src/api/client.ts');
const { scoreSync } = await import('../src/api/score-sync.ts');

const first = 'https://first.example.invalid', second = 'https://second.example.invalid';
const user = origin => ({ username: origin === first ? 'first_user' : 'second_user', nickname: 'Fixture player',
  email: 'fixture@example.invalid', emailVerified: true, rating: 10, bestPp: 100, createdAt: 1 });
const credential = origin => origin === first ? 'fixture-first-session' : 'fixture-second-session';
const requests = [], holds = new Map();
let acceptedScores = 0, checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function defer(path) {
  const pending = [];
  holds.set(path, pending);
  return {
    get count() { return pending.length; },
    releaseOne(body) { const request = pending.shift(); if (!pending.length) holds.delete(path); request.resolve(json(body)); },
    release(body) { holds.delete(path); for (const p of pending) p.resolve(json(body)); },
    reject() { holds.delete(path); for (const p of pending) p.reject(new Error('fixture delayed failure')); },
  };
}
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input, location), auth = new Headers(options.headers).get('Authorization') || '';
  requests.push({ origin: url.origin, path: url.pathname, auth, method: options.method || 'GET' });
  if (holds.has(url.pathname)) return new Promise((resolve, reject) => holds.get(url.pathname).push({ resolve, reject }));
  if (url.pathname === '/api/ping') return json({ ok: true, name: 'neonfall-server', ratingVersion: 3 });
  if (url.pathname === '/api/logout') return json({ ok: true });
  if (url.pathname === '/api/login') return json({ token: credential(url.origin), user: user(url.origin) });
  if (url.pathname === '/api/me') return auth === 'Bearer ' + credential(url.origin) ? json(user(url.origin)) : json({ error: 'fixture unsigned' }, 401);
  if (url.pathname === '/api/leaderboard') return json([user(url.origin)]);
  if (url.pathname === '/api/scores/mine') return json([]);
  if (url.pathname === '/api/scores') { acceptedScores++; return json({ ok: true, rating: 12, rank: 1 }); }
  throw new Error('Unexpected isolated endpoint: ' + url.pathname);
};
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
function makeApp(store, online = true) {
  const app = Object.create(App.prototype), canvas = createCanvas(1000, 900);
  Object.assign(app, { store, platform: 'web', w: 1000, h: 900, ctx: canvas.getContext('2d'),
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    server: new ServerApi(store.settings.serverUrl, store), serverOnline: online,
    account: { server: online, user: online ? user(store.settings.serverUrl) : store.getProfile() },
    screen: { name: 'account' }, saveSettings() { this.store.saveSettings(); }, toast() {}, uiSound() {}, gotoScreen() {} });
  app.server.setToken(store.getToken()); app.server.online = online; app.ui = new UI(app);
  const screen = new AccountScreen(app); screen.active = true; screen.serverUrl.value = store.settings.serverUrl;
  const controls = [], original = app.ui.button.bind(app.ui);
  app.ui.button = (...args) => { controls.push(args); return original(...args); };
  return { app, screen, draw() { controls.length = 0; app.ui.beginFrame({ x: -1, y: -1, down: false, moved: false }); screen.draw(app.ctx); app.ui.endFrame(); return controls; } };
}
const pendingScores = () => JSON.parse(memory.get('nf.score-sync.v1') || '{}').pending || [];
const localResult = { chartId: 'a'.repeat(40), keys: 4, score: 3200, acc: 1, maxCombo: 10,
  counts: { perfect: 10, great: 0, good: 0, ok: 0, bad: 0, miss: 0, holdTicks: 0 }, stars: 5, pp: 100,
  grade: 'SS', passed: true, mods: [], playedAt: 1000, title: 'Fixture chart', version: '4K', durationMs: 100000 };

const store = new Store(); store.settings.serverUrl = first; store.settings.serverDisconnected = false;
store.createLocalProfile('local_user', 'Local player', ''); store.setToken(credential(first));
const { app, screen, draw } = makeApp(store);
const initialControls = draw();
check(screen.serverUrl.el.disabled, 'connected URL is locked');
check(initialControls.find(args => args[0] === 'connect')?.[5] === 'DISCONNECT', 'connected button offers disconnect');

// Preserve an unsent result and arrange real delayed API requests.
app.screen = { name: 'play' }; const sync = scoreSync(app); sync.submit({ ...localResult }); await settle();
check(pendingScores().length === 1, 'fixture ranked score is durably queued');
app.screen = { name: 'account' };
const latePing = defer('/api/ping'), lateMe = defer('/api/me'), lateBoard = defer('/api/leaderboard'), lateScores = defer('/api/scores/mine');
const inFlight = [app.pingServer(), app.refreshAccount(), screen.loadLeaderboard(), screen.loadMyPlays(), sync.sync()];
check(latePing.count === 1 && lateMe.count === 2 && lateBoard.count === 1 && lateScores.count === 1, 'delayed requests entered actual API path');
const oldApi = app.server; screen.password.value = 'fixture secret'; screen.verifyCode.value = '123456'; screen.disconnectServer();
check(app.server !== oldApi && !app.serverOnline && app.settings.serverDisconnected, 'disconnect replaces identity and clears connection');
check(store.getToken() === '' && oldApi.token === '' && app.server.token === '', 'disconnect clears stored/old/new credentials');
check(!app.account.server && app.account.user.username === 'local_user', 'disconnect restores local profile');
check(screen.password.value === '' && screen.verifyCode.value === '', 'disconnect clears sensitive form values');
check(!app.centralLibrary, 'disconnected web uses local chart library');
check(pendingScores().length === 1 && pendingScores()[0].server === first && pendingScores()[0].username === 'first_user', 'pending score ownership survives disconnect');
const disconnectedControls = draw();
check(!screen.serverUrl.el.disabled, 'server address becomes editable');
check(disconnectedControls.find(args => args[0] === 'connect')?.[5] === 'CONNECT', 'disconnected button offers reconnect');
latePing.release({ ok: true, name: 'neonfall-server' }); lateMe.release(user(first)); lateBoard.release([user(first)]); lateScores.release([{ ...localResult, chartId: 'stale' }]);
await Promise.all(inFlight); await settle();
check(!app.serverOnline && !app.account.server && app.account.user.username === 'local_user', 'late ping/account/sync cannot restore disconnected session');
check(screen.leaderboard.length === 0 && screen.myPlays.every(score => score.chartId !== 'stale'), 'late account lists cannot restore old server data');
check(acceptedScores === 0 && pendingScores().length === 1, 'late sync does not upload or lose queued result');

const requestCount = requests.length;
sync.start();
for (const name of ['online', 'focus', 'visibilitychange']) for (const listener of events.get(name) || []) listener();
await sync.sync(); await app.pingServer(); await app.refreshAccount(); await settle(); sync.stop();
check(requests.length === requestCount, 'poll/start/focus/online events make no requests while disconnected');
const restartedStore = new Store(), restarted = makeApp(restartedStore, false);
check(restartedStore.settings.serverDisconnected && !restarted.app.centralLibrary && restartedStore.getToken() === '', 'restart preserves disconnection and cleared credentials');
scoreSync(restarted.app).restoreCachedAccount(); await scoreSync(restarted.app).sync(); await restarted.app.pingServer(); await restarted.app.refreshAccount();
check(!restarted.app.account.server && requests.length === requestCount, 'cached account does not reconnect after restart');
check(pendingScores().length === 1, 'restart retains unsent score');

// Failed reconnect keeps current disconnected/local state; successful reconnect
// and host switch start anonymously and never forward the previous host token.
const failPing = defer('/api/ping'); screen.serverUrl.value = second;
const failed = screen.connectServer(); failPing.release({ ok: false }); await failed;
check(app.settings.serverDisconnected && app.server.base === first && !app.account.server, 'failed candidate preserves original disconnected state');
screen.serverUrl.value = second; const switchStart = requests.length; await screen.connectServer(); await sync.sync();
check(!app.settings.serverDisconnected && app.server.base === second && app.serverOnline, 'new host reconnect succeeds');
check(!app.account.server && store.getToken() === '', 'new host starts with local profile and no login');
check(requests.slice(switchStart).every(r => !r.auth), 'reconnect requests carry no previous credential');
check(pendingScores().length === 1, 'anonymous new host cannot consume old-host queue');
screen.username.value = 'second_user'; screen.password.value = 'fixture login'; await screen.doLogin(); await sync.sync();
check(app.account.server && app.account.user.username === 'second_user' && acceptedScores === 0, 'different host/user cannot upload first-host result');
screen.disconnectServer(); await settle(); screen.serverUrl.value = first; await screen.connectServer(); await sync.sync();
screen.username.value = 'first_user'; screen.password.value = 'fixture login'; await screen.doLogin(); await sync.sync();
check(app.account.server && app.account.user.username === 'first_user' && acceptedScores === 1 && pendingScores().length === 0, 'explicit original-host login resumes its durable queue');
check(new Store().settings.serverDisconnected === false, 'successful reconnect persists enabled state');

// Anonymous polling has its own ping path and must also ignore a late success.
screen.disconnectServer(); await settle(); screen.serverUrl.value = first; await screen.connectServer(); await sync.sync();
const anonymousPing = defer('/api/ping'), anonymousFlight = sync.sync();
check(anonymousPing.count === 1, 'anonymous background ping is in flight');
screen.disconnectServer(); anonymousPing.release({ ok: true, name: 'neonfall-server' }); await anonymousFlight; await settle();
check(!app.serverOnline && app.settings.serverDisconnected, 'late anonymous sync ping cannot reconnect');

// A failed old leaderboard request must not erase a newly connected host's rows.
screen.serverUrl.value = first; await screen.connectServer(); await sync.sync();
const staleBoard = defer('/api/leaderboard'), oldBoardFlight = screen.loadLeaderboard();
screen.disconnectServer(); await settle(); holds.delete('/api/leaderboard'); screen.serverUrl.value = second;
await screen.connectServer(); await sync.sync();
check(screen.leaderboard[0]?.username === 'second_user', 'new host leaderboard is visible before old failure');
staleBoard.reject(); await oldBoardFlight;
check(screen.leaderboard[0]?.username === 'second_user', 'old leaderboard failure cannot clear newly connected host rows');

// A score already sent when disconnect is clicked must retain its durable
// pending entry; only an acknowledgment for the current account may consume it.
screen.disconnectServer(); await settle(); screen.serverUrl.value = first; await screen.connectServer(); await sync.sync();
screen.username.value = 'first_user'; screen.password.value = 'fixture login'; await screen.doLogin(); await sync.sync();
app.screen = { name: 'play' }; sync.submit({ ...localResult, chartId: 'b'.repeat(40), playedAt: 2000 }); await settle();
app.screen = { name: 'account' };
const lateAck = defer('/api/scores'), sending = sync.sync(); await settle();
check(lateAck.count === 1 && pendingScores().length === 1, 'score request is in flight before disconnect');
screen.disconnectServer(); lateAck.release({ ok: true, rating: 999, rank: 1 }); await sending; await settle();
check(!app.account.server && app.account.user.username === 'local_user' && app.account.user.rating !== 999, 'late score acknowledgment cannot restore account or remote rating');
check(pendingScores().length === 1 && pendingScores()[0].result.chartId === 'b'.repeat(40), 'late acknowledgment cannot discard pending result after disconnect');

// Leaving and reentering clears the screen's busy UI. A still-pending candidate
// must not commit after that lifecycle change or a later explicit disconnect.
const candidatePing = defer('/api/ping'); screen.serverUrl.value = second;
const pendingConnect = screen.connectServer();
check(candidatePing.count === 1, 'candidate connection ping is pending');
screen.leave(); screen.enter(); screen.disconnectServer();
candidatePing.release({ ok: true, name: 'neonfall-server', ratingVersion: 3 }); await pendingConnect; await settle();
check(app.settings.serverDisconnected && !app.serverOnline && !app.account.server, 'late candidate ping cannot undo disconnect after leaving/reentering account');

for (const operation of ['login', 'register']) {
  screen.serverUrl.value = first; await screen.connectServer(); await sync.sync();
  screen.username.value = 'first_user'; screen.password.value = 'fixture-password';
  screen.nickname.value = 'Fixture'; screen.email.value = 'fixture@example.invalid';
  const authReply = defer('/api/' + operation);
  const authenticate = operation === 'login' ? screen.doLogin() : screen.doRegister();
  check(authReply.count === 1, `${operation} request is pending`);
  screen.leave(); screen.enter(); screen.disconnectServer();
  authReply.release({ token: credential(first), user: user(first) }); await authenticate; await settle();
  check(app.settings.serverDisconnected && !app.serverOnline && !app.account.server && store.getToken() === '',
    `late ${operation} cannot restore credentials after disconnect`);
}

// Reentering without disconnect keeps the same API object. An isolated auth
// client must prevent the old response from mutating that object's token, and
// its finally block must leave a newer operation's busy UI intact.
screen.serverUrl.value = first; await screen.connectServer(); await sync.sync();
const competingLogins = defer('/api/login'); screen.username.value = 'first_user'; screen.password.value = 'fixture-password';
const olderLogin = screen.doLogin(); screen.leave(); screen.enter();
screen.username.value = 'first_user'; screen.password.value = 'fixture-password'; const newerLogin = screen.doLogin();
check(competingLogins.count === 2, 'old and new auth requests coexist on same host after reentry');
competingLogins.releaseOne({ token: 'fixture-obsolete-session', user: { ...user(first), username: 'obsolete_user' } }); await olderLogin;
check(screen.busy === 'signing in…', 'stale successful auth completion cannot clear newer busy state');
check(store.getToken() === '' && app.server.token === '' && !app.account.server, 'stale auth cannot mutate same API credentials without an explicit disconnect');
competingLogins.release({ token: credential(first), user: user(first) }); await newerLogin; await sync.sync();
check(screen.busy === '' && app.account.user.username === 'first_user' && store.getToken() === credential(first), 'newer auth alone commits and completes');

const rejectedLogin = defer('/api/login'); screen.password.value = 'fixture-password'; const oldRejectedAuth = screen.doLogin();
screen.leave(); screen.enter(); const newerPing = defer('/api/ping'); screen.serverUrl.value = second; const newerConnect = screen.connectServer();
check(newerPing.count === 1, 'new connection request follows stale login');
rejectedLogin.reject(); await oldRejectedAuth;
check(screen.busy === 'connecting…' && screen.error === '', 'stale auth failure cannot clear newer busy state or overwrite its error');
newerPing.release({ ok: true, name: 'neonfall-server', ratingVersion: 3 }); await newerConnect; await sync.sync();
check(screen.busy === '' && app.server.base === second && !app.account.server && store.getToken() === '', 'newer host switch completes anonymously after stale auth failure');

screen.leave(); restarted.screen.leave(); sync.stop(); scoreSync(restarted.app).stop();
const output = new URL('../test-results/skin-field-refresh/disconnect-report.md', import.meta.url);
fs.writeFileSync(output, `# Server disconnect regression\n\nPASS ${checks} checks. Uses actual AccountScreen, App prototype methods, ServerApi, Store and ScoreSync with in-memory localStorage and intercepted fetch. No real server contact, credentials or user files.\n\nValidated disconnect URL editing/local profile/token clearing; persisted restart state; durable owner-bound score queue; no background reconnect; delayed ping/me/scores/leaderboard isolation; failed candidate preservation; anonymous host switch; explicit login restores only matching host/user queue; old leaderboard rejection cannot clear new host; late score ACK preserves queue and cannot restore remote rating; leaving/reentering and disconnecting invalidates pending candidate ping, login and registration. Same-API reentry without disconnect also rejects old auth token mutations; old success/failure cannot clear a newer busy state or overwrite errors, while newer auth/host switch completes normally.\n\nThe previously reproduced candidate-ping lifecycle race is fixed and its regression passes. No remaining blocker from this scoped test.\n\nNo release build. This is isolated API/UI state verification, not browser/device testing.\n`);
console.log(`PASS server disconnect: ${checks} isolated state/API/UI checks, no external requests.`);
