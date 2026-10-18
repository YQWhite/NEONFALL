import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveObjectURL } from 'node:buffer';
import { createCanvas, Image } from '@napi-rs/canvas';
import { parseOSK } from '../src/core/osk.ts';
import { parseMSP } from '../src/core/msp.ts';
import { unzipToMap, strToBytes, findCI, zipFromMap } from '../src/core/zip.ts';
import { importChartArchive } from '../src/core/import.ts';
import { readNFM } from '../src/core/nfm.ts';
import { getDefaultSkin } from '../src/core/default-skin.ts';
import { repairKnownLegacySkin } from '../src/core/legacy-skin-repair.ts';
import { resolveSelectedSkin } from '../src/core/skin-selection.ts';
import { readNFSK } from '../src/core/nfm.ts';
import { zipSync } from 'fflate';
import { PlayfieldRenderer } from '../src/engine/render.ts';
import { DEFAULT_SETTINGS, DEFAULT_MODS } from '../src/core/types.ts';
import { setLanguage } from '../src/ui/i18n.ts';

const root = new URL('../', import.meta.url), output = new URL('test-results/v0210/', root);
fs.mkdirSync(output, { recursive: true });
let checks = 0, scans = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
globalThis.document = { documentElement: {}, createElement() { scans++; return createCanvas(1, 1); } };
globalThis.Image = class extends Image {
  set src(value) { const blob = resolveObjectURL(value); blob.arrayBuffer().then(b => { super.src = Buffer.from(b); }); }
};
setLanguage('en');
const grades = ['perfect', 'great', 'good', 'ok', 'bad', 'miss'];
const labels = ['PERFECT', 'GREAT', 'GOOD', 'OK', 'MEH', 'MISS'];
const png = (color, w = 80, h = 30) => {
  const canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  if (color) { ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); }
  return new Uint8Array(canvas.toBuffer('image/png'));
};
const transparent = png(null, 1, 1);
const fixture = (ini, files) => new Map([['skin.ini', strToBytes(ini)], ...Object.entries(files)]);
const rendererFor = async ({ skin, assets }) => {
  const files = new Map(Object.entries(assets));
  const renderer = new PlayfieldRenderer(skin, p => findCI(files, p), structuredClone(DEFAULT_SETTINGS), { ...DEFAULT_MODS });
  await renderer.prepareSkinArt(); return renderer;
};
const draw = (renderer, label, age = 100) => {
  const canvas = createCanvas(200, 90), ctx = canvas.getContext('2d'), calls = [], texts = [];
  const originalDraw = ctx.drawImage.bind(ctx), originalText = ctx.fillText.bind(ctx);
  ctx.drawImage = (image, ...args) => { calls.push({ image, args }); originalDraw(image, ...args); };
  ctx.fillText = (text, ...args) => { texts.push(text); originalText(text, ...args); };
  renderer.drawJudgement(ctx, { chartTime: () => 1000, popups: [{ t0: 1000 - age, label, color: '#ffffff' }] }, 100, 45, 160);
  const data = ctx.getImageData(0, 0, 200, 90).data;
  let pixels = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 8) pixels++;
  return { canvas, calls, texts, pixels };
};

