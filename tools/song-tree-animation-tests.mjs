import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const output = path.resolve('test-results/v0210/song-tree-animation');
fs.mkdirSync(output, { recursive: true });
for (const name of ['segoeui.ttf', 'msyh.ttc']) {
  const file = `C:/Windows/Fonts/${name}`;
  if (fs.existsSync(file)) GlobalFonts.registerFromPath(file, name === 'msyh.ttc' ? 'Microsoft YaHei' : 'Segoe UI');
}
let reduced = false;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: reduced }) };
globalThis.document = { documentElement: {}, activeElement: null, body: { appendChild() {} }, createElement(tag) {
  if (tag === 'canvas') return createCanvas(1, 1);
  return { style: {}, value: '', addEventListener() {}, remove() {}, setAttribute() {}, focus() { document.activeElement = this; }, blur() { document.activeElement = null; } };
} };
const { DEFAULT_SETTINGS, DEFAULT_MODS } = await import('../src/core/types.ts');
const { SelectScreen } = await import('../src/ui/screens/select.ts');
const { UI } = await import('../src/ui/widgets.ts');
const { setLanguage } = await import('../src/ui/i18n.ts');
setLanguage('en');
const entries = Array.from({ length: 15 }, (_, i) => ({ id: `animation-${i}`, title: ['Night Drive', 'Skyline', 'Aurora', 'Daybreak', 'Afterglow'][Math.floor(i / 3)], artist: 'Example Artist', creator: 'Mapper', version: ['Normal', 'Hard', 'Extra'][i % 3], keys: 4, stars: 2 + i % 3, notes: 500, lengthMs: 100000, addedAt: 20 - i, name: `${i}.nfm` }));
const app = {
  w: 1280, h: 800, ctx: null, isTouch: true, settings: structuredClone(DEFAULT_SETTINGS), mods: structuredClone(DEFAULT_MODS),
  account: { server: false }, serverOnline: false, centralLibrary: false, server: {},
  store: { listCharts: async () => entries, getHighScores: () => Object.fromEntries(entries.map((entry, i) => [entry.id, { score: 987654 - i * 1000, scoreVersion: 2, grade: 'S' }])), getChartBytes: async () => null },
  canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
  menuMusic: { entry: entries[0], select: async () => {}, ensureStarted: async () => {} },
  uiSound() {}, toast() {}, gotoScreen() {},
};
app.ui = new UI(app);
const screen = new SelectScreen(app); app.screen = screen; screen.loadCover = () => {};
await screen.enter(); await new Promise(resolve => setImmediate(resolve));
clearTimeout(screen.previewTimer); screen.previewTimer = null;
const schedulePreview = screen.schedulePreview.bind(screen);
let previews = 0; screen.schedulePreview = () => { previews++; };
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const equal = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const position = () => screen.visualRows.map(row => ({ index: row.index, header: row.header, top: row.top, reveal: row.reveal }));
const child = index => screen.visualRows.find(row => !row.header && row.index === index);
const geometry = () => {
  let bottom = 0;
  for (const row of screen.visualRows) {
    check(row.top >= bottom - .001 && row.visibleHeight > 0 && row.visibleHeight <= row.height + .001, 'animated row bounds do not overlap');
    bottom = row.top + row.visibleHeight;
  }
  check(screen.visualListHeight >= bottom, 'scroll extent includes visible rows');
};
function draw(name) {
  const canvas = createCanvas(app.w, app.h); app.ctx = canvas.getContext('2d');
  app.ui.beginFrame({ x: -10, y: -10, down: false, moved: false, downX: 0, downY: 0 });
  screen.draw(app.ctx); app.ui.endFrame();
  if (name) fs.writeFileSync(path.join(output, `${app.w}x${app.h}-${name}.png`), canvas.toBuffer('image/png'));
  return canvas;
}
function tapVisual(row) {
  const area = screen.listArea();
  screen.scroll = Math.max(0, row.top - 5);
  const x = area.x + area.w / 2, y = area.y + row.top - screen.scroll + row.visibleHeight / 2;
  screen.pointerDown(x, y); screen.pointerUp(x, y);
}

