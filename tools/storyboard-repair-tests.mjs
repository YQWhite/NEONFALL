import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { readNFM } from '../src/core/nfm.ts';
import { repairBundledStoryboard } from '../src/core/storyboard-repair.ts';
import { evaluateStoryboardObject } from '../src/core/storyboard.ts';
import { DEFAULT_MODS, DEFAULT_SETTINGS } from '../src/core/types.ts';

const oldDir = new URL('../test-results/menu-refresh-final/user-data/charts/', import.meta.url);
const currentDir = new URL('../../samples-converted/', import.meta.url);
const bundledName = fs.readdirSync(currentDir).find(name => name.includes('Suic!de') && name.endsWith('.nfm'));
assert.ok(bundledName, 'Mopemope bundled fixture is required');
const oldPath = new URL(bundledName, oldDir);
const currentPath = new URL(bundledName, currentDir);
const oldBytes = fs.readFileSync(oldPath);
const currentBytes = fs.readFileSync(currentPath);
const oldArchive = readNFM(oldBytes);
const currentArchive = readNFM(currentBytes);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const storyboardHash = archive => sha256(JSON.stringify(archive.chart.storyboard));
const oldHash = '60f82fb0217b5d5601b244bc7fbcf7ba8ca469acd4bfd7cc8829468a36ea293a';
const currentHash = '8261992a8b10b7804bf1ab67af520552feb534bd0c7b3b914028e8878fa1e7f5';
assert.equal(storyboardHash(oldArchive), oldHash, 'fixture must retain the old missing-command defect');
assert.equal(storyboardHash(currentArchive), currentHash, 'candidate must be the verified conversion');
assert.equal(oldArchive.chart.meta.previewSource, undefined, 'legacy fixture predates preview provenance');
assert.equal(currentArchive.chart.meta.previewSource, 'authored', 'new reference retains authored preview provenance');

// Real scripted notes at this timestamp occupy all four columns. The damaged
// conversion dropped constant MX commands, leaving many notes at default x=320.
const noteStates = archive => archive.chart.storyboard.objects
  .filter(object => /\/[ABCX][12]\.png$/i.test(object.path))
  .map(object => evaluateStoryboardObject(object, 73554))
  .filter(state => state.visible);
const columns = archive => [...new Set(noteStates(archive).map(state => Math.round(state.x)))].sort((a, b) => a - b);
assert.ok(noteStates(oldArchive).filter(state => state.x === 320).length > 8, 'old fixture must reproduce stacked notes');
assert.deepEqual(columns(currentArchive), [190, 254, 318, 382]);

const originalJson = JSON.stringify(oldArchive.chart);
const candidateJson = JSON.stringify(currentArchive.chart);
let reads = [];
const repaired = await repairBundledStoryboard(oldArchive, async name => {
  reads.push(name);
  return currentArchive;
});
assert.deepEqual(reads, [bundledName]);
assert.equal(storyboardHash(repaired), currentHash);
assert.deepEqual(columns(repaired), [190, 254, 318, 382], 'legacy archive must regain four scripted note columns');
assert.equal(JSON.stringify(oldArchive.chart), originalJson, 'repair must not mutate the original chart');
assert.equal(JSON.stringify(currentArchive.chart), candidateJson, 'repair must not mutate its candidate');
const { storyboard: oldStoryboard, ...oldGameplay } = oldArchive.chart;
const { storyboard: repairedStoryboard, ...repairedGameplay } = repaired.chart;
assert.deepEqual(repairedGameplay, oldGameplay, 'only storyboard data may change');
assert.deepEqual(repaired.files, oldArchive.files, 'all original file entries and bytes must remain intact');

// Existing IDs, displayed difficulty and score-bearing gameplay must survive
// even when they differ from the freshly converted bundled archive.
const personalized = structuredClone(oldArchive);
personalized.chart.id = 'existing-chart-id';
personalized.chart.stars = 7.58;
const personalizedRepair = await repairBundledStoryboard(personalized, async () => currentArchive);
assert.equal(personalizedRepair.chart.id, 'existing-chart-id');
assert.equal(personalizedRepair.chart.stars, 7.58);
assert.deepEqual(personalizedRepair.chart.notes, personalized.chart.notes);
assert.equal(storyboardHash(personalizedRepair), currentHash);

