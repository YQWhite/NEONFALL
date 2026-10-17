// Native Canvas checks cover seek correctness and work per frame, without
// treating native Canvas timings as browser or device FPS measurements.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PlayfieldRenderer, SkinImages } from '../src/engine/render.ts';
import { buildTimeMap, readNFSK } from '../src/core/nfm.ts';
import { selectSkinForKeys } from '../src/core/osk.ts';
import { DEFAULT_MODS, DEFAULT_SETTINGS } from '../src/core/types.ts';

const settings = { ...DEFAULT_SETTINGS }, mods = { ...DEFAULT_MODS };
const output = new URL('../test-results/skin-performance/', import.meta.url);
fs.mkdirSync(output, { recursive: true });
const columns = Array.from({ length: 4 }, () => ({ width: 66, noteImg: 'tap', noteImgH: 'head', noteImgT: 'tail', bodyImg: 'body' }));
const skin = { columns, columnWidth: 66, hitPosition: 402, judgementLine: false, keyUnderNotes: true, noteBodyStyle: 1 };
const assets = new Map();
for (const [name, height, colour] of [['tap', 200, '#c0d0ee'], ['head', 28, '#89bdcc'], ['tail', 20, '#edbbca'], ['body', 2, '#72a696']]) {
  const image = createCanvas(66, height), ctx = image.getContext('2d');
  ctx.fillStyle = colour; ctx.fillRect(3, 0, 60, height);
  ctx.fillStyle = 'rgba(12,25,30,.7)'; ctx.fillRect(8, 0, 12, Math.max(1, height / 2));
  assets.set(name, image);
}
const makeRenderer = (custom = skin, decoded = assets) => {
  const r = new PlayfieldRenderer(custom, () => undefined, settings, mods);
  for (const [name, image] of decoded) r.images.images.set(name, image);
  return r;
};
const notes = [{ t: -5000, col: 0, end: 40000 }];
for (let i = 0; i < 2500; i++) notes.push({ t: i * 20, col: i % 4, ...(i % 13 === 1 ? { end: i * 20 + 2400 } : {}) });
const timeMap = buildTimeMap([{ t: 0, bpm: 120 }, { t: 14000, bpm: 240 }], [{ t: 7000, sv: .2 }, { t: 20000, sv: 3 }], 0);
const canvas = createCanvas(512, 480), reference = createCanvas(512, 480);
const actual = makeRenderer(), fullScan = makeRenderer();
// Same renderer with all elapsed notes admitted is the reference drawing path.
// Offscreen history must have no effect on final pixels, even after rewinds.
fullScan.lowerBoundT = () => 0;
const state = { keys: 4, notes, timeMap, colFlash: [0, 0, 0, 0], drawTime: () => 0, isJudged: () => false, isHeld: () => false };
let compared = 0;
for (const t of [-6000, 0, 300, 8000, 19000, 36000, 22000, 1000, 45000]) {
  state.drawTime = () => t;
  for (const held of [false, true]) {
    state.isJudged = i => held && i === 0;
    state.isHeld = i => held && i === 0;
    for (const [c, r] of [[canvas, actual], [reference, fullScan]]) {
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, 512, 480);
      r.drawNotes(ctx, state, 124, [66, 66, 66, 66], 402, 1000);
    }
    assert.deepEqual(canvas.getContext('2d').getImageData(0, 0, 512, 480).data,
      reference.getContext('2d').getImageData(0, 0, 512, 480).data, `visible notes differ at ${t}, held=${held}`);
    compared++;
  }
}

// Compare repeating textures to an independently assembled continuous strip.
// Individual subpixel sprites leave antialias seams between old tiles; the strip
// and pattern both preserve continuous skin artwork without those seams.
let maxPatternMeanError = 0;
for (const width of [33, 66, 99, 70.25]) {
  const patternRenderer = makeRenderer();
  const oldCtx = reference.getContext('2d');
  canvas.getContext('2d').clearRect(0, 0, 512, 480); oldCtx.clearRect(0, 0, 512, 480);
  patternRenderer.drawHold(canvas.getContext('2d'), {}, 0, 157, width, 121.3, 402.5, 0);
  const body = assets.get('body'), head = assets.get('head'), tail = assets.get('tail');
  const headH = width * head.height / head.width, tailH = width * tail.height / tail.width;
  const top = 121.3 - tailH / 2, bottom = 402.5 - headH / 2, ratio = width / body.width;
  const count = Math.ceil((bottom - top) / (body.height * ratio));
  const strip = createCanvas(body.width, body.height * count);
  for (let i = 0; i < count; i++) strip.getContext('2d').drawImage(body, 0, i * body.height);
  oldCtx.drawImage(strip, 0, 0, body.width, (bottom - top) / ratio, 157 - width / 2, top, width, bottom - top);
  oldCtx.save(); oldCtx.translate(157 - width / 2, 121.3); oldCtx.scale(1, -1); oldCtx.drawImage(tail, 0, 0, width, tailH); oldCtx.restore();
  oldCtx.drawImage(head, 157 - width / 2, 402.5 - headH, width, headH);
  const a = canvas.getContext('2d').getImageData(0, 0, 512, 480).data, b = oldCtx.getImageData(0, 0, 512, 480).data;
  let total = 0, visible = 0;
  for (let i = 0; i < a.length; i++) { total += Math.abs(a[i] - b[i]); if (a[i] || b[i]) visible++; }
  maxPatternMeanError = Math.max(maxPatternMeanError, total / visible);
  assert.ok(total / visible < 4, `pattern differs from continuous strip at width ${width}: ${total / visible}`);
}

