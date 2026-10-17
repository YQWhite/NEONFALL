import assert from 'node:assert/strict';
import { AudioEngine } from '../src/engine/audio.ts';
import { MenuMusic } from '../src/ui/menu-music.ts';
import { groupSongs, songKey } from '../src/ui/song-groups.ts';
const gain = () => ({ gain: { value: 0, linearRampToValueAtTime(v) { this.value = v; }, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} });
const sources = [];
const ctx = { currentTime: 10, state: 'running', createGain: gain, createBufferSource() {
  const src = { connect() {}, disconnect() {}, start(when, offset) { this.when = when; this.offset = offset; }, stop() { this.stopped = true; } };
  sources.push(src); return src;
} };
const audio = new AudioEngine(); audio.ctx = ctx; audio.master = gain();
audio.decode = async () => ({ duration: 100 });
await audio.previewMusic(new Uint8Array(), 'a', 0, .4);
const startedRevision = audio.previewTimelineRevision;
assert.equal(audio.previewInfo.loopStart, 0);
ctx.currentTime += 4;
assert.ok(audio.previewTimeSec > 3.9 && audio.previewTimeSec < 4);
assert.equal(audio.previewTimelineRevision, startedRevision, 'natural progress, even across a stalled UI frame, is not a transport action');
audio.pausePreview(); const paused = audio.previewTimeSec;
assert.ok(audio.previewTimelineRevision > startedRevision, 'pause is observable even if the UI misses the paused frame');
const pauseRevision = audio.previewTimelineRevision;
ctx.currentTime += 8; assert.equal(audio.previewTimeSec, paused); assert.equal(audio.isPreviewPaused, true);
audio.seekPreview(50); assert.equal(audio.previewTimeSec, 50);
assert.ok(audio.previewTimelineRevision > pauseRevision, 'paused seek still invalidates a pending section entry');
audio.resumePreview(); ctx.currentTime += 2; assert.ok(audio.previewTimeSec > 51.9);
const resumedRevision = audio.previewTimelineRevision;
audio.setPreviewVolume(.2); assert.equal(audio.previewGain.gain.value, .2);
ctx.currentTime += 101; assert.ok(audio.previewTimeSec < 100);
assert.equal(audio.previewTimelineRevision, resumedRevision, 'a natural loop retains its transport revision');
audio.seekPreview(audio.previewTimeSec);
assert.ok(audio.previewTimelineRevision > resumedRevision, 'even a same-position seek cancels effects, without relying on a clock jump threshold');
let resolveDecode; audio.decode = () => new Promise(r => resolveDecode = r);
const pending = audio.previewMusic(new Uint8Array(), 'late', 0, .2); audio.stopPreview();
resolveDecode({ duration: 100 }); await pending; assert.equal(audio.previewActive, false);
assert.equal(audio.previewDurationSec, 0);
console.log('PASS audio clock, pause/resume, seek, volume, loop, stale decode cancellation');

audio.decode = async () => ({ duration: 100 });
await audio.previewMusic(new Uint8Array(), 'audible', 0, .4);
const audibleSource = audio.previewSrc;
let oldDecode; audio.decode = () => new Promise(resolve => { oldDecode = resolve; });
const oldRequest = audio.previewMusic(new Uint8Array(), 'superseded', 0, .4);
audio.cancelPreviewLoad(); assert.equal(audio.previewSrc, audibleSource, 'new selection keeps current source during loading');
oldDecode({ duration: 100 }); assert.equal(await oldRequest, false); assert.equal(audio.previewSrc, audibleSource);
audio.decode = async () => { throw new Error('decode failure'); };
assert.equal(await audio.previewMusic(new Uint8Array(), 'bad', 0, .4), false); assert.equal(audio.previewSrc, audibleSource, 'decode failure retains current music');
audio.decode = async () => ({ duration: 120 });
await audio.previewMusic(new Uint8Array(), 'ready', 0, .4); assert.notEqual(audio.previewSrc, audibleSource, 'replacement starts only after decode');
audio.stopPreview();
console.log('PASS audible continuity while decoding, cancelled/failed replacement and ready-source handover');

