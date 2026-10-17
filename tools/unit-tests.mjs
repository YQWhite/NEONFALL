// NEONFALL unit tests — parsers, timing maps, rating, skin, roundtrips.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOsuChart } from '../src/core/osz.ts';
import { parseMc } from '../src/core/mcz.ts';
import { buildTimeMap, buildNFM, readNFM, buildNFSK, readNFSK } from '../src/core/nfm.ts';
import { parseOSK } from '../src/core/osk.ts';
import { computeStars, computePP, computeRating, RATING_WEIGHT } from '../src/core/rating.ts';
import { unzipToMap } from '../src/core/zip.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.resolve(HERE, '..', '..', 'samples');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + (e?.message || e));
  }
}

const oszDir = path.join(SAMPLES, 'osz_mopemope');
const mczFile = path.join(SAMPLES, 'mcz_cure', '1788339919.mc');
const oskDir = path.join(SAMPLES, 'osk_remilia');

console.log('NEONFALL unit tests');

// ---------- osu parsing ----------
const diffs = ['-cute.-.', '-evil.-.', '-Suic!de.-.'];
const oszCharts = {};
for (const d of diffs) {
  const f = path.join(oszDir, `LeaF - Mopemope (eZmmR) [${d}].osu`);
  test(`osz parse [${d}]`, () => {
    assert.ok(existsSync(f), 'sample exists');
    const chart = parseOsuChart(readFileSync(f, 'utf8'));
    oszCharts[d] = chart;
    assert.equal(chart.keys, 4);
    assert.ok(chart.notes.length > 100, 'notes parsed: ' + chart.notes.length);
    assert.ok(chart.timing.length > 0, 'timing points');
    assert.ok(chart.meta.audio === 'assets/audio.mp3');
    assert.ok(chart.notes.every((n) => n.col >= 0 && n.col < 4));
    // notes sorted
    for (let i = 1; i < chart.notes.length; i++) assert.ok(chart.notes[i].t >= chart.notes[i - 1].t);
  });
}

test('osz Suic!de storyboard parsed', () => {
  const c = oszCharts['-Suic!de.-.'];
  assert.ok(c.storyboard, 'has storyboard');
  assert.ok(c.storyboard.objects.length > 2000, 'sprites: ' + c.storyboard.objects.length);
  const count = (cmds) => cmds.reduce((n, x) => n + 1 + count(x.loops ?? []), 0);
  const cmds = c.storyboard.objects.reduce((a, o) => a + count(o.cmds), 0);
  assert.ok(cmds > 6000, 'commands: ' + cmds);
  // spot check: first sprite has MX commands
  const first = c.storyboard.objects[0];
  assert.ok(first.cmds.some((x) => x.k === 'MX'));
});

test('osz holds parsed', () => {
  const c = oszCharts['-evil.-.'];
  const holds = c.notes.filter((n) => n.end !== undefined);
  assert.ok(holds.length > 10, 'holds: ' + holds.length);
  for (const h of holds) assert.ok(h.end > h.t);
});

// ---------- time map ----------
test('time map sv/beat consistency', () => {
  const c = oszCharts['-Suic!de.-.'];
  const tm = buildTimeMap(c.timing, c.sv, c.offset);
  const len = c.meta.lengthMs;
  let prevBeat = -Infinity;
  let prevSv = -Infinity;
  for (let t = 0; t <= len; t += 5000) {
    const b = tm.beatAt(t);
    const sv = tm.svBeatAt(t);
    assert.ok(b >= prevBeat - 1e-6, 'beat monotonic');
    assert.ok(sv >= prevSv - 1e-6, 'svBeat monotonic');
    prevBeat = b;
    prevSv = sv;
    // inverse
    const back = tm.msAtSvBeat(sv);
    assert.ok(Math.abs(back - t) < 1200, `inverse drift ${Math.abs(back - t)}ms at ${t}`);
  }
});

test('SV changes present in cute diff', () => {
  const c = oszCharts['-cute.-.'];
  assert.ok(c.sv.length > 50, 'sv points: ' + c.sv.length);
  // SV values sane
  for (const s of c.sv) assert.ok(s.sv > 0 && s.sv <= 10, 'sv in range: ' + s.sv);
});

