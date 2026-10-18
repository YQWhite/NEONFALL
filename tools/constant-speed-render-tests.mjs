import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { PlaySession } from '../src/engine/play.ts';
import { PlayfieldRenderer } from '../src/engine/render.ts';
import { DEFAULT_MODS, DEFAULT_SETTINGS } from '../src/core/types.ts';
import { computePP, resultPP } from '../src/core/rating.ts';

const out = new URL('../test-results/constant-speed/', import.meta.url); fs.mkdirSync(out, { recursive: true });
let assertions = 0;
const check = (value, message) => { assertions++; assert.ok(value, message); };
const eq = (a, b, message) => { assertions++; assert.deepEqual(a, b, message); };
const near = (a, b, message) => { assertions++; assert.ok(Math.abs(a - b) < 1e-7, `${message}: ${a} vs ${b}`); };
const wildTiming = [{ t: -1200, bpm: 90 }, { t: 0, bpm: 120 }, { t: 1000, bpm: 60 }, { t: 2000, bpm: 240 },
  { t: 3500, bpm: 150 }, { t: 5000, bpm: 720 }, { t: 6500, bpm: 30 }, { t: 9000, bpm: 180 }, { t: 10825, bpm: 600 }];
const wildSv = [{ t: -2000, sv: .5 }, { t: 500, sv: 2 }, { t: 1600, sv: .25 }, { t: 2900, sv: 4 },
  { t: 4600, sv: .6 }, { t: 5700, sv: 1.8 }, { t: 7500, sv: .05 }, { t: 9200, sv: 8 }, { t: 10825, sv: .15 }];
const notes = [{ t: 1000, col: 0 }, { t: 2500, col: 1, end: 9000 }, { t: 4000, col: 2 }, { t: 4500, col: 3 },
  { t: 5000, col: 0 }, { t: 6000, col: 2, end: 10000 }, { t: 8000, col: 3 }, { t: 11000, col: 2 }, { t: 12000, col: 0 }];
const tilted = { format: 'neonfall-skin', version: 1, name: 'Test perspective', keys: 4, columns: Array.from({ length: 4 }, () => ({ width: 120 })),
  columnStart: 16, hitPosition: 414, perspective: { angle: 43, topWidth: .224 }, msp: { depth: .26 } };

function make({ constant = true, wild = true, skin = null, scrollSpeed = .55, speed = 1, visualOffset = 0, chartNotes = notes, audioOffset = 71, inputOffset = 23 } = {}) {
  let clock = 0; const down = new Set(), playCalls = [], seeks = [];
  const settings = { ...DEFAULT_SETTINGS, scrollSpeed, audioOffset, inputOffset, visualOffset, particles: false };
  const mods = { ...DEFAULT_MODS, constantSpeed: constant, speed };
  const chart = { format: 'neonfall-chart', version: 1, id: 'constant-speed-render', keys: 4, od: 8, hp: 5, stars: 6,
    offset: wild ? 350 : 0, meta: { title: 'Timing changes', artist: 'Test', creator: 'Test', version: '4K', audio: '', lengthMs: 30000 },
    timing: wild ? wildTiming : [{ t: 0, bpm: 120 }], sv: wild ? wildSv : [], breaks: [], notes: chartNotes };
  const audio = { songTimeMs: () => clock, musicDurationMs: 30000, playSynth() {}, stopPreview() {}, stopMusic() {}, pauseMusic() {}, resumeMusic() {},
    playMusic(sec) { playCalls.push(sec); clock = sec * 1000; }, seekMusic(sec) { seeks.push(sec); clock = sec * 1000; } };
  const session = new PlaySession(chart, {}, { skin, getAsset: () => undefined }, mods, settings, audio);
  session.input.isDown = col => down.has(col); session.input.reset = () => down.clear(); session.beginPlay();
  const renderer = new PlayfieldRenderer(skin, () => undefined, settings, mods), canvas = createCanvas(780, 360), ctx = canvas.getContext('2d');
  const commands = []; const tap = renderer.drawTap.bind(renderer), hold = renderer.drawHold.bind(renderer);
  renderer.drawTap = (...args) => { commands.push({ kind: 'tap', col: args[2], y: args[5] }); tap(...args); };
  renderer.drawHold = (...args) => { commands.push({ kind: 'hold', col: args[2], tail: args[5], head: args[6], consumed: !!args[8], alpha: args[0].globalAlpha }); hold(...args); };
  return { session, renderer, canvas, chart, down, settings, mods, playCalls, seeks,
    at(t) { clock = t + audioOffset; },
    draw(t) { this.at(t); commands.length = 0; ctx.clearRect(0, 0, 780, 360); renderer.draw(ctx, session, 780, 360, 1e6); return structuredClone(commands); },
    pixels() { return Buffer.from(ctx.getImageData(0, 0, 780, 360).data); },
    updateJudgeAt(t) { clock = t + audioOffset + inputOffset; session.update(25, 1e6 + t); },
    press(col, t) { clock = t + audioOffset + inputOffset; down.add(col); session.press(col, t + inputOffset); },
    release(col, t) { clock = t + audioOffset + inputOffset; down.delete(col); session.release(col, t + inputOffset); },
  };
}

