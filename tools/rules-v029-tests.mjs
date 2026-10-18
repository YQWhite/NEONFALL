import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PlaySession } from '../src/engine/play.ts';
import { DEFAULT_MODS, DEFAULT_SETTINGS } from '../src/core/types.ts';
import { computePP } from '../src/core/rating.ts';
import { SCORING_VERSION, accuracyFromCounts, gradeFromAccuracy, judgmentCount, judgmentForError,
  judgmentWindows, scoreFromCounts, scrollSpeedMultiplier, scrollSpeedFromMultiplier } from '../src/core/scoring.ts';

let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (value, message) => { assert.ok(value, message); checks++; };
const counts = (patch = {}) => ({ perfect: 0, great: 0, good: 0, ok: 0, bad: 0, miss: 0, holdTicks: 0, ...patch });
function make(notes, { od = 8, mods = {}, inputOffset = 0 } = {}) {
  let now = 0; const down = new Set();
  const chart = { format: 'neonfall-chart', version: 1, keys: 4, od, hp: 5, offset: 0,
    notes, stars: 8, meta: { title: 'Rules test', version: '4K', lengthMs: 120000 },
    timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [] };
  const audio = { songTimeMs: () => now, playMusic(t) { now = t * 1000; }, seekMusic(t) { now = t * 1000; },
    pauseMusic() {}, resumeMusic() {}, stopMusic() {}, stopPreview() {}, playSynth() {} };
  const session = new PlaySession(chart, {}, { skin: null, getAsset: () => undefined },
    { ...DEFAULT_MODS, noFail: true, ...mods }, { ...DEFAULT_SETTINGS, particles: false, inputOffset }, audio);
  session.input.isDown = col => down.has(col); session.input.reset = () => down.clear(); session.beginPlay();
  return { s: session, at(t, dt = 16) { now = t; session.update(dt, t); },
    press(col, t) { now = t; down.add(col); session.press(col, t); },
    release(col, t) { now = t; down.delete(col); session.release(col, t); }, down };
}

// Exact values and both sides of the documented native-mania ScoreV2 windows.
eq(judgmentWindows(0), [22, 64, 97, 127, 151, 188], 'OD 0');
eq(judgmentWindows(5), [19, 49, 82, 112, 136, 173], 'OD 5');
eq(judgmentWindows(8), [16, 40, 73, 103, 127, 164], 'OD 8');
eq(judgmentWindows(10), [13, 34, 67, 97, 121, 158], 'OD 10');
eq(judgmentWindows(8, true), [24, 60, 109, 154, 190, 246], 'tail lenience');
eq(judgmentWindows(NaN), judgmentWindows(8));
eq(judgmentWindows(-100), judgmentWindows(0)); eq(judgmentWindows(100), judgmentWindows(10));
for (let od = 0; od <= 10; od += .25) for (const tail of [false, true]) {
  const w = judgmentWindows(od, tail), grades = ['perfect', 'great', 'good', 'ok', 'bad', 'miss'];
  for (let i = 0; i < w.length; i++) {
    eq(judgmentForError(-w[i], w), grades[i], `early inclusive OD ${od} tail ${tail} ${grades[i]}`);
    eq(judgmentForError(-w[i] - .51, w), grades[i + 1] ?? null, `early next OD ${od}`);
    if (i < 4) {
      eq(judgmentForError(w[i], w), grades[i], `late inclusive OD ${od}`);
      eq(judgmentForError(w[i] + .51, w), i < 3 ? grades[i + 1] : 'miss', `late next OD ${od}`);
    }
  }
  eq(judgmentForError(-w[5] - 1, w), null);
  eq(judgmentForError(w[4], w), 'miss', 'late MEH unavailable');
}