let listResolve; let calls = 0;
const fake = { audio: { previewActive: true, isPreviewPaused: false, stopPreview() { this.previewActive = false; }, }, store: { listCharts: () => new Promise(r => listResolve = r) }, settings: {}, serverOnline: false };
const radio = new MenuMusic(fake); radio.setEnabled(true); assert.equal(fake.audio.previewActive, true);
radio.entry = { id: 'a' }; radio.loading = false;
radio.select = async () => { calls++; };
await radio.ensureStarted(); assert.equal(calls, 0, 'active track remains continuous');
radio.setEnabled(false); assert.equal(fake.audio.previewActive, false);
radio.entry = null; radio.setEnabled(true); radio.setEnabled(false); listResolve([{ id: 'a' }]);
await new Promise(r => setTimeout(r, 0)); assert.equal(calls, 0, 'late library load cannot play after leaving');
console.log('PASS shared player continuity and late library cancellation');

// Archive fetch cancellation must happen BEFORE decode, not only inside AudioEngine.
const fs = await import('node:fs');
const sampleDir = new URL('../../samples-converted/', import.meta.url);
const sampleName = fs.readdirSync(sampleDir).find(f => f.endsWith('.nfm'));
const sampleBytes = fs.readFileSync(new URL(sampleName, sampleDir));
let fetchA; const starts = [];
const app = { settings: { previewVolume: .3 }, serverOnline: false, audio: {
  previewActive: false, isPreviewPaused: false,
  stopPreview() { this.previewActive = false; }, stopAmbient() {},
  async previewMusic(_bytes, key, from) { starts.push({key,from}); this.previewActive = true; },
}, store: { listCharts: async () => [], getChartBytes: id => id === 'a' ? new Promise(r => fetchA = r) : Promise.resolve(sampleBytes) } };
const controller = new MenuMusic(app); controller.setEnabled(true);
const a = controller.select({id:'a'},true);
await controller.select({id:'b'},true);
fetchA(sampleBytes); await a;
assert.deepEqual(starts, [{key:'b',from:0}]);
await controller.select({id:'b'}); assert.equal(starts.length,1);
controller.setEnabled(false); assert.equal(app.audio.previewActive,false);
console.log('PASS archive-fetch race cancellation, full-song start offset and same-track no restart');

const entry = (id, title, stars, overrides = {}) => ({ id, title, artist: 'Artist', creator: 'Mapper', version: id, stars, keys: 4, addedAt: 1, lengthMs: 100000, notes: 100, size: 1000, name: id + '.nfm', ...overrides });
const songs = [entry('hard', 'Song A', 6), entry('other', 'Song B', 4), entry('easy', 'Song A', 1), entry('medium', ' song a ', 3, { artist: 'Ａrtist' })];
const grouped = groupSongs(songs);
assert.equal(grouped.length, 2);
assert.deepEqual(grouped[0].charts.map(c => c.id), ['easy', 'medium', 'hard']);
assert.notEqual(songKey(songs[0]), songKey({ ...songs[0], artist: 'Different artist' }));
assert.equal(groupSongs(songs, 'stars')[0].charts[0].id, 'easy', 'song sorting must retain ascending child difficulties');
const radioApp = { ...app, audio: { ...app.audio, previewActive: true, seekPreview() { throw Error('single song must not restart'); } }, store: { listCharts: async () => songs } };
const songRadio = new MenuMusic(radioApp); songRadio.setEnabled(true); songRadio.entry = songs[0];
await songRadio.select(songs[2]);
assert.equal(songRadio.entry.id, 'easy');
assert.equal(radioApp.audio.previewActive, true, 'difficulty selection preserves playback');
let nextEntry;
songRadio.select = async e => { nextEntry = e; songRadio.entry = e; };
await songRadio.next(); assert.equal(nextEntry.id, 'other', 'next must skip every difficulty of the current recording');
radioApp.store.listCharts = async () => songs.filter(c => c.title.trim().toLowerCase() === 'song a');
songRadio.entry = songs[0]; nextEntry = null;
await songRadio.next(); assert.equal(nextEntry, null);
console.log('PASS normalized song grouping, ascending difficulties, next-recording selection and one-song continuity');

