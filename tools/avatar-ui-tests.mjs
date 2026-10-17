import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveObjectURL } from 'node:buffer';
import { createCanvas, Image as NativeImage, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { AvatarCrop, cropAvatar } from '../src/ui/avatar-upload.ts';

const output = path.resolve('test-results/avatar-ui'); fs.mkdirSync(output, { recursive: true });
if (fs.existsSync('C:/Windows/Fonts/msyh.ttc')) GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'Microsoft YaHei');
const all = [];
function element(tag) {
  const el = tag === 'canvas' ? createCanvas(320, 320) : {};
  Object.assign(el, { tagName: tag.toUpperCase(), style: {}, attrs: {}, children: [], listeners: new Map(), value: '', disabled: false, isConnected: false,
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, callback) { const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks); },
    appendChild(child) { child.parent = this; child.isConnected = true; this.children.push(child); return child; },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
    focus() { document.activeElement = this; }, blur() { if (document.activeElement === this) document.activeElement = null; },
    capture: null, setPointerCapture(id) { this.capture = id; }, releasePointerCapture(id) { if (this.capture === id) this.capture = null; }, getBoundingClientRect: () => ({ width: 320, height: 320 }),
    async fire(type, values = {}) { await Promise.all((this.listeners.get(type) || []).map(callback => callback({ stopPropagation() {}, preventDefault() {}, ...values }))); },
  });
  if (tag === 'canvas') el.toBlob = callback => callback(new Blob([el.toBuffer('image/png')], { type: 'image/png' }));
  all.push(el); return el;
}
globalThis.document = { createElement: element, body: element('body'), documentElement: {}, activeElement: null };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.Image = class extends NativeImage {
  set src(value) { const blob = typeof value === 'string' ? resolveObjectURL(value) : null; if (blob) blob.arrayBuffer().then(bytes => { super.src = Buffer.from(bytes); }); else super.src = value; }
};
const source = createCanvas(800, 400), sourceCtx = source.getContext('2d');
sourceCtx.fillStyle = '#ff0000'; sourceCtx.fillRect(0, 0, 400, 400);
sourceCtx.fillStyle = '#0000ff'; sourceCtx.fillRect(400, 0, 400, 400);
const file = new File([source.toBuffer('image/png')], 'avatar.png', { type: 'image/png' });
const waitForDialog = async () => {
  for (let i = 0; i < 100; i++) {
    const overlay = document.body.children.find(el => el.attrs.role === 'dialog');
    if (overlay) return overlay;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Avatar crop did not open');
};
const descendants = root => [root, ...root.children.flatMap(descendants)];

const math = new AvatarCrop(800, 400);
assert.deepEqual(math.rect, { x: 200, y: 0, size: 400 });
math.drag(20,20,0);assert.deepEqual(math.rect,{x:200,y:0,size:400},'hidden/zero-size previews cannot corrupt crop coordinates');
math.drag(-1000, 1000, 320); assert.deepEqual(math.rect, { x: 400, y: 0, size: 400 });
math.setZoom(2); assert.equal(math.rect.size, 200); assert.equal(math.rect.size <= Math.min(800, 400), true);
for (const [width, height] of [[400, 800], [1, 1], [800, 800]]) {
  const crop = new AvatarCrop(width, height); crop.setZoom(3); crop.drag(-10000, 10000, 320);
  assert.ok(crop.rect.x >= 0 && crop.rect.y >= 0 && crop.rect.x + crop.size <= width && crop.rect.y + crop.size <= height);
}

const pending = cropAvatar(file), dialog = await waitForDialog(), nodes = descendants(dialog);
const preview = nodes.find(el => el.tagName === 'CANVAS'), slider = nodes.find(el => el.type === 'range');
await preview.fire('pointerdown', { pointerId: 1, clientX: 160, clientY: 160 });
await preview.fire('pointermove', { pointerId: 1, clientX: -640, clientY: 160 });
await preview.fire('pointerup', { pointerId: 1 });
assert.equal(preview.capture,null,'releasing a crop drag releases pointer capture');
slider.value = '2'; await slider.fire('input');
await preview.fire('pointerdown',{pointerId:2,clientX:100,clientY:100});
await preview.fire('lostpointercapture',{pointerId:2});
const beforeLost=preview.toBuffer('image/png');
await preview.fire('pointermove',{pointerId:2,clientX:500,clientY:500});
assert.deepEqual(preview.toBuffer('image/png'),beforeLost,'lost capture ends dragging instead of moving on a stale pointer');
fs.writeFileSync(path.join(output, 'selected-square-preview.png'), preview.toBuffer('image/png'));
const confirm = nodes.filter(el => el.tagName === 'BUTTON').at(-1); await confirm.fire('click');
const bytes = await pending, image = await loadImage(bytes);
assert.equal(image.width, 256); assert.equal(image.height, 256);
const decoded = createCanvas(256, 256); decoded.getContext('2d').drawImage(image, 0, 0);
assert.deepEqual([...decoded.getContext('2d').getImageData(128, 128, 1, 1).data], [0, 0, 255, 255], 'confirmed output reflects the user-selected right-hand region');
assert.deepEqual([...decoded.getContext('2d').getImageData(2, 2, 1, 1).data], [0, 0, 255, 255], 'preview guides are excluded from uploaded pixels');
fs.writeFileSync(path.join(output, 'selected-avatar.png'), bytes);
assert.equal(document.body.children.length, 0);

const cancelled = cropAvatar(file), cancelDialog = await waitForDialog();
await descendants(cancelDialog).find(el => el.tagName === 'BUTTON').fire('click'); assert.equal(await cancelled, null);
const controller = new AbortController(), aborted = cropAvatar(file, controller.signal); await waitForDialog(); controller.abort(); assert.equal(await aborted, null);
assert.equal(document.body.children.length, 0);
await assert.rejects(cropAvatar(new File(['<svg/>'], 'bad.svg', { type: 'image/svg+xml' })), /PNG/);
await assert.rejects(cropAvatar({ type: 'image/png', size: 11 * 1024 * 1024 }), /10 MB/);
console.log('PASS actual avatar crop drag/zoom/confirm, square 256px output, no guide pixels, cancellation/abort and source validation');

const { AccountScreen } = await import('../src/ui/screens/account.ts');
const { UI } = await import('../src/ui/widgets.ts');
const { setLanguage } = await import('../src/ui/i18n.ts'); setLanguage('zh-CN');
const canvas = createCanvas(800, 600), controls = [];
const app = { w: 800, h: 600, ctx: canvas.getContext('2d'), settings: { serverUrl: 'https://example.invalid' }, serverOnline: true,
  server: { base: 'https://example.invalid', avatarsEnabled: true, leaderboard: async () => [], myScores: async () => [] },
  account: { server: true, user: { username: 'tester', nickname: 'Player', rating: 25.2, bestPp: 120, email: '', emailVerified: true } },
  store: { getToken: () => '', getBestScores: () => ({}) }, canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, gotoScreen() {}, toast() {}, uiSound() {},
};
app.ui = new UI(app); const originalButton = app.ui.button.bind(app.ui);
app.ui.button = (...args) => { controls.push(args); return originalButton(...args); };
const account = new AccountScreen(app); account.enter();
const draw = () => { app.ctx.fillStyle = '#0d1218'; app.ctx.fillRect(0, 0, 800, 600); controls.length = 0; app.ui.beginFrame({ x: -1, y: -1, down: false }); account.draw(app.ctx); app.ui.endFrame(); };
draw();
assert.equal(account.serverUrl.el.disabled, true);
const connected = controls.find(args => args[0] === 'connect'); assert.equal(connected[5], 'DISCONNECT'); assert.equal(connected[6].disabled, false);
assert.ok(controls.some(args => args[0] === 'avatar-upload' && !args[6].disabled), 'signed-in capable server offers avatar upload');
fs.writeFileSync(path.join(output, 'connected-profile.png'), canvas.toBuffer('image/png'));
app.serverOnline = false; app.account = { server: false, user: null }; draw(); assert.equal(account.serverUrl.el.disabled, false);
assert.equal(controls.find(args => args[0] === 'connect')[5], 'CONNECT');
app.serverOnline = true; app.account = { server: false, user: null }; draw();
assert.ok(controls.some(args => args[0] === 'do-auth'), 'connected anonymous user sees login');
assert.ok(!controls.some(args => args[0] === 'avatar-upload'), 'anonymous user cannot upload an avatar');
account.leave(); account.enter(); assert.equal(account.serverUrl.el.isConnected, true, 'fields are restored when revisiting account'); account.leave();
console.log('PASS connected address locked with disconnect available, anonymous login retained, authenticated avatar action and account revisit');
app.w = 780; app.h = 360; app.isTouch = true; app.account = { server: true, user: { username: 'tester', nickname: 'Player', rating: 25, bestPp: 120, email: '', emailVerified: true } };
canvas.width = 780; canvas.height = 360;
app.store.getToken = () => 'test-session'; account.enter(); draw();
assert.ok(controls.find(args => args[0] === 'avatar-upload')[2] >= app.h - 20, 'landscape avatar starts below the viewport');
account.pointerDown(300, 290); account.pointerMove(300, 150); account.pointerUp(300, 150); draw();
assert.equal(account.scroll, 140, 'touch drag scrolls the actual account screen');
const reachable = controls.find(args => args[0] === 'avatar-upload'); assert.ok(reachable[2] >= 106 && reachable[2] + reachable[4] < app.h - 20, 'avatar action becomes fully reachable');
let picked = 0; account.chooseAvatar = () => { picked++; };
app.ui.beginFrame({ x: reachable[1] + 5, y: reachable[2] + 5, down: false }); account.draw(app.ctx); app.ui.endFrame();
assert.equal(picked, 0, 'scroll release cannot activate upload');
fs.writeFileSync(path.join(output, 'landscape-profile-scrolled.png'), canvas.toBuffer('image/png'));
account.leave();
await account.uploadAvatar(file); assert.ok(!document.body.children.some(el => el.attrs.role === 'dialog'), 'late file picker callbacks cannot open a crop after leaving');

account.enter(); const replies = [], signals = [];
app.server.uploadAvatar = (_bytes, _mime, signal) => { signals.push(signal); return new Promise(resolve => replies.push(resolve)); };
const confirmDialog = async () => { const overlay = await waitForDialog(); await descendants(overlay).filter(el => el.tagName === 'BUTTON').at(-1).fire('click'); };
const firstUpload = account.uploadAvatar(file); await confirmDialog();
assert.equal(replies.length, 1); account.leave(); assert.equal(signals[0].aborted, true, 'leaving aborts the avatar request');
account.enter(); const secondUpload = account.uploadAvatar(file); await confirmDialog(); assert.equal(replies.length, 2);
replies[1]({ ...app.account.user, avatar: '/api/avatars/tester/new.png' }); await secondUpload;
replies[0]({ ...app.account.user, avatar: '/api/avatars/tester/old.png' }); await firstUpload;
assert.equal(app.account.user.avatar, '/api/avatars/tester/new.png', 'old upload response cannot overwrite a newer operation after revisit');
account.leave();
console.log('PASS landscape touch-scroll reachability, suppressed drag clicks, late picker and out-of-order avatar response guards');
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ ok: true, verifiedAt: new Date().toISOString(), actualCropOutput: true, interactiveSelection: true, cancelledWithoutUpload: true, connectedControlsDisabled: true }, null, 2));