// Accuracy is independent from hold duration and does not mix legacy 320 MAXs.
eq(accuracyFromCounts(counts({ perfect: 1 })), 1);
eq(accuracyFromCounts(counts({ great: 1 })), 300 / 305);
eq(accuracyFromCounts(counts({ perfect: 1, great: 1, good: 1, ok: 1, bad: 1, miss: 1 })), 955 / 1830);
eq(accuracyFromCounts(counts({ great: 1, holdTicks: 100000 })), 300 / 305, 'sustain cannot farm accuracy');
for (const [acc, grade] of [[1, 'SS'], [.999999, 'S'], [.95, 'A'], [.950001, 'S'], [.9, 'B'], [.900001, 'A'], [.8, 'C'], [.800001, 'B'], [.7, 'D'], [.700001, 'C']]) {
  eq(gradeFromAccuracy(acc), grade); eq(gradeFromAccuracy(acc, false), 'F');
}
for (const total of [1, 3, 10, 999, 50000]) {
  eq(scoreFromCounts(counts({ perfect: total }), total), 1000000, `million cap ${total}`);
  eq(scoreFromCounts(counts({ perfect: total, holdTicks: 100000 }), total), 1000000);
  eq(scoreFromCounts(counts({ perfect: total }), total, ['NoTail']), 900000);
  eq(scoreFromCounts(counts({ perfect: total }), total, ['NoTail', 'NOTAIL']), 900000);
}
eq(scoreFromCounts(counts({ perfect: 1 }), 10), 100000, 'failed attempt uses full map denominator');
eq(scoreFromCounts(counts({ great: 10 }), 10), 937500);
eq(scoreFromCounts(counts(), 0), 0);
eq(computePP(8, 1, 120000, ['NoTail']), 142.56);
eq(computePP(8, 1, 120000, ['NoTail', 'ConstantSpeed']), 128.3);
eq(computePP(8, 1, 120000, ['NoTail', 'notail']), 142.56);

const mixedNotes = [{ t: 1000, col: 0, end: 2000 }, { t: 4000, col: 1 }, { t: 5000, col: 2, end: 60000 }];
eq(judgmentCount(mixedNotes), 5);
// Negative authored timing is legal; a tail at audio time zero is still a tail.
for (const mods of [{}, { auto: true }, { noTail: true }]) {
  const zeroTail = make([{ t: -1000, col: 0, end: 0 }], { mods });
  if (mods.auto) zeroTail.at(0);
  else { zeroTail.press(0, -1000); if (mods.noTail) zeroTail.at(0); else zeroTail.release(0, 0); }
  eq(zeroTail.s.totalJudgments, 2); eq(zeroTail.s.counts.perfect, 2); eq(zeroTail.s.counts.holdTicks, 19);
  eq(zeroTail.s.score, mods.noTail ? 900000 : 1000000); eq(zeroTail.s.isHeld(0), false);
}
const missedZeroTail = make([{ t: -1000, col: 0, end: 0 }]); missedZeroTail.at(0);
eq(missedZeroTail.s.counts.miss, 2, 'missed zero tail still consumes its two judgments');
let x = make(mixedNotes); x.press(0, 1000); x.release(0, 2000); x.press(1, 4000); x.press(2, 5000); x.release(2, 60000);
eq(x.s.counts.perfect, 5); eq(x.s.counts.holdTicks, 1118); eq(x.s.score, 1000000); eq(x.s.accuracy(), 1);
eq(x.s.buildResult().scoreVersion, SCORING_VERSION);
const id = x.s.buildResult().playId; ok(id.length >= 16); eq(x.s.buildResult().playId, id, 'stable upload attempt');
x.s.retry(); ok(x.s.buildResult().playId !== id, 'retry creates a separate attempt'); eq(x.s.score, 0); eq(x.s.buildResult().failedAtMs, undefined);

// ±20 ms is now MAX for a tail, ±55 ms GREAT; it was downgraded by head windows.
for (const [offset, grade] of [[-20, 'perfect'], [20, 'perfect'], [-55, 'great'], [55, 'great'], [-100, 'good'], [100, 'good'], [-150, 'ok'], [150, 'ok'], [-185, 'bad'], [185, 'miss']]) {
  x = make([{ t: 1000, col: 0, end: 2000 }]); x.press(0, 1000); x.release(0, 2000 + offset);
  eq(x.s.counts[grade], grade === 'perfect' ? 2 : 1, `tail ${offset}ms`);
  eq(x.s.isHeld(0), false); const before = x.s.score; x.release(0, 2000 + offset); eq(x.s.score, before, 'release cannot score twice');
}
x = make([{ t: 1000, col: 0, end: 2000 }]); x.press(0, 1000); x.at(2154); eq(x.s.isHeld(0), true); x.at(2155); eq(x.s.counts.miss, 1);
x = make([{ t: 1000, col: 0 }]); x.press(0, 835); eq(x.s.isJudged(0), false, 'too early ignored'); x.press(0, 836); eq(x.s.counts.miss, 1, 'early miss consumes once');
x = make([{ t: 1000, col: 0 }]); x.at(1103); eq(x.s.counts.miss, 0); x.at(1104); eq(x.s.counts.miss, 1, 'late auto miss after OK');