let audibleWave = true;
const analysers = [];
const analyserContext = { ...ctx, sampleRate: 44100, createAnalyser() {
  const analyser = { connect() {}, disconnect() { this.disconnected = true; }, getByteFrequencyData(data) { data.fill(0); if (audibleWave) data.fill(210, 1, 8); }, getByteTimeDomainData(data) { data.fill(audibleWave ? 154 : 128); } };
  analysers.push(analyser); return analyser;
} };
const reactiveAudio = new AudioEngine(); reactiveAudio.ctx = analyserContext; reactiveAudio.master = gain(); reactiveAudio.decode = async () => ({ duration: 100 });
await reactiveAudio.previewMusic(new Uint8Array(), 'rhythm', 0, .3);
assert.equal(analysers.length, 1);
let spectrum = reactiveAudio.samplePreviewSpectrum();
assert.ok(spectrum.bass > .5 && spectrum.energy > .2);
assert.ok(spectrum.bands[0] > spectrum.bands[16], 'bars represent actual frequency bands');
audibleWave = false; spectrum = reactiveAudio.samplePreviewSpectrum(); assert.equal(spectrum.energy, 0);
audibleWave = true; reactiveAudio.setPreviewVolume(0); spectrum = reactiveAudio.samplePreviewSpectrum(); assert.equal(spectrum.energy, 0); assert.ok(spectrum.bands.every(v => v === 0));
reactiveAudio.setPreviewVolume(.3); reactiveAudio.pausePreview(); assert.equal(reactiveAudio.samplePreviewSpectrum().energy, 0);
reactiveAudio.resumePreview(); assert.equal(analysers.length, 2);
reactiveAudio.stopPreview();

const beatAudio = { previewTimeSec: .5, previewActive: true, ctx: { state: 'running' }, samplePreviewSpectrum: () => ({ bands: new Float32Array(17), bass: .4, energy: .6 }) };
const reactiveRadio = new MenuMusic({ audio: beatAudio });
reactiveRadio.timing = [{ t: 0, bpm: 120 }, { t: 1000, bpm: 240 }];
assert.equal(reactiveRadio.visualizer(16).pulse, 1);
beatAudio.previewTimeSec = .75; assert.ok(reactiveRadio.visualizer(500).pulse < .15);
beatAudio.previewTimeSec = 1.25; assert.equal(reactiveRadio.visualizer(16).pulse, 1, 'seek and BPM changes use the actual playback clock');
beatAudio.previewActive = false; assert.ok(reactiveRadio.visualizer(500).pulse < .05, 'paused audio settles instead of producing invented beats');
console.log('PASS preview-bus spectrum, mute/pause gating, BPM changes and audio-clock beat phase');

