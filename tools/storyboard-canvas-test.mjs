// Native Canvas verification of the real PlayScreen composition. This does not
// substitute for launching Electron or comparing the complete animation in osu!.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveObjectURL } from 'node:buffer';
import { createCanvas, Image as NativeImage } from '@napi-rs/canvas';

globalThis.window = {};
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas', 'This runner only implements Canvas DOM elements');
    return createCanvas(1, 1);
  },
};
// Resolve the same Blob URLs used by the browser loader to native decoder input.
globalThis.Image = class extends NativeImage {
  set src(value) {
    const blob = typeof value === 'string' ? resolveObjectURL(value) : undefined;
    if (blob) blob.arrayBuffer().then(bytes => { super.src = Buffer.from(bytes); });
    else super.src = value;
  }
  get src() { return super.src; }
};

const { PlayScreen } = await import('../src/ui/screens/play.ts');
const { PlaySession } = await import('../src/engine/play.ts');
const { PlayfieldRenderer } = await import('../src/engine/render.ts');
const { StoryboardPlayer, evaluateStoryboardObject } = await import('../src/core/storyboard.ts');
const { repairBundledStoryboard } = await import('../src/core/storyboard-repair.ts');
const { importChartArchive } = await import('../src/core/import.ts');
const { readNFM } = await import('../src/core/nfm.ts');
const { DEFAULT_SETTINGS, DEFAULT_MODS } = await import('../src/core/types.ts');

const output = path.resolve(process.env.NF_CANVAS_OUTPUT || fileURLToPath(new URL('../test-results/storyboard-canvas', import.meta.url)));
fs.mkdirSync(output, { recursive: true });
const sampleDir = new URL('../../', import.meta.url);
const filename = fs.readdirSync(sampleDir).find(name => name.includes('Mopemope') && name.endsWith('.osz'));
assert.ok(filename, 'Mopemope source archive required');
const converted = importChartArchive(filename, fs.readFileSync(new URL(filename, sampleDir))).find(chart => chart.version.includes('Suic!de'));
assert.ok(converted, 'Suic!de source difficulty required');
const archive = readNFM(converted.nfm);
const settings = { ...DEFAULT_SETTINGS, sbEnabled: true, sbQuality: 1, bgDim: 0, skinId: '', audioOffset: 0, visualOffset: 0, particles: false, videoBg: false };
const mods = { ...DEFAULT_MODS, auto: true, noFail: true };
let time = 0;
const audio = { songTimeMs: () => time };
const assets = name => archive.files.get(name);
const session = new PlaySession(archive.chart, archive, { skin: null, getAsset: assets }, mods, settings, audio, 1);
session.phase = 'playing';
const app = { w: 1280, h: 720, settings, mods, time: 0, isTouch: false, ui: { button: () => false } };
const screen = new PlayScreen(app);
screen.sess = session;
screen.renderer = new PlayfieldRenderer(null, assets, settings, mods);
screen.status = '';
screen.sbCanvas = createCanvas(1, 1);
screen.entry = { title: archive.chart.meta.title, version: archive.chart.meta.version, keys: archive.chart.keys };
const player = session.sb;
assert.equal(player.objects.length, 2765);
await player.prepare(session.initialTime());
await Promise.all([...new Set(player.objects.map(state => state.obj.path))].map(name => player.load(name)));
assert.equal(player.missing.size, 0, 'All real storyboard resources must decode');

const capture = () => {
  const canvas = createCanvas(app.w, app.h);
  screen.draw(canvas.getContext('2d'));
  return canvas;
};
const pixel = (canvas, x, y) => Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
const report = {
  renderer: '@napi-rs/canvas; product PlayScreen.draw, PlayfieldRenderer and StoryboardPlayer',
  objects: player.objects.length,
  resources: player.images.size,
  layers: player.objects.reduce((counts, state) => { counts[state.obj.layer] = (counts[state.obj.layer] || 0) + 1; return counts; }, {}),
  frames: [],
};
const frames = [];
for (const t of [2379, 45590, 46779, 73554, 98979, 45590]) {
  time = t;
  const before = performance.now();
  const canvas = capture();
  const png = canvas.toBuffer('image/png');
  report.frames.push({ t, captureAndEncodeMs: performance.now() - before, center: pixel(canvas, 640, 360) });
  if (frames.length === 5) assert.ok(png.equals(frames[1].png), 'Seeking must restore the same complete image');
  else fs.writeFileSync(path.join(output, `play-${t}.png`), png);
  frames.push({ t, canvas, png });
}