// Use a real converted Remilia skin when present, including transparent sprites.
const bundled = new URL('../../samples-converted/', import.meta.url);
if (fs.existsSync(bundled)) {
  const file = fs.readdirSync(bundled).find(f => /\.nfsk$/i.test(f));
  if (file) {
    const parsed = readNFSK(fs.readFileSync(new URL(file, bundled)));
    const layout = selectSkinForKeys(parsed.skin, 4), images = new Map();
    for (const col of layout.columns) for (const key of ['noteImg', 'noteImgH', 'noteImgT', 'bodyImg', 'bodyBegin', 'bodyEnd']) {
      const name = col[key]; if (name && !images.has(name)) images.set(name, await loadImage(Buffer.from(parsed.files.get(name))));
    }
    const optimized = makeRenderer(layout, images), original = makeRenderer(layout, images); original.lowerBoundT = () => 0;
    for (const t of [700, 15000, 37500, 2000]) {
      state.drawTime = () => t; state.isJudged = () => false; state.isHeld = () => false;
      for (const [c, r] of [[canvas, optimized], [reference, original]]) { const ctx = c.getContext('2d'); ctx.clearRect(0, 0, 512, 480); r.drawNotes(ctx, state, 124, [66, 66, 66, 66], 402, 1000); }
      assert.deepEqual(canvas.getContext('2d').getImageData(0, 0, 512, 480).data, reference.getContext('2d').getImageData(0, 0, 512, 480).data);
      if (t === 15000) {
        fs.writeFileSync(new URL('remilia-optimized.png', output), canvas.toBuffer('image/png'));
        fs.writeFileSync(new URL('remilia-reference.png', output), reference.toBuffer('image/png'));
      }
      compared++;
    }
  }
}

const manyNotes = [{ t: 0, col: 0, end: 3000000 }, ...Array.from({ length: 100000 }, (_, i) => ({ t: 1 + i * 20, col: i % 4 }))];
let checks = 0, oldHoldVisible = false;
const largeState = { ...state, notes: manyNotes, drawTime: () => 1800000, isJudged: () => { checks++; return false; }, isHeld: () => false };
const bounded = makeRenderer(); bounded.prepareNotes(largeState);
bounded.drawHold = () => { oldHoldVisible = true; };
bounded.drawNotes(canvas.getContext('2d'), largeState, 124, [66, 66, 66, 66], 402, 1000);
assert.ok(oldHoldVisible, 'a hold beginning 30 minutes before the window must remain visible');
assert.ok(checks < 1000, `100000-note chart scanned ${checks} notes per frame`);

let patternCalls = 0, spriteCalls = 0;
const counted = new Proxy(canvas.getContext('2d'), { get(target, prop) {
  const value = Reflect.get(target, prop, target);
  if (prop === 'createPattern') return (...args) => { patternCalls++; return value.apply(target, args); };
  if (prop === 'drawImage') return (...args) => { spriteCalls++; return value.apply(target, args); };
  return typeof value === 'function' ? value.bind(target) : value;
}, set(target, prop, value) { Reflect.set(target, prop, value, target); return true; } });
const cached = makeRenderer();
for (let frame = 0; frame < 50; frame++) cached.drawHold(counted, {}, 0, 157, 66, -480, 900, 0);
assert.equal(patternCalls, 1); assert.equal(spriteCalls, 100, 'tiled body should not add sprite calls');

// Missing resources and decode failures should be remembered and release blobs.
let reads = 0;
const missing = new SkinImages(() => { reads++; return undefined; });
await Promise.all([missing.load('missing'), missing.load('missing')]); assert.equal(reads, 1);
const oldImage = globalThis.Image, revoked = [], oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
try {
  globalThis.Image = class { set src(value) { queueMicrotask(() => this.onerror()); } };
  URL.createObjectURL = () => 'blob:failed'; URL.revokeObjectURL = url => revoked.push(url);
  const broken = new SkinImages(() => new Uint8Array([1]));
  assert.equal(await broken.load('broken'), null); assert.equal(await broken.load('broken'), null);
  assert.deepEqual(revoked, ['blob:failed']); assert.equal(broken.pending.size, 0);
} finally { globalThis.Image = oldImage; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }

fs.writeFileSync(new URL('results.json', output), JSON.stringify({
  canvasComparisons: compared, fullScanPixelDifferences: 0,
  chartNotes: manyNotes.length, candidateChecksPerFrame: checks, oldHoldVisible,
  tiledFrames: 50, capSpriteCalls: spriteCalls, patternCreations: patternCalls,
  maxPatternMeanChannelError: maxPatternMeanError,
  missingAssetsCached: true, failedDecodeBlobReleased: true,
  limitation: 'Native Canvas regression and draw-work counts; not browser FPS or physical-device testing.',
}, null, 2));
console.log(`PASS ${compared} Canvas comparisons / 100000 notes: ${checks} candidates per frame / 50 tiled holds: ${spriteCalls} cap sprites, ${patternCalls} pattern / missing-image cleanup`);
console.log(`Pattern versus continuous strip mean channel error <= ${maxPatternMeanError.toFixed(2)}/255; this is a native Canvas regression, not a browser FPS benchmark.`);
