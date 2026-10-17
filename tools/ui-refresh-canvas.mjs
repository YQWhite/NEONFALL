import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { createCanvas, Image as NativeImage, GlobalFonts, loadImage } from '@napi-rs/canvas';

const output = path.resolve('test-results/ui-refresh/screens'); fs.mkdirSync(output, { recursive: true });
for (const file of ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/segoeui.ttf']) {
  if (fs.existsSync(file)) GlobalFonts.registerFromPath(file, file.includes('msyh') ? 'Microsoft YaHei' : 'Segoe UI');
}
const listeners = new Map();
globalThis.window = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
const elements = [];
function element(tag) {
  const el = { tagName: tag.toUpperCase(), value: '', type: 'text', style: {}, addEventListener() {}, remove() {}, setAttribute() {}, focus() { document.activeElement = this; }, blur() { document.activeElement = null; } };
  elements.push(el); return el;
}
globalThis.document = { documentElement: {}, body: { appendChild() {} }, hidden: false, activeElement: null,
  createElement(tag) { return tag === 'canvas' ? createCanvas(1, 1) : element(tag); } };
globalThis.localStorage = { data: new Map(), getItem(k) { return this.data.get(k) ?? null; }, setItem(k, v) { this.data.set(k, v); }, removeItem(k) { this.data.delete(k); } };
globalThis.Image = class extends NativeImage {
  set src(value) { const blob = typeof value === 'string' ? resolveObjectURL(value) : undefined; if (blob) blob.arrayBuffer().then(bytes => { super.src = Buffer.from(bytes); }); else super.src = value; }
  get src() { return super.src; }
};
const { UI } = await import('../src/ui/widgets.ts');
const { setLanguage, tr, zh } = await import('../src/ui/i18n.ts');
const { DEFAULT_SETTINGS, DEFAULT_MODS } = await import('../src/core/types.ts');
const { Store } = await import('../src/core/store.ts');
const { readNFM, readNFSK } = await import('../src/core/nfm.ts');
const { PlaySession } = await import('../src/engine/play.ts');
const { PlayfieldRenderer } = await import('../src/engine/render.ts');
const { MenuMusic } = await import('../src/ui/menu-music.ts');
const screens = {};
for (const [name, exported] of [['menu', 'MenuScreen'], ['select', 'SelectScreen'], ['settings', 'SettingsScreen'], ['account', 'AccountScreen'], ['import', 'ImportScreen'], ['play', 'PlayScreen'], ['result', 'ResultScreen']]) screens[name] = (await import(`../src/ui/screens/${name}.ts`))[exported];
const seed = path.resolve('../samples-converted');
const charts = fs.readdirSync(seed).filter(f => f.endsWith('.nfm')).map((name, i) => {
  const bytes = fs.readFileSync(path.join(seed, name)), archive = readNFM(bytes), c = archive.chart;
  return { bytes, archive, entry: { id: 'chart' + i, name, title: c.meta.title, artist: c.meta.artist, creator: c.meta.creator, version: c.meta.version, keys: c.keys, stars: c.stars, notes: c.notes.length, lengthMs: c.meta.lengthMs, size: bytes.length, addedAt: i, source: c.source.type } };
});
const skinName = fs.readdirSync(seed).find(f => f.endsWith('.nfsk')), skinBytes = fs.readFileSync(path.join(seed, skinName)), parsedSkin = readNFSK(skinBytes);
const track = charts.find(x => x.entry.version.includes('evil'));
let currentTime = 30000;
const result = { chartId: track.entry.id, keys: 4, score: 1256048, acc: .9742, maxCombo: 1246, counts: { perfect: 938, great: 74, good: 23, ok: 8, bad: 0, miss: 2, holdTicks: 152 }, stars: track.entry.stars, pp: 264.3, grade: 'S', passed: true, mods: [], playedAt: Date.now(), title: track.entry.title, version: track.entry.version, durationMs: track.entry.lengthMs };
const profile = { username: 'rhythm', nickname: 'Rhythm Player', email: '', rating: 1482.6, bestPp: 264.3, local: true, createdAt: Date.now() };
const settings = structuredClone(DEFAULT_SETTINGS); settings.skinId = 'remilia'; settings.sbEnabled = false;
const audio = { previewActive: true, isPreviewPaused: false, previewDurationSec: 120, previewTimeSec: 30, ctx: { state: 'running' }, baseLatencyMs: 12,
  songTimeMs: () => currentTime, applySettings() {}, playSynth() {}, pauseMusic() {}, resumeMusic() {}, stopMusic() {}, stopPreview() {}, playMusic(sec) { currentTime = sec * 1000; }, seekMusic(sec) { currentTime = sec * 1000; } };
