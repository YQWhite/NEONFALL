import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PlaySession } from '../src/engine/play.ts';
import { PlayScreen } from '../src/ui/screens/play.ts';
import { AudioEngine } from '../src/engine/audio.ts';
import { parseStoryboard } from '../src/core/osz.ts';
import { DEFAULT_MODS, DEFAULT_SETTINGS } from '../src/core/types.ts';

let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const near = (actual, expected, label) => { assert.ok(Math.abs(actual - expected) < 1e-7, `${label}: ${actual} != ${expected}`); checks++; };
function make({ first = 1000, notes = [{ t: first, col: 0 }], duration = 10000, length = 4000, audioOffset = 0, auto = false, sbStart, sbEnd = 12000, sbEnabled = true } = {}) {
  let now = 0, stopped = 0;
  const starts = [], seeks = [], down = new Set();
  const audio = {
    musicDurationMs: duration, songTimeMs: () => now,
    playMusic(sec) { starts.push(sec); now = sec * 1000; },
    seekMusic(sec) { seeks.push(sec); now = sec * 1000; },
    stopMusic() { stopped++; now = 0; }, pauseMusic() {}, resumeMusic() {}, stopPreview() {}, playSynth() {},
  };
  const chart = {
    format: 'neonfall-chart', version: 1, id: 'preparation-test', keys: 4, od: 8, offset: 0, stars: 1,
    meta: { lengthMs: length, title: 'Preparation/outro', version: '4K' },
    notes, timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [],
    storyboard: sbStart === undefined ? undefined : { objects: parseStoryboard(['Sprite,Background,Centre,"scene.png",320,240', ` F,0,${sbStart},${sbEnd},1`]) },
  };
  const settings = { ...DEFAULT_SETTINGS, audioOffset, particles: false, sbEnabled, touchHint: false };
  const s = new PlaySession(chart, {}, { skin: null, getAsset: () => undefined }, { ...DEFAULT_MODS, auto, noFail: true }, settings, audio);
  s.input.isDown = col => down.has(col); s.input.reset = () => down.clear();
  s.beginPlay();
  return {
    s, audio, starts, seeks, get stopped() { return stopped; },
    set(t) { now = t + audioOffset; },
    at(t) { now = t + audioOffset; s.update(16, t); },
    press(col, t) { now = t + audioOffset; down.add(col); s.press(col, t); },
    release(col, t) { now = t + audioOffset; down.delete(col); s.release(col, t); },
  };
}

// Exactly three seconds before an early note, without seeking away authored intros.
for (const first of [0, 1000, 2999, 3000]) for (const audioOffset of [-120, 0, 75]) {
  const x = make({ first, audioOffset });
  const start = Math.min(0, first - 3000);
  check(x.s.initialTime(), start, 'preparation start boundary');
  near(x.s.chartTime(), start, 'chart clock includes calibration exactly once');
  near(x.starts[0], (start + audioOffset) / 1000, 'audio clock begins at calibrated preparation');
  check(x.seeks.length, 0, 'preparation never auto-skips audio or intro');
  check(x.s.introSkipped, false, 'normal begin is not a skip');
  check(x.s.preparationRemainingMs(), first < 3000 ? 3000 : 0, 'ready indicator only for added preparation');
  x.press(0, first); check(x.s.counts.perfect, 1, 'first note remains playable');
  check(x.s.preparationRemainingMs(), 0, 'ready indicator ends at first note');
  x.s.retry(); near(x.s.chartTime(), start, 'retry restores full preparation');
  check(x.s.counts.perfect, 0, 'retry clears earlier judgments'); check(x.s.finishPending, false, 'retry clears completion');
}
for (const [sbStart, first, expected] of [[-5000, 0, -5000], [-500, 0, -3000], [-4000, 1000, -4000], [500, 2999, -1]]) {
  const x = make({ sbStart, first, audioOffset: 75 });
  check(x.s.initialTime(), expected, 'negative storyboard and preparation keep the earliest authored point');
  near(x.s.chartTime(), expected, 'storyboard/calibration clock');
  x.s.pause(); x.s.resume(); near(x.s.chartTime(), expected, 'pause at beginning does not seek before authored start');
}
check(make({ first: 1000, sbStart: -5000, sbEnabled: false }).s.initialTime(), -2000, 'disabled storyboard does not add its negative intro');
const longIntro = make({ first: 10000 });
check(longIntro.s.initialTime(), 0, 'long intros play from zero'); check(longIntro.s.canSkipIntro(), true, 'long intro skip remains opt-in');
check(longIntro.seeks.length, 0, 'no automatic long-intro seek');