// Exercise the real tree layout and pointer/keyboard selection, not a second layout implementation.
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { body: { appendChild() {} }, createElement() { return { value: '', style: {}, addEventListener() {}, blur() {}, remove() {} }; } };
const { SelectScreen } = await import('../src/ui/screens/select.ts');
const treeApp = { w: 800, h: 600, menuMusic: { entry: songs[0], ensureStarted: async () => {} }, ui: { p: {}, cancelPointer() {} }, uiSound() {} };
const tree = new SelectScreen(treeApp); tree.entries = songs; tree.applyFilter();
assert.deepEqual(tree.view.map(c => c.id), ['easy', 'medium', 'hard', 'other']);
assert.equal(tree.entry().id, 'hard', 'initial selection follows the current recording difficulty');
assert.equal(tree.rows.filter(row => row.header).length, 2);
let target = tree.rows.find(row => !row.header && tree.view[row.index].id === 'medium');
tree.scroll = target.top;
tree.pointerDown(50, tree.listArea().y + 10); tree.pointerUp(50, tree.listArea().y + 10); assert.equal(tree.entry().id, 'medium');
tree.keyDown('ArrowDown', {}); assert.equal(tree.entry().id, 'hard');
treeApp.h = 400; tree.resize();
target = tree.rows.find(row => !row.header && tree.view[row.index].id === 'hard');
assert.ok(target.top >= tree.scroll && target.top + target.height <= tree.scroll + tree.listArea().h, 'resize keeps selected child visible');
tree.scroll = 0; tree.pointerDown(50, tree.listArea().y + 100); tree.pointerMove(50, tree.listArea().y + 40); tree.pointerUp(50, tree.listArea().y + 40);
assert.ok(tree.scroll > 0); assert.equal(tree.entry().id, 'hard', 'touch scrolling must not select a song while dragging');
tree.search = 'medium'; tree.applyFilter(); assert.deepEqual(tree.view.map(c => c.id), ['medium']); assert.equal(tree.rows.length, 2);
tree.search = ''; tree.keyFilter = 7; tree.applyFilter(); assert.equal(tree.rows.length, 0); assert.equal(tree.entry(), null);
tree.leave();
console.log('PASS tree headers, child hit testing, keyboard navigation, resize, touch scrolling, search and key filter');

// Exercise actual shared-player state across every pre-game screen. Changing a
// screen must not decode again, restart the source, or reset an explicit pause.
const navigationAudio = new AudioEngine(); navigationAudio.ctx = ctx; navigationAudio.master = gain();
let navigationDecodes = 0;
navigationAudio.decode = async () => { navigationDecodes++; return { duration: 200 }; };
const navigationApp = { settings: { previewVolume: .35 }, serverOnline: false, audio: navigationAudio,
  store: { listCharts: async () => [], getChartBytes: async () => sampleBytes } };
const navigationMusic = new MenuMusic(navigationApp);
navigationMusic.setScreen('menu'); await navigationMusic.ensureStarted();
await navigationMusic.select(entry('navigation', 'Navigation song', 3), true);
const navigationSource = navigationAudio.previewSrc, navigationBuffer = navigationAudio.previewBuffer;
const navigationScreens = ['settings', 'account', 'import', 'select', 'menu', 'settings', 'menu'];
let navigationClock = navigationAudio.previewTimeSec;
for (const name of navigationScreens) {
  ctx.currentTime += 2;
  navigationMusic.setScreen(name);
  assert.equal(navigationAudio.previewSrc, navigationSource, `${name}: preserve active source`);
  assert.equal(navigationAudio.previewBuffer, navigationBuffer, `${name}: preserve decoded audio`);
  assert.ok(navigationAudio.previewTimeSec > navigationClock + 1.9, `${name}: clock continues`);
  navigationClock = navigationAudio.previewTimeSec;
}
assert.equal(navigationDecodes, 1, 'submenu navigation never reloads the song');
navigationAudio.pausePreview(); navigationClock = navigationAudio.previewTimeSec;
for (const name of navigationScreens) {
  navigationMusic.setScreen(name); ctx.currentTime += 1;
  assert.equal(navigationAudio.isPreviewPaused, true, `${name}: respect manual pause`);
  assert.equal(navigationAudio.previewTimeSec, navigationClock, `${name}: preserve pause position`);
}
navigationAudio.resumePreview();
assert.ok(Math.abs(navigationAudio.previewTimeSec - navigationClock) < .001, 'resume uses original pause position');