const app = { w: 1280, h: 800, ctx: null, settings, mods: { ...DEFAULT_MODS }, audio, platform: 'desktop', isTouch: false, time: 10000, version: '0.1.0', account: { server: false, user: null }, serverOnline: false, previewChart: null,
  canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, uiSound() {}, toast() {}, gotoScreen(name, params) { this.destination = { name, params }; }, resize() {}, quitApp() {},
  saveSettings() { setLanguage(settings.language); localStorage.setItem('nf.settings.v1', JSON.stringify(settings)); this.saves++; }, saves: 0,
  server: { listCharts: async () => charts.map(x => x.entry), leaderboard: async () => [], myScores: async () => [], scores: async () => [] },
  store: { settings, listCharts: async () => charts.map(x => x.entry), listSkins: async () => [{ id: 'remilia', name: parsedSkin.skin.name, keys: 4, size: skinBytes.length }], getSkinBytes: async () => skinBytes,
    getChartBytes: async id => charts.find(x => x.entry.id === id)?.bytes, getBest: () => result, getBestScores: () => ({ [result.chartId]: result }), deleteSkin: async () => {}, },
};
app.ui = new UI(app); app.menuMusic = new MenuMusic(app); app.menuMusic.entry = track.entry; app.menuMusic.ensureStarted = async () => {}; app.menuMusic.select = async () => {};
const controls = [];
for (const method of ['button', 'chip', 'slider']) {
  const original = app.ui[method].bind(app.ui);
  app.ui[method] = (...args) => { controls.push({ method, id: args[0], x: args[1], y: args[2], w: args[3], h: args[4] }); return original(...args); };
}
const textCalls = [], files = [];
function draw(screen, name, pointer = {}) {
  app.screen = screen;
  controls.length = 0; textCalls.length = 0;
  const canvas = createCanvas(app.w, app.h), ctx = canvas.getContext('2d'); app.ctx = ctx;
  ctx.fillStyle = '#0d1218'; ctx.fillRect(0, 0, app.w, app.h);
  const fillText = ctx.fillText.bind(ctx); ctx.fillText = (value, ...args) => { textCalls.push(String(value)); fillText(value, ...args); };
  app.ui.beginFrame({ x: -1, y: -1, down: false, downX: 0, downY: 0, moved: false, ...pointer });
  screen.draw(ctx); if (['menu', 'select'].includes(screen.name)) app.menuMusic.draw(ctx); app.ui.endFrame();
  if (name) { const filename = `${settings.language}-${app.w}x${app.h}-${name}.png`; fs.writeFileSync(path.join(output, filename), canvas.toBuffer('image/png')); files.push(filename); }
  return canvas;
}
function click(screen, id) {
  draw(screen); const c = controls.find(c => c.id === id); assert.ok(c, 'control exists: ' + id);
  const pointer = { x: c.x + c.w / 2, y: c.y + c.h / 2, down: true };
  draw(screen, null, pointer); draw(screen, null, { ...pointer, down: false });
}
const play = new screens.play(app); play.entry = track.entry; play.status = '';
const getAsset = p => track.archive.files.get(p) ?? parsedSkin.files.get(p);
play.sess = new PlaySession(track.archive.chart, track.archive, { skin: parsedSkin.skin, getAsset }, { ...DEFAULT_MODS }, settings, audio);
play.sess.phase = 'playing'; play.sess.score = 123456; play.sess.combo = 128; play.sess.maxCombo = 128;
play.renderer = new PlayfieldRenderer(parsedSkin.skin, getAsset, settings, app.mods);
await Promise.all([...parsedSkin.skin.columns.flatMap(c => [c.keyImg, c.keyImgD, c.noteImg, c.noteImgH, c.noteImgT, c.bodyImg]), ...Object.values(parsedSkin.skin.stage), ...Object.values(parsedSkin.skin.judgments), ...Object.values(parsedSkin.skin.hud), ...Object.values(parsedSkin.skin.grades)].map(p => play.renderer.images.load(p)));