const motionRows = [], sampleTimes = [0, 499, 501, 999, 1001, 1599, 1601, 2001, 2901, 3501, 4599, 4601, 4999, 5001, 5699, 5701, 6501, 7501, 8999, 9201, 10800, 10850];
for (const skin of [null, tilted]) {
  for (const [scrollSpeed, speed, visualOffset] of [[.4, .75, -37], [.55, 1, 0], [.85, 1.5, 37], [1.7, 1.5, 0]]) {
    const fixed = make({ skin, scrollSpeed, speed, visualOffset }), baseline = make({ constant: false, wild: false, skin, scrollSpeed, speed, visualOffset });
    const variable = make({ constant: false, skin, scrollSpeed, speed, visualOffset }); let differences = 0;
    for (const at of sampleTimes) {
      const commands = fixed.draw(at), reference = baseline.draw(at), normal = variable.draw(at);
      eq(commands, reference, 'Constant Speed note heads, bodies, tails and visibility match a uniform 120 BPM reference');
      eq(fixed.pixels(), baseline.pixels(), 'Actual generated note pixels are identical through BPM/SV changes');
      if (JSON.stringify(commands) !== JSON.stringify(normal)) differences++;
      near(fixed.session.chartTime(), at, 'Constant Speed leaves the music/chart clock untouched');
      near(fixed.session.drawTime(), at + visualOffset, 'Visual offset remains applied once');
      near(fixed.session.timeMap.bpmAt(at), variable.session.timeMap.bpmAt(at), 'Real BPM still drives musical beat effects');
    }
    check(differences > sampleTimes.length / 2, 'Normal mode still visibly responds to authored BPM and SV');
    const a = fixed.draw(10800).filter(c => c.kind === 'tap' && c.col === 2).at(-1), b = fixed.draw(10850).filter(c => c.kind === 'tap' && c.col === 2).at(-1);
    check(a && b, 'Test note remains a candidate on both sides of the extreme timing change');
    near(b.y - a.y, 50 * scrollSpeed * speed, 'Scroll speed and speed mod multiply fixed travel as expected');
    near(a.y, fixed.session.hitY() - (11000 - 10800 - visualOffset) * scrollSpeed * speed, 'Fixed distance uses milliseconds until the hit, including visual offset');
    motionRows.push({ perspective: !!skin, scrollSpeed, speed, visualOffset, variableFrames: differences, fixedTravelPer50ms: b.y - a.y });
  }
}

// A head outside the visible candidate window must still supply its crossing
// hold body/tail. This covers the interval-tree path, not only nearby note heads.
const crossing = make({ chartNotes: [{ t: 2500, end: 9000, col: 1 }] });
const oldHold = crossing.draw(7000).find(c => c.kind === 'hold');
check(oldHold, 'A long hold starting before the head window is still drawn across timing changes');
near(oldHold.head, crossing.session.hitY() + 4500 * .55, 'Unconsumed old hold head uses fixed scroll mapping');
near(oldHold.tail, crossing.session.hitY() - 2000 * .55, 'Old hold tail uses the same fixed mapping');
crossing.press(1, 2500); crossing.updateJudgeAt(7000);
const held = crossing.draw(7000).find(c => c.kind === 'hold');
check(held?.consumed, 'Consumed hold heads remain suppressed in Constant Speed');
near(held.head, crossing.session.hitY(), 'A held body stays attached to the judgement line');
near(held.tail, crossing.session.hitY() - 2000 * .55, 'Held tail motion stays fixed across SV/BPM changes');
let alpha = 1;
for (const at of [8955, 8970, 8990, 9000]) {
  const command = crossing.draw(at).find(c => c.kind === 'hold');
  check(command.alpha <= alpha, 'Constant Speed preserves monotonic held-tail disappearance'); alpha = command.alpha;
}
near(alpha, 0, 'Consumed long note is fully transparent at its tail time');

// A distant SV change must not replace the millisecond candidate window. Huge
// maps still visit only nearby heads plus crossing holds.
const denseNotes = [{ t: 0, end: 3e6, col: 3 }, ...Array.from({ length: 100000 }, (_, i) => ({ t: 25 * i + 100, col: i % 4 }))];
const dense = make({ chartNotes: denseNotes }), densePlain = make({ wild: false, constant: false, chartNotes: denseNotes });
const candidates = dense.draw(1500000), denseReference = densePlain.draw(1500000);
eq(candidates, denseReference, 'Dense chart candidates exactly match the fixed-clock reference');
check(candidates.length < 150, '100,001 notes stay bounded to fewer than 150 draw candidates');
check(candidates.some(c => c.kind === 'hold' && c.col === 3), 'Long holds outside the candidate head window are retained');