draw('before');
const before = position(), oldHeight = screen.visualListHeight;
screen.setSel(3);
equal(position(), before, 'switch starts from exact existing geometry');
equal(screen.visualListHeight, oldHeight, 'switch does not instantly jump scroll extent');
check(screen.treeMotion.size === 2, 'old and new tree animate together');
equal(previews, 1, 'song change requests preview only once');
screen.update(50, 50); geometry(); draw('50ms');
check(child(3).reveal > child(4).reveal && child(4).reveal > child(5).reveal, 'new difficulties unzip in order');
check(child(0).reveal > child(1).reveal && child(1).reveal > child(2).reveal, 'old difficulties close bottom first');
const closing = child(0);
screen.pointerDown(screen.listArea().x + 40, screen.listArea().y + closing.top - screen.scroll + closing.visibleHeight / 2);
check(!screen.listDrag?.row, 'closing difficulty cannot be selected');
screen.listDrag = null;
const interrupted = position(); screen.setSel(6);
equal(position(), interrupted, 'rapid next song preserves every intermediate row position');
screen.update(60, 110); geometry(); draw('interrupted');
const opening = child(7); check(opening && opening.reveal > 0, 'opening row is visible before animation finishes');
tapVisual(opening); equal(screen.entry().id, entries[7].id, 'tap follows visible animated difficulty coordinates');
screen.update(500, 610); geometry(); draw('settled');
equal(screen.treeMotion.size, 0, 'completed transitions release motion data');
equal(screen.visualRows.filter(row => !row.header).map(row => row.index), [6, 7, 8], 'settled tree contains only selected song');
equal(screen.visualListHeight, screen.listHeight, 'settled visual and logical list extents agree');
equal(screen.visualRows.map(({ reveal, visibleHeight, interactive, ...row }) => row), screen.rows, 'settled rows match final layout exactly');

const header = screen.visualRows.find(row => row.header && row.group.key === screen.expandedGroup);
tapVisual(header); screen.update(75, 685); geometry();
check(child(6)?.reveal > 0 && child(6).reveal < 1, 'manual collapse animates');
screen.keyDown('ArrowRight', {}); const reopening = position(); screen.update(0, 685);
equal(position(), reopening, 'keyboard reversal keeps continuous geometry');
screen.update(500, 1185); equal(screen.visualRows.filter(row => !row.header).length, 3, 'keyboard reopen finishes normally');

for (const [w, h] of [[1280, 800], [780, 360], [568, 320]]) {
  app.w = w; app.h = h; screen.resize(); screen.setSel(0); screen.update(500, 2000); draw('start');
  screen.setSel(9);
  let elapsed = 0;
  for (const dt of [30, 40, 70, 100, 200]) {
    elapsed += dt; screen.update(dt, 2000 + elapsed); geometry(); draw(`switch-${elapsed}ms`);
    check(Number.isFinite(screen.scroll) && screen.scroll >= 0, 'scroll stays finite and nonnegative while expanding');
  }
  const selected = screen.visualRows.find(row => !row.header && row.index === screen.sel), area = screen.listArea();
  check(selected.top + selected.height <= screen.scroll + area.h + .01, 'selected difficulty remains reachable after animated reveal');
  equal(screen.entry().id, entries[9].id, 'animation frames never change selection');
}

