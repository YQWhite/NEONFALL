import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { DEFAULT_SETTINGS, DEFAULT_MODS, PLAYFIELD_SCALE_MIN, PLAYFIELD_SCALE_MAX } from '../src/core/types.ts';
import { getBuiltinSkin } from '../src/core/default-skin.ts';
import { selectSkinForKeys } from '../src/core/osk.ts';
import { PlayfieldRenderer } from '../src/engine/render.ts';
import { PlaySession } from '../src/engine/play.ts';
import { PlayScreen } from '../src/ui/screens/play.ts';
import { SettingsScreen } from '../src/ui/screens/settings.ts';
import { Store } from '../src/core/store.ts';
import { UI } from '../src/ui/widgets.ts';
import { laneAtPoint } from '../src/engine/lane-geometry.ts';
import { setLanguage } from '../src/ui/i18n.ts';
import { buildNFM } from '../src/core/nfm.ts';

const output = new URL('../test-results/mobile-field/', import.meta.url);
fs.mkdirSync(output, { recursive: true });
globalThis.document = { documentElement: {}, hidden: false, createElement: tag => {
  assert.equal(tag, 'canvas'); return createCanvas(1, 1);
} };
globalThis.localStorage = { data: new Map(), getItem(k) { return this.data.get(k) ?? null; }, setItem(k, v) { this.data.set(k, v); } };
for (const font of ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/segoeui.ttf']) if (fs.existsSync(font)) GlobalFonts.registerFromPath(font);
setLanguage('en');
const { skin, files } = getBuiltinSkin('builtin:malody'), images = new Map();
for (const [path, data] of files) if (/\.png$/i.test(path)) images.set(path, await loadImage(data));
let assertions = 0;
function check(value, message) { assertions++; assert.ok(value, message); }
function equal(actual, expected, message) { assertions++; assert.equal(actual, expected, message); }
function rendererFor(keys, scale = DEFAULT_SETTINGS.playfieldScale) {
  const selected = selectSkinForKeys(skin, keys), settings = { ...DEFAULT_SETTINGS, playfieldScale: scale };
  const renderer = new PlayfieldRenderer(selected, path => files.get(path), settings, { ...DEFAULT_MODS });
  for (const [path, image] of images) renderer.images.images.set(path, image);
  return { selected, renderer, settings };
}

const widths = [];
for (const [w, h] of [[1280, 720], [780, 360], [360, 780], [320, 640]]) {
  for (const keys of [4, 5, 6]) {
    let previousWidth = 0;
    for (const zoom of [PLAYFIELD_SCALE_MIN, 1.08, PLAYFIELD_SCALE_MAX]) {
      const { selected, renderer } = rendererFor(keys, zoom), origin = renderer.fieldOrigin(w, h);
      equal(origin.oy, 0, 'Perspective rails start at screen top');
      check(Math.abs(origin.oy + selected.hitPosition * origin.scaleY - h * .86) < 1e-7, 'Width never shifts the hit line');
      const total = selected.columns.reduce((sum, c) => sum + c.width, 0), start = selected.columnStart ?? (512 - total) / 2;
      const left = origin.ox + renderer.projectX(start, 480) * origin.scale;
      const right = origin.ox + renderer.projectX(start + total, 480) * origin.scale;
      check(left >= w * .01 && right <= w * .99, 'The complete outer receptors remain inside the screen at maximum width');
      const trackWidth = total * origin.scale;
      check(trackWidth >= previousWidth, 'Increasing the scale cannot narrow the lanes'); previousWidth = trackWidth;
      if (w === 780 && zoom === 1.08) check(trackWidth > 580, 'Landscape default provides at least 580px of touch width');
      if (zoom === PLAYFIELD_SCALE_MAX) check(trackWidth > w * .84, 'Full-width preset uses over 84% of the display at the hit line');
      for (const logicalY of [220, selected.hitPosition, 474]) {
        let x = start;
        for (let col = 0; col < keys; col++) {
          const center = x + selected.columns[col].width / 2;
          const screenX = origin.ox + renderer.projectX(center, logicalY) * origin.scale;
          const screenY = origin.oy + logicalY * origin.scaleY;
          equal(laneAtPoint(screenX, screenY, origin, start, selected.columns.map(c => c.width), (a, b) => renderer.projectX(a, b)), col, 'Touch agrees with all widened, projected lanes');
          x += selected.columns[col].width;
        }
      }
      widths.push({ w, h, keys, zoom, trackWidth });
    }
  }
}

for (const value of [.5, 1.08, 1.6, 2, 99, .1]) {
  localStorage.setItem('nf.settings.v1', JSON.stringify({ playfieldScale: value }));
  equal(new Store().settings.playfieldScale, Math.max(.5, Math.min(2, value)), 'The extended scale persists across restart and is clamped');
}

const chart = { format: 'neonfall-chart', version: 1, keys: 4, od: 8, hp: 5, offset: 0,
  meta: { title: 'Mobile lane test', artist: 'Test', creator: 'Test', version: '4K', audio: '', previewTime: 0, audioLeadIn: 0, lengthMs: 30000 },
  timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [], notes: [{ t: 1400, col: 0 }, { t: 1500, col: 1, end: 2200 }, { t: 1700, col: 2 }, { t: 1800, col: 3 }, { t: 20000, col: 0 }] };
const screenshots = [];
for (const [w, h] of [[1280, 720], [780, 360], [360, 780], [320, 640]]) {
  const { selected, renderer, settings } = rendererFor(4), canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  const audio = { songTimeMs: () => 1000, pauseMusic() {}, resumeMusic() {}, stopMusic() {} };
  const session = new PlaySession(chart, {}, { skin: selected, getAsset: path => files.get(path) }, { ...DEFAULT_MODS }, settings, audio);
  session.phase = 'playing'; session.combo = 128; session.score = 123456;
  session.popups = [{ label: 'PERFECT', color: '#f5d462', x: 76, y: 414, t0: 900, big: true }];
  const app = { w, h, settings, mods: { ...DEFAULT_MODS }, audio, ctx, isTouch: true, platform: 'android', uiSound() {}, saveSettings() {}, animateViewChange(change) { this.transitions = (this.transitions ?? 0) + 1; change(); } };
  app.ui = new UI(app); app.ui.beginFrame({ x: -1, y: -1, down: false, downX: 0, downY: 0, moved: false });
  const screen = new PlayScreen(app); screen.sess = session; screen.renderer = renderer; screen.status = ''; screen.entry = { title: chart.meta.title, version: '4K', keys: 4 };
  const texts = [], art = [], originalText = ctx.fillText.bind(ctx), originalDraw = ctx.drawImage.bind(ctx);
  ctx.fillText = (label, ...args) => { texts.push({ label, args }); originalText(label, ...args); };
  ctx.drawImage = (image, ...args) => { art.push({ image, args }); originalDraw(image, ...args); };
  screen.draw(ctx);
  equal(texts.filter(t => t.label === '128x combo').length, 1, 'Combo is a single line');
  check(!texts.some(t => t.label === '128' || t.label === 'COMBO'), 'No old second combo line remains');
  const judgment = art.filter(a => a.image === images.get(selected.judgments.perfect));
  equal(judgment.length, 1, 'Exactly one judgement sprite is shown');
  const [, , , , x, y, aw, ah] = judgment[0].args;
  check(Math.abs(x + aw / 2 - w / 2) < .001 && y > 55 && y + ah <= 100, 'Grade sits centrally below combo in HUD coordinates');
  const glow = art.find(a => a.image === images.get(selected.msp.perfectEffect.image));
  check(glow && Math.abs(glow.args[0] + glow.args[2] / 2 - w / 2) < .001, 'Perfect glow follows the HUD grade');
  const topPixel = ctx.getImageData(Math.round(w / 2), 0, 1, 1).data;
  check(topPixel[3] > 0 && topPixel[0] !== 13, 'Track background reaches the top pixel');
  screen.visualPhase = 'playing'; session.phase = 'paused'; screen.update(16, 1000);
  equal(app.transitions, 1, 'Pause changes invoke the continuous screen transition');
  session.phase = 'playing'; screen.update(16, 1000);
  equal(app.transitions, 2, 'Resume changes invoke the continuous screen transition');
  const filename = `${w}x${h}-play.png`; fs.writeFileSync(new URL(filename, output), canvas.toBuffer('image/png')); screenshots.push(filename);
}

// A simultaneous chord uses a single readable grade, preserving a miss rather
// than covering it with a later perfect from another column.
const canvas = createCanvas(360, 180), ctx = canvas.getContext('2d');
const fallback = new PlayfieldRenderer(null, () => undefined, DEFAULT_SETTINGS, DEFAULT_MODS), labels = [];
ctx.fillText = text => labels.push(text);
fallback.drawJudgement(ctx, { chartTime: () => 1000, popups: [
  { t0: 900, label: 'MISS', color: '#ff0000' }, { t0: 900, label: 'PERFECT', color: '#ffffff' },
] }, 180, 83, 120);
equal(labels.length, 1, 'Chord grades never stack'); equal(labels[0], 'MISS', 'A same-time miss remains visible');

const settingsApp = { w: 780, h: 360, ctx: createCanvas(780, 360).getContext('2d'), settings: structuredClone(DEFAULT_SETTINGS), isTouch: true,
  uiSound() {}, saveSettings() {}, animateViewChange(change) { this.transitions = (this.transitions ?? 0) + 1; change(); } };
settingsApp.ui = new UI(settingsApp); const settingsScreen = new SettingsScreen(settingsApp);
settingsScreen.changeTab('gameplay'); equal(settingsApp.transitions, 1, 'Settings tabs use screen animation');
settingsScreen.changeTab('gameplay'); equal(settingsApp.transitions, 1, 'Reselecting a tab does not restart animation');
settingsApp.ui.beginFrame({ x: -1, y: -1, down: false, downX: 0, downY: 0, moved: false }); settingsScreen.draw(settingsApp.ctx);
check(settingsScreen.maxScroll > 150, 'Landscape test has content to scroll');
const v = settingsScreen.viewport;
settingsScreen.pointerDown(v.x + 10, v.y + v.h - 10); settingsScreen.pointerMove(v.x + 12, v.y + 8); settingsScreen.pointerUp();
check(settingsScreen.scroll > 100, 'A phone can drag the settings pane to reach track width controls');

const duck = []; settingsApp.audio = { setPreviewDucking: v => duck.push(v) }; settingsApp.toast = () => {};
settingsScreen.calib = { state: 'starting', update() {}, cancel() { this.state = 'cancelled'; } };
settingsScreen.update(); equal(duck.at(-1), .08, 'Calibration start lowers preview volume without pausing');
for (const state of ['running', 'done', 'error']) {
  settingsScreen.calib.state = state; settingsScreen.update();
  equal(duck.at(-1), state === 'running' ? .08 : 1, 'Calibration restores preview on completion or error');
}
settingsScreen.calib.state = 'running'; settingsScreen.keyDown('Escape', {});
equal(duck.at(-1), 1, 'Cancelling calibration restores preview volume');
settingsScreen.calib.state = 'starting'; settingsScreen.changeTab('audio');
equal(duck.at(-1), 1, 'Changing tabs restores preview volume');
settingsScreen.calib.state = 'running'; settingsScreen.leave();
equal(duck.at(-1), 1, 'Leaving settings restores preview volume');

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const bytes = buildNFM({ ...chart, meta: { ...chart.meta, audio: 'music.wav' } }, { 'music.wav': new Uint8Array([0]) });
let attached = 0, started = 0, redirected = 0;
globalThis.window = { addEventListener() { attached++; }, removeEventListener() {} };
const decode = deferred(), decoding = deferred(); let decodeSignal;
const raceApp = { settings: { ...DEFAULT_SETTINGS }, mods: { ...DEFAULT_MODS },
  store: { getChartBytes: async () => bytes, prepareChart: async archive => archive },
  audio: { async loadMusic(_bytes, _key, signal) { decodeSignal = signal; decoding.resolve(); await decode.promise; },
    stopMusic() {}, stopPreview() {}, playMusic() { started++; } },
  gotoScreen() { redirected++; },
};
const race = new PlayScreen(raceApp), loading = race.enter({ entry: { id: 'race' } });
await decoding.promise; race.leave(); decode.resolve(); await loading;
equal(decodeSignal.aborted, true, 'Leaving gameplay aborts any pending shared-engine music decode');
equal(attached, 0, 'Late decode cannot attach keyboard/touch input'); equal(started, 0, 'Late decode cannot start music');
equal(race.renderer, null, 'Late decode does not recreate a disposed renderer');
const download = deferred(); raceApp.store.getChartBytes = () => download.promise;
const lateError = race.enter({ entry: { id: 'late-error' } }); race.leave(); download.reject(new Error('expected late download failure')); await lateError;
equal(race.errorTimer, null, 'A late failure does not schedule a redirect after leaving'); equal(redirected, 0, 'Navigation destination survives late load failure');

fs.writeFileSync(new URL('report.json', output), JSON.stringify({ assertions, widths, screenshots,
  limitations: 'Native Canvas and simulated input; not an Android installation or physical touch latency test.' }, null, 2));
console.log(`PASS ${assertions} mobile field checks: 50-200% persistence, full-height 4/5/6K lanes, touch geometry, single-line combo/grade placement, local transitions and settings touch scroll`);