const judgedNotes = [{ t: 1000, col: 0 }, { t: 1500, col: 1, end: 5500 }, { t: 3500, col: 2 }, { t: 6500, col: 3 }, { t: 7000, col: 0, end: 8400 }];
const events = [{ t: 1000, type: 'press', col: 0 }, { t: 1050, type: 'release', col: 0 }, { t: 1500, type: 'press', col: 1 },
  { t: 3530, type: 'press', col: 2 }, { t: 3580, type: 'release', col: 2 }, { t: 5500, type: 'release', col: 1 },
  { t: 6560, type: 'press', col: 3 }, { t: 6610, type: 'release', col: 3 }, { t: 7000, type: 'press', col: 0 }, { t: 8400, type: 'release', col: 0 }];
const times = [...new Set([...Array.from({ length: 341 }, (_, i) => i * 25), ...events.map(e => e.t)])].sort((a, b) => a - b);
const judgedFixed = make({ chartNotes: judgedNotes }), judgedNormal = make({ constant: false, chartNotes: judgedNotes });
eq(judgedFixed.playCalls, judgedNormal.playCalls, 'Initial audio start/preparation time is unchanged');
eq(judgedFixed.session.notes.map(({ t, end, col }) => ({ t, end, col })), judgedNotes.map(({ t, end, col }) => ({ t, end, col })), 'Constant Speed never rewrites note times');
for (const t of times) {
  for (const state of [judgedFixed, judgedNormal]) {
    for (const e of events.filter(e => e.t === t)) state[e.type](e.col, t);
    state.updateJudgeAt(t);
  }
  eq(judgedFixed.session.counts, judgedNormal.session.counts, 'Tap, 20Hz hold ticks and graded tails keep identical judgement windows');
  near(judgedFixed.session.chartTime(), judgedNormal.session.chartTime(), 'Mod does not accelerate or seek audio');
}
const fixedResult = judgedFixed.session.buildResult(), normalResult = judgedNormal.session.buildResult();
near(fixedResult.acc, (5 * 305 + 300 + 200) / (7 * 305), 'Accuracy includes seven head/tail judgments without body-tick inflation');
check(fixedResult.passed && fixedResult.acc > .9 && fixedResult.pp > 0, 'Real mixed tap/hold play remains ranked and earns PP');
for (const key of ['score', 'acc', 'maxCombo', 'counts', 'durationMs']) eq(fixedResult[key], normalResult[key], `Constant Speed preserves raw ${key}`);
eq(fixedResult.mods, ['ConstantSpeed'], 'Result records the enabled mod');
eq(fixedResult.pp, computePP(fixedResult.stars, fixedResult.acc, fixedResult.durationMs, ['ConstantSpeed']), 'buildResult applies the Constant Speed factor');
check(Math.abs(fixedResult.pp - normalResult.pp * .9) <= .01, 'The 90% PP conversion is applied exactly once (rounding to cents)');
eq(resultPP(fixedResult), fixedResult.pp, 'Recalculation does not apply the factor a second time');
for (const state of [judgedFixed, judgedNormal]) { state.session.pause(); state.session.resume(); }
eq(judgedFixed.seeks, judgedNormal.seeks, 'Pause rewind seeks exactly the same audio position');
eq(judgedFixed.session.counts, judgedNormal.session.counts, 'Pause rewind preserves the same judged notes and holds');

const report = `# Constant Speed renderer/session verification\n\nPassed **${assertions} assertions** using real PlaySession, PlayfieldRenderer and native Canvas.\n\n- Flat and tilted tracks produce byte-identical note pixels to a uniform 120 BPM reference across BPM 30–720, SV 0.05–8, chart offsets and timing boundaries. Normal mode still changes its motion.\n- 50ms travel combines scrollSpeed and mods.speed, with visual/audio/input offsets retained. Perspective depth remains the authored geometric projection; musical BPM/SV no longer changes the underlying travel.\n- Crossing and consumed long notes retain correct heads, bodies, tails and monotonic endpoint fade. A 100,001-note map visits ${candidates.length} candidates, including an old crossing hold.\n- Real mixed tap/hold inputs preserve raw score, accuracy, combo, 20Hz ticks, tail grades, audio start and pause rewind. Result emits ConstantSpeed and converts PP to 90% exactly once; recalculation is idempotent.\n\nRuntime diagnostics: normal PP ${normalResult.pp}, Constant Speed PP ${fixedResult.pp}, accuracy ${fixedResult.acc}.\n\nThis is native Canvas/simulated input validation, not device FPS or physical touch latency. No production source changed by this verification task.\n`;
fs.writeFileSync(new URL('render-report.md', out), report);
console.log(`PASS Constant Speed renderer/session: ${assertions} assertions; ${candidates.length} candidates for 100001 notes; PP ${normalResult.pp} -> ${fixedResult.pp}`);