// ---------- time map MAGNITUDE (beat math regression guard) ----------
test('time map beat magnitude is exact', () => {
  const tm = buildTimeMap([{ t: 0, bpm: 192 }], [], 0);
  const beatLen = 60000 / 192;
  assert.ok(Math.abs(tm.beatAt(beatLen) - 1) < 0.001, 'beatAt(1 beat) = ' + tm.beatAt(beatLen));
  assert.ok(Math.abs(tm.svBeatAt(beatLen) - 1) < 0.001, 'svBeatAt(1 beat) = ' + tm.svBeatAt(beatLen));
  assert.ok(Math.abs(tm.msAtSvBeat(2) - 2 * beatLen) < 0.01, 'msAtSvBeat(2)');
  assert.ok(Math.abs(tm.msAtBeat(1) - beatLen) < 0.01, 'msAtBeat(1)');
  // with SV
  const tm2 = buildTimeMap([{ t: 0, bpm: 120 }], [{ t: 0, sv: 2 }], 0);
  assert.ok(Math.abs(tm2.svBeatAt(500) - 2) < 0.001, 'svBeatAt 500ms @120bpm sv2 = ' + tm2.svBeatAt(500));
});

// ---------- pre-offset SV must be ignored (Mopemope Suic!de regression) ----------
test('SV points before the first timing point are dropped', () => {
  const c = oszCharts['-Suic!de.-.'];
  for (const s of c.sv) {
    assert.ok(s.t >= c.timing[0].t, 'sv point ' + s.t + ' before offset ' + c.timing[0].t);
  }
  const tm = buildTimeMap(c.timing, c.sv, c.offset);
  // at 5.7s into the chart (200bpm from -22ms), svBeat must be ~19 beats, not ~0.19
  const t = 5700;
  const expected = ((t - c.offset) * 200) / 60000;
  const got = tm.svBeatAt(t);
  assert.ok(Math.abs(got - expected) < 0.5, `svBeatAt(${t}) = ${got.toFixed(2)}, expected ~${expected.toFixed(2)}`);
});

// ---------- malody ----------
let mcChart;
test('mcz parse', () => {
  assert.ok(existsSync(mczFile));
  mcChart = parseMc(readFileSync(mczFile, 'utf8'));
  assert.equal(mcChart.keys, 4);
  assert.ok(mcChart.notes.length > 200, 'notes: ' + mcChart.notes.length);
  // beat 0 is a sound cue, not a note; first playable notes are at beat 29.
  const raw = JSON.parse(readFileSync(mczFile, 'utf8'));
  assert.equal(mcChart.notes.length, 1386);
  assert.equal(mcChart.notes.length, raw.note.filter((n) => Number.isInteger(n.column)).length);
  assert.deepEqual(raw.note.filter((n) => n.sound), [
    { beat: [0, 0, 1], type: 1, sound: '1788339912.ogg', offset: 261 },
  ]);
  const first = mcChart.notes[0];
  assert.equal(first.t, 29 * 60000 / 192 - 261);
  assert.deepEqual(mcChart.notes.filter((n) => n.t === first.t).map((n) => n.col), [0, 2]);
  assert.equal(mcChart.meta.audio, 'assets/1788339912.ogg');
  assert.equal(mcChart.offset, -261);
  const holds = mcChart.notes.filter((n) => n.end);
  assert.ok(holds.length > 20, 'holds: ' + holds.length);
});

// ---------- parser regression fixtures (no renderer/skin API dependencies) ----------
const osuFixture = (points, mode = '3', leadIn = 0) => `osu file format v14
[General]
${mode === null ? '' : 'Mode:' + mode}
AudioFilename:song.ogg
AudioLeadIn:${leadIn}
[Difficulty]
CircleSize:4
[TimingPoints]
${points}
[HitObjects]
64,192,1500,1,0,0:0:0:0:
192,192,2000,128,0,3500:0:0:0:0:
`;

test('osu explicitly rejects mixed/non-mania modes, missing and malformed modes', () => {
  for (const mode of [null, '0', '1', '2', '3junk', '3.5', 'NaN']) {
    assert.throws(() => parseOsuChart(osuFixture('0,500,4,1,0,100,1,0', mode)), /Not an osu!mania/);
  }
  assert.equal(parseOsuChart(osuFixture('0,500,4,1,0,100,1,0')).notes.length, 2);
});