const mustNotLoad = async () => assert.fail('an unrelated or healthy archive must not load a replacement');
assert.strictEqual(await repairBundledStoryboard(currentArchive, mustNotLoad), currentArchive);
const edited = structuredClone(oldArchive);
edited.chart.storyboard.objects[0].x += 1;
assert.strictEqual(await repairBundledStoryboard(edited, mustNotLoad), edited, 'manual storyboard edits are not a known damaged conversion');
const withoutStoryboard = structuredClone(oldArchive);
delete withoutStoryboard.chart.storyboard;
assert.strictEqual(await repairBundledStoryboard(withoutStoryboard, mustNotLoad), withoutStoryboard);

// A matching storyboard alone is insufficient identity for a repair.
for (const change of [
  chart => { chart.notes[0].t += 1; },
  chart => { chart.notes[0].col = (chart.notes[0].col + 1) % chart.keys; },
  chart => { chart.source.original = 'another-source.osz'; },
  chart => { chart.source.type = 'mcz'; },
  chart => { chart.meta.previewTime += 1; },
]) {
  const unrelated = structuredClone(oldArchive);
  change(unrelated.chart);
  const result = await repairBundledStoryboard(unrelated, async () => currentArchive);
  assert.strictEqual(result, unrelated, 'different gameplay or source must not receive this storyboard');
  assert.equal(storyboardHash(result), oldHash);
}

// An absent, stale, edited or mismatched replacement must leave playback usable.
for (const candidate of [
  null,
  oldArchive,
  (() => { const value = structuredClone(currentArchive); value.chart.storyboard.objects[0].x += 1; return value; })(),
  (() => { const value = structuredClone(currentArchive); value.chart.notes[0].t += 1; return value; })(),
  (() => { const value = structuredClone(currentArchive); value.chart.source.original = 'another-source.osz'; return value; })(),
  (() => { const value = structuredClone(currentArchive); value.files.delete(value.chart.storyboard.objects[0].path); return value; })(),
  (() => { const value = structuredClone(currentArchive); value.files.get(value.chart.meta.audio)[0] ^= 1; return value; })(),
]) {
  assert.strictEqual(await repairBundledStoryboard(oldArchive, async () => candidate), oldArchive);
}
assert.strictEqual(await repairBundledStoryboard(oldArchive, async () => { throw new Error('fixture read failed'); }), oldArchive);

