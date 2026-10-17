import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { importSkinArchive, detectKind } from '../src/core/import.ts';
import { parseMSP } from '../src/core/msp.ts';
import { unzipToMap, strToBytes } from '../src/core/zip.ts';
import { readNFSK, buildTimeMap } from '../src/core/nfm.ts';
import { selectSkinForKeys } from '../src/core/osk.ts';
import { DEFAULT_MODS, DEFAULT_SETTINGS } from '../src/core/types.ts';
import { PlayfieldRenderer } from '../src/engine/render.ts';
import { InputManager } from '../src/engine/input.ts';
import { laneAtPoint } from '../src/engine/lane-geometry.ts';
import { mspArtPaths, mspCatPoses } from '../src/engine/msp-art.ts';
import { getDefaultSkin } from '../src/core/default-skin.ts';

const root = new URL('../', import.meta.url), output = new URL('test-results/msp/', root);
fs.mkdirSync(output, { recursive: true });
const source = fs.readFileSync(new URL('../RM_White_Blue_Bar_4-6K.msp', root));
const original = unzipToMap(source), converted = importSkinArchive('RM_White_Blue_Bar_4-6K.MSP', source);
const { skin, files } = readNFSK(converted.nfsk);
assert.equal(detectKind('custom.MSP'), 'msp');
assert.equal(skin.name, 'RM White Blue Bar 4-6K');
assert.equal(skin.author, 'dreamcat');
assert.deepEqual(Object.keys(skin.variants), ['4', '5', '6']);
assert.equal(skin.perspective.angle, 43);
assert.equal(skin.perspective.topWidth, 376 / 1680, 'Track convergence comes from the author\'s angle table');
assert.equal(skin.msp.profile, 'rm-white-blue');
assert.equal(skin.msp.hit.frames.length, 7);
assert.equal(skin.msp.holdHit.frames.length, 16);
assert.equal(skin.msp.hit.fps, 60);
assert.equal(skin.msp.holdHit.fps, 30);
assert.ok(skin.msp.hit.additive, 'Black source background must use additive blending');
assert.ok(mspArtPaths(skin).length > 40, 'Stage, key backgrounds, cats and animation frames are retained');
assert.equal(skin.source.scripted, true);
assert.ok(![...files.keys()].some(p => /\.lua$/.test(p)), 'Lua scripts are never included as executable skin assets');
assert.equal(selectSkinForKeys(skin, 7), null, 'Unsupported key counts retain the existing fallback');
for (const keys of [4, 5, 6]) {
  const layout = selectSkinForKeys(skin, keys);
  assert.equal(layout.columns.length, keys);
  for (const c of layout.columns) {
    for (const property of ['noteImg', 'noteImgH', 'bodyImg', 'noteImgT', 'keyImg', 'keyImgD']) {
      assert.ok(c[property], `Missing ${keys}K ${property}`);
      assert.deepEqual(files.get(c[property]), original.get(c[property]), 'Converted sprites preserve original bytes');
    }
    assert.notEqual(c.noteImgH, c.bodyImg);
    assert.equal(c.tailFlip, false);
    assert.ok(c.noteScaleY > .7 && c.noteScaleY < .75, 'Use the scene-scale 1.0 variant');
    assert.notEqual(c.holdHeadScaleY, c.noteScaleY, 'Hold head has its own authored scale');
    assert.notEqual(c.holdTailScaleY, c.noteScaleY, 'Hold tail has its own authored scale');
  }
}
assert.equal(skin.columns[3].keyPressedFlip, true, 'Right receptor artwork retains horizontal reflection');
assert.equal(skin.hud.healthFill, '1749529118158.png');
assert.equal(skin.judgments.miss, 'judgemiss-1.png');
const bundled = getDefaultSkin();
assert.equal(getDefaultSkin(), bundled, 'The default skin is decoded only once');
assert.deepEqual(bundled.skin, skin, 'The embedded default matches the current MSP importer');
const wrapped = new Map([...original].map(([path, data]) => ['Wrapped/' + path, data]));
assert.equal(parseMSP(wrapped).skin.name, skin.name);
const broken = new Map(original); broken.set('info.asm', new Uint8Array([26, 255]));
assert.throws(() => parseMSP(broken), /Truncated MSP/);
const wrongMode = new Map(original); wrongMode.set('info.json', strToBytes('{"mode":3}'));
assert.throws(() => parseMSP(wrongMode), /Key mode/);
const unknown = new Map(original), bytes = original.get('info.asm');
const extended = new Uint8Array(bytes.length + 3); extended.set(bytes); extended.set([248, 7, 1], bytes.length);
unknown.set('info.asm', extended);
assert.equal(parseMSP(unknown).skin.name, skin.name, 'Unknown protobuf fields are ignored');

