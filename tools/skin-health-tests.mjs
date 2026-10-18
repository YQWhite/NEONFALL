import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getDefaultSkin } from '../src/core/default-skin.ts';
import { parseOSK } from '../src/core/osk.ts';
import { strToBytes, unzipToMap } from '../src/core/zip.ts';
import { prepareSkinHealth, drawSkinHealth } from '../src/ui/skin-health.ts';
import { PlayScreen } from '../src/ui/screens/play.ts';
import { setLanguage } from '../src/ui/i18n.ts';

const output = new URL('../test-results/v0210/', import.meta.url);
fs.mkdirSync(output, { recursive: true });
let checks = 0, scans = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
globalThis.document = { documentElement: {}, createElement() { scans++; return createCanvas(1, 1); } };
setLanguage('en');
const loadHealth = async (skin, files) => {
  const map = new Map();
  for (const path of Object.values(skin.hud ?? {})) if (path && files.get(path)) map.set(path, await loadImage(Buffer.from(files.get(path))));
  return { get: path => map.get(path) };
};
const draw = (skin, images, hp, w = 1280, h = 800) => {
  const canvas = createCanvas(w, h), ctx = canvas.getContext('2d'), calls = [];
  const original = ctx.drawImage.bind(ctx);
  ctx.drawImage = (image, ...args) => {
    const transform = ctx.getTransform();
    calls.push({ image, args, scale: transform.a, blend: ctx.globalCompositeOperation, alpha: ctx.globalAlpha });
    original(image, ...args);
  };
  const titleY = drawSkinHealth(ctx, skin, images, hp, w, h);
  return { canvas, ctx, calls, titleY };
};

// This embedded fixture is the user's real Remilia OSK, including its full-
// screen scorebar-bg and intentionally padded fill. No external fixture is
// needed in CI; when the original is present, verify that exact source too.
const builtin = getDefaultSkin(), realSkin = builtin.skin, realImages = await loadHealth(realSkin, builtin.files);
const originalName = fs.readdirSync(new URL('../../', import.meta.url)).find(p => /Remilia.*\.osk$/i.test(p));
if (originalName) {
  const original = parseOSK(unzipToMap(fs.readFileSync(new URL('../../' + originalName, import.meta.url))));
  equal(JSON.parse(JSON.stringify(original.skin.hud)), realSkin.hud, 'Original OSK and built-in scorebar metadata agree');
  for (const path of Object.values(realSkin.hud)) if (path) equal(original.assets[path], builtin.files.get(path), 'Original scorebar pixels are unchanged: ' + path);
}
prepareSkinHealth(realSkin, realImages);
const preparedScans = scans;
for (const [w, h] of [[1366, 768], [1280, 800], [780, 360], [568, 320]]) {
  for (const hp of [0, .5, 1]) {
    const frame = draw(realSkin, realImages, hp, w, h), bg = frame.calls[0], fill = frame.calls[1];
    equal(bg.image, realImages.get(realSkin.hud.healthBackground), 'The full authored background is retained');
    equal(bg.args, [0, 0, 1366, 768], 'Background is neither alpha-cropped nor squeezed into a small bar');
    check(bg.scale > 0 && bg.scale * 1366 <= w + .001, 'Full background fits landscape width');
    if (hp) {
      equal(fill.args, [0, 0, 342 * hp, 56, 5, 16, 342 * hp, 56], 'HP clips the complete source width, retaining transparent margins and official offset');
      equal(fill.scale, bg.scale, 'Background and fill use exactly the same logical scale');
    } else equal(frame.calls.length, 1, 'Zero HP does not draw an empty source rectangle or a default fill');
    check(frame.titleY >= 87 * bg.scale + 12, 'Song name is placed below the custom health artwork');
    frame.ctx.save(); frame.ctx.globalCompositeOperation = 'destination-over'; frame.ctx.fillStyle = '#26313a'; frame.ctx.fillRect(0, 0, w, h); frame.ctx.restore();
    fs.writeFileSync(new URL(`skin-health-${w}x${h}-${hp * 100}.png`, output), frame.canvas.toBuffer('image/png'));
  }
}
equal(scans, preparedScans, 'Per-frame HUD drawing performs no new alpha scans');

