// .nfm (chart package) / .nfsk (skin package) read & write.
import type { NFChart, NFSkin, NFTimingPoint, NFSVPoint } from './types.ts';
import { zipFromMap, unzipToMap, strToBytes, bytesToStr, findCI } from './zip.ts';

export interface NFMArchive {
  chart: NFChart;
  files: Map<string, Uint8Array>; // asset path -> bytes (paths as in chart JSON)
}

export function buildNFM(chart: NFChart, assets: Record<string, Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const level: Record<string, number> = {};
  files['chart.nf'] = strToBytes(JSON.stringify(chart));
  level['chart.nf'] = 9;
  for (const [path, data] of Object.entries(assets)) {
    files[path] = data;
    // audio/video are already compressed formats -> store
    level[path] = /\.(mp3|ogg|wav|flac|mp4|webm|m4a)$/i.test(path) ? 0 : 6;
  }
  return zipFromMap(files, { level });
}

export function readNFM(data: Uint8Array): NFMArchive {
  const files = unzipToMap(data);
  return parseNFMFiles(files);
}

/** Registering a download needs metadata, never every storyboard/audio asset. */
export function readNFMMetadata(data: Uint8Array): NFChart {
  return parseNFMFiles(unzipToMap(data, new Set(['chart.nf']))).chart;
}

export function parseNFMFiles(files: Map<string, Uint8Array>): NFMArchive {
  const raw = findCI(files, 'chart.nf');
  if (!raw) throw new Error('Not a valid .nfm package (missing chart.nf)');
  const chart = JSON.parse(bytesToStr(raw)) as NFChart;
  if (chart.format !== 'neonfall-chart') throw new Error('Unsupported chart format: ' + chart.format);
  // Compatibility for libraries converted before inherited-point filtering was fixed.
  // Repair only osu data: Malody may legitimately scroll before its first BPM point.
  if (chart.source?.type === 'osz' && chart.timing.length) {
    const first = Math.min(...chart.timing.map(p => p.t));
    chart.sv = chart.sv.filter(p => p.t >= first);
  }
  return { chart, files };
}

export function buildNFSK(skin: NFSkin, assets: Record<string, Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'skin.nfskin': strToBytes(JSON.stringify(skin)),
  };
  const level: Record<string, number> = { 'skin.nfskin': 9 };
  for (const [path, data] of Object.entries(assets)) {
    files[path] = data;
    level[path] = /\.(ogg|wav|mp3)$/i.test(path) ? 0 : 6;
  }
  return zipFromMap(files, { level });
}

export function readNFSK(data: Uint8Array): { skin: NFSkin; files: Map<string, Uint8Array> } {
  const files = unzipToMap(data);
  const raw = findCI(files, 'skin.nfskin');
  if (!raw) throw new Error('Not a valid .nfsk package (missing skin.nfskin)');
  const skin = JSON.parse(bytesToStr(raw)) as NFSkin;
  if (skin.format !== 'neonfall-skin') throw new Error('Unsupported skin format: ' + skin.format);
  return { skin, files };
}

// ---------- timing helpers ----------

export interface TimeMap {
  beatAt(ms: number): number;
  svTimeAt(ms: number): number; // cumulative SV-scaled time from chart start
  svBeatAt(ms: number): number; // cumulative SV-scaled BEATS (scroll position basis)
  msAtSvBeat(sb: number): number; // inverse of svBeatAt
  msAtBeat(beat: number): number;
  bpmAt(ms: number): number;
}

/** Build cumulative beat & SV-scaled time maps over the whole chart. */
export function buildTimeMap(timing: NFTimingPoint[], svPoints: NFSVPoint[], offset: number): TimeMap {
  const tp = [...timing].sort((a, b) => a.t - b.t);
  const sv = [...svPoints].sort((a, b) => a.t - b.t);
  if (tp.length === 0) tp.push({ t: offset, bpm: 120 });
  const first = tp[0];

  // segment boundaries: union of timing & sv change times
  const bounds = new Set<number>([offset]);
  for (const p of tp) bounds.add(p.t);
  for (const p of sv) bounds.add(p.t);
  const segs = [...bounds].sort((a, b) => a - b);
  const segBpm: number[] = [];
  const segSv: number[] = [];
  let curBpm = first.bpm;
  let curSv = 1;
  let ti = 0, si = 0;
  for (let i = 0; i < segs.length; i++) {
    while (ti < tp.length && tp[ti].t <= segs[i]) {
      curBpm = tp[ti].bpm;
      ti++;
    }
    while (si < sv.length && sv[si].t <= segs[i]) {
      curSv = sv[si].sv;
      si++;
    }
    segBpm.push(curBpm);
    segSv.push(curSv);
  }

  // prefix sums (segBpm stores BPM; beats = ms * bpm / 60000)
  const beatPrefix: number[] = [0];
  const svPrefix: number[] = [0];
  const svBeatPrefix: number[] = [0];
  for (let i = 1; i < segs.length; i++) {
    const dt = segs[i] - segs[i - 1];
    beatPrefix.push(beatPrefix[i - 1] + (dt * segBpm[i - 1]) / 60000);
    svPrefix.push(svPrefix[i - 1] + dt * segSv[i - 1]);
    svBeatPrefix.push(svBeatPrefix[i - 1] + (dt * segBpm[i - 1] * segSv[i - 1]) / 60000);
  }

  // Binary searches use bounded segment arrays, never a per-frame time cache.
  const indexAt = (values: number[], x: number): number => {
    let lo = 0, hi = values.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (values[mid] <= x) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const valueAt = (ms: number, prefix: number[], rates: number[]) => {
    const i = indexAt(segs, ms);
    return prefix[i] + (ms - segs[i]) * rates[i];
  };
  const beatRates = segBpm.map(b => b / 60000);
  const scrollRates = segBpm.map((b, i) => b * segSv[i] / 60000);
  const inverse = (x: number, prefix: number[], rates: number[]) => {
    const i = indexAt(prefix, x);
    return segs[i] + (x - prefix[i]) / rates[i];
  };
  const beatAt = (ms: number) => valueAt(ms, beatPrefix, beatRates);
  const svTimeAt = (ms: number) => valueAt(ms, svPrefix, segSv);
  const svBeatAt = (ms: number) => valueAt(ms, svBeatPrefix, scrollRates);
  const msAtBeat = (b: number) => inverse(b, beatPrefix, beatRates);
  const msAtSvBeat = (b: number) => inverse(b, svBeatPrefix, scrollRates);
  const bpmAt = (ms: number) => segBpm[indexAt(segs, ms)];
  return { beatAt, svTimeAt, svBeatAt, msAtSvBeat, msAtBeat, bpmAt };
}

export function chartLengthMs(chart: NFChart): number {
  let end = 0;
  for (const n of chart.notes) end = Math.max(end, n.end ?? n.t);
  return end;
}
