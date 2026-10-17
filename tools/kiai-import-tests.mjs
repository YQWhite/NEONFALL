import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseOsuChart } from '../src/core/osz.ts';
import { parseMc } from '../src/core/mcz.ts';
import { importChartArchive } from '../src/core/import.ts';
import { buildNFM, readNFM } from '../src/core/nfm.ts';
import { zipFromMap, strToBytes } from '../src/core/zip.ts';

let assertions = 0;
const check = (condition, message) => { assertions++; assert.ok(condition, message); };
const eq = (a, b, message) => { assertions++; assert.deepEqual(a, b, message); };
const point = (t, beatLength, inherited = false, effects = 0) => `${t},${beatLength},4,1,0,100,${inherited ? 0 : 1},${effects}`;
function osu(points, preview, hitObjects = ['64,192,1000,1,0,0:0:0:0:', '192,192,6000,128,0,7000:0:0:0:0:']) {
  return `osu file format v14\n[General]\nAudioFilename: audio.wav\nMode: 3\n${preview === undefined ? '' : `PreviewTime: ${preview}\n`}[Metadata]\nTitle: Kiai test\nArtist: Test\nCreator: Test\nVersion: 4K\n[Difficulty]\nCircleSize: 4\nOverallDifficulty: 8\n[TimingPoints]\n${points.join('\n')}\n[HitObjects]\n${hitObjects.join('\n')}\n`;
}
const switches = [point(0, 500), point(1000, 500, false, 1), point(1500, -50, true, 1), point(2000, -100, true, 9),
  point(2500, -100, true, 8), point(3000, -100, true, 1), '4000,-100,4,1,0,100,0', point(4500, 300, false, 1)];
const expected = [{ t: 1000, end: 2500 }, { t: 3000, end: 4000 }, { t: 4500, end: 7000 }];
const chart = parseOsuChart(osu(switches, 0));
eq(chart.kiai, expected, 'Red/green kiai points, repeated on state and open final interval survive conversion');
eq(chart.meta.previewTime, 0, 'osu PreviewTime=0 remains valid'); eq(chart.meta.previewSource, 'authored', 'Zero preview is authored');
check(chart.sv.some(p => p.t === 1500 && p.sv === 2), 'Kiai parsing preserves inherited velocity');
check(chart.timing.some(p => p.t === 4500 && p.bpm === 200), 'Kiai parsing preserves BPM');

const cases = [
  { points: [point(0, 500), point(1000, -100, true, 8), point(2000, -100, true, 2)], expected: undefined, label: 'Barline bit 3 and unused bit 1 cannot enable kiai' },
  { points: [point(0, 500), point(1000, -100, true, 1), point(1000, -100, true, 0), point(2000, -100, true, 1), point(2500, -100, true, 0), point(2500, -100, true, 1), point(3000, -100, true, 0)], expected: [{ t: 2000, end: 3000 }], label: 'Last state at equal timestamps wins without empty ranges or artificial gaps' },
  { points: [point(4000, -100, true, 0), point(0, 500), point(3000, -100, true, 1), point(1000, -100, true, 1), point(2000, -100, true, 0)], expected: [{ t: 1000, end: 2000 }, { t: 3000, end: 4000 }], label: 'Unordered timing input becomes chronological non-overlapping ranges' },
  { points: [point(-500, 500, false, 1), point(0, -100, true, 1), point(100, -100, true, 0)], expected: [{ t: -500, end: 100 }], label: 'Negative authored intro time remains on the audio-file clock' },
  { points: [point(0, 500), point(1000.5, -100, true, 1), point(2000.75, -100, true, 0)], expected: [{ t: 1000.5, end: 2000.75 }], label: 'Fractional timing-point milliseconds remain exact' },
  { points: [point(0, 500), point('Infinity', -100, true, 1), point('NaN', -100, true, 1), point(1000, -100, true, 'Infinity'), point(2000, -100, true, -1), point(3000, -100, true, 1.5)], expected: undefined, label: 'Non-finite timestamps and invalid effect flags cannot create kiai' },
  { points: [point(0, 500), point(1000, 'NaN', true, 1), point(2000, 'NaN', true, 0)], expected: [{ t: 1000, end: 2000 }], label: 'Effect state does not depend on a usable SV beat length' },
  { points: [point(0, 500), point(8000, -100, true, 1)], expected: undefined, label: 'Unclosed kiai after known chart end does not fabricate an infinite range' },
  { points: [point(0, 500), point(8000, -100, true, 1), point(9000, -100, true, 0)], expected: [{ t: 8000, end: 9000 }], label: 'Explicit authored off time survives beyond final note for audio outro' },
];
for (const test of cases) {
  const result = parseOsuChart(osu(test.points, -1)); eq(result.kiai, test.expected, test.label);
  let end = -Infinity;
  for (const interval of result.kiai ?? []) { check(Number.isFinite(interval.t) && Number.isFinite(interval.end) && interval.t < interval.end && interval.t >= end, 'Every kiai interval is finite, positive length and ordered'); end = interval.end; }
}
const badNote = parseOsuChart(osu([point(0, 500, false, 1)], -1, ['64,192,Infinity,1,0,0:0:0:0:', '192,192,6000,128,0,7000:0:0:0:0:']));
eq(badNote.kiai, [{ t: 0, end: 7000 }], 'Malformed infinite notes cannot poison the finite terminal range');