// Header/row geometry and the automatic viewport must finish on the same
// frame, with zero endpoint velocity rather than a late clamp or scroll drift.
screen.setSel(0); screen.update(500, 2800); draw();
screen.setSel(9);
const cachedHeader = screen.visualRows.find(row => row.header && row.index === 9);
screen.update(330, 3130); draw();
const at330 = screen.visualRows.find(row => row.header && row.index === 9).top - screen.scroll;
screen.update(15, 3145); draw();
const at345 = screen.visualRows.find(row => row.header && row.index === 9).top - screen.scroll;
screen.update(14, 3159); draw();
const nearEnd = position(), beforeFinishScroll = screen.scroll;
const at359 = screen.visualRows.find(row => row.header && row.index === 9).top - screen.scroll;
screen.update(1, 3160); draw();
const finished = position(), afterFinishScroll = screen.scroll;
equal(screen.treeMotion.size, 0, 'tree finishes at shared 360ms deadline');
equal(screen.scrollMotion, null, 'automatic scrolling finishes with tree, without trailing drift');
check(Math.abs(afterFinishScroll - beforeFinishScroll) < .01, 'final viewport clamp is subpixel');
for (const row of finished) {
  const before = nearEnd.find(candidate => candidate.index === row.index && candidate.header === row.header);
  check(before && Math.abs(row.top - before.top) < .01 && Math.abs(row.reveal - before.reveal) < .001, 'final row cleanup has no position snap');
}
check(Math.abs(at359 - at345) / 14 < Math.abs(at345 - at330) / 15, 'visible song header decelerates into its endpoint');
equal(screen.visualRows.find(row => row.header && row.index === 9), cachedHeader, 'animation reuses header object instead of recreating every frame');
screen.update(32, 3192); draw(); equal(position(), finished, 'following frame does not reflow the final tree');
equal(screen.scroll, afterFinishScroll, 'following frame does not continue automatic scrolling');

screen.setSel(3); screen.update(70, 3000); reduced = true; screen.update(0, 3000);
equal(screen.treeMotion.size, 0, 'reduced motion change immediately finishes running tree');
equal(screen.detailEntrance, 1, 'reduced motion completes detail entrance');
screen.setSel(0); equal(screen.treeMotion.size, 0, 'reduced motion starts no new tree animation');
equal(screen.visualListHeight, screen.listHeight, 'reduced motion shows final geometry immediately');
reduced = false; screen.setSel(6); screen.update(40, 3040); screen.resize();
equal(screen.treeMotion.size, 0, 'resize reflows without retaining stale animation geometry');
screen.setSel(3); screen.update(40, 3080); screen.search = 'Afterglow'; screen.applyFilter();
equal(screen.treeMotion.size, 0, 'filter removes old animated row references');
check(screen.visualRows.every(row => row.group.title === 'Afterglow' || row.group.charts[0].title === 'Afterglow'), 'filter shows only current result rows');