// The historical package lost constant MX shorthand commands. Reproduce the
// resulting single-column notes, then exercise the same repair used at load.
const legacyPath = new URL('../test-results/menu-refresh-final/user-data/charts/もぺもぺ [-_Suic!de.-.].nfm', import.meta.url);
const bundledPath = new URL('../../samples-converted/もぺもぺ [-_Suic!de.-.].nfm', import.meta.url);
const legacyArchive = readNFM(fs.readFileSync(legacyPath));
const bundledArchive = readNFM(fs.readFileSync(bundledPath));
const repairedArchive = await repairBundledStoryboard(legacyArchive, async name => {
  assert.equal(name, path.basename(fileURLToPath(bundledPath)));
  return bundledArchive;
});
assert.notEqual(repairedArchive, legacyArchive, 'The historical damaged storyboard must be repaired');
assert.deepEqual(repairedArchive.chart.storyboard, archive.chart.storyboard, 'Repair must match a fresh import of the original OSZ');

async function prepareScene(source) {
  const sceneSettings = { ...settings };
  const getAsset = name => source.files.get(name);
  const sceneSession = new PlaySession(source.chart, source, { skin: null, getAsset }, mods, sceneSettings, audio, 1);
  sceneSession.phase = 'playing';
  const sceneApp = { ...app, settings: sceneSettings };
  const sceneScreen = new PlayScreen(sceneApp);
  sceneScreen.sess = sceneSession;
  sceneScreen.renderer = new PlayfieldRenderer(null, getAsset, sceneSettings, mods);
  sceneScreen.status = '';
  sceneScreen.sbCanvas = createCanvas(1, 1);
  sceneScreen.entry = { title: source.chart.meta.title, version: source.chart.meta.version, keys: source.chart.keys };
  await sceneSession.sb.prepare(sceneSession.initialTime());
  await Promise.all([...new Set(sceneSession.sb.objects.map(state => state.obj.path))].map(name => sceneSession.sb.load(name)));
  assert.equal(sceneSession.sb.missing.size, 0);
  return { app: sceneApp, session: sceneSession, capture() {
    const canvas = createCanvas(sceneApp.w, sceneApp.h);
    sceneScreen.draw(canvas.getContext('2d'));
    return canvas;
  } };
}
const [legacyScene, repairedScene, bundledScene] = await Promise.all([
  prepareScene(legacyArchive), prepareScene(repairedArchive), prepareScene(bundledArchive),
]);
const rawPixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
function changedBounds(before, after) {
  assert.equal(before.width, after.width); assert.equal(before.height, after.height);
  const a = rawPixels(before), b = rawPixels(after);
  let count = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
    const x = i / 4 % before.width, y = Math.floor(i / 4 / before.width);
    count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { count, minX, maxX, minY, maxY };
}
const noteStates = (source, t) => source.chart.storyboard.objects
  .map((obj, index) => ({ obj, index, value: evaluateStoryboardObject(obj, t) }))
  .filter(state => /\/(?:W|B|X1)\.png$/.test(state.obj.path) && state.value.visible);
