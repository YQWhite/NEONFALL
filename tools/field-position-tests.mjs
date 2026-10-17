import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PlayfieldRenderer } from '../src/engine/render.ts';
import { PlaySession } from '../src/engine/play.ts';
import { DEFAULT_SETTINGS, DEFAULT_MODS } from '../src/core/types.ts';
import { getBuiltinSkin } from '../src/core/default-skin.ts';
import { selectSkinForKeys } from '../src/core/osk.ts';
import { laneAtPoint } from '../src/engine/lane-geometry.ts';

const output = new URL('../test-results/skin-field-refresh/', import.meta.url);
fs.mkdirSync(output, { recursive: true });
const layouts = [{ name: 'generated', skin: null, files: new Map(), images: new Map() }];
for (const id of ['', 'builtin:malody']) {
  const archive = getBuiltinSkin(id);
  const skin = selectSkinForKeys(archive.skin, 4);
  if (!skin) continue;
  const images = new Map();
  const paths = new Set(skin.columns.flatMap(col => [col.noteImg, col.noteImgH, col.noteImgT, col.bodyImg, col.keyImg, col.keyImgD]));
  for (const path of Object.values(skin.stage ?? {})) paths.add(path);
  for (const field of ['trackLeft', 'trackLight', 'trackBottom', 'laneLine', 'keyBackground']) paths.add(skin.msp?.[field]?.image);
  for (const path of paths) if (path && archive.files.has(path)) images.set(path, await loadImage(archive.files.get(path)));
  layouts.push({ name: skin.perspective ? 'malody' : 'osu', skin, files: archive.files, images });
}
let assertions = 0;
const check = (condition, message) => { assertions++; assert.ok(condition, message); };
const near = (a, b, message) => check(Math.abs(a - b) < 1e-7, `${message}: ${a} != ${b}`);
const chart = { format: 'neonfall-chart', version: 1, keys: 4, od: 8, hp: 5, offset: 0,
  meta: { title: 'Position and velocity', audio: '', previewTime: 0, audioLeadIn: 0, lengthMs: 30000 },
  timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [], notes: [] };