// Compare actual rendered background pixels. Old and new images remain opaque
// under the soft mask, including interruption while both images are visible.
function background(color) {
  const canvas = createCanvas(96, 60), ctx = canvas.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height);
  canvas.complete = true; canvas.naturalWidth = canvas.width; canvas.naturalHeight = canvas.height;
  return canvas;
}
const red = background('#ed6547'), blue = background('#407cdd'), green = background('#65cd88');
function backdropFrame() {
  const canvas = createCanvas(app.w, app.h); screen.drawBackdrop(canvas.getContext('2d'), app.w, app.h); return canvas;
}
const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
function sameFrame(a, b, message) {
  const ap = pixels(a), bp = pixels(b); let max = 0;
  for (let i = 0; i < ap.length; i++) max = Math.max(max, Math.abs(ap[i] - bp[i]));
  check(max <= 2, `${message} (max channel difference ${max})`);
}
reduced = true; screen.changeBackdrop(red, 'red'); reduced = false;
const redFrame = backdropFrame(); screen.changeBackdrop(blue, 'blue');
sameFrame(redFrame, backdropFrame(), 'new image starts at exact previous visible background');
screen.update(325, 4000);
const mixed = backdropFrame(); fs.writeFileSync(path.join(output, 'backdrop-mid-mask.png'), mixed.toBuffer('image/png'));
const redPixel = pixels(redFrame).slice(0, 3), mixedPixel = pixels(mixed).slice(0, 3);
check(mixedPixel[2] > redPixel[2] && mixedPixel[0] < redPixel[0], 'soft mask displays both previous and new colors mid-transition');
screen.changeBackdrop(green, 'green');
sameFrame(mixed, backdropFrame(), 'rapid third background continues the visible blend without flashing black');
screen.update(650, 4650);
check(!screen.backdropFrom, 'completed background releases old composite');
const settled = backdropFrame();
screen.changeBackdrop(green, 'same-picture-new-chart');
for (const dt of [50, 100, 150, 200, 150]) { screen.update(dt, 4800); sameFrame(settled, backdropFrame(), 'identical art stays equally bright throughout mask fade'); }
screen.changeBackdrop(null, 'missing-art'); const withMissing = backdropFrame();
sameFrame(settled, withMissing, 'missing next background also starts from the visible art');
screen.update(650, 5500); equal(Array.from(pixels(backdropFrame()).slice(0, 4)), [13, 18, 24, 255], 'intentional missing art fades to normal theme backdrop');
reduced = true; screen.changeBackdrop(red, 'reduced-art');
equal(screen.backdropFade, 1, 'reduced motion replaces background immediately');
check(!screen.backdropFrom, 'reduced motion does not retain a transition snapshot');
reduced = false;

const previousList = app.store.listCharts, previousBackground = app.menuMusic.background;
let finishCatalogue;
app.store.listCharts = () => new Promise(resolve => { finishCatalogue = resolve; });
app.menuMusic.background = red;
const inheritedScreen = new SelectScreen(app); app.screen = inheritedScreen;
await inheritedScreen.enter();
equal(inheritedScreen.backdrop, red, 'library inherits shared-player decoded background synchronously');
equal(inheritedScreen.backdropFade, 1, 'inherited art is fully visible before library or image requests finish');
const inheritedFrame = createCanvas(app.w, app.h);
inheritedScreen.drawBackdrop(inheritedFrame.getContext('2d'), app.w, app.h);
sameFrame(redFrame, inheritedFrame, 'opening song selection shows existing art without initial black fade');
inheritedScreen.leave(); finishCatalogue([]); await new Promise(resolve => setImmediate(resolve));
app.store.listCharts = previousList; app.menuMusic.background = previousBackground; app.screen = screen;

const previousEntry = app.menuMusic.entry, previousPlaying = app.menuMusic.playingChart, previousLoading = app.menuMusic.loading;
async function enteredScreen() {
  const selection = new SelectScreen(app); app.screen = selection;
  selection.loadCover = () => {};
  const audioRequests = []; selection.schedulePreview = selectAudio => audioRequests.push(selectAudio);
  await selection.enter(); await new Promise(resolve => setImmediate(resolve));
  return { selection, audioRequests };
}
app.menuMusic.entry = entries[14]; app.menuMusic.playingChart = entries[8]; app.menuMusic.loading = true;
let opened = await enteredScreen();
equal(opened.selection.entry().id, entries[6].id, 'enter selects first difficulty of audible song, not pending replacement');
equal(opened.audioRequests, [false], 'entering audible song does not restart audio or cancel pending replacement');
equal(opened.selection.expandedGroup, opened.selection.groups[2].key, 'audible song is expanded immediately');
opened.selection.setSel(9); opened.selection.update(16, 6400);
equal(opened.selection.entry().id, entries[9].id, 'manual next selection is not reverted while old recording finishes decoding');
app.menuMusic.playingChart = entries[11]; app.menuMusic.entry = entries[11]; app.menuMusic.loading = false;
opened.selection.update(16, 6416); opened.selection.setSel(10); opened.selection.leave();
opened = await enteredScreen();
equal(opened.selection.entry().id, entries[9].id, 'reenter follows playing song first difficulty instead of prior harder chart');
opened.selection.leave(); app.menuMusic.playingChart = entries[5]; app.menuMusic.entry = entries[5];
opened = await enteredScreen();
equal(opened.selection.entry().id, entries[3].id, 'each visit follows newly playing song, not first catalogue item');
opened.selection.setSel(4); opened.selection.leave();
app.menuMusic.playingChart = null; app.menuMusic.entry = null;
opened = await enteredScreen();
equal(opened.selection.entry().id, entries[3].id, 'without playback fall back to remembered song first difficulty');
opened.selection.leave();
app.menuMusic.playingChart = { ...entries[0], id: 'outside', title: 'Outside current catalogue' }; app.menuMusic.entry = app.menuMusic.playingChart;
opened = await enteredScreen();
equal(opened.selection.entry().id, entries[3].id, 'absent current recording falls back to remembered available song');
opened.selection.leave();
app.menuMusic.entry = previousEntry; app.menuMusic.playingChart = previousPlaying; app.menuMusic.loading = previousLoading; app.screen = screen;

