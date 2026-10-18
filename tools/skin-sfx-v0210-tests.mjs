// Source-level skin sound integration; WebAudio is deterministic, no device output.
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/engine/audio.ts';
import { PlaySession } from '../src/engine/play.ts';
import { DEFAULT_SETTINGS, DEFAULT_MODS } from '../src/core/types.ts';
import { parseOSK } from '../src/core/osk.ts';
import { getDefaultSkin, getBuiltinSkin } from '../src/core/default-skin.ts';
import { findCI, strToBytes } from '../src/core/zip.ts';

let tests = 0;
const test = async (name, run) => { await run(); tests++; console.log(`PASS ${name}`); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const decoded = bytes => ({ duration: .1, sample: [...new Uint8Array(bytes)] });

await test('same file name in different skins cannot reuse the first sample', async () => {
  const audio = new AudioEngine(); let count = 0;
  audio.ctx = { decodeAudioData: async bytes => { count++; return decoded(bytes); } };
  const a = new Uint8Array([1, 2]), b = new Uint8Array([8, 9]);
  const first = await audio.decode(a, 'combobreak.ogg');
  const second = await audio.decode(b, 'combobreak.ogg');
  assert.notEqual(first, second); assert.deepEqual(second.sample, [8, 9]); assert.equal(count, 2);
  assert.equal(await audio.decode(a, 'combobreak.ogg'), first); assert.equal(count, 2);
});

await test('the source byte identity shares aliases but not distinct buffer views', async () => {
  const audio = new AudioEngine(); let count = 0;
  audio.ctx = { decodeAudioData: async bytes => { count++; return decoded(bytes); } };
  const container = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const a = container.subarray(1, 3), b = container.subarray(3, 5);
  const first = await audio.decode(a, 'normal-hitnormal.ogg');
  assert.equal(await audio.decode(a, 'skin/normal-hitnormal.ogg'), first);
  assert.deepEqual(first.sample, [1, 2]); assert.equal(count, 1);
  assert.deepEqual((await audio.decode(b, 'normal-hitnormal.ogg')).sample, [3, 4]); assert.equal(count, 2);
});

await test('concurrent preload and playback decode a source only once', async () => {
  const audio = new AudioEngine(), ready = deferred(); let count = 0;
  audio.ctx = { decodeAudioData: () => { count++; return ready.promise; } };
  const sample = new Uint8Array([1]);
  const preload = audio.decode(sample, 'combobreak.ogg');
  const playback = audio.decode(sample, 'combobreak.ogg');
  assert.equal(count, 1); ready.resolve({ duration: 1 });
  assert.equal(await preload, await playback); assert.equal(audio.pendingDecodes.size, 0);
});

await test('out-of-order skin decodes cannot overwrite another skin sample', async () => {
  const audio = new AudioEngine(), first = deferred(), second = deferred();
  audio.ctx = { decodeAudioData: bytes => new Uint8Array(bytes)[0] === 1 ? first.promise : second.promise };
  const a = new Uint8Array([1]), b = new Uint8Array([2]);
  const oldLoad = audio.decode(a, 'combobreak.ogg'), newLoad = audio.decode(b, 'combobreak.ogg');
  const newBuffer = { sample: 2 }, oldBuffer = { sample: 1 };
  second.resolve(newBuffer); assert.equal(await newLoad, newBuffer);
  first.resolve(oldBuffer); assert.equal(await oldLoad, oldBuffer);
  assert.equal(await audio.decode(b, 'combobreak.ogg'), newBuffer);
});

await test('failed decode and its retry are shared and do not poison later retries', async () => {
  const audio = new AudioEngine(); let count = 0, fail = true;
  audio.ctx = { decodeAudioData: async bytes => { count++; if (fail) throw new Error('invalid sample'); return decoded(bytes); } };
  const sample = new Uint8Array([1]);
  const results = await Promise.allSettled([audio.decode(sample, 'bad.wav'), audio.decode(sample, 'bad.wav')]);
  assert.ok(results.every(result => result.status === 'rejected')); assert.equal(count, 2);
  assert.equal(audio.pendingDecodes.size, 0); assert.equal(audio.decodeCache.size, 0);
  fail = false; assert.deepEqual((await audio.decode(sample, 'bad.wav')).sample, [1]); assert.equal(count, 3);
});

await test('decoded sample cache stays bounded and keeps recently used miss sounds', async () => {
  const audio = new AudioEngine(); let count = 0;
  audio.ctx = { decodeAudioData: async bytes => { count++; return decoded(bytes); } };
  const sources = Array.from({ length: 25 }, (_, i) => new Uint8Array([i]));
  for (const bytes of sources.slice(0, 24)) await audio.decode(bytes, 'sample');
  const first = await audio.decode(sources[0], 'sample');
  await audio.decode(sources[24], 'sample'); assert.equal(audio.decodeCache.size, 24);
  assert.equal(await audio.decode(sources[0], 'sample'), first); assert.equal(count, 25);
  await audio.decode(sources[1], 'sample'); assert.equal(count, 26); assert.equal(audio.decodeCache.size, 24);
});

await test('skin sounds use the live effects bus and reuse prepared audio', async () => {
  const gains = [], played = []; let decodes = 0;
  class Context {
    state = 'running'; currentTime = 1; destination = {};
    async decodeAudioData(bytes) { decodes++; return decoded(bytes); }
    createGain() { const node = { gain: { value: 1 }, connect(to) { this.to = to; } }; gains.push(node); return node; }
    createBufferSource() { return { connect(to) { this.to = to; }, start() { played.push(this); } }; }
  }
  globalThis.window = { AudioContext: Context };
  const audio = new AudioEngine(), source = new Uint8Array([4]);
  audio.applySettings({ ...DEFAULT_SETTINGS, sfxVolume: .3 });
  await audio.decode(source, 'combobreak.ogg');
  await audio.playFileOnce(source, 'combobreak.ogg', { vol: .7 });
  assert.equal(decodes, 1); assert.equal(played[0].to.gain.value, .7);
  assert.equal(played[0].to.to, audio.sfxGain); assert.equal(audio.sfxGain.gain.value, .3);
  audio.applySettings({ ...DEFAULT_SETTINGS, sfxVolume: 0 });
  await audio.playFileOnce(source, 'combobreak.ogg', { vol: .7 });
  assert.equal(played[1].to.to.gain.value, 0); assert.equal(decodes, 1);
});

await test('OSK keeps the supplied combo break file across Mania layouts', () => {
  const sample = new Uint8Array([7, 8]);
  const parsed = parseOSK(new Map([
    ['skin.ini', strToBytes('[Mania]\nKeys:4\n[Mania]\nKeys:7')],
    ['ComboBreak.WAV', sample],
  ]));
  assert.equal(parsed.skin.misc.combobreak, 'ComboBreak.WAV');
  assert.equal(parsed.skin.variants['7'].misc.combobreak, 'ComboBreak.WAV');
  assert.equal(parsed.assets['ComboBreak.WAV'], sample);
});

const osu = getDefaultSkin(), malody = getBuiltinSkin('builtin:malody');
const missPath = osu.skin.misc.combobreak, missBytes = findCI(osu.files, missPath);
assert.equal(missPath, 'combobreak.ogg'); assert.equal(missBytes.length, 7936);
const makeSession = (notes, skin = osu.skin, files = osu.files) => {
  let now = 0, down = false;
  const sounds = [], synth = [];
  const chart = { format: 'neonfall-chart', version: 1, keys: 4, od: 8, offset: 0,
    meta: { lengthMs: 5000 }, notes, timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [] };
  const audio = { songTimeMs: () => now,
    playFileOnce(bytes, path, options) { sounds.push({ bytes, path, options }); },
    playSynth(...args) { synth.push(args); }, pauseMusic() {}, stopMusic() {}, stopPreview() {}, playMusic() {} };
  const session = new PlaySession(chart, {}, { skin, getAsset: p => findCI(files, p) },
    { ...DEFAULT_MODS, noFail: true }, { ...DEFAULT_SETTINGS, particles: false }, audio);
  session.phase = 'playing'; session.input.isDown = () => down;
  return { session, sounds, synth,
    time(t) { now = t; session.update(16, t); },
    press(t) { now = t; down = true; session.press(0, t); },
    release(t) { now = t; down = false; session.release(0, t); } };
};

await test('natural missed taps use the actual example skin sound each time', () => {
  const run = makeSession([{ t: 1000, col: 0 }, { t: 2000, col: 0 }]);
  run.time(1300); assert.equal(run.session.counts.miss, 1); assert.equal(run.sounds.length, 1);
  assert.equal(run.sounds[0].bytes, missBytes); assert.equal(run.sounds[0].path, missPath);
  assert.equal(run.synth.length, 0);
  run.time(1400); assert.equal(run.sounds.length, 1);
  run.time(2300); assert.equal(run.sounds.length, 2); assert.equal(run.session.counts.miss, 2);
});

await test('early hold release and late tail each use the skin miss sound once', () => {
  for (const late of [false, true]) {
    const run = makeSession([{ t: 1000, col: 0, end: 2000 }]); run.press(1000);
    if (late) run.time(2300); else run.release(1500);
    const missSounds = run.sounds.filter(sound => sound.path === missPath);
    assert.equal(run.session.counts.miss, 1); assert.equal(missSounds.length, 1);
    assert.equal(missSounds[0].bytes, missBytes);
    run.time(2500); assert.equal(run.sounds.filter(sound => sound.path === missPath).length, 1);
  }
});

await test('fully missed hold keeps two judgments without stacking duplicate sounds', () => {
  const run = makeSession([{ t: 1000, col: 0, end: 2000 }]); run.time(1300);
  assert.equal(run.session.counts.miss, 2); assert.equal(run.sounds.length, 1);
});

await test('a missed chord in one update plays one skin break without losing judgments', () => {
  const run = makeSession([{ t: 1000, col: 0 }, { t: 1000, col: 1 }, { t: 1000, col: 2 }]); run.time(1300);
  assert.equal(run.session.counts.miss, 3); assert.equal(run.sounds.length, 1);
});

await test('the Malody example has no supplied audio and retains the fallback sound', () => {
  assert.equal(malody.skin.misc?.combobreak, undefined);
  assert.equal([...malody.files.keys()].filter(p => /\.(ogg|wav|mp3|flac)$/i.test(p)).length, 0);
  const run = makeSession([{ t: 1000, col: 0 }], malody.skin, malody.files); run.time(1300);
  assert.equal(run.sounds.length, 0); assert.equal(run.synth.length, 1);
});

console.log(`PASS ${tests} skin sound cases: source isolation, concurrent decode, bounded cache, volume bus, and supplied miss samples`);