const decoded = new Map();
for (const [path, data] of files) if (/\.png$/i.test(path)) decoded.set(path, await loadImage(data));
const notes = [{ t: 500, col: 0 }, { t: 680, col: 1, end: 1140 }, { t: 920, col: 2 }, { t: 1100, col: 3 }, { t: 1250, col: 0, end: 3000 }];
const screens = [];
for (const [width, height] of [[1280, 720], [360, 780], [780, 360]]) {
  for (const keys of [4, 5, 6]) {
    const selected = selectSkinForKeys(skin, keys), renderer = new PlayfieldRenderer(selected, p => files.get(p), { ...DEFAULT_SETTINGS }, { ...DEFAULT_MODS });
    for (const [path, image] of decoded) renderer.images.images.set(path, image);
    const session = { keys, notes, timeMap: buildTimeMap([{ t: 0, bpm: 120 }], [], 0),
      input: { isDown: col => col === 1 }, colFlash: Array.from({ length: keys }, (_, col) => col === 1 ? 970 : 0), particles: [], popups: [],
      drawTime: () => 350, chartTime: () => 350, isJudged: () => false, isHeld: () => false,
      laneStart: () => 16, hitY: () => selected.hitPosition };
    const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
    const drawn = new Set(), originalDraw = ctx.drawImage.bind(ctx);
    ctx.drawImage = (image, ...args) => { drawn.add(image); originalDraw(image, ...args); };
    ctx.fillStyle = '#10202b'; ctx.fillRect(0, 0, width, height);
    renderer.draw(ctx, session, width, height, 1000);
    for (const asset of [selected.msp.trackLeft.image, selected.msp.keyBackground.image, selected.msp.laneLine.image, selected.msp.press.image, selected.msp.hit.frames[1]]) {
      assert.ok(drawn.has(decoded.get(asset)), `Actual stage must draw ${asset}`);
    }
    if (width === 1280) assert.ok(drawn.has(decoded.get(selected.msp.cat.background)), 'Author\'s companion is visible beside the track');
    const { ox, oy, scale, scaleY } = renderer.fieldOrigin(width, height);
    assert.ok(Math.abs(oy + selected.hitPosition * scaleY - height * .86) < 1e-7);
    assert.equal(renderer.projectX(16, selected.hitPosition), 16, 'Judgement line remains fixed');
    assert.ok(renderer.projectX(16, 0) > 150, 'Track converges towards the top');
    const input = new InputManager(keys, DEFAULT_SETTINGS);
    input.setLaneResolver((x, y) => laneAtPoint(x, y, { ox, oy, scale, scaleY }, 16, selected.columns.map(c => c.width), (x, y) => renderer.projectX(x, y)));
    for (let col = 0; col < keys; col++) {
      const y = (height * .9 - oy) / scaleY;
      const touchX = ox + renderer.projectX(16 + 480 / keys * (col + .5), y) * scale;
      assert.equal(input.colAtXY(touchX, height * .9), col, 'Touch aligns with the visible receptor');
    }
    let prior = -Infinity;
    for (let y = -1000; y <= 480; y += 5) {
      const screenY = renderer.projectY(y); assert.ok(screenY > prior, 'Depth must be monotonic'); prior = screenY;
    }
    assert.equal(renderer.projectY(selected.hitPosition), selected.hitPosition, 'Perspective cannot shift the judgment time');
    assert.ok(renderer.projectY(200) < 200, 'Distant notes approach from the vanishing point');
    const nearHeight = renderer.projectY(414) - renderer.projectY(400), farHeight = renderer.projectY(100) - renderer.projectY(86);
    assert.ok(nearHeight > farHeight * 2, 'Sprite height follows the same perspective depth as its timing anchor');
    const file = `${width}x${height}-${keys}K.png`; fs.writeFileSync(new URL(file, output), canvas.toBuffer('image/png')); screens.push(file);
  }
}
assert.deepEqual(mspCatPoses([true, false, false, false]), [0]);
assert.deepEqual(mspCatPoses([true, true, false, false]), [1]);
assert.deepEqual(mspCatPoses([false, false, true, false, false]), [10]);
assert.deepEqual(mspCatPoses([true, true, true, true, true]), [8, 14]);
assert.deepEqual(mspCatPoses([true, true, true, true, true, true]), [8, 13]);
// Bounds on work for very long holds: rasterization clips source time to visible
// pixels and never loops over a multi-minute hold's offscreen length.
const renderer = new PlayfieldRenderer(skin, () => undefined, DEFAULT_SETTINGS, DEFAULT_MODS);
for (const [path, image] of decoded) renderer.images.images.set(path, image);
const canvas = createCanvas(512, 480), ctx = canvas.getContext('2d');
let draws = 0; const drawImage = ctx.drawImage.bind(ctx); ctx.drawImage = (...args) => { draws++; drawImage(...args); };
renderer.drawHold(ctx, {}, 0, 76, 120, -1e8, 414, 0);
assert.ok(draws <= 125, `Offscreen holds must remain bounded: ${draws}`);
const report = { name: skin.name, keys: Object.keys(skin.variants), assets: files.size - 1, bytes: converted.nfsk.length,
  sourceSha256: createHash('sha256').update(source).digest('hex'), screenshots: screens, longHoldDrawCalls: draws,
  limitations: 'Native Canvas checks, not Android device FPS. RM stage/input animations are translated natively; arbitrary Lua is not executed.' };
fs.writeFileSync(new URL('report.json', output), JSON.stringify(report, null, 2));
console.log('PASS MSP: actual archive import, protobuf validation, 4–6K sprites, perspective rendering, portrait/landscape input and bounded long holds');