// Decoded audio overrides short or stale metadata. Calibration cannot shorten the
// one-second silence after the actual sound ends.
for (const audioOffset of [-120, 0, 75]) {
  const x = make({ duration: 10000, length: 3000, audioOffset });
  x.press(0, 1000); const end = 10000 - audioOffset;
  check(x.s.playbackEndTime(), end, 'decoded duration mapped into chart time');
  x.at(4501); check(x.s.phase, 'playing', 'short metadata cannot truncate actual audio');
  x.at(end); check(x.s.phase, 'playing', 'natural audio end alone does not settle');
  x.at(end + 999); check(x.s.phase, 'playing', 'full second after audio must elapse');
  x.at(end + 1000); check(x.s.phase, 'finished', 'exact one-second completion boundary');
  check(x.stopped, 1, 'completion stops audio once');
}
const shortAudio = make({ duration: 5000, length: 10000 }); shortAudio.press(0, 1000);
shortAudio.at(5999); check(shortAudio.s.phase, 'playing', 'actual shorter audio still gets one-second grace');
shortAudio.at(6000); check(shortAudio.s.phase, 'finished', 'stale longer metadata does not prolong the outro');
const fallback = make({ duration: 0, length: 5000 }); fallback.press(0, 1000);
fallback.at(5999); check(fallback.s.phase, 'playing', 'metadata fallback delay');
fallback.at(6000); check(fallback.s.phase, 'finished', 'undecoded test/audio fallback');

// The last visible storyboard frame remains available, even after audio + 1s.
const sb = make({ duration: 5000, length: 3000, sbStart: -1000, sbEnd: 8000 }); sb.press(0, 1000);
sb.at(6000); check(sb.s.phase, 'playing', 'long storyboard outro survives sound completion');
sb.at(8000); check(sb.s.phase, 'playing', 'last storyboard frame remains drawable');
sb.at(8001); check(sb.s.phase, 'finished', 'completion follows final storyboard frame');

// A long-note head being judged does not mean its tail is settled.
const held = make({ notes: [{ t: 1000, col: 0, end: 5000 }] });
held.press(0, 1000); held.at(4900);
check(held.s.canSkipOutro(), false, 'active long-note body blocks outro skip');
held.at(5000); check(held.s.canSkipOutro(), false, 'unreleased final tail blocks skip at endpoint');
const holdCounts = { ...held.s.counts };
check(held.s.trySkip(), false, 'space cannot replace final tail judgment'); check(held.s.counts, holdCounts, 'blocked skip does not award judgments');
held.release(0, 5000); check(held.s.canSkipOutro(), true, 'released final tail enables outro skip');
const expectedResult = held.s.buildResult(); const beforeSkip = { score: held.s.score, combo: held.s.combo, counts: { ...held.s.counts }, acc: held.s.accuracy(), hp: held.s.hp };
let handoffs = 0, handedResult;
const keyboard = new PlayScreen({ uiSound() {}, gotoScreen() {} }); keyboard.sess = held.s;
keyboard.submitAndGo = result => { handoffs++; handedResult = result; };
let prevented = 0;
keyboard.keyDown('Space', { preventDefault() { prevented++; } });
check(prevented, 1, 'space handles the eligible outro action'); check(held.s.phase, 'finished', 'space skips outro');
keyboard.update(16, 5001); keyboard.update(16, 5017); keyboard.keyDown('Space', { preventDefault() { prevented++; } });
check(handoffs, 1, 'result submits once despite repeated updates/space');
check(handedResult.score, expectedResult.score, 'skip result retains earned score'); check(handedResult.counts, expectedResult.counts, 'skip result retains release/tick judgments');
check({ score: held.s.score, combo: held.s.combo, counts: held.s.counts, acc: held.s.accuracy(), hp: held.s.hp }, beforeSkip, 'skipping never farms score, combo, accuracy or HP');
held.s.retry(); check(held.s.phase, 'playing', 'retry after skipping resumes gameplay'); check(held.s.canSkipOutro(), false, 'retry resets outro eligibility');

