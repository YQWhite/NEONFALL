// Deterministic session work/allocation checks. This is not a device FPS test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PlaySession } from '../src/engine/play.ts';
import { DEFAULT_MODS, DEFAULT_SETTINGS } from '../src/core/types.ts';

const output = new URL('../test-results/skin-field-refresh/', import.meta.url);
fs.mkdirSync(output, { recursive: true });
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const scoringResult = session => {
  const { playedAt, ...result } = session.buildResult();
  return result;
};
function make(notes, { particles = true, auto = false, skin = null } = {}) {
  let now = 0;
  const down = new Set();
  const chart = { format: 'neonfall-chart', version: 1, keys: 4, od: 8, hp: 5, offset: 0, notes,
    meta: { lengthMs: 1000000 }, stars: 1, timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [] };
  const audio = { songTimeMs: () => now, playSynth() {}, playMusic(t) { now = t * 1000; }, pauseMusic() {},
    seekMusic(t) { now = t * 1000; }, resumeMusic() {}, stopMusic() {}, stopPreview() {} };
  const s = new PlaySession(chart, {}, { skin, getAsset: () => undefined },
    { ...DEFAULT_MODS, noFail: true, auto }, { ...DEFAULT_SETTINGS, audioOffset: 0, inputOffset: 0, particles }, audio);
  s.input.isDown = col => down.has(col); s.input.reset = () => down.clear(); s.beginPlay();
  return { s,
    press(col, t) { now = t; down.add(col); s.press(col, t); },
    release(col, t) { now = t; down.delete(col); s.release(col, t); },
    at(t, dt = 16) { now = t; s.update(dt, t); },
  };
}

// One hit has exactly one seven-particle burst for every non-miss manual grade.
for (const offset of [0, 35, 65, 90, 115]) {
  const { s, press } = make([{ t: 1000, col: 0 }]);
  press(0, 1000 + offset);
  check(s.particles.length === 7, `offset ${offset}: duplicate or missing hit burst`);
}
const automatic = make([{ t: 1000, col: 0 }], { auto: true }); automatic.at(1000, 0);
check(automatic.s.particles.length === 7, 'autoplay retains a normal hit burst');
const disabled = make([{ t: 1000, col: 0 }], { particles: false }); disabled.press(0, 1000);
check(disabled.s.particles.length === 0, 'particle preference remains effective');

// Motion and stable survivor order match the previous filtering update exactly.
const motion = make([{ t: 100000, col: 0 }]);
motion.s.particles.push(
  { x: 10, y: 20, vx: 2, vy: -3, life: 0, ttl: 200, color: '#fff', size: 2 },
  { x: 20, y: 30, vx: -1, vy: -2, life: 195, ttl: 200, color: '#abc', size: 3 },
  { x: 30, y: 40, vx: 1.5, vy: -4, life: 10, ttl: 300, color: '#def', size: 4 },
);
const expected = motion.s.particles.map(p => ({ ...p })).filter(p => {
  p.x += p.vx * 2; p.y += p.vy * 2; p.vy += .3; p.life += 32; return p.life < p.ttl;
});
const particlesArray = motion.s.particles, popupArray = motion.s.popups;
motion.at(1000, 32);
assert.deepEqual(motion.s.particles, expected); checks++;
check(motion.s.particles === particlesArray && motion.s.popups === popupArray, 'update must retain both effect arrays');

// Repeated live hits reuse particles and judgment objects after they expire.
const repeat = make(Array.from({ length: 100 }, (_, i) => ({ t: 1000 + i * 1500, col: i % 4 })));
const particleObjects = new Set(), popupObjects = new Set();
const repeatParticles = repeat.s.particles, repeatPopups = repeat.s.popups;
for (let i = 0; i < 100; i++) {
  const t = 1000 + i * 1500;
  repeat.press(i % 4, t);
  for (const p of repeat.s.particles) { particleObjects.add(p); check(p.life === 0, 'reused particle life resets'); }
  for (const p of repeat.s.popups) { popupObjects.add(p); check(p.t0 === t, 'reused popup timestamp resets'); }
  repeat.at(t + 1000, 1000);
  check(repeat.s.particles === repeatParticles && repeat.s.popups === repeatPopups, 'effect arrays remain stable over full run');
  check(repeat.s.particles.length === 0 && repeat.s.popups.length === 0, 'expired effects clear');
}
check(particleObjects.size === 7, `100 hits allocated ${particleObjects.size} distinct particles`);
check(popupObjects.size === 1, `100 hits allocated ${popupObjects.size} distinct popups`);
repeat.s.retry();
check(repeat.s.particles === repeatParticles && repeat.s.popups === repeatPopups, 'retry retains effect buffers');
repeat.press(0, 1000); repeat.s.pause(); repeat.s.resume();
check(repeat.s.particles === repeatParticles && repeat.s.popups === repeatPopups, 'resume retains effect buffers');
check(repeat.s.particles.length === 0 && repeat.s.popups.length === 0, 'resume clears effects before rewind');