test('osu red lines reset SV and preserve exact same-time source order', () => {
  const c = parseOsuChart(osuFixture([
    '2000,-25,4,1,0,100,0,0', // intentionally unsorted: green before red at 2000
    '0,500,4,1,0,100,1,0',
    '500,-50,4,1,0,100,0,0',
    '1000,400,4,1,0,100,1,0',
    '1000,-80,4,1,0,100,0,0', // red before green at 1000
    '2000,600,4,1,0,100,1,0',
    '2500,-200,4,1,0,100,0,0',
  ].join('\n')));
  assert.deepEqual(c.timing, [{ t: 0, bpm: 120 }, { t: 1000, bpm: 150 }, { t: 2000, bpm: 100 }]);
  assert.deepEqual(c.sv, [
    { t: 0, sv: 1 }, { t: 500, sv: 2 }, { t: 1000, sv: 1 },
    { t: 1000, sv: 1.25 }, { t: 2000, sv: 4 }, { t: 2000, sv: 1 }, { t: 2500, sv: 0.5 },
  ]);
  assert.ok(c.timing.every((p) => Number.isFinite(p.bpm) && p.bpm > 0));
});

test('osu AudioLeadIn is advisory, never moves audio-absolute notes/timing/SV', () => {
  const points = '100,500,4,1,0,100,1,0\n1200,-50,4,1,0,100,0,0';
  const base = parseOsuChart(osuFixture(points));
  const lead = parseOsuChart(osuFixture(points, '3', 7000));
  assert.equal(lead.meta.audioLeadIn, 7000);
  for (const field of ['notes', 'timing', 'sv', 'offset']) assert.deepEqual(lead[field], base[field]);
  assert.equal(lead.notes[0].t, 1500);
  assert.equal(lead.notes[1].end, 3500);
});

const mcFixture = (overrides = {}) => ({
  meta: { mode: 0, mode_ext: { column: 4 }, song: { file: 'legacy.ogg' } },
  time: [{ beat: [0, 0, 1], bpm: 120, delay: 125 }],
  note: [{ beat: [1, 0, 1], column: 0 }],
  ...overrides,
});

test('Malody integrates unsorted BPM sections, fractional beats, holds and SV', () => {
  const c = parseMc(JSON.stringify(mcFixture({
    time: [
      { beat: [8, 0, 1], bpm: 60, delay: 99999 },
      { beat: [0, 0, 1], bpm: 120, delay: 125 },
      { beat: [4, 0, 1], bpm: 240, delay: 0 },
    ],
    note: [
      { beat: [3, 0, 1], endbeat: [9, 0, 1], column: 2 },
      { beat: [4, 1, 2], column: 1 },
      { beat: [8, 0, 1], column: 3 },
    ],
    sub: [{ beat: [5, 0, 1], val: 2 }, { beat: [8, 1, 2], v: 0.5 }],
  })));
  assert.deepEqual(c.timing, [{ t: -125, bpm: 120 }, { t: 1875, bpm: 240 }, { t: 2875, bpm: 60 }]);
  assert.deepEqual(c.notes.map((n) => [n.t, n.col, n.end]), [[1375, 2, 3875], [2000, 1, undefined], [2875, 3, undefined]]);
  assert.deepEqual(c.sv, [{ t: 2125, sv: 2 }, { t: 3375, sv: 0.5 }]);
  assert.equal(c.meta.lengthMs, 3875);
});

test('Malody song cue selects audio and signed offset without phantom notes or double delay', () => {
  for (const offset of [-250, 0, 375]) {
    const c = parseMc(JSON.stringify(mcFixture({ note: [
      { beat: [2, 0, 1], type: 1, sound: 'actual.ogg', offset },
      { beat: [0, 0, 1], type: 0, sound: 'effect.wav', offset: 999 },
      { beat: [3, 0, 1], type: 2, sound: 'key.wav', offset: -999 },
      { beat: [1, 0, 1], type: 0, offset: 10 }, // no column is never a key
      { beat: [2, 0, 1], column: 2, endbeat: [4, 0, 1] },
    ] })));
    assert.equal(c.meta.audio, 'assets/actual.ogg');
    assert.equal(c.offset, -offset - 1000);
    assert.equal(c.notes.length, 1);
    assert.equal(c.notes[0].t, 0 - offset);
    assert.equal(c.notes[0].end, -offset + 1000);
    assert.equal(c.timing[0].t, -offset - 1000);
  }
});

test('Malody song/effect events with stray columns never make phantom keys; keysounds remain playable', () => {
  const c = parseMc(JSON.stringify(mcFixture({ note: [
    { beat: [0,0,1], type: 1, sound: 'song.ogg', offset: 261, column: 0 },
    { beat: [0,0,1], type: 0, sound: 'fx.wav', column: 1 },
    { beat: [1,0,1], type: 2, sound: 'key.wav', column: 2 },
    { beat: [2,0,1], sound: 'key2.wav', column: 3 },
    { beat: [3,0,1], column: -1 },
    { beat: [3,0,1], column: 4 },
  ] })));
  assert.deepEqual(c.notes.map(n => [n.t,n.col]), [[239,2],[739,3]]);
});