assert.deepEqual(noteStates(legacyArchive, 10000).map(state => state.value.x), [320, 320, 320, 320]);
assert.deepEqual(noteStates(repairedArchive, 10000).map(state => state.value.x).sort((a, b) => a - b), [190, 254, 318, 382]);
const coordinateComparison = createCanvas(1920, 1152);
const coordinateCtx = coordinateComparison.getContext('2d');
coordinateCtx.fillStyle = '#121212'; coordinateCtx.fillRect(0, 0, 1920, 1152);
report.legacyRepair = { source: 'Historical NFM versus runtime repair versus current bundled NFM', frames: [], sizes: [] };
for (const [row, t] of [10000, 35000, 73554].entries()) {
  time = t;
  const captures = [legacyScene.capture(), repairedScene.capture(), bundledScene.capture()];
  const restoredDifference = changedBounds(captures[1], captures[2]);
  assert.equal(restoredDifference.count, 0, `Repaired and current packages must render identical pixels at ${t} ms`);
  const legacyDifference = changedBounds(captures[0], captures[1]);
  assert.ok(legacyDifference.count > 1000, `The legacy regression must visibly reproduce at ${t} ms`);
  for (let column = 0; column < captures.length; column++) {
    const label = ['Legacy NFM: lost MX commands', 'Runtime repair: restored columns', 'Current NFM: identical to repair'][column];
    coordinateCtx.drawImage(captures[column], column * 640, row * 384 + 24, 640, 360);
    coordinateCtx.fillStyle = 'white'; coordinateCtx.font = '15px sans-serif';
    coordinateCtx.fillText(`${label} | ${t} ms`, column * 640 + 8, row * 384 + 18);
    fs.writeFileSync(path.join(output, `coordinates-${['legacy', 'repaired', 'current'][column]}-${t}.png`), captures[column].toBuffer('image/png'));
  }
  report.legacyRepair.frames.push({ t, changedPixels: legacyDifference.count, repairedVsCurrentChangedPixels: restoredDifference.count,
    legacyNoteX: noteStates(legacyArchive, t).map(state => state.value.x), repairedNoteX: noteStates(repairedArchive, t).map(state => state.value.x) });
}
fs.writeFileSync(path.join(output, 'coordinate-repair-comparison.png'), coordinateComparison.toBuffer('image/png'));

// Measure actual raster bounds of each of the four visible notes. Removing the
// other three isolates each note without replacing any product drawing code.
time = 10000;
const repairedPlayer = repairedScene.session.sb;
const allStates = repairedPlayer.objects;
const visibleNotes = noteStates(repairedArchive, time).sort((a, b) => a.value.x - b.value.x);
const visibleIndices = new Set(visibleNotes.map(state => state.index));
const withoutNotes = allStates.filter((_, index) => !visibleIndices.has(index));
for (const [w, h] of [[640, 400], [800, 600], [1280, 720]]) {
  repairedScene.app.w = bundledScene.app.w = w;
  repairedScene.app.h = bundledScene.app.h = h;
  assert.equal(changedBounds(repairedScene.capture(), bundledScene.capture()).count, 0, `Repair must match current rendering at ${w}x${h}`);
  repairedPlayer.objects = withoutNotes;
  const baseline = repairedScene.capture();
  const positions = [];
  for (const note of visibleNotes) {
    repairedPlayer.objects = allStates.filter((_, index) => !visibleIndices.has(index) || index === note.index);
    const bounds = changedBounds(baseline, repairedScene.capture());
    assert.ok(bounds.count > 0, 'Every restored note must have visible pixels');
    const actualX = (bounds.minX + bounds.maxX + 1) / 2;
    const expectedX = (w - 640 * h / 480) / 2 + note.value.x * h / 480;
    assert.ok(Math.abs(actualX - expectedX) <= 1, `Note x=${note.value.x} must map to ${expectedX}, got ${actualX} at ${w}x${h}`);
    positions.push({ logicalX: note.value.x, expectedX, actualX, bounds });
  }
  repairedPlayer.objects = allStates;
  report.legacyRepair.sizes.push({ w, h, positions });
}

// Recreate the former draw order with the same parsed objects and decoded
// resources to isolate the effect of placing Overlay behind the playfield.
time = 45590;
const productDraw = player.draw;
player.draw = function(ctx, t, fail, pass) {
  if (pass === 'background') productDraw.call(this, ctx, t, fail, 'all');
};
const oldComposition = capture();
player.draw = productDraw;
const comparison = createCanvas(1280, 384);
const comparisonCtx = comparison.getContext('2d');
comparisonCtx.fillStyle = '#121212';
comparisonCtx.fillRect(0, 0, 1280, 384);
comparisonCtx.drawImage(oldComposition, 0, 24, 640, 360);
comparisonCtx.drawImage(frames[1].canvas, 640, 24, 640, 360);
comparisonCtx.fillStyle = 'white';
comparisonCtx.font = '16px sans-serif';
comparisonCtx.fillText('Former layer order (controlled reproduction), 45590 ms', 8, 18);
comparisonCtx.fillText('Corrected Overlay composition, 45590 ms', 648, 18);
fs.writeFileSync(path.join(output, 'layer-comparison.png'), comparison.toBuffer('image/png'));

