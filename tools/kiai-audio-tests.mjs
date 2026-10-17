import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AudioEngine } from '../src/engine/audio.ts';

const output = path.resolve('test-results/kiai'); fs.mkdirSync(output, { recursive: true });
const sampleRate = 12000;
function pcmBuffer(duration, fn, channels = 1) {
  const arrays = Array.from({ length: channels }, (_, channel) => {
    const data = new Float32Array(duration * sampleRate);
    for (let i = 0; i < data.length; i++) data[i] = fn(i / sampleRate, channel, i);
    return data;
  });
  let reads = 0;
  return { duration, sampleRate, length: arrays[0].length, numberOfChannels: channels,
    getChannelData(channel) { reads++; return arrays[channel]; }, get reads() { return reads; } };
}
const tone = (frequency, time) => Math.sin(2 * Math.PI * frequency * time);
const audio = new AudioEngine();
assert.equal(audio.previewHighlightMs(), 0);
const contrast = pcmBuffer(100, time => time >= 10 && time < 40 ? .95 * tone(100, time) : time >= 55 && time < 85 ? .25 * tone(4000, time) : 0);
audio.previewBuffer = contrast;
const highStart = audio.previewHighlightMs();
assert.ok(Math.abs(highStart - 55000) <= 300, `high-frequency section should beat louder low-frequency section: ${highStart}`);
assert.equal(contrast.reads, 1);
for (let i = 0; i < 100; i++) assert.equal(audio.previewHighlightMs(), highStart);
assert.equal(contrast.reads, 1, 'repeated menu queries reuse per-buffer analysis');
assert.equal(audio.ctx, null, 'PCM analysis never creates an AudioContext');

const antiphase = pcmBuffer(90, (time, channel) => time >= 45 && time < 75 ? (channel ? -1 : 1) * .3 * tone(3500, time) : .08 * tone(120, time), 2);
audio.previewBuffer = antiphase;
assert.ok(Math.abs(audio.previewHighlightMs() - 45000) <= 300, 'opposite-phase stereo retains high-frequency energy');
assert.equal(antiphase.reads, 2);
audio.previewBuffer = contrast;
assert.equal(audio.previewHighlightMs(), highStart); assert.equal(contrast.reads, 1, 'cache survives switching away and back to decoded buffer');

const ending = pcmBuffer(70, time => time >= 50 ? .4 * tone(3000, time) : 0);
audio.previewBuffer = ending;
assert.equal(audio.previewHighlightMs(), 40000, 'a late peak chooses the last valid full 30-second span');
const beginning = pcmBuffer(70, time => time < 30 ? .4 * tone(3000, time) : 0);
audio.previewBuffer = beginning; assert.equal(audio.previewHighlightMs(), 0);
console.log('PASS high-frequency emphasis, strongest 30-second span, antiphase stereo, boundary spans and per-buffer cache');

for (const buffer of [
  { duration: 10, length: 120000, numberOfChannels: 1, getChannelData() { throw Error('short tracks need no scan'); } },
  { duration: 30, length: 360000, numberOfChannels: 1, getChannelData() { throw Error('exact 30 seconds need no scan'); } },
  { duration: 90 }, { duration: NaN, length: 20, numberOfChannels: 1 },
  { duration: 90, length: 1, numberOfChannels: 1 },
  pcmBuffer(60, () => 0), pcmBuffer(60, (_time, _channel, i) => i % 2 ? NaN : Infinity),
]) {
  audio.previewBuffer = buffer;
  assert.equal(audio.previewHighlightMs(), 0, 'short/silent/missing/non-finite PCM falls back to start');
}
console.log('PASS silence, short songs, unavailable mocks, invalid PCM and finite zero fallback');

// Virtual long PCM exposes every numerical read without allocating hours of
// audio. Bounded sparse *adjacent* reads must still locate a short loud section.
const duration = 7200, longRate = 48000, frameCount = duration * longRate;
let numericalReads = 0, channelsRead = 0;
const virtualPcm = new Proxy({ length: frameCount }, {
  get(target, key) {
    if (key === 'length') return target.length;
    const index = Number(key);
    if (!Number.isInteger(index)) return undefined;
    numericalReads++; assert.ok(index >= 0 && index < frameCount, 'never access outside PCM');
    const time = index / longRate;
    return time >= 4400 && time < 4430 ? .5 * tone(9000, time) : .01 * tone(120, time);
  },
});
const longBuffer = { duration, sampleRate: longRate, length: frameCount, numberOfChannels: 8,
  getChannelData() { channelsRead++; return virtualPcm; } };
audio.previewBuffer = longBuffer;
const source = { testSource: true }, previewGain = { testGain: true };
audio.previewSrc = source; audio.previewGain = previewGain; audio.previewOffset = 17; audio.previewPaused = true;
const longStart = audio.previewHighlightMs();
assert.ok(longStart >= 4398000 && longStart <= 4402000, `bounded long-track analysis finds high-energy section: ${longStart}`);
assert.ok(longStart >= 0 && longStart + 30000 <= duration * 1000);
assert.equal(channelsRead, 2, 'scan at most two independent channels');
assert.ok(numericalReads <= 262144, `at most 131072 adjacent pairs, got ${numericalReads} reads`);
const readsBefore = numericalReads;
assert.equal(audio.previewHighlightMs(), longStart); assert.equal(numericalReads, readsBefore, 'cached queries scan zero PCM samples');
assert.equal(audio.previewSrc, source); assert.equal(audio.previewGain, previewGain);
assert.equal(audio.previewOffset, 17); assert.equal(audio.previewPaused, true); assert.equal(audio.ctx, null);
console.log('PASS two-hour/multichannel bounded PCM work, valid time range, cache and unchanged playback source/clock/pause');
fs.writeFileSync(path.join(output, 'audio-tests.json'), JSON.stringify({ ok: true, highStart, longStart, numericalReads, channelsRead, checked: ['high-frequency-emphasis', 'stereo-antiphase', '30-second-window', 'short-silent-invalid', 'bounded-work', 'weak-cache', 'no-playback-mutation'] }, null, 2));