for (const lang of ['zh-CN', 'en']) {
  settings.language = lang; setLanguage(lang);
  for (const [w, h] of [[1280, 800], [800, 600], [640, 400]]) {
    app.w = w; app.h = h;
    const menu = new screens.menu(app); menu.enter(); menu.t0 = -10000; draw(menu, 'menu');
    const select = new screens.select(app); app.screen = select; select.active = true; select.entries = charts.map(x => x.entry); select.applyFilter(); draw(select);
    await new Promise(resolve => setTimeout(resolve, 240));
    draw(select, 'select'); select.showMods = true; draw(select, 'mods'); select.leave();
    const setting = new screens.settings(app); app.screen = setting; await setting.enter(); await setting.loadPreview();
    for (const tab of ['general', 'gameplay', 'audio', 'video', 'input', 'skin', 'about']) {
      setting.tab = tab; setting.scroll = 0; draw(setting, 'settings-' + tab);
      if (tab === 'audio') { setting.scroll = setting.maxScroll; draw(setting, 'settings-calibration'); }
    }
    setting.leave();
    const imp = new screens.import(app); await imp.enter(); draw(imp, 'import'); imp.jobs = [{ name: 'LeaF - Mopemope (eZmmR).osz', status: 'done', detail: tr('Converted {count} charts', { count: 3 }) }]; draw(imp, 'import-done'); imp.leave();
    app.account.user = null; const account = new screens.account(app); account.enter(); draw(account, 'account-create'); account.scroll = account.maxScroll; draw(account, 'account-connect'); account.leave();
    app.account.user = profile; const signed = new screens.account(app); signed.enter(); await signed.loadMyPlays(); draw(signed, 'account-profile'); signed.leave();
    const summary = new screens.result(app); summary.enter({ result, entry: track.entry, rating: 1502.4, gradeImage: play.renderer.images.get(parsedSkin.skin.grades.S) }); draw(summary, 'result');
    play.sess.phase = 'playing'; currentTime = 30000; draw(play, 'play-skin');
    assert.equal(controls.some(c => c.id === 'pbtn'), false, 'desktop must have no pause button');
    assert.ok(!textCalls.some(t => /^\d+:\d\d$/.test(t)), 'play HUD contains no time labels');
    play.sess.phase = 'paused'; draw(play, 'pause');
    for (const id of ['p-resume', 'p-retry', 'p-quit']) { const c = controls.find(c => c.id === id); assert.ok(c && c.y >= 0 && c.y + c.h <= h, 'pause actions fit: ' + id); }
    play.sess.phase = 'failed'; draw(play, 'failed'); app.account.user = null;
  }
}
app.w = 1280; app.h = 800;
const setting = new screens.settings(app); await setting.enter(); setting.tab = 'general';
click(setting, 'language-en'); assert.equal(settings.language, 'en'); assert.equal(new Store().settings.language, 'en');
click(setting, 'language-zh-CN'); assert.equal(settings.language, 'zh-CN'); assert.equal(document.documentElement.lang, 'zh-CN');
setting.tab = 'input'; draw(setting); click(setting, 'bind-4-0'); setting.keyDown('KeyF', {}); assert.deepEqual(settings.keybinds['4'].slice(0, 2), ['KeyF', 'KeyD']);
setting.tab = 'gameplay'; draw(setting); const slider = controls.find(c => c.id === 's-scale');
draw(setting, null, { x: slider.x + slider.w * ((1.2 - .5) / (2 - .5)), y: slider.y + 11, down: true }); draw(setting); assert.equal(settings.playfieldScale, 1.2); assert.equal(new Store().settings.playfieldScale, 1.2);
const saves = app.saves; for (let i = 0; i < 8; i++) draw(setting); assert.equal(app.saves, saves, 'unchanged frames do not write settings'); setting.leave();
settings.audioOffsetAuto = false; settings.audioOffset = 70; app.saveSettings(); assert.equal(new Store().settings.audioOffsetAuto, false, 'manual audio calibration stays manual after restart');
await setting.enter(); setting.tab = 'video'; setting.scroll = 0; draw(setting);
const brightness = controls.find(c => c.id === 's-sb-brightness'); assert.ok(brightness);
draw(setting, null, { x: brightness.x + brightness.w * .5, y: brightness.y + 11, down: true }); draw(setting);
assert.equal(settings.storyboardBrightness, .5); assert.equal(new Store().settings.storyboardBrightness, .5, 'storyboard brightness persists');
setting.leave();
const download = new screens.select(app); app.screen = download; download.active = true;
download.entries = charts.map(c => ({ ...c.entry, server: true })); download.applyFilter();
const selectedId = download.entry().id;
app.server.downloadChart = async id => charts.find(c => c.entry.id === id).bytes;
const savedDownloads = [];
app.store.putChart = async (bytes, name) => { savedDownloads.push({ bytes, name }); };
await download.downloadSelected();
assert.equal(savedDownloads.length, 1); assert.equal(download.entry().downloaded, true);
assert.deepEqual(savedDownloads[0].bytes, charts.find(c => c.entry.id === selectedId).bytes, 'download button persists the selected server chart');
app.platform = 'android'; app.w = 780; app.h = 360; draw(download, 'server-library-downloaded');
assert.ok(textCalls.includes(tr('DOWNLOADED')), 'native library shows offline availability');
download.leave(); app.platform = 'desktop'; app.w = 1280; app.h = 800;
for (const key of Object.keys(zh)) { setLanguage('en'); assert.equal(tr(key), key); setLanguage('zh-CN'); assert.equal(tr(key), zh[key]); }

const selected = ['menu', 'select', 'settings-general', 'settings-skin', 'import', 'account-create', 'play-skin', 'pause', 'result'];
const montage = createCanvas(1280, 400 * Math.ceil(selected.length / 2)), mc = montage.getContext('2d');
for (let i = 0; i < selected.length; i++) { const img = await loadImage(fs.readFileSync(path.join(output, `zh-CN-1280x800-${selected[i]}.png`))); mc.drawImage(img, i % 2 * 640, Math.floor(i / 2) * 400, 640, 400); }
fs.writeFileSync(path.join(output, 'overview.png'), montage.toBuffer('image/png'));
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ renderer: 'Native Canvas; real screens and widgets, simulated DOM/audio', files, checks: ['two languages', 'three window sizes', 'language persistence', 'scale persistence', 'key swap', 'settings writes only on changes', 'PC pause hidden', 'no HUD times', 'pause controls fit'] }, null, 2));
console.log(`PASS ${files.length} native Canvas captures; language/zoom persistence, key swap, PC HUD, responsive pause. Evidence: ${output}`);
