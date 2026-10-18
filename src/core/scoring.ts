import type { JudgeGrade, NFNote, PlayCounts } from './types.ts';

/** NF's million-point rules, deliberately versioned separately from old scores. */
export const SCORING_VERSION = 2;
export const MAX_SCORE = 1_000_000;
export const SCROLL_SPEED_BASE = .55;
export const SCROLL_MULTIPLIER_MIN = .5;
export const SCROLL_MULTIPLIER_MAX = 4;

/** Keep existing saved physical speeds while displaying a real reference multiplier. */
export function scrollSpeedMultiplier(speed: number): number { return speed / SCROLL_SPEED_BASE; }
export function scrollSpeedFromMultiplier(multiplier: number): number { return multiplier * SCROLL_SPEED_BASE; }

/**
 * osu!mania ScoreV2 hit windows. Signed errors are rounded to milliseconds;
 * limits are truncated, as documented by the osu!mania judgement wiki.
 * Tail release windows are 1.5 times the corresponding head windows.
 * https://osu.ppy.sh/wiki/en/Gameplay/Judgement/osu!mania#scorev2
 */
export function judgmentWindows(od: number, tail = false): number[] {
  const difficulty = Math.max(0, Math.min(10, Number.isFinite(od) ? od : 8));
  const maximum = difficulty <= 5 ? 22.4 - .6 * difficulty : 24.9 - 1.1 * difficulty;
  return [maximum, 64 - 3 * difficulty, 97 - 3 * difficulty, 127 - 3 * difficulty,
    151 - 3 * difficulty, 188 - 3 * difficulty].map(value => Math.floor(value * (tail ? 1.5 : 1)));
}

/** null means too early to consume this note. Late MEH is a MISS in mania. */
export function judgmentForError(errorMs: number, windows: readonly number[]): JudgeGrade | null {
  const absolute = Math.round(Math.abs(errorMs)), error = errorMs < 0 ? -absolute : absolute;
  if (error < -windows[5]) return null;
  if (error > windows[3]) return 'miss';
  if (absolute <= windows[0]) return 'perfect';
  if (absolute <= windows[1]) return 'great';
  if (absolute <= windows[2]) return 'good';
  if (absolute <= windows[3]) return 'ok';
  if (absolute <= windows[4]) return 'bad';
  return 'miss';
}

export function judgmentCount(notes: readonly NFNote[]): number {
  let count = notes.length;
  for (const note of notes) if (note.end !== undefined && note.end > note.t) count++;
  return count;
}

export function judgedCount(counts: PlayCounts): number {
  return counts.perfect + counts.great + counts.good + counts.ok + counts.bad + counts.miss;
}

export function modScoreMultiplier(mods: readonly string[] = []): number {
  return mods.some(mod => /^notail$/i.test(mod)) ? .9 : 1;
}

/**
 * Every tap/head/tail has equal maximum weight; body ticks do not inflate
 * score or accuracy. Dividing by the entire chart also bounds failed plays.
 * The 320/300/200/100/50 weights follow mania hit values, while NF uses this
 * deterministic normalization instead of mania's order-dependent bonus gauge.
 */
export function scoreFromCounts(counts: PlayCounts, chartJudgments: number, mods: readonly string[] = []): number {
  if (chartJudgments <= 0) return 0;
  const value = 320 * counts.perfect + 300 * counts.great + 200 * counts.good + 100 * counts.ok + 50 * counts.bad;
  return Math.round(MAX_SCORE * Math.max(0, Math.min(1, value / (320 * chartJudgments))) * modScoreMultiplier(mods));
}

/** osu!mania ScoreV2 accuracy gives MAX 305 and GREAT 300 (not 320 and 300). */
export function accuracyFromCounts(counts: PlayCounts): number {
  const total = judgedCount(counts);
  return total ? (305 * counts.perfect + 300 * counts.great + 200 * counts.good + 100 * counts.ok + 50 * counts.bad) / (305 * total) : 1;
}

/** osu!mania grade thresholds are strict: exactly 95% is A, not S. */
export function gradeFromAccuracy(accuracy: number, passed = true): string {
  if (!passed) return 'F';
  if (accuracy >= 1) return 'SS';
  if (accuracy > .95) return 'S';
  if (accuracy > .9) return 'A';
  if (accuracy > .8) return 'B';
  if (accuracy > .7) return 'C';
  return 'D';
}