for (const preview of [undefined, -1, 'NaN', 'Infinity', 0, 1234, 1234.5]) {
  const result = parseOsuChart(osu([point(0, 500)], preview)), authored = typeof preview === 'number' && preview >= 0;
  eq(result.meta.previewSource, authored ? 'authored' : 'generated', 'osu preview source is explicit');
  eq(result.meta.previewTime, authored ? preview : -1, 'Only finite nonnegative osu previews are preserved');
}

function mc(preview, extra = {}) {
  return { meta: { mode: 0, mode_ext: { column: 4 }, creator: 'Test', version: '4K', ...(preview === undefined ? {} : { preview }), song: { title: 'MC preview test', artist: 'Test' } },
    time: [{ beat: [0, 0, 1], bpm: 120 }], sub: [{ beat: [4, 0, 1], val: 2 }],
    note: [{ beat: [0, 0, 1], sound: 'audio.wav', type: 1, offset: 125 }, { beat: [4, 0, 1], column: 0 }, { beat: [32, 0, 1], column: 1 }, { beat: [64, 0, 1], column: 2 }], ...extra };
}
for (const preview of [undefined, -1, null, '6128', 0, 6128]) {
  const result = parseMc(JSON.stringify(mc(preview))), authored = typeof preview === 'number' && preview >= 0;
  eq(result.meta.previewSource, authored ? 'authored' : 'generated', 'Malody verifies numeric meta.preview and marks generated fallback');
  if (authored) eq(result.meta.previewTime, preview, 'Malody authored preview, including zero, is not shifted by the audio cue');
  else check(result.meta.previewTime >= 0, 'Missing Malody preview keeps a bounded generated playback hint');
  eq(result.kiai, undefined, 'Ordinary MC chart does not invent kiai from BPM/SV or audio effects');
}
const invented = parseMc(JSON.stringify(mc(undefined, { kiai: [{ t: 1000, end: 5000 }], effect: [{ beat: [4, 0, 1], type: 'kiai', value: 1 }] })));
eq(invented.kiai, undefined, 'Unverified MC extension keys are not misrepresented as authored kiai');
eq(invented.meta.previewSource, 'generated', 'Unverified effects still permit the documented audio-analysis fallback');

const fakeAudio = new Uint8Array([1, 2, 3, 4]);
for (const preview of [0, 6128, -1, undefined]) {
  const packed = zipFromMap({ 'test.osu': strToBytes(osu(switches, preview)), 'audio.wav': fakeAudio });
  const [imported] = importChartArchive('kiai.osz', packed), roundtrip = readNFM(imported.nfm).chart;
  eq(imported.chart.kiai, expected, 'Full OSZ import retains authored ranges'); eq(roundtrip.kiai, expected, 'NFM JSON roundtrip retains kiai');
  eq(roundtrip.meta.previewSource, typeof preview === 'number' && preview >= 0 ? 'authored' : 'generated', 'Full OSZ import does not lose preview provenance');
  if (preview === 0 || preview === 6128) eq(roundtrip.meta.previewTime, preview, 'Finalization preserves authored zero/nonzero preview');
  else check(roundtrip.meta.previewTime >= 0, 'Finalization creates a usable hint and marks it generated');
}
for (const preview of [0, 6128, undefined]) {
  const packed = zipFromMap({ 'test.mc': strToBytes(JSON.stringify(mc(preview))), 'audio.wav': fakeAudio });
  const [imported] = importChartArchive('preview.mcz', packed), roundtrip = readNFM(imported.nfm).chart;
  eq(roundtrip.meta.previewSource, preview === undefined ? 'generated' : 'authored', 'MCZ import retains verified preview provenance');
  if (preview !== undefined) eq(roundtrip.meta.previewTime, preview, 'MCZ conversion preserves native preview');
  eq(roundtrip.kiai, undefined, 'MCZ conversion leaves unverified kiai absent');
}
const legacy = structuredClone(chart); delete legacy.meta.previewSource; delete legacy.kiai;
const decodedLegacy = readNFM(buildNFM(legacy, { 'assets/audio.wav': fakeAudio })).chart;
eq(decodedLegacy.meta.previewTime, 0, 'Legacy NFM preview zero remains intact');
eq(decodedLegacy.meta.previewSource, undefined, 'Reading legacy NFM does not relabel its preview as generated');
eq(decodedLegacy.kiai, undefined, 'Legacy NFM lacking markers stays valid');

fs.mkdirSync(new URL('../test-results/kiai/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../test-results/kiai/import-results.json', import.meta.url), JSON.stringify({ assertions, kiai: expected,
  tested: ['red/green effects bit 0', 'other bits', 'same-time order', 'unordered input', 'negative/fractional time', 'finite fallback', 'authored preview zero', 'verified MC meta.preview', 'unknown MC effects ignored', 'OSZ/MCZ archive conversion', 'NFM roundtrip/legacy compatibility'] }, null, 2));
console.log(`PASS kiai import: ${assertions} checks; authored osu intervals, native MC preview, generated provenance, finite ranges and NFM roundtrip`);