// Exercise the actual Store.loadChart route without Electron, IndexedDB or user
// data. Loading repairs in memory and must not write charts, metadata or scores.
const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const chartId = 'existing-library-content-hash';
const best = { chartId, stars: 7.58, score: 987654, acc: .98 };
const storage = new Map([
  ['nf.chartMeta.v1', JSON.stringify({ [chartId]: { id: chartId, stars: 7.58, name: bundledName } })],
  ['nf.scores.v1', JSON.stringify({ [chartId]: best })],
]);
const savedStorage = new Map(storage);
let chartWrites = 0, storageWrites = 0;
const chartReads = [], bundleReads = [];
const fakeBridge = {
  isDesktop: true,
  async readChart(id) { chartReads.push(id); return id === chartId ? oldBytes.toString('base64') : null; },
  async readBundledChart(name) { bundleReads.push(name); return currentBytes.toString('base64'); },
  async writeChart() { chartWrites++; },
};
try {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { neonfallBridge: fakeBridge } });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) { storageWrites++; storage.set(key, value); },
      removeItem(key) { storageWrites++; storage.delete(key); },
    },
  });
  const { Store } = await import('../src/core/store.ts');
  const store = new Store();
  const loaded = await store.loadChart(chartId);
  assert.ok(loaded);
  assert.equal(storyboardHash(loaded), currentHash);
  assert.deepEqual(columns(loaded), [190, 254, 318, 382]);
  assert.deepEqual(chartReads, [chartId], 'load keeps the original library ID');
  assert.deepEqual(bundleReads, [bundledName]);
  assert.equal(loaded.chart.id, oldArchive.chart.id);
  assert.equal(loaded.chart.stars, oldArchive.chart.stars);
  assert.deepEqual(loaded.chart.notes, oldArchive.chart.notes);
  assert.deepEqual(store.getBest(chartId), best, 'existing score remains attached to its ID');
  assert.deepEqual(storage, savedStorage);
  assert.equal(chartWrites, 0);
  assert.equal(storageWrites, 0);

  // PlayScreen historically parsed getChartBytes directly, bypassing loadChart.
  // Stop at audio decoding, after the actual session has received its archive;
  // no browser image/canvas/audio machinery is needed to verify this route.
  const { PlayScreen } = await import('../src/ui/screens/play.ts');
  const sentinel = new Error('stop after playback archive preparation');
  const capturedErrors = [], audioLoads = [], delayedCallbacks = [];
  const savedError = console.error;
  const savedTimeout = globalThis.setTimeout;
  const screen = new PlayScreen({
    store,
    settings: { ...DEFAULT_SETTINGS, skinId: '', videoBg: false },
    mods: { ...DEFAULT_MODS },
    audio: { async loadMusic(bytes, id) { audioLoads.push({ bytes, id }); throw sentinel; } },
    gotoScreen() { assert.fail('test must intercept the delayed return to selection'); },
  });
  try {
    console.error = error => capturedErrors.push(error);
    globalThis.setTimeout = (callback, delay) => { delayedCallbacks.push({ callback, delay }); return 0; };
    await screen.enter({ entry: { id: chartId } });
  } finally {
    console.error = savedError;
    globalThis.setTimeout = savedTimeout;
  }
  assert.deepEqual(capturedErrors, [sentinel], 'actual entry must reach the audio decode boundary');
  assert.equal(delayedCallbacks.length, 1);
  assert.ok(screen.sess?.sb, 'actual PlaySession receives the repaired storyboard');
  assert.equal(storyboardHash({ chart: screen.sess.chart }), currentHash);
  assert.deepEqual(columns({ chart: screen.sess.chart }), [190, 254, 318, 382]);
  assert.equal(screen.sess.chart.id, chartId, 'playback and scoring retain the selected library ID');
  assert.deepEqual(screen.sess.chart.notes, oldArchive.chart.notes);
  assert.equal(audioLoads.length, 1);
  assert.equal(audioLoads[0].id, chartId);
  assert.deepEqual(audioLoads[0].bytes, oldArchive.files.get(oldArchive.chart.meta.audio));
  assert.deepEqual(bundleReads, [bundledName, bundledName]);
  assert.deepEqual(storage, savedStorage);
  assert.equal(chartWrites, 0);
  assert.equal(storageWrites, 0);

  assert.equal(await store.loadChart('missing-id'), null);
  assert.deepEqual(bundleReads, [bundledName, bundledName], 'missing chart must not trigger bundled reads');
  fakeBridge.readBundledChart = async () => { throw new Error('bundled chart unavailable'); };
  assert.equal(storyboardHash(await store.loadChart(chartId)), oldHash);
  fakeBridge.readBundledChart = async () => 'not a ZIP';
  assert.equal(storyboardHash(await store.loadChart(chartId)), oldHash, 'bad bundled archive falls back safely');
  delete fakeBridge.readBundledChart;
  assert.equal(storyboardHash(await store.loadChart(chartId)), oldHash, 'older bridge remains compatible');
  assert.equal(chartWrites, 0);
  assert.equal(storageWrites, 0);
} finally {
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else delete globalThis.window;
  if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage); else delete globalThis.localStorage;
}

assert.equal(sha256(fs.readFileSync(oldPath)), sha256(oldBytes), 'old fixture must remain unchanged on disk');
assert.equal(sha256(fs.readFileSync(currentPath)), sha256(currentBytes), 'bundled fixture must remain unchanged on disk');
console.log('PASS legacy storyboard repair: four note columns, fingerprint/gameplay/asset guards, safe fallbacks, Store load and PlayScreen entry, IDs/scores/files preserved');
