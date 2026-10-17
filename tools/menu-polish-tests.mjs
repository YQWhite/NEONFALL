import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, Image as NativeImage, GlobalFonts } from '@napi-rs/canvas';

for (const font of ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/segoeui.ttf']) if (fs.existsSync(font)) GlobalFonts.registerFromPath(font, font.includes('msyh') ? 'Microsoft YaHei' : 'Segoe UI');
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { body: { appendChild() {} }, activeElement: null, createElement: tag => tag === 'canvas' ? createCanvas(1, 1) : { style: {}, addEventListener() {} } };
const { MenuMusic } = await import('../src/ui/menu-music.ts');
const { MenuScreen } = await import('../src/ui/screens/menu.ts');
const { drawAvatar } = await import('../src/ui/avatar-art.ts');
const { UI } = await import('../src/ui/widgets.ts');
const { setLanguage } = await import('../src/ui/i18n.ts');
setLanguage('zh-CN');
const out = path.resolve('test-results/menu-polish'); fs.mkdirSync(out, { recursive: true });

async function solid(color) {
  const canvas = createCanvas(320, 180), ctx = canvas.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180);
  const image = new NativeImage(); image.src = canvas.toBuffer('image/png');
  await image.decode(); return image;
}
const [red, blue, green] = await Promise.all([solid('#e05050'), solid('#4050e0'), solid('#50d060')]);
const app = { w: 1280, h: 800, version: '0.2.0', platform: 'desktop', screen: { name: 'menu' }, serverOnline: true, server: { base: 'https://example.test/game' },
  settings: {}, account: { server: true, user: { nickname: 'Rhythm Player', username: 'rhythm', rating: 123.45 } },
  audio: { previewActive: true, previewTimeSec: 30, previewDurationSec: 120, ctx: { state: 'running' } },
  uiSound() {}, gotoScreen(name) { this.target = name; },
};
const radio = app.menuMusic = new MenuMusic(app); app.ui = new UI(app);
radio.entry = { title: 'A smooth transition', artist: 'NEONFALL' };
radio.background = red; radio.backgroundChangedAt = -10000;
const canvas = createCanvas(320, 180), ctx = canvas.getContext('2d');
const frame = now => { radio.drawBackground(ctx, 320, 180, now); return Array.from(ctx.getImageData(160, 90, 1, 1).data); };
const before = frame(0); radio.changeBackground(blue, 0); const start = frame(0);
assert.deepEqual(start, before, 'changing artwork preserves the exact visible previous frame');
const middle = frame(500), end = frame(1000);
assert.ok(middle[0] < start[0] && middle[0] > end[0], 'red fades monotonically');
assert.ok(middle[2] > start[2] && middle[2] < end[2], 'blue fades monotonically');
radio.background = red; radio.backgroundChangedAt = -10000; radio.backgroundFrom = null;
radio.changeBackground(blue, 0); const interrupted = frame(420);
radio.changeBackground(green, 420); assert.deepEqual(frame(420), interrupted, 'rapid skip continues from the existing blend');
radio.changeBackground(null, 1600);
assert.ok(frame(2100)[1] > frame(2600)[1], 'a chart without art fades to the base background');
console.log('PASS artwork crossfade, no dark flash, interrupted transition and missing-art fade');

let failDownload;
const waiting = new MenuMusic({ ...app, audio: { stopPreview() {} }, store: { getChartBytes: () => new Promise((_, reject) => { failDownload = reject; }) } });
waiting.enabled = true; waiting.background = red;
const selecting = waiting.select({ id: 'unavailable-song' });
assert.equal(waiting.background, red, 'background remains while the next recording downloads');
failDownload(new Error('offline')); await selecting;
assert.equal(waiting.background, red, 'failed download preserves the previous artwork');
console.log('PASS artwork retained during slow or failed song download');

const requested = [];
globalThis.Image = class { set src(url) { requested.push(url); } };
drawAvatar(ctx, app, { username: 'A', avatar: '/api/avatars/a.png?v=1' }, 10, 10, 50);
assert.equal(requested[0], 'https://example.test/game/api/avatars/a.png?v=1');
for (const avatar of ['https://untrusted.test/a.png', '/api/avatars/../../me', '/api/avatars/..\\me', 'data:image/svg+xml,<svg/>']) drawAvatar(ctx, app, { username: 'A', avatar }, 10, 10, 50);
assert.equal(requested.length, 1, 'avatar widget only loads the configured server public-avatar route');
drawAvatar(ctx, app, { username: 'A', avatar: '/api/avatars/a.png?v=1' }, 10, 10, 50);
assert.equal(requested.length, 1, 'avatar image is cached between frames');
for (let i = 0; i < 30; ++i) drawAvatar(ctx, app, { username: 'A', avatar: `/api/avatars/${i}.png` }, 10, 10, 50);
drawAvatar(ctx, app, { username: 'A', avatar: '/api/avatars/a.png?v=1' }, 10, 10, 50);
assert.equal(requested.length, 32, 'avatar cache is bounded and evicts old entries');
console.log('PASS public avatar origin/path restriction, initials fallback and bounded cache');

radio.background = blue; radio.backgroundChangedAt = -10000; radio.backgroundFrom = null;
const controls = [], originalButton = app.ui.button.bind(app.ui);
app.ui.button = (...args) => { controls.push({ id: args[0], x: args[1], y: args[2], w: args[3], h: args[4] }); return originalButton(...args); };
function draw(w, h, pulse = .8, pointer = {}) {
  app.w = w; app.h = h;
  const canvas = createCanvas(w, h), context = canvas.getContext('2d'); app.ctx = context;
  const screen = new MenuScreen(app); screen.enter(); screen.t0 = -10000;
  screen.visual = { bands: Float32Array.from({ length: 17 }, (_, i) => .5 + Math.sin(i * .8) * .25), pulse, energy: .5, position: 30 };
  const glowingRects = [], fill = context.fillRect.bind(context);
  context.fillRect = (x, y, width, height) => { if (context.shadowBlur > 0) glowingRects.push(width); fill(x, y, width, height); };
  controls.length = 0;
  app.ui.beginFrame({ x: -1, y: -1, down: false, downX: 0, downY: 0, moved: false, ...pointer });
  screen.draw(context); radio.draw(context); app.ui.endFrame();
  const profile = controls.find(c => c.id === 'music-profile'), toggle = controls.find(c => c.id === 'music-toggle');
  assert.ok(profile && profile.x >= 0 && profile.w >= 90, 'profile card is visible');
  assert.ok(toggle && profile.x + profile.w < toggle.x, 'profile stays left of music controls');
  assert.ok(glowingRects.every(width => width <= 3), 'glowing fill rectangles are only the frequency bars');
  return { canvas, profile };
}
for (const [w, h] of [[1280,800],[800,600],[640,400],[390,844],[320,640]]) {
  const { canvas } = draw(w, h); fs.writeFileSync(path.join(out, `menu-${w}x${h}.png`), canvas.toBuffer('image/png'));
}
const { profile } = draw(800, 600), point = { x: profile.x + profile.w / 2, y: profile.y + profile.h / 2 };
draw(800, 600, .8, { ...point, down: true }); draw(800, 600, .8, { ...point, down: false });
assert.equal(app.target, 'account', 'profile widget opens the account page');
console.log('PASS shape-bound glow, five responsive profile/player layouts and account navigation');