// The supplied OSU sample hides MAX/GREAT deliberately; the other grades live
// in numbered frames while their static files are transparent placeholders.
const osuName = fs.readdirSync(new URL('../', root)).find(p => /Remilia.*\.osk$/i.test(p));
check(osuName, 'Original user OSU sample is available');
const osuSource = unzipToMap(fs.readFileSync(new URL('../' + osuName, root)));
const osu = parseOSK(osuSource);
const osuRenderer = await rendererFor(osu), scanAfterLoading = scans;
for (const [index, grade] of grades.entries()) {
  const result = draw(osuRenderer, labels[index]);
  check(osu.skin.judgments[grade].endsWith('-0.png'), `${grade} uses authored numbered artwork`);
  equal(osu.skin.judgmentAnimations[grade].fps, 60, `${grade} uses osu mania fixed animation FPS`);
  equal(result.texts, [], `${grade} has no generated text over skin art`);
  equal(result.calls[0].image, osuRenderer.images.get(osu.skin.judgments[grade]), `${grade} renders its own mapped sprite`);
  check(index < 2 ? result.pixels === 0 : result.pixels > 80, `${grade} preserves intentional visibility`);
}
equal(scans, scanAfterLoading, 'Judgment drawing performs no new alpha-bound pixel scans');
const builtin = getDefaultSkin();
equal(builtin.skin, JSON.parse(JSON.stringify(osu.skin)), 'Embedded OSU metadata matches the fixed original importer');
for (const grade of grades) equal(builtin.files.get(builtin.skin.judgments[grade]), osu.assets[osu.skin.judgments[grade]],
  `${grade} original animation bytes are bundled offline`);

// Reconstruct the former importer output from the original skin, without
// relying on a Git revision or reading a user's installed skin library.
const legacyManifest = structuredClone(builtin.skin), legacyFiles = new Map(builtin.files);
for (const layout of [legacyManifest, ...Object.values(legacyManifest.variants)]) {
  delete layout.judgmentAnimations;
  layout.assetDensity = Object.fromEntries(Object.entries(layout.assetDensity).map(([path, density]) => [path.replace(/^(mania-hit.+)-0\.png$/, '$1.png'), density]));
  for (const grade of grades) layout.judgments[grade] = layout.judgments[grade].replace(/-0\.png$/, '.png');
}
for (const grade of grades) {
  legacyFiles.delete(builtin.skin.judgments[grade]);
  legacyFiles.set(legacyManifest.judgments[grade], osuSource.get(legacyManifest.judgments[grade]));
}
legacyFiles.set('skin.nfskin', strToBytes(JSON.stringify(legacyManifest)));
const legacyBytes = zipFromMap(Object.fromEntries(legacyFiles));
const exactLegacy = readNFSK(legacyBytes), beforeLegacy = structuredClone(exactLegacy);
const repaired = repairKnownLegacySkin(exactLegacy);
check(repaired !== exactLegacy, 'Exact old sample output receives in-memory judgment repair');
equal(exactLegacy, beforeLegacy, 'Repair never mutates the original archive or asset bytes');
equal(repaired.skin.columns, exactLegacy.skin.columns, 'Repair preserves all original lane artwork and layout');
equal(repaired.skin.variants['4'].judgmentAnimations, builtin.skin.variants['4'].judgmentAnimations, 'Variant gains the original complete judgment animation metadata');
for (const grade of grades) equal(repaired.files.get(repaired.skin.judgments[grade]), osuSource.get(repaired.skin.judgments[grade]), 'Repair adds original source frame bytes');
const alternateZip = zipSync(Object.fromEntries([...legacyFiles].reverse().map(([path, data]) => [path, [data, { mtime: new Date(2001, 0, 1), level: 0 }]])));
check(Buffer.compare(Buffer.from(legacyBytes), Buffer.from(alternateZip)) !== 0, 'Repacked ZIP has different order, compression and timestamps');
check(repairKnownLegacySkin(readNFSK(alternateZip)).skin.judgmentAnimations?.good, 'ZIP metadata changes do not defeat exact content recognition');
for (const [path, data] of legacyFiles) {
  const changed = new Map(legacyFiles);
  if (path === 'skin.nfskin') changed.set(path, strToBytes(new TextDecoder().decode(data).replace('"hitPosition":464', '"hitPosition":463')));
  else { const altered = data.slice(); altered[0] ^= 1; changed.set(path, altered); }
  const candidate = readNFSK(zipFromMap(Object.fromEntries(changed)));
  equal(repairKnownLegacySkin(candidate), candidate, `Modified ${path} is never replaced by a name match`);
}
for (const kind of ['extra', 'missing', 'renamed']) {
  const changed = new Map(legacyFiles), path = legacyManifest.judgments.good;
  if (kind === 'extra') changed.set('custom.png', transparent);
  else { changed.delete(path); if (kind === 'renamed') changed.set('Custom-' + path, legacyFiles.get(path)); }
  const candidate = readNFSK(zipFromMap(Object.fromEntries(changed)));
  equal(repairKnownLegacySkin(candidate), candidate, `${kind} asset makes a custom archive ineligible for repair`);
}
const resolvedLegacy = await resolveSelectedSkin('existing-custom-id', 4, async () => legacyBytes);
equal(resolvedLegacy.skin.judgmentAnimations, builtin.skin.judgmentAnimations, 'Existing selected sample gets repaired without changing its saved ID');
equal(readNFSK(legacyBytes).skin.judgmentAnimations, undefined, 'Stored NFSK bytes remain the old original after selection');

