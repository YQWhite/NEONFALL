import assert from 'node:assert/strict';
import { PlaySession } from '../src/engine/play.ts';
import { AudioEngine } from '../src/engine/audio.ts';
import { parseStoryboard } from '../src/core/osz.ts';
import { DEFAULT_MODS, DEFAULT_SETTINGS } from '../src/core/types.ts';

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} !== ${expected}`);
const storyboard = (start, end, path = 'scene.png') => ({
  objects: parseStoryboard([`Sprite,Background,Centre,"${path}",320,240`, ` F,0,${start},${end},1`]),
});

function session({ sb, first = 10000, length = 15000, settings = {}, bg, getAsset = () => undefined } = {}) {
  let now = 0;
  const starts = [];
  const audio = {
    songTimeMs: () => now,
    playMusic(sec) { starts.push(sec); now = sec * 1000; },
    playSynth() {}, pauseMusic() {}, resumeMusic() {}, stopMusic() {}, stopPreview() {},
  };
  const chart = {
    format: 'neonfall-chart', version: 1, keys: 4, od: 8, offset: 0,
    notes: [{ t: first, col: 0 }], meta: { lengthMs: length, bg },
    timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [], storyboard: sb,
  };
  const player = new PlaySession(chart, {}, { skin: null, getAsset },
    { ...DEFAULT_MODS, auto: true, noFail: true },
    { ...DEFAULT_SETTINGS, audioOffset: 0, particles: false, ...settings }, audio);
  return { player, starts, at(t) { now = t + player.settings.audioOffset; player.update(16, t); } };
}

// Every intro now plays until the player explicitly requests a skip.
let x = session();
x.player.beginPlay();
assert.equal(x.player.initialTime(), 0);
assert.deepEqual(x.starts, [0]);
assert.equal(x.player.introSkipped, false);
assert.equal(x.player.canSkipIntro(), true);
x = session({ sb: storyboard(0, 12000) });
x.player.beginPlay();
assert.equal(x.player.initialTime(), 0);
assert.deepEqual(x.starts, [0]);
assert.equal(x.player.introSkipped, false);
x = session({ sb: storyboard(3000, 12000) });
assert.equal(x.player.initialTime(), 0, 'positive-time storyboard must retain the opening silence');

// Negative-time scenes and calibration offsets share one chart clock on retry.
x = session({ sb: storyboard(-2000, 12000), settings: { audioOffset: 75 } });
x.player.beginPlay();
assert.equal(x.player.initialTime(), -2000);
near(x.starts[0], -1.925, 'negative intro audio position');
near(x.player.chartTime(), -2000, 'negative intro chart position');
x.at(10000);
assert.equal(x.player.counts.perfect, 1);
x.player.retry();
assert.equal(x.player.phase, 'playing');
assert.equal(x.player.counts.perfect, 0);
near(x.starts[1], -1.925, 'retry audio position');
near(x.player.chartTime(), -2000, 'retry chart position');

// Disabling storyboard also retains the complete intro.
for (const options of [
  { sb: storyboard(-2000, 12000), settings: { sbEnabled: false } },
  { sb: { objects: [] } },
]) {
  x = session(options);
  assert.equal(x.player.initialTime(), 0);
}

// Scoring completion must wait for visible outro events, including their last frame.
x = session({ sb: storyboard(0, 8000), first: 1000, length: 5000 });
x.player.beginPlay();
x.at(6501);
assert.equal(x.player.phase, 'playing', 'outro must survive chart length + finish grace');
assert.equal(x.player.counts.perfect, 1);
x.at(8000);
assert.equal(x.player.phase, 'playing', 'last storyboard frame must remain drawable');
x.at(8001);
assert.equal(x.player.phase, 'finished');
assert.equal(x.player.finishPending, true);
x = session({ first: 1000, length: 5000 });
x.player.beginPlay();
x.at(6501);
assert.equal(x.player.phase, 'finished', 'charts without storyboard retain normal completion');
console.log('PASS session storyboard intro / audio offset / retry / disabled fallback / outro completion');

// The ordinary static background must not show through a faded scripted copy.
const previousImage = globalThis.Image;
const imageUrls = [];
try {
  globalThis.Image = class { set src(url) { imageUrls.push(url); } };
  const background = 'assets/Art/Background.PNG';
  const getAsset = () => new Uint8Array([137, 80, 78, 71]);
  x = session({ sb: storyboard(0, 12000, 'sb/art\\background.png'), bg: background, getAsset });
  assert.equal(x.player.bgImage, null, 'scripted matching background replaces static background');
  assert.equal(imageUrls.length, 0);
  x = session({ sb: storyboard(0, 12000, 'sb/elsewhere/background.png'), bg: background, getAsset });
  assert.ok(x.player.bgImage, 'different directories must not be matched by basename alone');
  x = session({ sb: storyboard(0, 12000, 'sb/art/background.png'), bg: background, getAsset, settings: { sbEnabled: false } });
  assert.equal(x.player.sb, null);
  assert.ok(x.player.bgImage, 'disabling storyboard restores static background');
} finally {
  imageUrls.forEach(url => URL.revokeObjectURL(url));
  if (previousImage === undefined) delete globalThis.Image;
  else globalThis.Image = previousImage;
}
console.log('PASS scripted background replacement / path identity / disabled background restoration');

// Test AudioEngine scheduling through its public methods with a simulated WebAudio clock.
const sources = [];
const context = {
  currentTime: 10, state: 'running',
  createBufferSource() {
    const source = {
      connect() {}, disconnect() {},
      start(when, offset) { this.when = when; this.offset = offset; },
      stop() { this.stopped = true; },
    };
    sources.push(source);
    return source;
  },
};
const audio = new AudioEngine();
audio.ctx = context;
audio.musicGain = {};
audio.decode = async () => ({ duration: 60 });
await audio.loadMusic(new Uint8Array(), 'test-song');
audio.playMusic(-2);
near(sources.at(-1).when, 12.03, 'negative intro scheduled audio start');
assert.equal(sources.at(-1).offset, 0, 'WebAudio offset must never be negative');
context.currentTime = 10.03;
near(audio.songTimeMs(), -2000, 'silent intro clock start');
context.currentTime = 11.03;
near(audio.songTimeMs(), -1000, 'silent intro clock progression');
audio.pauseMusic();
assert.equal(sources[0].stopped, true, 'pause cancels future scheduled audio');
context.currentTime = 20;
near(audio.songTimeMs(), -1000, 'silent intro pause');
audio.resumeMusic();
near(sources.at(-1).when, 21.03, 'resume schedules remaining silence');
assert.equal(sources.at(-1).offset, 0);
context.currentTime = 21.03;
near(audio.songTimeMs(), 0, 'music starts at audio zero');
context.currentTime = 25;
audio.seekMusic(-0.5);
near(sources.at(-1).when, 25.53, 'negative seek start');
assert.equal(sources.at(-1).offset, 0);
audio.seekMusic(1.25);
near(sources.at(-1).when, 25.03, 'positive seek start');
assert.equal(sources.at(-1).offset, 1.25);
context.currentTime = 25.03;
near(audio.songTimeMs(), 1250, 'positive seek clock');
audio.stopMusic();
assert.equal(audio.songTimeMs(), 0);
audio.seekMusic(-1.5);
assert.equal(audio.songTimeMs(), -1500, 'paused seek retains negative time');
audio.resumeMusic();
near(sources.at(-1).when, 26.56, 'resume after paused negative seek');
audio.stopMusic();
console.log('PASS negative-time WebAudio schedule / clock / pause / resume / seek / stop');
