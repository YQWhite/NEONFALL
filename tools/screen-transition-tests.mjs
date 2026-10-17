import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

let now = 0;
const originalPerformance = globalThis.performance;
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
function element(tag) {
  if (tag === 'canvas') {
    const canvas = createCanvas(1, 1); canvas.style = {};
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }); return canvas;
  }
  return { style: {}, value: '', addEventListener() {}, setAttribute() {}, remove() {}, focus() {}, blur() {} };
}
globalThis.window = { innerWidth: 320, innerHeight: 240, devicePixelRatio: 1, matchMedia: () => ({ matches: false }), addEventListener() {} };
globalThis.document = { documentElement: {}, body: { appendChild() {} }, getElementById: () => ({ appendChild() {} }),
  createElement: element, addEventListener() {}, activeElement: null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { App, Screen } = await import('../src/ui/app.ts');
const app = new App(); app.resize();
app.audio = { previewActive: true, isPreviewPaused: false, stopPreview() { this.previewActive = false; } };
app.menuMusic.ensureStarted = async () => {}; app.menuMusic.draw = () => {};
const calls = [], colors = { menu: '#ff0000', settings: '#0000ff', account: '#00ff00', import: '#ffff00', select: '#00ffff', play: '#ff00ff', result: '#ffffff' };
class TestScreen extends Screen {
  constructor(app, name) { super(app); this.name = name; }
  enter() { calls.push('enter:' + this.name); }
  leave() { calls.push('leave:' + this.name); this.left = true; }
  update() { calls.push('update:' + this.name); }
  draw(ctx) {
    assert.equal(this.left, undefined, 'disposed screens are never drawn');
    ctx.fillStyle = colors[this.name]; ctx.fillRect(0, 0, app.w, app.h);
    if (this.navigateDuringDraw) {
      app.gotoScreen('import');
      assert.equal(app.screen, this, 'draw-triggered navigation waits for complete frame');
      ctx.fillStyle = '#ffff00'; ctx.fillRect(0, 0, 20, 20);
      this.navigateDuringDraw = false;
    }
  }
}
for (const name of Object.keys(colors)) app.registerScreen(name, a => new TestScreen(a, name));
const pixel = (x = 100, y = 100) => [...app.ctx.getImageData(x, y, 1, 1).data];
app.gotoScreen('menu'); app.draw(); assert.deepEqual(pixel(), [255, 0, 0, 255]);
assert.equal(app.viewTransition.frame, null, 'boot has no empty outgoing snapshot');
app.gotoScreen('settings'); assert.equal(app.audio.previewActive, true, 'settings retains BGM');
app.draw(); assert.deepEqual(pixel(), [255, 0, 0, 255], 'first frame exactly preserves outgoing screen');
now = 140; app.draw(); const middle = pixel();
assert.ok(Math.abs(middle[0] - 128) <= 1 && Math.abs(middle[2] - 128) <= 1, 'halfway is blended without dark flash');
app.gotoScreen('account'); app.draw(); assert.deepEqual(pixel(), middle, 'rapid navigation preserves current blend');
now += 280; app.draw(); assert.deepEqual(pixel(), [0, 255, 0, 255]);
assert.equal(app.viewTransition.frame, null, 'snapshot freed when finished');

app.screen.navigateDuringDraw = true; app.draw();
assert.equal(app.screen.name, 'import'); assert.equal(calls.filter(c => c === 'leave:account').length, 1);
app.draw(); assert.deepEqual(pixel(10, 10), [255, 255, 0, 255], 'capture includes final outgoing draw operations');
assert.deepEqual(pixel(), [0, 255, 0, 255]);
now += 280; app.draw(); assert.deepEqual(pixel(), [255, 255, 0, 255]);
app.animateViewChange(() => { colors.import = '#0000ff'; }); app.draw(); assert.deepEqual(pixel(), [255, 255, 0, 255]);
now += 280; app.draw(); assert.deepEqual(pixel(), [0, 0, 255, 255], 'local panels share animation');

app.pointer.down = true; app.pointer.moved = false; app.ui.active = 'old';
app.gotoScreen('select'); assert.equal(app.pointer.down, false); assert.equal(app.ui.active, null);
app.draw(); window.innerWidth = 640; window.innerHeight = 360; app.resize();
now += 140; app.draw(); assert.equal(pixel(400, 200)[3], 255, 'resize keeps composite opaque');
now += 140; app.draw(); assert.deepEqual(pixel(400, 200), [0, 255, 255, 255]);
app.gotoScreen('play'); assert.equal(app.audio.previewActive, false, 'gameplay stops preview');
app.update(16, now); assert.equal(calls.at(-1), 'update:play', 'gameplay updates are never delayed by transition');
app.draw(); now += 280; app.draw(); assert.deepEqual(pixel(), [255, 0, 255, 255]);
app.gotoScreen('result'); app.draw(); now += 280; app.draw(); assert.deepEqual(pixel(), [255, 255, 255, 255]);
window.matchMedia = () => ({ matches: true }); app.gotoScreen('menu'); app.draw(); now += 100; app.draw();
assert.equal(app.viewTransition.frame, null, 'reduced-motion mode uses shorter transition');
fs.mkdirSync('test-results/navigation-delivery', { recursive: true });
fs.writeFileSync('test-results/navigation-delivery/transition-tests.json', JSON.stringify({ passed: true,
  checks: ['boot', 'all 7 screen types', 'crossfade pixels', 'interrupted continuity', 'draw navigation lifecycle', 'local views', 'pointer reset', 'resize', 'game timing', 'BGM navigation', 'reduced motion', 'snapshot release'],
  renderer: 'Native Canvas with simulated DOM; no browser/device claim' }, null, 2));
Object.defineProperty(globalThis, 'performance', { configurable: true, value: originalPerformance });
console.log('PASS screen transitions: pixel continuity, lifecycle, resize, pointer isolation and live gameplay');
