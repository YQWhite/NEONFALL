import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const output = path.resolve('test-results/v029/select-rankings'); fs.mkdirSync(output, { recursive: true });
for (const file of ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/segoeui.ttf']) if (fs.existsSync(file)) GlobalFonts.registerFromPath(file, file.includes('msyh') ? 'Microsoft YaHei' : 'Segoe UI');
const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { documentElement: {}, activeElement: null, body: { appendChild() {} }, createElement(tag) {
  if (tag === 'canvas') return createCanvas(1, 1);
  return { style: {}, value: '', addEventListener() {}, remove() {}, setAttribute() {}, focus() { document.activeElement = this; }, blur() { document.activeElement = null; } };
} };
const { Store } = await import('../src/core/store.ts');
const { DEFAULT_SETTINGS, DEFAULT_MODS } = await import('../src/core/types.ts');
const { SelectScreen } = await import('../src/ui/screens/select.ts');
const { RankingsScreen } = await import('../src/ui/screens/rankings.ts');
const { modsLabel } = await import('../src/ui/mod-labels.ts');
const { UI } = await import('../src/ui/widgets.ts');
const { setLanguage, tr } = await import('../src/ui/i18n.ts');
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const base = { chartId: 'chart-one', keys: 4, score: 900000, acc: 1, maxCombo: 100, counts: { perfect: 100, great: 0, good: 0, ok: 0, bad: 0, miss: 0, holdTicks: 0 }, stars: 4, pp: 0, grade: 'SS', mods: ['NoTail'], passed: true, playedAt: 10, title: 'Song', version: 'Hard', durationMs: 100000, scoreVersion: 2, playId: 'local-0001' };
const store = new Store();
store.submitLocalScore(structuredClone(base));
const higherScore = { ...structuredClone(base), score: 960000, acc: .96, grade: 'S', mods: [], playedAt: 11, playId: 'local-0002' };
store.submitLocalScore(higherScore);
equal(store.getBest('chart-one').playId, 'local-0001', 'rating best remains independent of score best');
equal(store.getHighScore('chart-one').playId, 'local-0002', 'highest normalized score replaces lower-score higher-pp run');
store.submitLocalScore({ ...structuredClone(base), scoreVersion: undefined, score: 5000000, playId: 'legacy-01', playedAt: 9 });
equal(store.getHighScore('chart-one').score, 960000, 'legacy scale cannot displace million-point PB');
store.submitLocalScore({ ...structuredClone(base), passed: false, grade: 'F', score: 200000, failedAtMs: 25000, playId: 'failed-01' });
store.submitLocalScore({ ...structuredClone(base), passed: false, grade: 'F', score: 200000, failedAtMs: 25000, playId: 'failed-01' });
let stats = store.getChartStats('chart-one');
equal(stats.attempts, 4, 'one retry upload/playId does not create duplicate attempt');
equal(stats.passes, 3, 'all completed runs count even when they do not improve PB');
equal(stats.failureBins[10], 1, 'failure maps to quarter-song bin');
equal(stats.passRate, .75, 'pass rate uses real attempts');
store.submitLocalScore({ ...structuredClone(base), passed: false, grade: 'F', score: 10000, playId: 'unknown-position' });
equal(store.getChartStats('chart-one').failureSamples, 1, 'unknown historical failure position is not invented');
store.submitLocalScore({ ...structuredClone(base), mods: ['Auto'], playId: 'auto-attempt', score: 1000000 });
equal(store.getChartStats('chart-one').attempts, 5, 'autoplay excluded from completion statistics');
equal(store.getHighScore('chart-one').score, 960000, 'autoplay cannot overwrite score PB');
equal(new Store().getChartStats('chart-one').failureBins[10], 1, 'attempt statistics persist');
const historical = { ...structuredClone(base), chartId: 'migration-case', scoreVersion: undefined, score: 5000000, acc: .5, mods: [], playId: undefined };
const savedPpBest = JSON.parse(memory.get('nf.scores.v1')); savedPpBest['migration-case'] = historical;
memory.set('nf.scores.v1', JSON.stringify(savedPpBest));
store.submitLocalScore({ ...historical, score: 1000000, acc: .99, playedAt: 99 });
equal(store.getHighScore('migration-case').score, 5000000, 'first migrated low-score high-pp run preserves existing historical score PB');
store.submitLocalScore({ ...historical, scoreVersion: 2, score: 950000, acc: .999, playedAt: 100, playId: 'new-migration' });
equal(store.getHighScore('migration-case').score, 950000, 'new-rule PB has its separate scale after migration');
equal(JSON.parse(memory.get('nf.highscores.v2'))['migration-case']['1'].score, 5000000, 'existing historical score remains stored when new rating PB replaces it');
setLanguage('en'); equal(modsLabel(['NoTail', 'ConstantSpeed']), 'NO TAIL · CONSTANT SPEED', 'mods readable on both leaderboards');

const entries = Array.from({ length: 12 }, (_, i) => ({ id: i ? `chart-${i}` : 'chart-one', title: `Night Drive ${Math.floor(i / 3)}`, artist: 'Example Artist', creator: 'Neon Mapper', version: ['Normal', 'Hard', 'Extra'][i % 3], keys: 4, stars: 2 + i % 3, notes: 500, lengthMs: 100000, size: 30000, addedAt: 20 - i, server: true, name: `${i}.nfm` }));
const serverRows = Array.from({ length: 25 }, (_, i) => ({ rank: i + 1, username: 'player' + i, nickname: 'Rhythm Player ' + i, avatar: `/api/avatars/player${i}/` + 'a'.repeat(64) + '.png', score: 998000 - i * 1200, acc: 1 - i / 1000, maxCombo: 700, playedAt: 100, mods: i % 2 ? ['NoTail'] : [], scoreVersion: 2, grade: 'S', rating: 150 - i, bestPp: 250 - i, totalScore: 15000000 - i * 10000, accuracy: .99 - i / 1000, clears: 20 - i % 10 }));
const ownScore = { ...serverRows[0], rank: 35, username: 'current', nickname: 'Current player', score: 865432, grade: 'A' };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
let token = 'test-token';
const app = {
  w: 1280, h: 800, ctx: null, isTouch: true, platform: 'android', settings: structuredClone(DEFAULT_SETTINGS), mods: structuredClone(DEFAULT_MODS),
  account: { server: true, user: { username: 'current', nickname: 'Current player' } }, serverOnline: true, centralLibrary: true,
  canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, store: { getHighScores: () => store.getHighScores(), getBestScores: () => store.getBestScores(), getChartStats: id => store.getChartStats(id), getToken: () => token, getChartBytes: async () => null },
  server: { base: 'https://example.invalid', scoreVersion: 2, statisticsVersion: 1, scores: async () => serverRows, chartStats: async () => ({ ...store.getChartStats('chart-one'), personalBest: ownScore }), leaderboard: async () => serverRows },
  menuMusic: { entry: entries[0], select: async () => {}, ensureStarted: async () => {} },
  uiSound() {}, toast() {}, gotoScreen(name) { this.destination = name; }, animateViewChange(change) { change(); },
};
app.ui = new UI(app);
const select = new SelectScreen(app); app.screen = select; select.active = true; select.entries = entries; select.applyFilter(); select.loadCover = () => {};
await select.loadChartInfo();
equal(select.personalBest(select.entry()).rank, 35, 'own server best loads even outside visible top20');
equal(select.chartScores.length, 25, 'chart leaderboard loaded');
equal(select.statsSource, 'server', 'server statistics labelled separately');
check(select.personalBest(select.entry()).score !== store.getHighScore('chart-one').score, 'server account does not inherit another local player best');
const delayed = deferred(), savedApi = app.server;
savedApi.scores = () => delayed.promise;
const pending = select.loadChartInfo();
app.server = { ...savedApi, scores: async () => [], chartStats: async () => ({ attempts: 0, passes: 0, passRate: null, failureBins: [], failureSamples: 0, personalBest: null }) };
await select.loadChartInfo(); delayed.resolve(serverRows); await pending;
equal(select.chartScores, [], 'late old-server chart response cannot overwrite new connection');
equal(select.remoteBest, null, 'late old-server own PB cannot leak across servers');
app.server = { ...savedApi, scores: async () => serverRows };
await select.loadChartInfo();
const staleSelection = deferred(); app.server.scores = () => staleSelection.promise;
const pendingSelection = select.loadChartInfo(); select.sel = 1; app.server.scores = async () => []; await select.loadChartInfo(); staleSelection.resolve(serverRows); await pendingSelection;
equal(select.chartScores, [], 'old difficulty response cannot populate next difficulty');
const sameUser = deferred(); app.server.scores = () => sameUser.promise; const sameUserPending = select.loadChartInfo();
app.account.user = { ...app.account.user, rating: 123 }; sameUser.resolve(serverRows); await sameUserPending;
equal(select.chartScores.length, 25, 'same-user profile refresh does not discard scores');
const staleAuth = deferred(); app.server.scores = () => staleAuth.promise; const staleAuthPending = select.loadChartInfo(); token = 'other-token'; staleAuth.resolve(serverRows); await staleAuthPending;
equal(select.chartScores.length, 0, 'old authenticated request cannot populate after account token changes');
let requestedScoreVersion;
app.server = { ...savedApi, scoreVersion: 0, statisticsVersion: 0, scores: async (_id, _keys, version) => { requestedScoreVersion = version; return [{ ...ownScore, scoreVersion: 1, score: 5000000 }]; } };
await select.loadChartInfo();
equal(requestedScoreVersion, 1, 'legacy server explicitly requests legacy scores instead of million-point table');
equal(select.personalBest(select.entry()).score, 5000000, 'legacy personal best remains readable on old server');
app.server = { ...savedApi, scores: async () => serverRows }; await select.loadChartInfo();
const board = new RankingsScreen(app); app.screen = board; board.enter(); await board.reload(); equal(board.rows.length, 25, 'global ranking supports public avatar rows');
const staleMetric = deferred(); app.server.leaderboard = metric => metric === 'rating' ? staleMetric.promise : Promise.resolve([{ ...serverRows[0], username: 'accuracy-winner' }]);
const pendingMetric = board.reload(); board.metric = 'accuracy'; await board.reload(); staleMetric.resolve(serverRows); await pendingMetric;
equal(board.rows[0].username, 'accuracy-winner', 'late previous metric does not overwrite active metric');
app.server.statisticsVersion = 0; board.metric = 'totalScore'; await board.reload(); check(board.error.includes('overall'), 'old server detailed ranks show supported fallback notice');
equal(board.rows.length, 0, 'old server does not mislabel rating rows as total score');
app.server.statisticsVersion = 1; app.server.leaderboard = async () => serverRows; board.metric = 'rating'; await board.reload();

const controls = [], screenshots = [], renderedText = [];
const originalButton = app.ui.button.bind(app.ui), originalChip = app.ui.chip.bind(app.ui), originalSlider = app.ui.slider.bind(app.ui);
for (const [name, original] of [['button', originalButton], ['chip', originalChip], ['slider', originalSlider]]) app.ui[name] = (...args) => { controls.push({ id: args[0], x: args[1], y: args[2], w: args[3], h: args[4] }); return original(...args); };
function draw(screen, label, pointer = {}) {
  app.screen = screen; controls.length = 0; renderedText.length = 0; const canvas = createCanvas(app.w, app.h); app.ctx = canvas.getContext('2d');
  const fillText = app.ctx.fillText.bind(app.ctx); app.ctx.fillText = (...args) => { renderedText.push(String(args[0])); return fillText(...args); };
  app.ui.beginFrame({ x: -10, y: -10, down: false, moved: false, downX: 0, downY: 0, ...pointer }); screen.draw(app.ctx); app.ui.endFrame();
  if (label) { const file = `${app.w}x${app.h}-${label}.png`; fs.writeFileSync(path.join(output, file), canvas.toBuffer('image/png')); screenshots.push(file); }
}
function bounded(ids) { for (const id of ids) { const c = controls.find(c => c.id === id); check(c && c.x >= 0 && c.y >= 0 && c.w > 0 && c.h > 0 && c.x + c.w <= app.w + .01 && c.y + c.h <= app.h + .01, `visible control ${id} at ${app.w}x${app.h}`); } }
function click(screen, id) {
  draw(screen); const c = controls.find(c => c.id === id); check(!!c, `click target exists ${id}`);
  const p = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
  draw(screen, '', { ...p, down: true }); draw(screen, '', { ...p, down: false });
}
select.remoteBest = { ...ownScore, scoreVersion: 1, score: 5000000 }; select.infoTab = 'rankings'; select.detailScroll = 0;
draw(select);
check(renderedText.some(value => value.includes('PERSONAL BEST') && value.includes('LEGACY')), 'legacy label is rendered in the visible personal-best card while rankings tab is active');
setLanguage('zh-CN');
for (const [w, h] of [[568, 320], [780, 360], [1280, 800]]) {
  app.w = w; app.h = h; select.sel = 0; select.chartScores = serverRows; select.remoteBest = ownScore; select.chartStats = { ...store.getChartStats('chart-one'), failureBins: Array.from({ length: 40 }, (_, i) => i % 7 === 0 ? i + 1 : 0), failureSamples: 99 }; select.resize(); select.detailScroll = 0; select.infoTab = 'rankings';
  draw(select, 'select-rankings'); bounded(['play', 'mods', 'download', 'export', 'chart-rankings', 'chart-details']);
  if (h < 500) {
    check(renderedText.includes(tr('SCORES')), 'mobile score tab caption is not ambiguously truncated');
    check(renderedText.includes(tr('DETAILS')), 'mobile details tab caption is not ambiguously truncated');
  }
  click(select, 'chart-details'); equal(select.infoTab, 'details', 'details tab responds to a real pointer gesture');
  click(select, 'chart-rankings'); equal(select.infoTab, 'rankings', 'rankings tab responds to a real pointer gesture');
  select.infoTab = 'details'; select.detailScroll = h < 500 ? 140 : 0; draw(select, 'select-details');
  select.showMods = true; draw(select, 'mods'); bounded(['mod-noTail', 'mod-constantSpeed', 'mod-speed', 'mods-close']); select.showMods = false;
  board.metric = 'rating'; board.rows = serverRows; board.scroll = 0; draw(board, 'rankings'); bounded(['rank-back', 'rank-refresh', 'rank-rating', 'rank-bestPp', 'rank-totalScore', 'rank-accuracy', 'rank-clears']);
  const area = board.area(); board.pointerDown(area.x + 100, area.y + area.h - 5); board.pointerMove(area.x + 100, area.y + 5); board.pointerUp(); check(board.scroll > 0, 'global ranking touch scroll works');
}
select.leave(); board.leave();
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, screenshots }, null, 2));
console.log(`PASS select/rankings: ${checks} checks, ${screenshots.length} screenshots; in-memory data and no live server.`);