// A stalled update may judge a dense batch; only cosmetic particles are capped.
const denseNotes = Array.from({ length: 1200 }, (_, i) => ({ t: 1000 + Math.floor(i / 4), col: i % 4 }));
const dense = make(denseNotes, { auto: true }), denseWithoutParticles = make(denseNotes, { auto: true, particles: false });
dense.at(1500, 0); denseWithoutParticles.at(1500, 0);
const peakParticles = dense.s.particles.length;
check(peakParticles > 0 && peakParticles <= 512, `dense frame created ${peakParticles} particles`);
check(dense.s.counts.perfect === denseNotes.length, 'particle budget never drops judgments');
assert.deepEqual(scoringResult(dense.s), scoringResult(denseWithoutParticles.s)); checks++;
dense.at(2500, 1000);
check(dense.s.particles.length === 0 && dense.s.popups.length === 0, 'dense effects expire normally');

// Both visual settings produce identical head/body/tail/miss scores.
const varied = [{ t: 1000, col: 0, end: 2100 }, { t: 3000, col: 1 }, { t: 4000, col: 2 },
  { t: 5000, col: 3, end: 6000 }, { t: 7000, col: 0 }, { t: 8000, col: 1 }];
const withEffects = make(varied), noEffects = make(varied, { particles: false });
for (const x of [withEffects, noEffects]) {
  x.press(0, 1000); x.at(1550); x.release(0, 2135);
  x.press(1, 3065); x.at(4500); x.press(3, 5000); x.release(3, 5500);
  x.press(0, 7090); x.press(1, 8115); x.at(9500, 1000);
}
assert.deepEqual(scoringResult(withEffects.s), scoringResult(noEffects.s)); checks++;

// Session lane geometry is reused across hot input/render queries, and is
// refreshed when a different skin/layout is attached.
const layout = make([{ t: 100000, col: 0 }], { skin: { columns: [{ width: 40 }, { width: 60 }, {}, { width: 70 }], columnWidth: 50, hitPosition: 402 } }).s;
const widths = layout.laneWidths(), l = layout.layoutOf(2);
assert.deepEqual(widths, [40, 60, 50, 70]); checks++;
check(layout.laneStart() === 146 && layout.laneX(2) === 271, 'cached centered lane geometry matches original layout');
for (let i = 0; i < 10000; i++) check(layout.laneWidths() === widths && layout.layoutOf(2) === l, 'hot layout queries allocate no arrays/objects');
layout.skin = { columns: [{ width: 80 }, {}, {}, {}], columnWidth: 60, hitPosition: 420 };
assert.deepEqual(layout.laneWidths(), [80, 60, 60, 60]); checks++;
check(layout.laneStart() === 126 && layout.layoutOf(0).hitY === 420 && layout.layoutOf(0).x === 166, 'skin replacement refreshes layout cache');

fs.writeFileSync(new URL('gameplay-performance.json', output), JSON.stringify({ checks,
  manualParticleBursts: 'one seven-particle burst per hit', repeatedHits: 100,
  distinctParticleObjects: particleObjects.size, distinctPopupObjects: popupObjects.size,
  denseFrameNotes: denseNotes.length, peakParticles, scoringParity: true,
  layoutQueries: 10000, effectArrayIdentityStable: true,
  limitation: 'Deterministic session correctness and allocation/work checks; not browser or physical-device FPS.' }, null, 2));
console.log(`PASS ${checks} checks: 100 hits reuse ${particleObjects.size} particles / ${popupObjects.size} popup; ${denseNotes.length} notes fully score with ${peakParticles} max particles; layout cache and effect buffers stable.`);