// Fetches started on the song list may finish while a submenu is visible.
let navigationFetch;
navigationApp.store.getChartBytes = () => new Promise(resolve => { navigationFetch = resolve; });
const submenuLoad = navigationMusic.select(entry('pending', 'Pending song', 4), true);
const oldNavigationSource = navigationAudio.previewSrc;
for (const name of ['account', 'settings', 'import']) {
  navigationMusic.setScreen(name);
  assert.equal(navigationAudio.previewSrc, oldNavigationSource, `${name}: keep old song while loading`);
}
navigationFetch(sampleBytes); await submenuLoad;
assert.equal(navigationMusic.entry.id, 'pending');
assert.notEqual(navigationAudio.previewSrc, oldNavigationSource, 'new song can finish loading in submenu');
assert.equal(navigationDecodes, 2);

// Gameplay/result must stop preview immediately and reject a late audio decode.
navigationApp.store.getChartBytes = async () => sampleBytes;
let navigationDecode;
navigationAudio.decode = () => new Promise(resolve => { navigationDecode = resolve; });
const gameplayCancelledLoad = navigationMusic.select(entry('late-game', 'Late song', 3));
await Promise.resolve(); await Promise.resolve();
assert.equal(typeof navigationDecode, 'function');
navigationMusic.setScreen('play');
assert.equal(navigationAudio.previewActive, false);
assert.equal(navigationAudio.previewDurationSec, 0);
navigationDecode({ duration: 180 }); await gameplayCancelledLoad;
assert.equal(navigationAudio.previewActive, false, 'late submenu decode cannot overlap gameplay');
navigationMusic.setScreen('result');
await navigationMusic.ensureStarted();
assert.equal(navigationAudio.previewActive, false, 'result keeps gameplay handover silent');
console.log('PASS every pre-game screen preserves source, clock, manual pause and in-flight load; gameplay/result stop and cancel preview');

// A slow initial catalogue must not strand music after quick leave/re-entry or
// clear the newer request when its obsolete promise eventually settles.
const catalogResolvers = [];
const catalogAudio = new AudioEngine(); catalogAudio.ctx = ctx; catalogAudio.master = gain();
catalogAudio.decode = async () => ({ duration: 90 });
const catalogApp = { settings: { previewVolume: .35 }, serverOnline: false, audio: catalogAudio,
  store: { listCharts: () => new Promise(resolve => catalogResolvers.push(resolve)), getChartBytes: async () => sampleBytes } };
const catalogMusic = new MenuMusic(catalogApp);
catalogMusic.setScreen('menu');
catalogMusic.setScreen('play');
catalogMusic.setScreen('settings');
assert.equal(catalogResolvers.length, 2, 'returning before first list resolves starts a current request');
const currentStartup = catalogMusic.starting;
catalogResolvers[0]([entry('stale-list', 'Obsolete song', 1)]);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(catalogMusic.starting, currentStartup, 'obsolete cleanup cannot clear newer startup');
assert.equal(catalogAudio.previewActive, false, 'obsolete catalogue cannot start music');
catalogResolvers[1]([entry('fresh-list', 'Current song', 2)]);
await currentStartup;
assert.equal(catalogMusic.entry.id, 'fresh-list');
assert.equal(catalogAudio.previewActive, true, 'current startup resumes in submenu');
catalogMusic.setScreen('play');
console.log('PASS rapid play/submenu re-entry and out-of-order initial catalogue cleanup');

// Playlist advance is driven by the audio clock/update, without drawing the
// player on settings/account/import. A seek is not a natural song completion.
const autoAudio = new AudioEngine(); autoAudio.ctx = ctx; autoAudio.master = gain();
autoAudio.decode = async () => ({ duration: 30 });
let autoEntries = [entry('auto-a', 'First recording', 1), entry('auto-a-hard', 'First recording', 5), entry('auto-b', 'Second recording', 2)];
const autoApp = { settings: { previewVolume: .35 }, serverOnline: false, audio: autoAudio,
  store: { listCharts: async () => [], getChartBytes: async () => sampleBytes } };
