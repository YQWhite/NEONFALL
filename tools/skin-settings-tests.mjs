import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas, Image } from '@napi-rs/canvas';
import { resolveObjectURL } from 'node:buffer';
import { DEFAULT_MODS, DEFAULT_SETTINGS } from '../src/core/types.ts';
import { Store } from '../src/core/store.ts';
import { UI } from '../src/ui/widgets.ts';
import { SettingsScreen } from '../src/ui/screens/settings.ts';
import { PlayScreen } from '../src/ui/screens/play.ts';
import { setLanguage } from '../src/ui/i18n.ts';

const output = new URL('../test-results/skin-field-refresh/', import.meta.url);
fs.mkdirSync(output, { recursive: true });
globalThis.document = { documentElement: {}, hidden: false, createElement: () => createCanvas(1, 1) };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const saved = new Map();
globalThis.localStorage = { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) };
globalThis.Image = class extends Image {
  set src(value) { const blob = resolveObjectURL(value); blob.arrayBuffer().then(b => { super.src = Buffer.from(b); }); }
};
setLanguage('en');
for (const value of [-1, 0, .23, .4, 1, null, '0.2']) {
  localStorage.setItem('nf.settings.v1', JSON.stringify({ playfieldBottomGap: value }));
  assert.equal(new Store().settings.playfieldBottomGap, typeof value === 'number' ? Math.max(0, Math.min(.4, value)) : undefined);
}
localStorage.removeItem('nf.settings.v1');
const store = new Store();
store.listSkins = async () => [{ id: 'custom-test', name: 'Imported', size: 1 }];
store.getSkinBytes = async () => null;
const app = { w: 1280, h: 800, settings: store.settings, store, audio: { setPreviewDucking() {}, baseLatencyMs: 0 }, uiSound() {},
  saveSettings() { store.saveSettings(); }, gotoScreen() {}, toast() {}, platform: 'web', version: 'test', isTouch: true };
const canvas = createCanvas(app.w, app.h); app.ctx = canvas.getContext('2d');
app.ui = new UI(app);
const controls = [];
for (const name of ['button', 'chip', 'slider']) {
  const original = app.ui[name].bind(app.ui);
  app.ui[name] = (...args) => { controls.push({ id: args[0], x: args[1], y: args[2], w: args[3], h: args[4], args }); return original(...args); };
}
const screen = new SettingsScreen(app); await screen.enter(); await screen.loadPreview();
function draw(pointer = {}) {
  controls.length = 0; app.ctx.clearRect(0, 0, app.w, app.h);
  app.ui.beginFrame({ x: -1, y: -1, down: false, moved: false, downX: 0, downY: 0, ...pointer });
  screen.draw(app.ctx); app.ui.endFrame();
}
function visible(id) {
  draw(); let c = controls.find(c => c.id === id); assert.ok(c, id);
  const v = screen.viewport;
  screen.scroll = Math.max(0, Math.min(screen.maxScroll, screen.scroll + c.y - v.y - 34));
  draw(); c = controls.find(c => c.id === id);
  assert.ok(c.y >= v.y && c.y + c.h <= v.y + v.h, `${id} reachable by scrolling`);
  return c;
}
function slide(id, fraction) {
  const c = visible(id), x = c.x + c.w * fraction, y = c.y + c.h / 2;
  draw({ x, y, down: true, downX: x, downY: y }); draw({ x, y, down: false });
}
function click(id) {
  const c = visible(id), x = c.x + c.w / 2, y = c.y + c.h / 2;
  draw({ x, y, down: true, downX: x, downY: y }); draw({ x, y, down: false });
}
screen.tab = 'gameplay'; slide('s-field-bottom-gap', .75);
assert.equal(app.settings.playfieldBottomGap, .3);
assert.equal(new Store().settings.playfieldBottomGap, .3);
fs.writeFileSync(new URL('settings-height.png', output), canvas.toBuffer('image/png'));
click('field-bottom-gap-reset');
assert.equal(app.settings.playfieldBottomGap, undefined);
assert.equal(new Store().settings.playfieldBottomGap, undefined);
screen.tab = 'skin'; screen.scroll = 0; draw();
assert.ok(controls.some(c => c.id === 'skin-default' && c.args[5] === 'OSU皮肤示例'));
assert.ok(controls.some(c => c.id === 'skin-builtin:malody' && c.args[5] === 'Malody斜轨示例'));
assert.ok(!controls.some(c => /^skin-del-(builtin:|default)/.test(c.id)), 'built-ins cannot be deleted');
assert.ok(controls.some(c => c.id === 'skin-del-custom-test'), 'imported skins remain removable');
click('skin-builtin:malody'); await screen.loadPreview();
assert.equal(app.settings.skinId, 'builtin:malody'); assert.ok(screen.preview.session.skin.perspective);
slide('s-skin-bottom-gap', .25); assert.equal(app.settings.playfieldBottomGap, .1);
click('skin-default'); await screen.loadPreview();
assert.equal(app.settings.skinId, ''); assert.equal(screen.preview.session.skin.perspective, undefined);
assert.match(screen.preview.session.skin.name, /Remilia/);
screen.tab = 'video'; screen.scroll = 0;
for (const value of [0, .5, 1]) {
  slide('s-bgdim', value); assert.equal(app.settings.bgDim, 1 - value);
  assert.equal(new Store().settings.bgDim, 1 - value);
  slide('s-sb-brightness', value); assert.equal(app.settings.storyboardBrightness, value);
  assert.equal(new Store().settings.storyboardBrightness, value);
}
screen.leave();

// Actual gameplay background pass: 0% is black, 50% halves RGB, 100% is unchanged.
const source = createCanvas(16, 16); source.getContext('2d').fillStyle = 'rgb(200,100,50)'; source.getContext('2d').fillRect(0, 0, 16, 16);
const picture = new Image(); picture.src = source.toBuffer('image/png'); await picture.decode();
const game = new PlayScreen(app); game.status = ''; game.drawHUD = () => {};
game.sess = { phase: 'playing', bgImage: picture, chartTime: () => 0 };
for (const brightness of [0, .5, 1]) {
  app.settings.bgDim = 1 - brightness; app.ctx.clearRect(0, 0, app.w, app.h); game.draw(app.ctx);
  const pixel = [...app.ctx.getImageData(300, 300, 1, 1).data];
  for (const [i, channel] of [200, 100, 50].entries()) assert.ok(Math.abs(pixel[i] - channel * brightness) <= 1);
}
game.sess.phase = 'paused';
for (const brightness of [0, 1]) {
  controls.length = 0; app.ui.beginFrame({ x: -1, y: -1, down: false }); game.drawPause(app.ctx); app.ui.endFrame();
  const c = controls.find(c => c.id === 'pause-bgdim'), x = c.x + c.w * brightness, y = c.y + c.h / 2;
  app.ui.beginFrame({ x, y, down: true, downX: x, downY: y }); game.drawPause(app.ctx); app.ui.endFrame();
  app.ui.beginFrame({ x, y, down: false }); game.drawPause(app.ctx); app.ui.endFrame();
  assert.equal(app.settings.bgDim, 1 - brightness, 'pause also exposes the entire range');
}
console.log('PASS actual settings sliders/persistence/reset, built-in skin selection/deletion guards, background and storyboard 0/50/100%, pause brightness and black pixels');