test('Malody legacy delay fallback and non-key modes are explicit', () => {
  const base = mcFixture();
  const c = parseMc(JSON.stringify(base));
  assert.equal(c.notes[0].t, 375);
  assert.equal(c.meta.audio, 'assets/legacy.ogg');
  for (const mode of [1, 2, 3, 4, 5, 6, 7, 8, '0']) {
    assert.throws(() => parseMc(JSON.stringify({ ...base, meta: { ...base.meta, mode } })), /Not a Malody key chart/);
  }
  assert.equal(parseMc(JSON.stringify({ ...base, meta: { song: base.meta.song } })).keys, 4);
});

// ---------- rating ----------
test('stars in range & pp monotonic', () => {
  for (const d of diffs) {
    const c = oszCharts[d];
    const st = computeStars(c);
    assert.ok(st.stars >= 0.5 && st.stars <= 13, `stars ${st.stars}`);
    console.log(`    ${d}: ★${st.stars.toFixed(2)} density ${st.density.toFixed(2)} avgChord ${st.avgChord.toFixed(2)} jackRatio ${st.jackRatio.toFixed(3)}`);
  }
  const mst = computeStars(mcChart);
  assert.ok(mst.stars >= 0.5 && mst.stars <= 13);
  console.log(`    mcz: ★${mst.stars.toFixed(2)}`);
  const pp1 = computePP(8, 0.95, 120000);
  const pp2 = computePP(8, 0.99, 120000);
  const pp3 = computePP(10, 0.95, 120000);
  assert.ok(pp2 > pp1, 'acc monotonic');
  assert.ok(pp3 > pp1, 'stars monotonic');
  assert.equal(computeRating([100, 50, 30]), Math.round((100 + 50 * 0.95 + 30 * 0.9025) / RATING_WEIGHT * 100) / 100);
});

// ---------- nfm roundtrip ----------
test('nfm build + read roundtrip (Suic!de)', () => {
  const c = oszCharts['-Suic!de.-.'];
  const assets = { 'assets/audio.mp3': new Uint8Array([1, 2, 3]), 'sb/test.png': new Uint8Array([4, 5, 6]) };
  const zip = buildNFM(c, assets);
  const arc = readNFM(zip);
  assert.equal(arc.chart.notes.length, c.notes.length);
  assert.equal(arc.files.get('assets/audio.mp3')[0], 1);
  assert.ok(arc.chart.storyboard);
});

// ---------- osk skin ----------
test('osk parse (Remilia skin)', () => {
  const oskPath = path.resolve(SAMPLES, '..', '----[Touhou project] .Remilia Scarlet. 2.0 ---- (月浊lpx).osk');
  const files = unzipToMap(readFileSync(oskPath));
  const { skin, assets } = parseOSK(files);
  assert.equal(skin.keys, 4);
  assert.ok(skin.columns.length === 4);
  assert.ok(skin.columns[0].keyImg, 'key image resolved: ' + skin.columns[0].keyImg);
  assert.ok(skin.columns[0].noteImg, 'note image resolved: ' + skin.columns[0].noteImg);
  assert.ok(Object.keys(assets).length > 5, 'assets: ' + Object.keys(assets).length);
  const zip = buildNFSK(skin, assets);
  const back = readNFSK(zip);
  assert.equal(back.skin.name, skin.name);
  assert.ok(back.files.get(skin.columns[0].keyImg), 'key image in package');
  console.log(`    skin "${skin.name}" by ${skin.author || '?'} — ${Object.keys(assets).length} assets, ${(zip.length / 1048576).toFixed(1)}MB .nfsk`);
});

// ---------- zip helpers ----------
test('zip case-insensitive lookup on mcz archive', () => {
  const mczZip = path.resolve(SAMPLES, '..', 'M@GICAL☆CURE!_LOVE_？_SHOT!_.mcz');
  assert.ok(existsSync(mczZip));
  const files = unzipToMap(readFileSync(mczZip));
  // mcz stores audio under a numeric name; case-insensitive lookup of chart file
  const keys = [...files.keys()];
  assert.ok(keys.some((k) => k.toLowerCase().endsWith('.mc')));
  assert.ok(keys.some((k) => k.toLowerCase().endsWith('.ogg')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