const audio = { songTimeMs: () => 0, pauseMusic() {}, resumeMusic() {}, stopMusic() {} };
const measurements = [];
for (const layout of layouts) for (const [w, h] of [[1280, 720], [780, 360], [360, 780], [320, 640]]) {
  for (const zoom of [.5, 1.08, 2]) {
    const settings = { ...DEFAULT_SETTINGS, playfieldScale: zoom, particles: false };
    const renderer = new PlayfieldRenderer(layout.skin, path => layout.files.get(path), settings, DEFAULT_MODS);
    for (const [path, image] of layout.images) renderer.images.images.set(path, image);
    const session = new PlaySession(chart, {}, { skin: layout.skin, getAsset: () => undefined }, DEFAULT_MODS, settings, audio);
    const base = renderer.fieldOrigin(w, h), hit = session.hitY(), beatHeight = renderer.beatHeight();
    const deltaBefore = base.scaleY * (renderer.projectY(hit - beatHeight * .8) - renderer.projectY(hit - beatHeight));
    if (layout.skin?.perspective) near(base.oy, 0, 'Unset Malody position retains its original anchor');
    for (const gap of [0, .1, .4]) {
      settings.playfieldBottomGap = gap;
      const origin = renderer.fieldOrigin(w, h);
      near(origin.oy + hit * origin.scaleY, h * (1 - gap), 'Hit line follows distance from the screen bottom');
      near(origin.scaleY, base.scaleY, 'Moving the hit line cannot rescale note height or velocity');
      near(origin.scale, base.scale, 'Moving the hit line cannot change lane width');
      near(renderer.beatHeight(), beatHeight, 'Scroll mapping is unchanged');
      near(origin.oy + origin.top * origin.scaleY, 0, 'Logical upper viewport reaches screen top');
      near(origin.oy + origin.bottom * origin.scaleY, h, 'Logical lower viewport reaches screen bottom');
      const deltaAfter = origin.scaleY * (renderer.projectY(hit - beatHeight * .8) - renderer.projectY(hit - beatHeight));
      near(deltaAfter, deltaBefore, 'Actual projected motion stays identical after repositioning');
      const widths = session.laneWidths(), start = session.laneStart();
      for (const screenY of [h * .45, h * .7, h - 1]) {
        let left = start;
        for (let col = 0; col < 4; col++) {
          const screenX = origin.ox + renderer.projectX(left + widths[col] / 2, (screenY - origin.oy) / origin.scaleY) * origin.scale;
          near(laneAtPoint(screenX, screenY, origin, start, widths, (x, y) => renderer.projectX(x, y)), col, 'Touch follows moved lanes to the bottom of the screen');
          left += widths[col];
        }
      }
      const canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
      renderer.draw(ctx, session, w, h, 1000);
      if (layout.name !== 'osu') {
        const topPixel = ctx.getImageData(Math.floor(w / 2), 0, 1, 1).data;
        check(topPixel[3] > 0, 'Visible track background never leaves a gap at screen top');
      }
      // Place a note in the newly exposed upper extension. The old hard-coded
      // 740-unit candidate range missed it at narrow playfield widths.
      const rawY = renderer.unprojectY((22 - origin.oy) / origin.scaleY);
      const noteTime = (hit - rawY) / beatHeight * 500;
      const noteChart = { ...chart, notes: [{ t: noteTime, col: 1 }] };
      const noteSession = new PlaySession(noteChart, {}, { skin: layout.skin, getAsset: () => undefined }, DEFAULT_MODS, settings, audio);
      const noNote = ctx.getImageData(0, 0, w, Math.min(36, h)).data;
      ctx.clearRect(0, 0, w, h);
      renderer.draw(ctx, noteSession, w, h, 1000);
      const withNote = ctx.getImageData(0, 0, w, Math.min(36, h)).data;
      check(!Buffer.from(noNote).equals(Buffer.from(withNote)), 'Notes in the extended top remain visible, including small zoom');
      if (w === 780 && zoom === 1.08) {
        const name = `position-${layout.name}-${Math.round(gap * 100)}.png`;
        fs.writeFileSync(new URL(name, output), canvas.toBuffer('image/png'));
      }
      measurements.push({ skin: layout.name, w, h, zoom, gap, scaleY: origin.scaleY, hitY: origin.oy + hit * origin.scaleY, velocityDelta: deltaAfter, logicalTop: origin.top });
    }
  }
}
// Flashlight must cover the added upper track too, especially at small scale.
{
  const settings = { ...DEFAULT_SETTINGS, playfieldScale: .5, playfieldBottomGap: 0, particles: false };
  const mods = { ...DEFAULT_MODS, flashlight: false };
  const renderer = new PlayfieldRenderer(null, () => undefined, settings, mods);
  const origin = renderer.fieldOrigin(780, 360), hit = 464;
  const rawY = (22 - origin.oy) / origin.scaleY;
  const noteTime = (hit - rawY) / renderer.beatHeight() * 500;
  const session = new PlaySession({ ...chart, notes: [{ t: noteTime, col: 1 }] }, {}, { skin: null, getAsset: () => undefined }, mods, settings, audio);
  const canvas = createCanvas(780, 360), ctx = canvas.getContext('2d');
  renderer.draw(ctx, session, 780, 360, 1000);
  const normal = ctx.getImageData(0, 0, 780, 36).data;
  mods.flashlight = true; ctx.clearRect(0, 0, 780, 360); renderer.draw(ctx, session, 780, 360, 1000);
  const masked = ctx.getImageData(0, 0, 780, 36).data;
  const brightness = data => data.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : value), 0);
  check(brightness(masked) < brightness(normal) * .4, 'Flashlight darkens notes throughout the new upper extension');
}
fs.writeFileSync(new URL('field-position-results.json', output), JSON.stringify({ assertions, measurements, limitation: 'Native Canvas and production renderer/session; no physical device FPS measurements.' }, null, 2));
console.log(`PASS ${assertions} field position, unchanged velocity, top extension, note visibility and touch assertions`);
