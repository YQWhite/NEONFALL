// Star rating & performance points (NEONFALL rating system).
import type { NFChart, PlayResult } from './types.ts';
import { clamp } from './zip.ts';

export interface StarInfo {
  stars: number;
  density: number;
  avgChord: number;
  jackRatio: number;
  holdRatio: number;
  svComplexity: number;
  bpm: number;
}

export function computeStars(chart: NFChart): StarInfo {
  const notes = chart.notes;
  if (notes.length === 0) {
    return { stars: 0.5, density: 0, avgChord: 1, jackRatio: 0, holdRatio: 0, svComplexity: 0, bpm: 120 };
  }
  const first = notes[0].t;
  let last = notes[0].t;
  let holdCount = 0;
  let holdLen = 0;
  for (const n of notes) {
    last = Math.max(last, n.end ?? n.t);
    if (n.end) {
      holdCount++;
      holdLen += n.end - n.t;
    }
  }
  const duration = Math.max(1000, last - first);

  // density: notes per second (weighted by local bursts)
  const nps = (notes.length / duration) * 1000;
  let burstNps = nps;
  {
    let windowStart = first;
    let windowCount = 0;
    let maxNps = 0;
    let maxStart = first;
    for (const n of notes) {
      windowCount++;
      while (n.t - windowStart > 2000) {
        windowCount--;
        windowStart += 500;
      }
      if (windowCount / ((n.t - maxStart) / 1000 || 1) > maxNps) {
        maxNps = windowCount / Math.max(1, (n.t - windowStart) / 1000);
        maxStart = windowStart;
      }
    }
    burstNps = Math.max(nps, maxNps * 0.85);
  }
  const density = nps * 0.65 + burstNps * 0.35;

  // chords: notes within 8ms
  let chordSum = 0;
  let chordCount = 0;
  {
    let i = 0;
    while (i < notes.length) {
      let j = i;
      while (j + 1 < notes.length && notes[j + 1].t - notes[i].t <= 8) j++;
      const size = j - i + 1;
      chordSum += size;
      chordCount++;
      i = j + 1;
    }
  }
  const avgChord = chordCount ? chordSum / chordCount : 1;

  // jacks: same column within 120ms
  let jacks = 0;
  {
    const lastPerCol = new Map<number, number>();
    for (const n of notes) {
      const prev = lastPerCol.get(n.col);
      if (prev !== undefined && n.t - prev <= 120 && n.t > prev) jacks++;
      lastPerCol.set(n.col, n.t);
    }
  }
  const jackRatio = jacks / notes.length;

  // holds
  const holdRatio = holdCount / notes.length;
  const avgHoldLen = holdCount ? holdLen / holdCount : 0;

  // SV complexity
  let svComplexity = 0;
  {
    let prevSv = 1;
    for (const s of chart.sv) {
      svComplexity += Math.abs(Math.log2(Math.max(0.1, s.sv)) - Math.log2(Math.max(0.1, prevSv)));
      prevSv = s.sv;
    }
    svComplexity = Math.min(3, svComplexity * 0.35 + (chart.sv.length > 0 ? 0.15 : 0));
  }

  // representative BPM: first timing point is usually the true offset BPM;
  // fall back to a time-weighted average over sane sections (SV-meme maps abuse
  // uninherited points to fake extreme BPMs, e.g. 36.6 or 10000).
  let bpm = 180;
  {
    const tp = [...chart.timing].sort((a, b) => a.t - b.t);
    if (tp.length) {
      const first = tp[0].bpm;
      if (first > 30 && first < 1000) {
        bpm = first;
      } else {
        let total = 0;
        let wsum = 0;
        for (let i = 0; i < tp.length; i++) {
          const end = i + 1 < tp.length ? tp[i + 1].t : last;
          const dur = Math.max(0, end - tp[i].t);
          if (tp[i].bpm > 30 && tp[i].bpm < 1000) {
            total += dur;
            wsum += dur * tp[i].bpm;
          }
        }
        bpm = total > 0 ? wsum / total : 180;
      }
    }
  }

  const stars =
    Math.pow(bpm, 0.45) * 0.22 +
    Math.pow(density, 0.75) * 0.9 +
    (avgChord - 1) * 0.4 +
    jackRatio * 2.8 +
    holdRatio * 0.35 +
    Math.min(avgHoldLen / 800, 1) * 0.3 +
    svComplexity * 0.35;

  return {
    stars: clamp(Math.round(stars * 100) / 100, 0.5, 13),
    density,
    avgChord,
    jackRatio,
    holdRatio,
    svComplexity,
    bpm,
  };
}

/** pp for a single play. */
export function computePP(stars: number, acc: number, durationMs: number, mods: readonly string[] = []): number {
  if (![stars, acc, durationMs].every(Number.isFinite) || stars <= 0) return 0;
  const accF = clamp(acc, 0, 1);
  const lenFactor = 1 + clamp(durationMs / 240000, 0, 1) * 0.25;
  // NEONFALL's accuracy curve rewards clean clears: a 90% clear earns only
  // 25% of perfect-play pp; below 80% it earns no performance points.
  const curve = Math.pow(clamp((accF - 0.8) / 0.2, 0, 1), 2);
  const modFactor = mods.some(mod => /^constantspeed$/i.test(mod)) ? 0.9 : 1;
  const pp = 2.2 * Math.pow(clamp(stars, 0, 13), 2.0) * curve * lenFactor * modFactor;
  return Math.round(pp * 100) / 100;
}

export function isRankedResult(result: PlayResult): boolean {
  return result.passed === true && Array.isArray(result.mods) && !result.mods.some(mod => /^(auto|mirror|random)$/i.test(mod));
}

/** Recalculate saved results too, so old pp values cannot bypass a rating update. */
export function resultPP(result: PlayResult): number {
  return isRankedResult(result) ? computePP(result.stars, result.acc, result.durationMs, result.mods) : 0;
}

export const RATING_PLAY_LIMIT = 100;
export const RATING_DECAY = 0.95;
export const RATING_WEIGHT = (1 - RATING_DECAY ** RATING_PLAY_LIMIT) / (1 - RATING_DECAY);

/**
 * Best play per chart, descending, with osu!'s 0.95^rank weighting.
 * RATING uses a fixed 100-slot denominator (empty slots = zero), rather than
 * raw total pp, so one clear cannot stand in for a developed score portfolio.
 * https://osu.ppy.sh/wiki/en/Performance_points/Weighting_system
 */
export function computeRating(ppList: number[]): number {
  const sorted = ppList.filter(pp => Number.isFinite(pp) && pp > 0).sort((a, b) => b - a);
  let sum = 0;
  for (let i = 0; i < sorted.length && i < RATING_PLAY_LIMIT; i++) {
    sum += sorted[i] * Math.pow(RATING_DECAY, i);
  }
  return Math.round(sum / RATING_WEIGHT * 100) / 100;
}