const autoMusic = new MenuMusic(autoApp);
autoMusic.setScreen('settings'); await autoMusic.ensureStarted();
autoApp.store.listCharts = async () => autoEntries;
await autoMusic.select(autoEntries[0], true); autoMusic.update();
assert.equal(autoAudio.previewLoopCount, 0);
ctx.currentTime += 31; assert.equal(autoAudio.previewLoopCount, 1); autoMusic.update();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(autoMusic.entry.id, 'auto-b', 'submenu clock advances to a different recording');
autoAudio.pausePreview(); ctx.currentTime += 80; autoMusic.update();
await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(autoMusic.entry.id, 'auto-b', 'manual pause never advances');
autoAudio.resumePreview(); autoMusic.update();
autoAudio.seekPreview(29); autoMusic.update();
autoAudio.seekPreview(0); autoMusic.update();
await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(autoMusic.entry.id, 'auto-b', 'manual seeks never advance');
autoEntries = [autoEntries[2]];
const singleSource = autoAudio.previewSrc;
ctx.currentTime += 31; autoMusic.update();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(autoAudio.previewSrc, singleSource, 'single-recording library loops continuously');
autoMusic.setScreen('play');
console.log('PASS automatic next recording in submenus, pause/seek safety and single-song looping without drawing controls');

// A radio playlist follows grouped list order; selection repeats one recording.
const orderAudio = new AudioEngine(); orderAudio.ctx = ctx; orderAudio.master = gain();
orderAudio.decode = async () => ({ duration: 30 });
const orderedEntries = [entry('order-c', 'C song', 1), entry('order-a-hard', 'A song', 5), entry('order-b', 'B song', 2), entry('order-a', 'A song', 1)];
const orderApp = { settings: { previewVolume: .35 }, audio: orderAudio, serverOnline: false,
  store: { listCharts: async () => orderedEntries, getChartBytes: async () => sampleBytes } };
const orderMusic = new MenuMusic(orderApp);
orderMusic.setScreen('menu'); await orderMusic.ensureStarted();
assert.equal(orderMusic.entry.id, 'order-a', 'radio starts at the first grouped song');
await orderMusic.next(); assert.equal(orderMusic.entry.id, 'order-b');
await orderMusic.next(); assert.equal(orderMusic.entry.id, 'order-c');
await orderMusic.next(); assert.equal(orderMusic.entry.id, 'order-a', 'manual next wraps grouped list');
orderMusic.setScreen('select'); const repeatingSource = orderAudio.previewSrc;
for (const screen of ['select', 'settings', 'account', 'import']) {
  orderMusic.setScreen(screen); ctx.currentTime += 31; orderMusic.update();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(orderMusic.entry.id, 'order-a', `${screen}: inherit selected-recording loop`);
  assert.equal(orderAudio.previewSrc, repeatingSource, `${screen}: loop does not replace source`);
}
orderMusic.setScreen('menu'); orderMusic.setScreen('settings');
ctx.currentTime += 31; orderMusic.update(); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(orderMusic.entry.id, 'order-b', 'submenu inherits menu playlist policy');
orderMusic.setScreen('menu');
ctx.currentTime += 31; orderMusic.update(); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(orderMusic.entry.id, 'order-c', 'natural end advances in list order');
ctx.currentTime += 31; orderMusic.update(); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(orderMusic.entry.id, 'order-a', 'natural end wraps to first song');
let finishOrderList;
orderApp.store.listCharts = () => new Promise(resolve => { finishOrderList = resolve; });
ctx.currentTime += 31; orderMusic.update();
orderMusic.setScreen('select'); finishOrderList(orderedEntries);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(orderMusic.entry.id, 'order-a', 'late automatic playlist fetch cannot advance the selected song');
orderMusic.setScreen('play');
console.log('PASS ordered playlist wrap, selected-song repeat, inherited submenu policy and late auto-next cancellation');

