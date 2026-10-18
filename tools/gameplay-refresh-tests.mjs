import assert from 'node:assert/strict';
import { PlaySession } from '../src/engine/play.ts';
import { PlayfieldRenderer } from '../src/engine/render.ts';
import { PlayScreen } from '../src/ui/screens/play.ts';
import { DEFAULT_SETTINGS, DEFAULT_MODS } from '../src/core/types.ts';

function make(notes, options = {}) {
  let now = 0; const down = new Set(), seeks = [];
  const settings = { ...DEFAULT_SETTINGS, particles: false, audioOffset: options.audioOffset ?? 0, inputOffset: options.inputOffset ?? 0 };
  const chart = { format: 'neonfall-chart', version: 1, keys: 4, od: 8, hp: 5, offset: 0, notes, meta: { lengthMs: 180000 }, timing: [{ t: 0, bpm: 120 }], sv: [], breaks: options.breaks ?? [] };
  const audio = { songTimeMs: () => now, playMusic: sec => now = sec * 1000, seekMusic(sec) { seeks.push(sec); now = sec * 1000; }, pauseMusic() {}, resumeMusic() {}, stopMusic() {}, stopPreview() {}, playSynth() {} };
  const s = new PlaySession(chart, {}, { skin: null, getAsset: () => undefined }, { ...DEFAULT_MODS, ...options.mods }, settings, audio);
  s.input.isDown = col => down.has(col); s.input.reset = () => down.clear(); s.beginPlay();
  return { s, seeks, down, at(t) { now = t + settings.audioOffset; s.update(16, t); }, press(col, t) { now = t + settings.audioOffset; down.add(col); s.press(col, t); }, release(col, t) { now = t + settings.audioOffset; down.delete(col); s.release(col, t); } };
}

let x = make([{ t: 1000, col: 0 }, { t: 4000, col: 1 }, { t: 6000, col: 2 }], { audioOffset: 75, inputOffset: 30 });
x.press(0, 1030); x.at(3900); const before = { score: x.s.score, counts: { ...x.s.counts }, hp: x.s.hp, combo: x.s.combo };
x.s.pause(); x.s.resume(); assert.equal(x.s.chartTime(), 900); assert.equal(x.seeks[0], .975);
assert.equal(x.s.rewindRemainingMs(), 3000); assert.equal(x.s.isJudged(0), true);
x.press(0, 1030); x.at(3800);
assert.deepEqual({ score: x.s.score, counts: x.s.counts, hp: x.s.hp, combo: x.s.combo }, before, 'replayed hits must not count twice');
x.press(1, 4030); assert.equal(x.s.counts.perfect, 2, 'upcoming note remains playable');
x.at(4800); x.s.pause(); x.s.resume(); x.at(2000); x.s.pause(); x.s.resume(); assert.equal(x.s.chartTime(), -1000, 'repeat pause keeps a full rewind into the new preparation interval');
x.s.pause(); x.s.resume(); assert.equal(x.s.chartTime(), x.s.initialTime(), 'further pauses clamp to the actual preparation start');
assert.equal(x.s.chartTime(), -2000, 'a first note at 1000 ms starts at -2000 ms');
assert.equal(x.s.counts.perfect, 2);

x = make([{ t: 1000, col: 0, end: 6000 }, { t: 8000, col: 1 }]);
x.press(0, 1000); x.at(4000); const ticks = x.s.counts.holdTicks, score = x.s.score;
x.s.pause(); x.s.resume(); assert.equal(x.s.chartTime(), 1000);
x.at(2500); x.release(0, 2600); assert.equal(x.s.counts.miss, 0, 'replayed hold releases are ignored');
x.press(0, 3900); x.at(4000); assert.equal(x.s.counts.holdTicks, ticks); assert.equal(x.s.score, score);
x.at(4500); assert.equal(x.s.counts.holdTicks, ticks + 10); x.release(0, 6000); assert.equal(x.s.counts.perfect, 2); assert.equal(x.s.counts.miss, 0);
x.s.retry(); assert.equal(x.s.rewindRemainingMs(), 0); assert.equal(x.s.counts.perfect, 0); assert.equal(x.s.isHeld(0), false);

x = make([{ t: 1000, col: 0, end: 6000 }]); x.press(0, 1000); x.at(4000); x.s.pause(); x.s.resume();
x.at(4001); assert.equal(x.s.counts.miss, 0, 'resume has a re-grab grace window'); x.at(4150); assert.equal(x.s.counts.miss, 1, 'unrecovered hold eventually breaks');

x = make([{ t: 10000, col: 0 }]); assert.equal(x.s.chartTime(), 0); assert.equal(x.s.introSkipped, false);
x.at(1000); assert.equal(x.s.canSkipIntro(), true); assert.equal(x.seeks.length, 0); assert.equal(x.s.phase, 'playing');
const screen = new PlayScreen({ uiSound() {}, gotoScreen() {} }); screen.sess = x.s;
screen.keyDown('Space', { preventDefault() {} }); assert.equal(x.s.chartTime(), 7000); assert.equal(x.s.canSkipIntro(), false); assert.equal(x.s.introSkipped, true);
x.s.retry(); assert.equal(x.s.chartTime(), 0); assert.equal(x.s.introSkipped, false);

const notes = Array.from({ length: 400 }, (_, i) => ({ t: 1000 + i * 250, col: 0 }));
x = make(notes);
for (let i = 0; i < notes.length; i++) {
  if (i % 10 === 9) x.at(notes[i].t + 140); else { x.press(0, notes[i].t + (i % 3 === 0 ? 60 : 30)); x.release(0, notes[i].t + 70); x.at(notes[i].t + 80); }
}
assert.equal(x.s.phase, 'playing'); assert.ok(x.s.hp > 60, 'a sustained good/great run with 10% misses remains viable');
x = make(notes); x.at(10000); assert.equal(x.s.phase, 'failed', 'repeated misses still fail');
x = make([{ t: 1000, col: 0, end: 3000 }]); x.at(1200); assert.equal(x.s.counts.miss, 2); assert.ok(Math.abs(x.s.hp - 95.2) < 1e-6, 'a missed long note has one health penalty');
x = make([{ t: 15000, col: 0 }], { breaks: [{ t: 2000, end: 8000 }] }); x.s.hp = 40; x.at(6000); assert.equal(x.s.hp, 56); x.s.pause(); x.s.resume(); x.at(6000); assert.equal(x.s.hp, 56, 'rewinding a break cannot farm HP'); x.at(7000); assert.equal(x.s.hp, 60);

for (const skin of [null, { hitPosition: 402 }]) {
  const r1 = new PlayfieldRenderer(skin, () => undefined, { ...DEFAULT_SETTINGS, playfieldScale: 1 }, DEFAULT_MODS);
  const r2 = new PlayfieldRenderer(skin, () => undefined, { ...DEFAULT_SETTINGS, playfieldScale: 1.08 }, DEFAULT_MODS);
  for (const [w, h] of [[1280, 720], [640, 400]]) {
    const a = r1.fieldOrigin(w, h), b = r2.fieldOrigin(w, h), hit = skin?.hitPosition ?? 464;
    assert.ok(Math.abs(b.scale / a.scale - 1.08) < 1e-9);
    assert.ok(Math.abs(a.oy + hit * a.scale - b.oy - hit * b.scale) < 1e-9, 'zoom preserves hit-line location');
  }
}
console.log('PASS actual 3s rewind / no double score / hold resume & grace / retry reset / opt-in intro skip / sustainable health / no break farming / anchored 108% scale');