const animated = parseOSK(fixture('[General]\nAnimationFramerate:2\n[Mania]\nKeys:4\nHit200:Custom\\Good', {
  'Custom/Good.png': transparent,
  'Custom/Good-0@2x.PNG': png('#ff0000'), 'Custom/Good-1@2x.PNG': png('#00ff00'),
  'Custom/Good-2@2x.PNG': png('#0000ff'), 'mania-hit200-0.png': png('#ffffff'),
  'mania-hit100.png': png('#ffff00'), 'mania-hit300g-0.png': transparent,
}));
equal(animated.skin.judgmentAnimations.good.frames,
  ['Custom/Good-0@2x.PNG', 'Custom/Good-1@2x.PNG', 'Custom/Good-2@2x.PNG'], 'Custom paths and HD frame sequences take precedence');
equal(animated.skin.assetDensity['Custom/Good-0@2x.PNG'], 2, 'Animated image density is retained');
equal(animated.skin.judgments.ok, 'mania-hit100.png', 'Skins with only static judgments remain supported');
const animatedRenderer = await rendererFor(animated);
for (const [age, frame] of [[0, 0], [17, 1], [34, 2], [50, 0], [67, 1]]) {
  equal(draw(animatedRenderer, 'GOOD', age).calls[0].image,
    animatedRenderer.images.get(animated.skin.judgmentAnimations.good.frames[frame]), `60 FPS animation loops at ${age} ms`);
}
equal(draw(animatedRenderer, 'TAIL GOOD', 34).calls[0].image,
  animatedRenderer.images.get(animated.skin.judgmentAnimations.good.frames[2]), 'Hold release judgments share the correct 200 artwork');
equal(draw(animatedRenderer, 'PERFECT').pixels, 0, 'Transparent animated MAX never falls back to text');
equal(draw(animatedRenderer, 'GOOD', 901).calls.length, 0, 'Expired judgment is not drawn');
const staticCustom = parseOSK(fixture('[Mania]\nKeys:4\nHit200:Custom/Still', {
  'Custom/Still.png': png('#123456'), 'mania-hit200-0.png': png('#ffffff'),
}));
equal(staticCustom.skin.judgments.good, 'Custom/Still.png', 'Explicit static override wins over default animation');

// Beatmap-embedded skins use the same animation metadata, with every frame
// correctly relocated to the NFM skin/ folder (including key-count variants).
const embeddedSource = Object.fromEntries(fixture('[Mania]\nKeys:4\nHit200:Custom/Good\n[Mania]\nKeys:7\nHit200:Custom/Good', {
  'Custom/Good-0.png': png('#ff0000'), 'Custom/Good-1.png': png('#00ff00'),
  'audio.ogg': new Uint8Array([79, 103, 103, 83]),
  'map.osu': strToBytes('osu file format v14\n[General]\nAudioFilename:audio.ogg\nMode:3\n[Metadata]\nTitle:Judgment test\nArtist:Test\nCreator:Test\nVersion:4K\n[Difficulty]\nCircleSize:4\nOverallDifficulty:8\n[TimingPoints]\n0,500,4,2,0,100,1,0\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:'),
}));
const embedded = readNFM(importChartArchive('judgment.osz', zipFromMap(embeddedSource))[0].nfm);
for (const layout of [embedded.chart.skin.data, ...Object.values(embedded.chart.skin.data.variants)]) {
  equal(layout.judgmentAnimations.good.frames, ['skin/Custom/Good-0.png', 'skin/Custom/Good-1.png'], 'Embedded root and variants prefix animation frames exactly once');
  for (const path of layout.judgmentAnimations.good.frames) check(embedded.files.get(path)?.length, 'Embedded animation frame resolves in its own archive');
}