// NoTail completion never requires a release, but all of its body must be held.
x = make([{ t: 1000, col: 0, end: 2000 }], { mods: { noTail: true } }); x.press(0, 1000); x.at(1999); eq(x.s.isHeld(0), true); x.at(2000);
eq(x.s.isHeld(0), false); eq(x.s.counts.perfect, 2); eq(x.s.score, 900000); eq(x.s.accuracy(), 1); eq(x.s.buildResult().mods, ['NoFail', 'NoTail']); eq(x.s.buildResult().pp, 142.56);
const completed = x.s.score; x.release(0, 2500); x.at(5000); eq(x.s.score, completed);
for (const releaseAt of [1200, 1950, 1999]) {
  x = make([{ t: 1000, col: 0, end: 2000 }], { mods: { noTail: true } }); x.press(0, 1000); x.release(0, releaseAt);
  eq(x.s.counts.miss, 1, `NoTail body release ${releaseAt}`); eq(x.s.score, 450000); eq(x.s.accuracy(), .5);
}
x = make([{ t: 1000, col: 0, end: 2000 }], { mods: { noTail: true } }); x.at(2000); eq(x.s.counts.miss, 2, 'NoTail cannot grant a missed head an automatic tail');
x = make([{ t: 1000, col: 0, end: 2000 }], { mods: { noTail: true }, inputOffset: 70 }); x.press(0, 1070); x.at(2069); eq(x.s.isHeld(0), true); x.at(2070); eq(x.s.score, 900000, 'NoTail respects input calibration');

// Pausing / replaying sustain does not duplicate accuracy, ticks or score.
x = make([{ t: 1000, col: 0, end: 6000 }], { mods: { noTail: true } }); x.press(0, 1000); x.at(4000);
const beforePause = { score: x.s.score, ticks: x.s.counts.holdTicks };
x.s.pause(); x.s.resume(); x.press(0, 3900); x.at(4000); eq(x.s.score, beforePause.score); eq(x.s.counts.holdTicks, beforePause.ticks); x.at(6000); eq(x.s.score, 900000);

x = make(Array.from({ length: 60 }, (_, i) => ({ t: 1000 + i * 250, col: i % 4 })), { mods: { noFail: false } }); x.at(10000);
eq(x.s.phase, 'failed'); eq(x.s.buildResult().failedAtMs, 10000); eq(x.s.buildResult().passed, false); eq(x.s.buildResult().pp, 0);
const failed = x.s.buildResult().failedAtMs; x.at(11000); eq(x.s.buildResult().failedAtMs, failed, 'first failure position is stable');

eq(scrollSpeedMultiplier(DEFAULT_SETTINGS.scrollSpeed), 1, 'default speed is x1');
for (const saved of [.4, .55, .85, 1.2, 2]) ok(Math.abs(scrollSpeedFromMultiplier(scrollSpeedMultiplier(saved)) - saved) < 1e-12, 'saved physical speed remains identical');

fs.mkdirSync('test-results/v029', { recursive: true });
fs.writeFileSync('test-results/v029/rules-results.json', JSON.stringify({ checks, scoringVersion: SCORING_VERSION,
  windowsOD8: judgmentWindows(8), tailWindowsOD8: judgmentWindows(8, true), maxScore: 1000000, noTailMaxScore: 900000,
  references: ['https://osu.ppy.sh/wiki/en/Gameplay/Judgement/osu!mania', 'https://osu.ppy.sh/wiki/en/Gameplay/Accuracy#osu!mania', 'https://osu.ppy.sh/wiki/en/Gameplay/Grade#osu!mania'],
  limitation: 'Deterministic engine/input tests; no physical device feel or timing-latency measurement. NF normalized score is not the osu bonus-gauge formula.' }, null, 2));
console.log(`PASS ${checks} checks: mania OD windows / 1.5x tails / million-point normalization / accuracy and grades / NoTail score+pp / attempt IDs and failures / pause and speed compatibility`);