// Exercise the production asynchronous Image callbacks, not only the blend
// helper. A pending or failed decode must leave old art visible, and a late
// prior-song load is ignored by the existing selection generation guard.
const realTimeout = globalThis.setTimeout, realImage = globalThis.Image;
const scheduled = [], images = [];
const flushImages = () => new Promise(resolve => setImmediate(resolve));
globalThis.setTimeout = callback => { scheduled.push(callback); return { fake: true }; };
globalThis.Image = class {
  constructor() {
    const image = background('#407cdd'); images.push(image); return image;
  }
};
try {
  screen.search = ''; screen.applyFilter();
  screen.sel = 0;
  app.previewChart = { id: screen.entry().id, archive: { chart: { meta: { bg: 'bg.png' } }, files: new Map([['bg.png', new Uint8Array([1])]]) } };
  const beforeLoad = backdropFrame(); schedulePreview(false); const oldLoad = scheduled.shift()(); await flushImages();
  sameFrame(beforeLoad, backdropFrame(), 'pending decode keeps previous background');
  const lateImage = images.at(-1);
  screen.sel = 3;
  app.previewChart = { id: screen.entry().id, archive: { chart: { meta: { bg: 'bg.png' } }, files: new Map([['bg.png', new Uint8Array([2])]]) } };
  schedulePreview(false); const latestLoad = scheduled.shift()(); await flushImages(); const latestImage = images.at(-1);
  lateImage.onload(); await oldLoad; sameFrame(beforeLoad, backdropFrame(), 'late old-song image does not commit');
  latestImage.onload(); await latestLoad; equal(screen.backdrop, latestImage, 'latest decoded image becomes transition destination');
  sameFrame(beforeLoad, backdropFrame(), 'decoded image begins continuous transition rather than fade from black');
  screen.update(650, 6200);
  const beforeError = backdropFrame();
  screen.sel = 6;
  app.previewChart = { id: screen.entry().id, archive: { chart: { meta: { bg: 'bg.png' } }, files: new Map([['bg.png', new Uint8Array([3])]]) } };
  schedulePreview(false); const failedLoad = scheduled.shift()(); await flushImages(); images.at(-1).onerror(); await failedLoad;
  sameFrame(beforeError, backdropFrame(), 'image decode failure preserves current artwork');
  const previousSelect = app.menuMusic.select, previousFetch = app.store.getChartBytes;
  let redundantFetches = 0;
  try {
    screen.sel = 9; app.previewChart = null;
    app.menuMusic.select = async selected => {
      app.previewChart = { id: selected.id, archive: { chart: { meta: { bg: 'bg.png' } }, files: new Map([['bg.png', new Uint8Array([4])]]) } };
    };
    app.store.getChartBytes = async () => { redundantFetches++; return null; };
    schedulePreview(true); const reusedLoad = scheduled.shift()(); await flushImages(); images.at(-1).onerror(); await reusedLoad;
    equal(redundantFetches, 0, 'background reuses shared-player parsed archive instead of downloading/unzipping twice during transition');
  } finally { app.menuMusic.select = previousSelect; app.store.getChartBytes = previousFetch; }
} finally { globalThis.setTimeout = realTimeout; globalThis.Image = realImage; }