// Metadata-free NFSK files that retained the frames recover them by filename.
const legacy = structuredClone(animated);
delete legacy.skin.judgmentAnimations; delete legacy.skin.variants;
legacy.skin.judgments.good = 'Custom/Good.png';
legacy.assets['Custom/Good.png'] = transparent;
const legacyRenderer = await rendererFor(legacy);
equal(draw(legacyRenderer, 'GOOD', 34).calls[0].image, legacyRenderer.images.get('Custom/Good-2@2x.png'),
  'Legacy static-path metadata discovers retained animation frames');
const legacyFirst = structuredClone(animated);
delete legacyFirst.skin.judgmentAnimations; delete legacyFirst.skin.variants;
const legacyFirstRenderer = await rendererFor(legacyFirst);
equal(draw(legacyFirstRenderer, 'GOOD', 17).calls[0].image, legacyFirstRenderer.images.get('Custom/Good-1@2x.PNG'),
  'Legacy first-frame metadata does not append a second -0 suffix');
const plain = await rendererFor({ skin: null, assets: {} });
equal(draw(plain, 'MEH').texts, ['50'], 'No-skin fallback uses the matching native mania grade label');

const msp = parseMSP(unzipToMap(fs.readFileSync(new URL('../RM_White_Blue_Bar_4-6K.msp', root))));
const mspRenderer = await rendererFor(msp);
equal(msp.skin.judgments.good, msp.skin.judgments.ok, 'Malody GOOD artwork also represents osu 100');
equal(msp.skin.judgments.good, msp.skin.judgments.bad, 'Malody GOOD artwork also represents osu 50');
check(msp.skin.judgments.great !== msp.skin.judgments.good, 'Malody GREAT keeps its distinct artwork');
for (const [index, grade] of grades.entries()) {
  const result = draw(mspRenderer, labels[index], 450); // after authored perfect glow
  equal(result.texts, [], `${grade} uses native Malody art`);
  equal(result.calls[0].image, mspRenderer.images.get(msp.skin.judgments[grade]), `${grade} has the expected Malody mapping`);
  check(result.pixels > 40, `${grade} Malody judgment is visible`);
}

const gallery = createCanvas(1200, 300), context = gallery.getContext('2d');
context.fillStyle = '#0d1520'; context.fillRect(0, 0, 1200, 300);
context.font = '15px Arial'; context.fillStyle = '#b9c7d7';
context.fillText('OSU sample: hidden MAX / 300, authored 200 / 100 / 50 / MISS', 18, 24);
context.fillText('Malody sample: native four grades mapped to six judgments', 18, 174);
for (let i = 0; i < grades.length; i++) {
  context.fillStyle = '#8795a8'; context.fillText(labels[i], i * 200 + 70, 52);
  context.drawImage(draw(osuRenderer, labels[i]).canvas, i * 200, 55);
  context.drawImage(draw(mspRenderer, labels[i], 450).canvas, i * 200, 205);
}
fs.writeFileSync(new URL('skin-judgments.png', output), gallery.toBuffer('image/png'));
fs.writeFileSync(new URL('skin-judgments.json', output), JSON.stringify({ checks, osu: osu.skin.judgments, msp: msp.skin.judgments, screenshot: 'skin-judgments.png' }, null, 2));
console.log(`PASS skin judgment artwork: ${checks} assertions, OSU animation/hidden sprites, native Malody mapping, legacy retained frames, preload performance`);