const png = (w, h, rectangles = [], density = 1) => {
  const canvas = createCanvas(w * density, h * density), ctx = canvas.getContext('2d');
  ctx.scale(density, density);
  for (const [x, y, rw, rh, color] of rectangles) { ctx.fillStyle = color; ctx.fillRect(x, y, rw, rh); }
  return new Uint8Array(canvas.toBuffer('image/png'));
};
const fixture = async (density = 1, transparent = false) => {
  const suffix = density === 2 ? '@2x' : '';
  const files = new Map([['skin.ini', strToBytes('[General]\nName: Scorebar regression\n[Mania]\nKeys: 4')],
    ['scorebar-bg' + suffix + '.png', png(350, 56, transparent ? [] : [[0, 0, 350, 56, '#151525'], [8, 8, 306, 24, '#546080']], density)],
    ['scorebar-colour' + suffix + '.png', png(300, 28, transparent ? [] : [[9, 4, 280, 14, '#e573a8']], density)],
    ['scorebar-marker' + suffix + '.png', png(12, 24, transparent ? [] : [[3, 4, 6, 16, '#ffffff']], density)]]);
  const { skin, assets } = parseOSK(files);
  return { skin, images: await loadHealth(skin, new Map(Object.entries(assets))) };
};
const one = await fixture(), two = await fixture(2);
prepareSkinHealth(one.skin, one.images); prepareSkinHealth(two.skin, two.images);
for (const hp of [0, .5, 1]) {
  const a = draw(one.skin, one.images, hp, 1366, 768), b = draw(two.skin, two.images, hp, 1366, 768);
  check(Buffer.from(a.ctx.getImageData(0, 0, 1366, 768).data).equals(Buffer.from(b.ctx.getImageData(0, 0, 1366, 768).data)), '1x/2x layers have identical logical size, offsets and output at HP ' + hp);
  const marker = a.calls.at(-1);
  equal(marker.args, [12 + 300 * hp - 6, 16 - 12, 12, 24], 'Marker centre follows the cropped fill endpoint and official y=16');
  equal(marker.blend, 'lighter', 'Marker uses additive composition');
  check(hp || marker.alpha === 0, 'Marker fades at zero HP');
  if (hp) equal(a.calls[1].args.slice(-4), [12, 12, 300 * hp, 28], 'Marker presence uses the official new-style fill origin');
}
// Old manifests that did not store density still recognise an @2x filename.
const legacyTwo = structuredClone(two.skin); delete legacyTwo.assetDensity;
equal(draw(legacyTwo, two.images, 1).calls.map(c => c.args), draw(two.skin, two.images, 1).calls.map(c => c.args), 'Legacy @2x paths retain density without added metadata');

const transparent = await fixture(2, true);
prepareSkinHealth(transparent.skin, transparent.images);
const blank = draw(transparent.skin, transparent.images, 1);
check(blank.titleY !== null, 'Transparent artwork owns the custom health region');
equal(blank.titleY, 73, 'Transparent background adds no empty song-label spacing');
equal(blank.ctx.getImageData(0, 0, 1280, 800).data.some(v => v !== 0), false, 'Transparent custom HUD stays completely invisible');
const tinySkin = { ...one.skin, hud: { healthBackground: 'blank@2x.png', healthFill: 'blank@2x.png' }, assetDensity: { 'blank@2x.png': 2 } };
const tinyImage = await loadImage(Buffer.from(png(1, 1, [], 2))), tinyImages = { get: () => tinyImage };
const tiny = draw(tinySkin, tinyImages, .5);
check(tiny.titleY !== null, '1 logical pixel placeholder is not mistaken for a missing image');
equal(tiny.ctx.getImageData(0, 0, 1280, 800).data.some(v => v !== 0), false, '1px placeholder does not cause a colored fallback');
const backgroundOnly = { ...one.skin, hud: { healthBackground: one.skin.hud.healthBackground } };
equal(draw(backgroundOnly, one.images, .5).calls.length, 1, 'A custom background without fill never receives generated fill');
equal(draw(null, one.images, 1).titleY, null, 'No skin requests the default UI');
equal(draw(one.skin, { get: () => undefined }, 1).titleY, null, 'Unavailable assets keep the default UI available');

// Verify the real PlayScreen branch, including removal of HEALTH and the
// panel/stroke. This prevents a helper-only test missing an extra HUD layer.
function hudFrame(skin, images, w = 1280, h = 800) {
  const canvas = createCanvas(w, h), ctx = canvas.getContext('2d'), texts = [], panels = [];
  ctx.fillStyle = '#26313a'; ctx.fillRect(0, 0, w, h);
  const originalText = ctx.fillText.bind(ctx), originalStroke = ctx.stroke.bind(ctx);
  ctx.fillText = (label, ...args) => { texts.push(label); originalText(label, ...args); };
  ctx.stroke = (...args) => { panels.push(1); originalStroke(...args); };
  const screen = new PlayScreen({ w, h, isTouch: false, settings: { touchHint: false } });
  screen.renderer = { images, drawJudgement() {} };
  screen.drawHUD(ctx, { skin, hp: 50, score: 123456, combo: 0, accuracy: () => .99, phase: 'paused', modsUsed: () => [], rewindRemainingMs: () => 0, preparationRemainingMs: () => 0, chartTime: () => 0, playbackEndTime: () => 1000 });
  return { canvas, ctx, texts, panels };
}
for (const sample of [one, transparent, { skin: tinySkin, images: tinyImages }, { skin: realSkin, images: realImages }]) {
  const result = hudFrame(sample.skin, sample.images);
  check(!result.texts.includes('HEALTH'), 'Custom scorebar has no extra NF HEALTH heading');
  equal(result.panels, [], 'Custom scorebar has no extra NF panel outline');
}
const fallback = hudFrame(null, { get: () => undefined });
check(fallback.texts.includes('HEALTH'), 'Default skin keeps HEALTH text');
check(fallback.panels.length > 0, 'Default skin keeps its panel border');
for (const [w, h] of [[1280, 800], [568, 320]]) fs.writeFileSync(new URL(`skin-health-hud-${w}x${h}.png`, output), hudFrame(realSkin, realImages, w, h).canvas.toBuffer('image/png'));

console.log(`PASS skin health: ${checks} checks; original full-screen background, shared offsets/proportions, 0/50/100% HP, @2x, transparent placeholders, marker, native HUD and short landscape.`);
