import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { readNFM, readNFMMetadata } from '../src/core/nfm.ts';
import { readNFMPreview, readNFMCover } from '../src/core/preview-archive.ts';

const chart = { format: 'neonfall-chart', version: 1, keys: 4, meta: { audio: 'AUDIO.ogg', bg: 'Art\\BG.PNG' },
  timing: [{ t: 100, bpm: 120 }], sv: [{ t: -100, sv: 1 }, { t: 100, sv: 2 }], notes: [], source: { type: 'osz' } };
const background = new Uint8Array([137, 80, 78, 71]), audio = new Uint8Array([79, 103, 103]);
const bytes = zipSync({ 'CHART.NF': new TextEncoder().encode(JSON.stringify(chart)), 'audio.ogg': audio,
  'Art/BG.PNG': background, 'storyboard/large.bin': new Uint8Array(2 * 1024 * 1024).fill(44), 'video.mp4': new Uint8Array(10000) });
const full = readNFM(bytes);
assert.deepEqual(readNFMMetadata(bytes), full.chart);
const previewRequest = readNFMPreview(bytes);
assert.equal(readNFMPreview(bytes), previewRequest, 'simultaneous preview reads share one extraction');
const preview = await previewRequest;
assert.deepEqual(preview.chart, full.chart, 'legacy timing repair remains identical');
assert.deepEqual(preview.files.get(chart.meta.audio), audio);
assert.deepEqual(preview.files.get(chart.meta.bg), background);
assert.ok(!preview.files.has('storyboard/large.bin') && !preview.files.has('video.mp4'), 'preview skips non-menu resources');
assert.deepEqual(await readNFMCover(bytes), background, 'cover reuses a prepared preview');
const separate = bytes.slice();
const coverRequest = readNFMCover(separate, 'art/BG.png');
assert.equal(readNFMCover(separate, 'ART\\bg.PNG'), coverRequest, 'equivalent paths share extraction');
assert.deepEqual(await coverRequest, background);
assert.equal(await readNFMCover(separate, 'missing.png'), undefined);
assert.deepEqual(await readNFMCover(bytes.slice()), background, 'legacy catalogue without bg falls back to metadata');
const imageOnly = zipSync({ 'art/BG.png': background });
assert.deepEqual(await readNFMCover(imageOnly, 'ART/bg.PNG'), background, 'known cover does not parse or require chart metadata');
await assert.rejects(readNFMPreview(imageOnly), /missing chart.nf/);
await assert.rejects(readNFMPreview(imageOnly), /missing chart.nf/, 'failed extraction is retryable');
assert.equal(bytes.byteLength, separate.byteLength, 'input buffer is not transferred or detached');
console.log('PASS selective menu archives: metadata parity, media-only extraction, path compatibility, shared pending work, failure retry, and intact inputs');