// A known opaque Overlay must retain its exact pixels over the real playfield.
const green = createCanvas(80, 80);
green.getContext('2d').fillStyle = 'rgb(20,240,40)';
green.getContext('2d').fillRect(0, 0, 80, 80);
const F = { k: 'F', ease: 0, t1: 0, t2: 2000, a: [1, 1] };
const probe = new StoryboardPlayer([{ type: 'sprite', layer: 4, origin: 1, path: 'probe', x: 320, y: 240, cmds: [F] }], () => undefined);
probe.objects[0].img = { img: green, w: 80, h: 80 };
session.sb = probe;
session.notes = [];
time = 1000;
const overlay = pixel(capture(), 640, 360);
assert.deepEqual(overlay, [20, 240, 40, 255], 'Overlay must appear above the playfield');
probe.objects[0].obj.layer = 3;
const foreground = pixel(capture(), 640, 360);
assert.notDeepEqual(foreground, overlay, 'Foreground must remain below the playfield');

// HUD remains readable over Overlay; raster quality and window aspect ratio
// must not change which layer wins in the middle of the playfield.
probe.objects[0].obj.layer = 4;
for (const [w,h,q] of [[640,400,.5],[800,600,.75],[1280,720,1]]) {
  app.w=w;app.h=h;settings.sbQuality=q;
  assert.deepEqual(pixel(capture(),w/2,h/2),overlay);
}
probe.objects[0].obj.x=(80-(app.w-640*app.h/480)/2)*480/app.h;
probe.objects[0].obj.y=35*480/app.h;
const hudWithOverlay=pixel(capture(),80,35);
session.sb=null;
const hudWithoutOverlay=pixel(capture(),80,35);
assert.deepEqual(hudWithOverlay,hudWithoutOverlay,'HUD is above Overlay');
assert.notDeepEqual(hudWithOverlay,overlay);
session.sb=probe;probe.objects[0].obj.x=320;probe.objects[0].obj.y=240;

// Additive sprites must brighten the underlying track, not replace it with
// the black/transparent backdrop of an intermediate storyboard canvas.
session.sb=null;
const backdrop=pixel(capture(),640,360);
const additive=new StoryboardPlayer([{type:'sprite',layer:4,origin:1,path:'probe',x:320,y:240,
  cmds:[F,{k:'P',ease:0,t1:0,t2:2000,a:[],parameter:'A'}]}],()=>undefined);
additive.objects[0].img={img:green,w:80,h:80};session.sb=additive;
assert.deepEqual(pixel(capture(),640,360),[Math.min(255,backdrop[0]+20),Math.min(255,backdrop[1]+240),Math.min(255,backdrop[2]+40),255]);
session.sb=probe;

// Native pixels expose incorrect tint blending around antialiased sprite edges.
const black = createCanvas(1, 1);
black.getContext('2d').fillStyle = 'rgba(0,0,0,0.5)';
black.getContext('2d').fillRect(0, 0, 1, 1);
const tinted = pixel(probe.tinted(black, 255, 0, 0), 0, 0);
assert.deepEqual(tinted.slice(0, 3), [0, 0, 0]);
assert.ok(Math.abs(tinted[3] - 128) <= 1, 'Tint must preserve alpha');
probe.objects[0].obj = { type: 'sprite', layer: 4, origin: 0, path: 'probe', x: 320, y: 240, cmds: [F, { k: 'P', ease: 0, t1: 0, t2: 2000, a: [], parameter: 'H' }] };
const flipped = createCanvas(640, 480);
probe.draw(flipped.getContext('2d'), 1000, false);
const flipRight = pixel(flipped, 330, 250), flipLeft = pixel(flipped, 310, 250);
assert.deepEqual(flipRight, [20, 240, 40, 255], 'Flip must preserve non-centred origin bounds');
assert.equal(flipLeft[3], 0);
report.composition = { overlay, foreground, hudWithOverlay, tinted, flipRight, flipLeft, additive: true, sizes: '640x400/800x600/1280x720' };

const montage = createCanvas(1280, 1080);
const montageCtx = montage.getContext('2d');
for (let i = 0; i < 5; i++) {
  const x = (i % 2) * 640, y = Math.floor(i / 2) * 360;
  montageCtx.drawImage(frames[i].canvas, x, y, 640, 360);
}
fs.writeFileSync(path.join(output, 'montage.png'), montage.toBuffer('image/png'));
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`PASS native Canvas: real source sample / complete PlayScreen composition / legacy repair pixel equivalence / four-column placement at three sizes / tint / flips / deterministic seek. Evidence: ${output}`);