// Cold cover demand is collected during draw and consumed only after the
// transition settles. Scroll/leave remove queued work before any download.
const queueEntries = Array.from({ length: 20 }, (_, i) => ({ ...entries[0], id: `queue-${i}`, title: `Queue recording ${i}`, addedAt: 100 - i }));
const queueApp = { ...app, w: 1280, h: 800, previewChart: null, menuMusic: { entry: null, playingChart: null, backgroundChart: null, background: null, select: async () => {}, ensureStarted: async () => {} }, store: { ...app.store, listCharts: async () => queueEntries } };
queueApp.ui = new UI(queueApp);
const queueScreen = new SelectScreen(queueApp); queueApp.screen = queueScreen; queueScreen.schedulePreview = () => {};
await queueScreen.enter(); await flushImages();
const started = [], finishCovers = []; let coverConcurrent = 0, peakConcurrent = 0;
queueScreen.coverImage = entry => {
  started.push(entry.id); peakConcurrent = Math.max(peakConcurrent, ++coverConcurrent);
  return new Promise(resolve => finishCovers.push(() => { coverConcurrent--; resolve(null); }));
};
function drawQueue() {
  const canvas = createCanvas(queueApp.w, queueApp.h); queueApp.ctx = canvas.getContext('2d');
  queueApp.ui.beginFrame({ x: -10, y: -10, down: false, moved: false, downX: 0, downY: 0 });
  queueScreen.draw(queueApp.ctx); queueApp.ui.endFrame();
}
drawQueue(); equal(started.length, 0, 'drawing cold list starts no cover network/decode work');
check(queueScreen.coverQueue.size > 1 && queueScreen.coverQueue.size < queueEntries.length, 'only visible song headers queue cover work');
queueScreen.update(200, 200); equal(started.length, 0, 'initial page transition receives priority over covers');
queueScreen.update(150, 350); equal(started.length, 1, 'one cover starts after initial transition');
queueScreen.update(500, 850); equal(started.length, 1, 'pending first image prevents a parallel cold-cover burst');
const firstVisible = new Set(queueScreen.visibleCovers); queueScreen.scroll = 900; drawQueue();
check([...queueScreen.coverQueue.keys()].every(key => queueScreen.visibleCovers.has(key)), 'scroll drops queued offscreen covers');
finishCovers.shift()(); await flushImages();
queueScreen.update(119, 969); equal(started.length, 1, 'cover completion leaves an idle frame gap');
queueScreen.update(1, 970); equal(started.length, 2, 'next visible cover starts gradually');
check(!firstVisible.has(queueScreen.coverKey(queueEntries.find(entry => entry.id === started[1]))), 'next download follows current viewport rather than stale initial queue');
equal(peakConcurrent, 1, 'cold-cover decode concurrency is one');
queueScreen.leave(); equal(queueScreen.coverQueue.size, 0, 'leaving removes unstarted cover work');
finishCovers.shift()(); await flushImages(); queueScreen.update(1000, 1970);
equal(started.length, 2, 'leaving never resumes old cover queue');