// Changing server invalidates pending fetch/decode/catalogue without silencing
// the decoded recording or stranding its visible pause/resume controls.
const { createCanvas } = await import('@napi-rs/canvas');
const { listPlaybackCharts } = await import('../src/api/library.ts');
const switchAudio = new AudioEngine(); switchAudio.ctx = ctx; switchAudio.master = gain();
switchAudio.decode = async () => ({ duration: 90 });
const switchApp = { settings: { previewVolume: .35 }, centralLibrary: false, serverOnline: false,
  audio: switchAudio, screen: { name: 'account' }, w: 1000, h: 700,
  store: { listCharts: async () => [], getChartBytes: async () => sampleBytes },
  server: { downloadChart: async () => sampleBytes },
};
const switchMusic = new MenuMusic(switchApp);
switchMusic.setScreen('menu'); await switchMusic.ensureStarted();
const priorSong = entry('old-remote', 'Decoded old song', 1, { server: true });
await switchMusic.select(priorSong, true);
const priorSource = switchAudio.previewSrc;
let resolveOldDownload;
switchApp.server.downloadChart = () => new Promise(resolve => { resolveOldDownload = resolve; });
const oldDownload = switchMusic.select(entry('late-remote', 'Pending old song', 2, { server: true }));
switchMusic.connectionChanged();
assert.equal(switchAudio.previewSrc, priorSource, 'disconnect retains already decoded audio');
assert.equal(switchMusic.entry, null, 'old remote entry cannot be reused as a download target');
assert.equal(switchMusic.playingEntry, priorSong, 'decoded recording keeps title and transport metadata');
resolveOldDownload(sampleBytes); await oldDownload;
assert.equal(switchAudio.previewSrc, priorSource, 'old host download cannot replace retained recording');
assert.equal(switchMusic.loading, false);
let toggleOptions;
switchApp.ui = { p: {}, hover: () => false, button(id, x, y, w, h, label, options) {
  if (id !== 'music-toggle') return false;
  toggleOptions = options; return !options.disabled;
} };
const switchCanvas = createCanvas(1000, 700).getContext('2d');
switchMusic.draw(switchCanvas);
assert.equal(toggleOptions.disabled, false, 'disconnect keeps the transport button enabled');
assert.equal(switchAudio.isPreviewPaused, true, 'retained recording can pause');
switchMusic.draw(switchCanvas);
assert.equal(switchAudio.previewActive, true, 'retained recording can resume');
const resumedSource = switchAudio.previewSrc;
let resolveOldDecode;
switchApp.server.downloadChart = async () => sampleBytes;
switchAudio.decode = () => new Promise(resolve => { resolveOldDecode = resolve; });
const switchedDecode = switchMusic.select(entry('decode-remote', 'Late decoded song', 3, { server: true }));
await Promise.resolve(); await Promise.resolve();
assert.equal(typeof resolveOldDecode, 'function');
switchMusic.connectionChanged(); resolveOldDecode({ duration: 60 }); await switchedDecode;
assert.equal(switchAudio.previewSrc, resumedSource, 'old host decode cannot replace retained recording');
switchMusic.setScreen('play');

const localEntry = entry('local-after-switch', 'Local download', 1);
let resolveOldList;
switchApp.store.listCharts = async () => [localEntry]; switchApp.centralLibrary = switchApp.serverOnline = true;
switchApp.server = { listCharts: () => new Promise(resolve => { resolveOldList = resolve; }) };
const oldList = listPlaybackCharts(switchApp); await Promise.resolve();
switchApp.server = {}; resolveOldList([priorSong]);
assert.deepEqual(await oldList, [localEntry], 'old server catalogue cannot enter replacement connection');
let rejectOldList;
switchApp.server = { listCharts: () => new Promise((_, reject) => { rejectOldList = reject; }) };
const failingList = listPlaybackCharts(switchApp); await Promise.resolve();
switchApp.server = {}; rejectOldList(new Error('old host offline'));
assert.deepEqual(await failingList, [localEntry]);
assert.equal(switchApp.serverOnline, true, 'old catalogue failure cannot mark new server offline');
console.log('PASS server switch preserves audio/transport and rejects old download, decode and catalogue responses');