// Last tap must resolve its late judgment window before any outro action appears.
const lateTap = make({ first: 1000 }); lateTap.at(1000); check(lateTap.s.canSkipOutro(), false, 'unjudged last tap blocks skip');
lateTap.at(1128); check(lateTap.s.counts.miss, 1, 'late tap eventually misses'); check(lateTap.s.canSkipOutro(), true, 'missed final tap can end outro');
const lateTail = make({ notes: [{ t: 1000, col: 0, end: 5000 }] }); lateTail.press(0, 1000); lateTail.at(5155);
check(lateTail.s.counts.miss, 1, 'unreleased tail eventually misses'); check(lateTail.s.canSkipOutro(), true, 'settled miss tail enables skip');

// Actual mobile HUD button routes to the same safe skip operation.
const touch = make(); touch.press(0, 1000);
const buttons = [], canvas = createCanvas(780, 360);
const app = { w: 780, h: 360, isTouch: true, platform: 'android', settings: touch.s.settings,
  ui: { button(id, x, y, w, h, label) { buttons.push({ id, x, y, w, h, label }); return id === 'skip'; } } };
const screen = new PlayScreen(app); screen.sess = touch.s;
screen.drawHUD(canvas.getContext('2d'), touch.s);
check(buttons.find(button => button.id === 'skip')?.label, 'SKIP OUTRO', 'touch HUD labels outro skip');
check(touch.s.phase, 'finished', 'touch button finishes settled outro');
for (const button of buttons) assert.ok(button.x >= 0 && button.y >= 0 && button.x + button.w <= 780 && button.y + button.h <= 360); checks++;

// Use the real WebAudio-derived clock and buffer duration getter. The song clock
// continues after the buffer finishes, so the trailing second can elapse.
const context = { currentTime: 10, state: 'running', createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {} }) };
const realAudio = new AudioEngine(); realAudio.ctx = context; realAudio.musicGain = {};
realAudio.playSynth = () => {}; // Sound synthesis is unrelated to the WebAudio clock contract.
realAudio.decode = async () => ({ duration: 5 }); await realAudio.loadMusic(new Uint8Array(), 'outro-test');
check(realAudio.musicDurationMs, 5000, 'duration getter reports decoded buffer milliseconds');
const real = make({ duration: 5000 }); real.s.audio = realAudio; real.s.beginPlay();
const clockZero = 10.03 + 2; // first=1000, so the scheduled chart clock starts at -2000.
context.currentTime = clockZero + 1; real.s.press(0, real.s.chartTime());
context.currentTime = clockZero + 5.999; real.s.update(16, 0); check(real.s.phase, 'playing', 'actual audio clock waits 999ms after sound');
context.currentTime = clockZero + 6.001; real.s.update(16, 0); check(real.s.phase, 'finished', 'actual audio clock advances through natural completion');

const output = path.resolve('test-results/preparation-outro'); fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ ok: true, checks, testedAt: new Date().toISOString(), coverage: ['early-note boundaries', 'negative storyboard', 'calibration and retry', 'decoded audio duration', 'one-second outro grace', 'storyboard final frame', 'tap/tail eligibility', 'keyboard and touch skip', 'single result/no score farming', 'actual WebAudio clock'] }, null, 2));
console.log(`PASS preparation/outro: ${checks} checks`);
