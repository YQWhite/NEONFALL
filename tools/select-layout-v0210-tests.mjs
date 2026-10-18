import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const output = path.resolve('test-results/v0210/select-layout'); fs.mkdirSync(output, { recursive: true });
for (const file of ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/segoeui.ttf']) if (fs.existsSync(file)) GlobalFonts.registerFromPath(file, file.includes('msyh') ? 'Microsoft YaHei' : 'Segoe UI');
const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { documentElement: {}, activeElement: null, body: { appendChild() {} }, createElement(tag) {
  if (tag === 'canvas') return createCanvas(1, 1);
  return { style: {}, value: '', addEventListener() {}, remove() {}, setAttribute() {}, focus() { document.activeElement = this; }, blur() { document.activeElement = null; } };
} };
const { DEFAULT_SETTINGS, DEFAULT_MODS } = await import('../src/core/types.ts');
const { SelectScreen } = await import('../src/ui/screens/select.ts');
const { UI } = await import('../src/ui/widgets.ts');
const { setLanguage, tr } = await import('../src/ui/i18n.ts');
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const entries = Array.from({ length: 12 }, (_, i) => ({ id: `chart-${i}`, title: `Night Drive ${Math.floor(i / 3)}`, artist: 'Example Artist', creator: 'Neon Mapper', version: ['Normal', 'Hard', 'Extra'][i % 3], keys: 4, stars: 2 + i % 3, notes: 500, lengthMs: 100000, size: 30000, addedAt: 20 - i, server: true, name: `${i}.nfm` }));
const score = (entry, i) => ({ chartId: entry.id, keys: 4, rank: 30 + i, username: 'current', nickname: 'Current player', score: 987654 - i * 10000, scoreVersion: 2, grade: i % 2 ? 'A' : 'S', acc: .97, maxCombo: 500, playedAt: 100, mods: i % 2 ? ['NoTail'] : [], passed: true });
const bests = entries.map(score);
const rows = Array.from({ length: 21 }, (_, i) => ({ ...score(entries[0], i), rank: i + 1, username: `player${i}`, nickname: `Rhythm player ${i}`, isSelf: false }));
const stats = { attempts: 81, passes: 61, passRate: 61 / 81, failureBins: Array.from({ length: 40 }, (_, i) => i % 7 === 0 ? i + 1 : 0), failureSamples: 126 };
let token = 'mock-token', allRequested = false;
const app = {
  w: 1280, h: 800, ctx: null, isTouch: true, platform: 'android', settings: structuredClone(DEFAULT_SETTINGS), mods: structuredClone(DEFAULT_MODS),
  account: { server: true, user: { username: 'current', nickname: 'Current player' } }, serverOnline: true, centralLibrary: false,
  canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, store: { listCharts: async () => entries, getHighScores: () => ({ 'chart-0': { ...bests[0], score: 111111 } }), getChartStats: () => stats, getToken: () => token, getChartBytes: async () => null },
  server: { base: 'https://example.invalid', scoreVersion: 2, statisticsVersion: 1, myScores: async all => { allRequested = all; return bests; }, scores: async () => rows, chartStats: async id => ({ ...stats, personalBest: bests.find(s => s.chartId === id) || null }) },
  menuMusic: { entry: entries[8], select: async () => {}, ensureStarted: async () => {} },
  uiSound() {}, toast() {}, gotoScreen(name) { this.destination = name; }, animateViewChange(change) { change(); },
};
app.ui = new UI(app);
let select = new SelectScreen(app); app.screen = select; select.loadCover = () => {};
await select.enter(); await flush(); await flush();
equal(select.entry().id, 'chart-6', 'entry selects the lowest difficulty of the currently playing song');
equal(select.rows.filter(r => !r.header).length, 3, 'only currently playing song difficulties initially expanded');
check(select.rows.filter(r => !r.header).every(r => r.group.key === select.groups[2].key), 'all other songs are collapsed');
equal(allRequested, true, 'all personal bests requested without legacy 100-row truncation');
equal(select.personalBest(entries[1]).score, bests[1].score, 'unselected difficulty shows logged-in score');
check(select.personalBest(entries[0]).score !== 111111, 'local scores never masquerade as current account PB');

function tapHeader(groupIndex) {
  const row = select.rows.find(r => r.header && r.group.key === select.groups[groupIndex].key);
  const area = select.listArea(); select.scroll = Math.max(0, row.top - 5);
  const x = area.x + 30, y = area.y + row.top - select.scroll + row.height / 2;
  select.pointerDown(x, y); select.pointerUp(x, y);
}
tapHeader(2); equal(select.rows.filter(r => !r.header).length, 0, 'active song header collapses its difficulty tree');
tapHeader(2); equal(select.rows.filter(r => !r.header).length, 3, 'same header reopens every difficulty');
tapHeader(0);
tapHeader(2); equal(select.entry().id, 'chart-6', 'another song header selects its first difficulty');
equal(select.rows.filter(r => !r.header).length, 3, 'opening another song closes previous song');
select.setSel(7); select.leave();
select = new SelectScreen(app); app.screen = select; select.loadCover = () => {};
app.menuMusic.entry = entries[11]; await select.enter(); await flush(); await flush();
equal(select.entry().id, 'chart-9', 'new screen follows the currently playing song and selects its first difficulty');
equal(select.expandedGroup, select.groups[3].key, 'currently playing song is expanded');
select.keyDown('ArrowLeft', {}); equal(select.expandedGroup, null, 'keyboard left collapses');
select.keyDown('ArrowRight', {}); equal(select.expandedGroup, select.groups[3].key, 'keyboard right expands');
select.setSel(8); select.keyDown('ArrowDown', {}); equal(select.entry().id, 'chart-9', 'keyboard traverses into collapsed next song');
equal(select.expandedGroup, select.groups[3].key, 'keyboard selecting next song expands it');
select.search = 'Night Drive 1'; select.applyFilter(); equal(select.entry().id, 'chart-3', 'search chooses available first difficulty');
equal(select.rows.filter(r => !r.header).length, 3, 'search result expands selected group');
select.search = ''; select.applyFilter(); select.setSel(0);

const savedApi = app.server, late = defer();
app.server = { ...savedApi, myScores: () => late.promise };
const oldRequest = select.loadPersonalBests();
token = 'new-token'; app.account.user = { username: 'other', nickname: 'Other' };
app.server = { ...savedApi, myScores: async () => [], scores: async () => [], chartStats: async () => ({ ...stats, personalBest: null }) };
await select.loadPersonalBests(); late.resolve(bests); await oldRequest;
equal(select.personalBest(entries[1]), null, 'late old-account PB cannot leak into unselected rows');
app.server = savedApi; token = 'mock-token'; app.account.user = { username: 'current', nickname: 'Current player' };
await select.loadPersonalBests(); await select.loadChartInfo();

// Bulk PB and detail statistics can straddle an automatic score upload.
// The selected row must use the highest cached score in either response order.
for (const bulkFirst of [true, false]) for (const olderRules of [false, true]) {
  const bulk = defer(), detail = defer(), entry = select.entry();
  const current = { ...bests[0], chartId: entry.id, scoreVersion: 2, score: 900000 };
  const old = { ...current, scoreVersion: olderRules ? 1 : 2, score: olderRules ? 5000000 : 800000 };
  app.server = { ...savedApi, myScores: () => bulk.promise, scores: async () => [], chartStats: () => detail.promise };
  const bulkRequest = select.loadPersonalBests(), detailRequest = select.loadChartInfo();
  if (bulkFirst) { bulk.resolve([current]); await bulkRequest; detail.resolve({ ...stats, personalBest: old }); await detailRequest; }
  else { detail.resolve({ ...stats, personalBest: old }); await detailRequest; bulk.resolve([current]); await bulkRequest; }
  equal(select.personalBest(entry).score, 900000, 'selected PB uses merged current-rule best regardless of stats/bulk order');
}
app.server = savedApi; await select.loadPersonalBests(); await select.loadChartInfo();

// A 0.2.9 host ignores all=1. Expanded-group requests fill an older off-top20 PB,
// without launching an unbounded request for each chart in the full catalogue.
let running = 0, peak = 0, requests = 0;
app.server = { ...savedApi, myScores: async () => [], chartStats: async id => { running++; requests++; peak = Math.max(peak, running); await flush(); running--; return { ...stats, personalBest: bests.find(s => s.chartId === id) || null }; } };
await select.loadPersonalBests(); await select.loadExpandedBests();
equal(select.personalBest(entries[2]).score, bests[2].score, 'old truncated host fills unselected difficulty via stats');
check(peak <= 3 && requests === 3, 'expanded group fallback has at most three concurrent requests');
select.bestGroups.clear(); running = peak = requests = 0;
select.expandedGroup = select.groups[0].key; const groupA = select.loadExpandedBests();
select.expandedGroup = select.groups[1].key; const groupB = select.loadExpandedBests();
select.expandedGroup = select.groups[2].key; const groupC = select.loadExpandedBests();
await Promise.all([groupA, groupB, groupC]);
check(peak <= 3 && requests === 9, 'rapidly opening multiple songs shares the same three-request cap');
select.expandedGroup = select.groups[0].key; select.rebuildRows();
app.server = savedApi; await select.loadPersonalBests(); await select.loadChartInfo();
select.rememberBest(entries[1].id, 4, { ...bests[1], scoreVersion: 1, score: 9999999 });
equal(select.personalBest(entries[1]).scoreVersion, 2, 'historical scale cannot replace modern PB');
select.remoteBests.delete(`${entries[2].id}:4`);
select.rememberBest(entries[2].id, 4, { ...bests[2], scoreVersion: 1, score: 5000000 });
select.rememberBest(entries[2].id, 4, { ...bests[2], scoreVersion: 1, score: 1000000 });
equal(select.personalBest(entries[2]).score, 5000000, 'same-version PB chooses higher score regardless of result order');
select.rememberBest(entries[2].id, 4, bests[2]);
equal(select.personalBest(entries[2]).scoreVersion, 2, 'new-rule score supersedes separately labelled legacy scale');

const controls = [], texts = [], screenshots = [];
const originalButton = app.ui.button.bind(app.ui);
app.ui.button = (...args) => { controls.push({ id: args[0], x: args[1], y: args[2], w: args[3], h: args[4] }); return originalButton(...args); };
function draw(label = '', pointer = {}) {
  controls.length = 0; texts.length = 0;
  const canvas = createCanvas(app.w, app.h); app.ctx = canvas.getContext('2d');
  const fillText = app.ctx.fillText.bind(app.ctx); app.ctx.fillText = (value, x, y, ...rest) => { texts.push({ value: String(value), x, y, font: app.ctx.font }); return fillText(value, x, y, ...rest); };
  app.ui.beginFrame({ x: -10, y: -10, down: false, moved: false, downX: 0, downY: 0, ...pointer }); select.draw(app.ctx); app.ui.endFrame();
  if (label) { const file = `${app.w}x${app.h}-${label}.png`; fs.writeFileSync(path.join(output, file), canvas.toBuffer('image/png')); screenshots.push(file); }
}
function bounded(ids) { for (const id of ids) { const c = controls.find(c => c.id === id); check(c && c.x >= 0 && c.y >= 0 && c.w > 0 && c.h > 0 && c.x + c.w <= app.w + .01 && c.y + c.h <= app.h + .01, `control in view: ${id} ${app.w}x${app.h}`); } }
function click(id) {
  draw(); const c = controls.find(c => c.id === id); check(!!c, `click target ${id}`);
  const p = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
  draw('', { ...p, down: true }); draw('', { ...p, down: false });
}
setLanguage('en'); app.w = 1280; app.h = 800; select.setSel(0); select.resize(); select.scroll = 0; draw();
const normal = texts.find(t => t.value === 'Normal'), hard = texts.find(t => t.value === 'Hard');
const firstPb = texts.find(t => t.value === bests[0].score.toLocaleString()), secondPb = texts.find(t => t.value === bests[1].score.toLocaleString());
check(firstPb && firstPb.y < normal.y, 'selected PB is above difficulty name');
check(secondPb && secondPb.y < hard.y, 'unselected PB is above difficulty name');
check(parseFloat(secondPb.font) > parseFloat(hard.font) || /21px/.test(secondPb.font), 'unselected PB has larger typography than difficulty');
select.remoteBests.set(`${entries[1].id}:4`, { ...bests[1], scoreVersion: 1, score: 5000000 });
draw(); check(texts.some(t => t.value === 'LEGACY'), 'legacy status is visible on unselected difficulty card');
select.remoteBests.set(`${entries[1].id}:4`, bests[1]);
setLanguage('zh-CN');
for (const [w, h] of [[568, 320], [780, 360], [1024, 600], [1280, 800]]) {
  app.w = w; app.h = h; select.resize(); select.scroll = 0; select.detailScroll = 0; select.infoTab = 'rankings'; select.showChartActions = false;
  draw('rankings'); bounded(['play', 'mods', 'chart-rankings', 'chart-details']);
  const tabs = controls.filter(c => c.id === 'chart-rankings' || c.id === 'chart-details');
  check(tabs.every(c => c.y + c.h <= select.detailViewport.y), 'tabs stay above scrolling content');
  check(controls.find(c => c.id === 'play').y >= select.detailViewport.y + select.detailViewport.h, 'actions stay below scrolling content');
  if (h < 600) {
    click('chart-actions'); draw('actions'); bounded(['download', 'export', 'chart-actions']);
    select.keyDown('Escape', {}); equal(select.showChartActions, false, 'Escape dismisses tools without leaving song selection');
    click('chart-actions'); click('mods'); check(select.showMods && !select.showChartActions, 'opening mods dismisses tools so mod controls remain enabled');
    select.setModsVisible(false);
  }
  else bounded(['download', 'export']);
  click('chart-details'); equal(select.infoTab, 'details', 'details tab responds to actual click');
  draw('details-top');
  if (select.detailContentH > select.detailViewport.h) {
    const r = select.detailViewport; select.pointerDown(r.x + r.w / 2, r.y + r.h - 3); select.pointerMove(r.x + r.w / 2, r.y + 3); select.pointerUp(r.x + r.w / 2, r.y + 3);
    check(select.detailScroll > 0, 'touch scroll reaches lower details');
    select.detailScroll = 170; draw('details-graph');
  }
  click('chart-rankings'); equal(select.infoTab, 'rankings', 'fixed tabs remain clickable after scrolling');
}
select.leave();
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, screenshots }, null, 2));
console.log(`PASS select layout v0.2.10: ${checks} checks; ${screenshots.length} screenshots; synthetic data only.`);
