import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { createCanvas, Image as NativeImage, GlobalFonts } from '@napi-rs/canvas';

const output = path.resolve('test-results/menu-library-refresh');
fs.mkdirSync(output, { recursive: true });
for (const font of ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/segoeui.ttf']) if (fs.existsSync(font)) GlobalFonts.registerFromPath(font, font.includes('msyh') ? 'Microsoft YaHei' : 'Segoe UI');
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { body: { appendChild() {} }, documentElement: {}, activeElement: null,
  createElement(tag) { return tag === 'canvas' ? createCanvas(1, 1) : { value: '', style: {}, addEventListener() {}, blur() {}, remove() {} }; } };
globalThis.Image = class extends NativeImage {
  set src(value) { const blob = resolveObjectURL(value); if (blob) blob.arrayBuffer().then(bytes => { super.src = Buffer.from(bytes); }); else super.src = value; }
  get src() { return super.src; }
};
const { MenuMusic } = await import('../src/ui/menu-music.ts');
const { MenuScreen } = await import('../src/ui/screens/menu.ts');
const { SelectScreen } = await import('../src/ui/screens/select.ts');
const { readNFM } = await import('../src/core/nfm.ts');
const { UI } = await import('../src/ui/widgets.ts');
const seed = path.resolve('../samples-converted');
const tracks = fs.readdirSync(seed).filter(name => name.endsWith('.nfm')).map((name, i) => {
  const bytes = fs.readFileSync(path.join(seed, name)), archive = readNFM(bytes), c = archive.chart;
  return { bytes, archive, entry: { id: 'track' + i, name, title: c.meta.title, artist: c.meta.artist, creator: c.meta.creator, version: c.meta.version, keys: c.keys, stars: c.stars, notes: c.notes.length, lengthMs: c.meta.lengthMs, size: bytes.length, addedAt: i } };
});
const audio = { previewActive: false, isPreviewPaused: false, ctx: { state: 'running' }, previewTimeSec: 30, previewDurationSec: 120,
  stopPreview() { this.previewActive = false; }, stopAmbient() {}, async previewMusic() { this.previewActive = true; },
  samplePreviewSpectrum: () => ({ bands: Float32Array.from({ length: 17 }, (_, i) => .5 + Math.sin(i * .8) * .25), bass: .65, energy: .55 }) };
const app = { w: 1280, h: 800, time: 10000, version: '0.2.0', platform: 'desktop', account: { user: null }, settings: { previewVolume: .35 }, audio,
  server: { scoreVersion: 0 }, serverOnline: false,
  canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, uiSound() {}, toast() {}, gotoScreen() {},
  store: { listCharts: async () => tracks.map(t => t.entry), getChartBytes: async id => tracks.find(t => t.entry.id === id)?.bytes, getBest: () => null } };
app.ui = new UI(app); app.menuMusic = new MenuMusic(app); app.menuMusic.enabled = true;
await app.menuMusic.select(tracks.find(t => t.entry.version.includes('evil')).entry, true);
await new Promise(resolve => setTimeout(resolve, 60));
assert.ok(app.menuMusic.background?.naturalWidth > 0, 'current playback archive supplies its real background');
app.menuMusic.backgroundChangedAt = -10000;
const files = [];
function draw(screen, name) {
  app.screen = screen;
  const canvas = createCanvas(app.w, app.h); app.ctx = canvas.getContext('2d');
  app.ui.beginFrame({ x: -1, y: -1, down: false, downX: 0, downY: 0, moved: false });
  screen.draw(app.ctx); app.menuMusic.draw(app.ctx); app.ui.endFrame();
  const file = `${name}-${app.w}x${app.h}.png`; fs.writeFileSync(path.join(output, file), canvas.toBuffer('image/png')); if (!files.includes(file)) files.push(file);
}
for (const [w, h] of [[1280, 800], [800, 600], [640, 400]]) {
  app.w = w; app.h = h;
  const menu = new MenuScreen(app); menu.enter(); menu.t0 = -10000; menu.update(16, 10000); draw(menu, 'menu');
  const tree = new SelectScreen(app); app.screen = tree; tree.active = true; tree.entries = tracks.map(t => t.entry); tree.applyFilter();
  draw(tree, 'tree'); // Starts lazy cover decode using the real visible rows.
  await new Promise(resolve => setTimeout(resolve, 240));
  tree.update(600, 10000);
  assert.equal(tree.groups.length, 2); assert.equal(tree.view.length, 4);
  draw(tree, 'tree'); tree.leave();
}
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ renderer: 'Real MenuMusic/MenuScreen/SelectScreen and native Canvas; real bundled chart background; simulated DOM/audio spectrum', files, checks: ['current playback background loaded', 'four charts grouped into two songs', 'three window sizes'] }, null, 2));
console.log(`PASS current music background and six menu/tree Canvas captures: ${output}`);