// A shared image is reusable across difficulties only when its recorded source
// matches; audio may already have changed while a new background is decoding.
const reuseApp = { ...queueApp, store: { ...queueApp.store, getChartBytes: async () => { throw new Error('unexpected duplicate chart download'); } }, menuMusic: { ...queueApp.menuMusic, background: green, backgroundChart: queueEntries[2], playingChart: queueEntries[3] } };
const reuseScreen = new SelectScreen(reuseApp); reuseApp.screen = reuseScreen; reuseScreen.active = true;
const anotherDifficulty = { ...queueEntries[2], id: 'queue-difficulty-2', version: 'Extra' };
equal(await reuseScreen.coverImage(anotherDifficulty), green, 'same recording first difficulty reuses decoded menu art without downloading');
equal(reuseScreen.sharedCover(queueEntries[3]), null, 'audio-ready next song does not inherit image still belonging to old recording');
const coverBytes = new Uint8Array([9, 8, 7]);
reuseApp.menuMusic.background = null;
reuseApp.previewChart = { id: anotherDifficulty.id, archive: { chart: { meta: { ...anotherDifficulty, bg: 'art.png' } }, files: new Map([['art.png', coverBytes]]) } };
equal(await reuseScreen.coverData(queueEntries[2]), coverBytes, 'same-song archive reuses already extracted background despite different difficulty id');

const lateImages = [];
globalThis.Image = class { constructor() { const image = background('#cead78'); lateImages.push(image); return image; } };
try {
  const lateEntry = { ...queueEntries[5], id: 'late-cover', title: 'Late isolated cover' };
  reuseScreen.coverData = async () => new Uint8Array([1]);
  const first = reuseScreen.coverImage(lateEntry), same = reuseScreen.coverImage({ ...lateEntry, id: 'late-cover-difficulty' });
  equal(first, same, 'background and thumbnail share one in-flight request for a recording');
  const rejected = assert.rejects(first, /no longer active/); await flushImages();
  equal(lateImages.length, 1, 'deduplicated artwork request creates one decoder');
  reuseScreen.leave(); lateImages[0].onload(); await rejected; checks++;
  const freshScreen = new SelectScreen(reuseApp); freshScreen.active = true; freshScreen.coverData = async () => new Uint8Array([2]);
  const fresh = freshScreen.coverImage(lateEntry); await flushImages();
  equal(lateImages.length, 2, 'late image from departed screen was not committed to shared cover cache');
  lateImages[1].onload(); await fresh; freshScreen.leave();
} finally { globalThis.Image = realImage; }

const labelCanvas = createCanvas(600, 160), labelCtx = labelCanvas.getContext('2d');
const measure = labelCtx.measureText.bind(labelCtx), renderedLabels = []; let measurements = 0;
labelCtx.measureText = value => { measurements++; return measure(value); };
const labelDraw = labelCtx.fillText.bind(labelCtx); labelCtx.fillText = (value, ...args) => { renderedLabels.push(value); labelDraw(value, ...args); };
screen.label(labelCtx, 'A long label that needs truncating', 5, 20, 70, { size: 12 });
const firstMeasures = measurements;
screen.label(labelCtx, 'A long label that needs truncating', 5, 20, 70, { size: 12, color: '#fff' });
equal(measurements, firstMeasures, 'unchanged label geometry reuses truncation instead of repeated frame measurements');
screen.label(labelCtx, 'A long label that needs truncating', 5, 20, 90, { size: 12 });
check(measurements > firstMeasures, 'available-width changes invalidate label measurement');
setLanguage('en'); screen.label(labelCtx, 'COLLECTION', 5, 20, 500); const english = renderedLabels.at(-1);
setLanguage('zh-CN'); screen.label(labelCtx, 'COLLECTION', 5, 20, 500);
check(renderedLabels.at(-1) !== english, 'label cache keys include translated content when locale changes');
setLanguage('en');
for (let i = 0; i < 600; i++) screen.label(labelCtx, `Bounded label ${i}`, 5, 20, 90, { size: 12 });
check(screen.labelCache.size <= 512, 'label measurement cache remains bounded across searches and score changes');
screen.leave();
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks }, null, 2));
console.log(`PASS song-tree animation: ${checks} geometry/input/motion checks; desktop and small landscape Canvas frames.`);
