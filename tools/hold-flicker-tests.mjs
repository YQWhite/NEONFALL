import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PlaySession } from '../src/engine/play.ts';
import { PlayfieldRenderer } from '../src/engine/render.ts';
import { DEFAULT_MODS, DEFAULT_SETTINGS } from '../src/core/types.ts';
import { readNFSK } from '../src/core/nfm.ts';
import { selectSkinForKeys } from '../src/core/osk.ts';

const output = new URL('../test-results/hold-flicker/', import.meta.url);
fs.mkdirSync(output, { recursive: true });
const settings = { ...DEFAULT_SETTINGS, particles: false };
const mods = { ...DEFAULT_MODS, noFail: true };
const images = new Map();
for (const [key, height, color] of [['head', 28, '#ff8030'], ['tail', 20, '#5bb8ff'], ['body', 4, '#6db6e5']]) {
  const image = createCanvas(66, height), ctx = image.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, 66, height); images.set(key, image);
}
const plain = { columns: Array.from({ length: 4 }, () => ({ width: 66, noteImgH: 'head', noteImgT: 'tail', bodyImg: 'body' })), hitPosition: 402 };
const layouts = [
  { name: 'flat', skin: plain, images },
  { name: 'perspective', skin: { ...plain, perspective: { topWidth: .55 } }, images },
  { name: 'generated', skin: null, images: new Map() },
];
const bundled = new URL('../../samples-converted/', import.meta.url);
for (const name of fs.readdirSync(bundled).filter(name => /\.nfsk$/i.test(name))) {
  const parsed = readNFSK(fs.readFileSync(new URL(name, bundled))), skin = selectSkinForKeys(parsed.skin, 4);
  if (!skin) continue;
  const decoded = new Map();
  for (const col of skin.columns) for (const key of ['noteImg', 'noteImgH', 'noteImgT', 'bodyImg', 'bodyBegin', 'bodyEnd']) {
    const file = col[key]; if (file && !decoded.has(file) && parsed.files.has(file)) decoded.set(file, await loadImage(Buffer.from(parsed.files.get(file))));
  }
  layouts.push({ name: name.replace(/\.nfsk$/, ''), skin, images: decoded });
}

function make(skin, decoded, visualOffset = 0) {
  let now = 1000, down = true;
  const chart = { format: 'neonfall-chart', version: 1, keys: 4, od: 8, offset: 0, notes: [{ t: 1000, col: 0, end: 2000 }], meta: { lengthMs: 5000 }, timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [] };
  const audio = { songTimeMs: () => now, playSynth() {}, pauseMusic() {}, stopMusic() {}, stopPreview() {}, playMusic() {} };
  const session = new PlaySession(chart, {}, { skin, getAsset: () => undefined }, mods, { ...settings, visualOffset }, audio);
  session.phase = 'playing'; session.input.isDown = () => down; session.press(0, 1000);
  const renderer = new PlayfieldRenderer(skin, () => undefined, settings, mods);
  for (const [key, image] of decoded) renderer.images.images.set(key, image);
  const canvas = createCanvas(512, 480), ctx = canvas.getContext('2d');
  const frames = [];
  function draw(at) {
    now = at; session.update(16, at); ctx.clearRect(0, 0, 512, 480);
    renderer.drawNotes(ctx, session, session.laneStart(), session.laneWidths(), session.hitY(), at + 1000);
    const data = ctx.getImageData(0, 0, 512, 480).data;
    let alpha = 0; for (let i = 3; i < data.length; i += 4) alpha += data[i];
    frames.push({ at, alpha }); return { alpha, data };
  }
  return { session, renderer, canvas, ctx, draw, frames, release(at) { now = at; down = false; session.release(0, at); } };
}

// Trace actual drawing: a consumed head is never redrawn, and body ends at the
// hitline rather than at the centre of a head sprite which no longer exists.
for (const perspective of [false, true]) {
  const state = make(perspective ? layouts[1].skin : plain, images);
  let headCalls = 0, bodyBottom = -Infinity;
  const trace = new Proxy(state.ctx, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'drawImage') return (image, ...args) => {
        if (image === images.get('head')) headCalls++;
        if (image === images.get('body')) bodyBottom = Math.max(bodyBottom, args[1] + args[3]);
        return value.call(target, image, ...args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) { Reflect.set(target, key, value, target); return true; },
  });
  state.renderer.drawNotes(trace, state.session, 124, [66, 66, 66, 66], 402, 3000);
  assert.equal(headCalls, 0, `consumed head redrawn: perspective=${perspective}`);
  assert.equal(bodyBottom, 402, 'held body must reach the judgement line');
}

const results = [];
const times = [1900, 1950, 1960, 1970, 1980, 1990, 1998, 2000, 2010, 2040];
const montage = createCanvas(times.length * 128, layouts.length * 120);
for (const [row, layout] of layouts.entries()) {
  const state = make(layout.skin, layout.images);
  let previous = Infinity;
  for (const [column, time] of times.entries()) {
    const frame = state.draw(time);
    assert.ok(frame.alpha <= previous + 1, `${layout.name}: brightness increases near tail at ${time}`);
    if (time < 2000) assert.ok(frame.alpha > 0, `${layout.name}: disappears before endpoint`);
    else assert.equal(frame.alpha, 0, `${layout.name}: tail reappeared after being consumed`);
    previous = frame.alpha;
    montage.getContext('2d').drawImage(state.canvas, 0, 300, 512, 180, column * 128, row * 120, 128, 120);
  }
  assert.equal(state.session.isHeld(0), true, 'visual consumption must not end the release judgment');
  assert.equal(state.session.counts.miss, 0);
  state.release(2040);
  assert.equal(state.session.counts.great, 1, 'late release retains its actual grade');
  assert.equal(state.session.counts.holdTicks, 19, 'body scoring remains 20Hz');
  assert.equal(state.draw(2041).alpha, 0, 'released hold remains hidden');

  const rewind = make(layout.skin, layout.images);
  const before = rewind.draw(1980).data;
  rewind.draw(2010);
  assert.deepEqual(rewind.draw(1980).data, before, 'visual seek must not latch consumed notes permanently');
  results.push({ skin: layout.name, frames: state.frames, headConsumed: true, releaseJudgmentPreserved: true, rewindDeterministic: true });
}
for (const visualOffset of [-80, 80]) {
  const state = make(plain, images, visualOffset);
  assert.ok(state.draw(1980 - visualOffset).alpha > 0);
  assert.equal(state.draw(2000 - visualOffset).alpha, 0, 'disappearance follows visual offset');
  assert.equal(state.session.isHeld(0), true);
}

fs.writeFileSync(new URL('tail-consumption.png', output), montage.toBuffer('image/png'));
fs.writeFileSync(new URL('results.json', output), JSON.stringify({ results, limitation: 'Native Canvas and real PlaySession; no physical device or browser FPS measurement.' }, null, 2));
console.log(`PASS ${layouts.length} held-note layouts / no consumed-head redraw / monotonic tail fade / visual offsets / preserved 20Hz scoring and graded release / rewind`);
