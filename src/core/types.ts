// NEONFALL shared types — chart, skin, storyboard, account, platform.
export interface NFNote {
  t: number; col: number; end?: number; sound?: number; sampleSet?: number; vol?: number; idx?: number;
}
export interface NFTimingPoint { t: number; bpm: number; }
export interface NFSVPoint { t: number; sv: number; }
export interface NFBreak { t: number; end: number; }
export interface SBCmd {
  k: 'F' | 'M' | 'MX' | 'MY' | 'S' | 'V' | 'C' | 'R' | 'P' | 'L' | 'T';
  ease: number; t1: number; t2: number; a: number[]; loops?: SBCmd[];
  parameter?: 'A' | 'H' | 'V'; trigger?: string; group?: number;
}
export interface SBObject {
  type: 'sprite' | 'anim'; layer: number; origin: number; path: string;
  x: number; y: number; cmds: SBCmd[]; frames?: number; frameDelay?: number; loopType?: number; additive?: boolean;
}
export interface NFStoryboard { objects: SBObject[]; }
export interface NFChartMeta {
  title: string; titleOrg?: string; artist: string; artistOrg?: string; creator: string;
  version: string; source?: string; tags?: string; audio: string; audioLeadIn: number;
  previewTime: number;
  /** Missing on legacy NFM; a nonnegative legacy preview remains authored. */
  previewSource?: 'authored' | 'generated';
  bg?: string; video?: string; lengthMs: number;
}
export interface NFChart {
  format: 'neonfall-chart'; version: 1; id?: string; meta: NFChartMeta;
  keys: number; od: number; hp?: number; offset: number;
  timing: NFTimingPoint[]; sv: NFSVPoint[]; breaks: NFBreak[]; notes: NFNote[];
  /** Authored emphasis intervals, in the same audio-file milliseconds as notes. */
  kiai?: NFBreak[];
  storyboard?: NFStoryboard; skin?: { files: Record<string, string>; data?: NFSkin }; stars?: number;
  source?: { type: 'osz' | 'mcz'; hash?: string; original?: string };
}
// ---- skin ----
export interface NFSkinColumn {
  keyImg?: string;
  keyImgD?: string;
  /** Normalized crop for a shared Malody receptor strip. */
  keyCrop?: [number, number, number, number];
  keyFlip?: boolean;
  keyPressedFlip?: boolean;
  noteScaleY?: number;
  holdHeadScaleY?: number;
  holdTailScaleY?: number;
  noteImg?: string;
  /** Long-note head (osu NoteImage{i}H), not a pressed receptor. */
  noteImgH?: string;
  /** Long-note body (osu NoteImage{i}L). */
  bodyImg?: string;
  /** Long-note tail (osu NoteImage{i}T). */
  noteImgT?: string;
  /** Vertical flip of the tail artwork (osu 2.5+ default); absent keeps modern default. */
  tailFlip?: boolean;
  /** Compatibility alias for the hold head. */
  bodyBegin?: string;
  /** Compatibility alias for the hold tail. */
  bodyEnd?: string;
  tint?: [number, number, number];
  /** Explicit column backdrop, RGBA (alpha 0..255); absent keeps the stage transparent. */
  background?: [number, number, number, number];
  width?: number;
}
export interface NFSkin {
  format: 'neonfall-skin';
  version: 1;
  name: string;
  author?: string;
  keys: number;
  perspective?: { angle: number; topWidth: number };
  msp?: import('./msp-types.ts').MSPPresentation;
  source?: { type: 'msp'; scripted: boolean };
  /** Left edge of the first column, in the source skin's logical coordinates. */
  columnStart?: number;
  columnWidth?: number;
  hitPosition?: number;
  specialStyle?: number;
  keyUnderNotes?: boolean;
  judgementLine?: boolean;
  /** osu NoteBodyStyle: 0 stretch, 1 tile. */
  noteBodyStyle?: number;
  columnSpacing?: number[];
  columnLineWidth?: number[];
  /** Actual pixel density per asset path, normally 1 or 2. */
  assetDensity?: Record<string, number>;
  /** Independent key-count layouts. Children do not contain a variants backlink. */
  variants?: Record<string, NFSkin>;
  columns: NFSkinColumn[];
  stage?: { left?: string; right?: string; bottom?: string; light?: string; hint?: string; warning?: string };
  judgments?: { perfect?: string; great?: string; good?: string; ok?: string; bad?: string; miss?: string };
  hitsounds?: {
    normal?: { hit?: string; whistle?: string; finish?: string; clap?: string };
    soft?: { hit?: string; whistle?: string; finish?: string; clap?: string };
    drum?: { hit?: string; whistle?: string; finish?: string; clap?: string };
  };
  misc?: { combobreak?: string; comboburst?: string; go?: string; ready?: string; count1?: string; count2?: string; count3?: string };
  fonts?: { combo?: string; score?: string; name?: string };
  hud?: { healthBackground?: string; healthFill?: string; healthMarker?: string };
  grades?: Partial<Record<'SS' | 'S' | 'A' | 'B' | 'C' | 'D' | 'F', string>>;
}
// ---- result / score ----
export interface PlayCounts {
  perfect: number; great: number; good: number; ok: number; bad: number; miss: number; holdTicks: number;
}
export interface PlayResult {
  chartId: string; keys: number; score: number; acc: number; maxCombo: number; counts: PlayCounts;
  stars: number; pp: number; grade: string; mods: string[]; passed: boolean; playedAt: number;
  title: string; version: string; durationMs: number;
  /** Missing denotes legacy combo/tick scoring; never compare it as a million-point score. */
  scoreVersion?: number;
  /** Stable for one attempt, including upload retries; a gameplay retry starts a new ID. */
  playId?: string;
  /** Chart-time position of the first failure; absent for clears and unknown legacy data. */
  failedAtMs?: number;
}
export interface UserInfo { username: string; nickname: string; email: string; emailVerified: boolean; createdAt: number; rating: number; bestPp: number; avatar?: string; }
export interface LeaderboardEntry { rank: number; username: string; nickname: string; score: number; acc: number; maxCombo: number; playedAt: number; isSelf?: boolean; mods?: string[]; grade?: string; avatar?: string; scoreVersion?: number; }
export type JudgeGrade = 'perfect' | 'great' | 'good' | 'ok' | 'bad' | 'miss';
export const JUDGE_WINDOWS: { g: JudgeGrade; ms: number; value: number; color: string; label: string }[] = [
  { g: 'perfect', ms: 16, value: 320, color: '#ffd94d', label: 'PERFECT' },
  { g: 'great', ms: 40, value: 300, color: '#46e8ff', label: 'GREAT' },
  { g: 'good', ms: 73, value: 200, color: '#59ff8f', label: 'GOOD' },
  { g: 'ok', ms: 103, value: 100, color: '#b58aff', label: 'OK' },
  { g: 'bad', ms: 127, value: 50, color: '#ff8a5c', label: 'MEH' },
  { g: 'miss', ms: 164, value: 0, color: '#ff4b5c', label: 'MISS' },
];
export const GRADE_COLORS: Record<string, string> = {
  SS: '#ffd94d', S: '#ffd94d', A: '#46e8ff', B: '#59ff8f', C: '#b58aff', D: '#ff8a5c', F: '#ff4b5c',
};
export const NEON_COLORS = ['#3fd6ff', '#ff4bd8', '#ffd166', '#6dff8a', '#ff7a5c', '#b58aff', '#ffe94d'];
export interface Mods {
  auto: boolean; mirror: boolean; random: boolean; hidden: boolean; fadeIn: boolean; flashlight: boolean;
  noFail: boolean; downScroll: boolean; speed: number; constantSpeed: boolean; noTail: boolean;
}
export const DEFAULT_MODS: Mods = {
  auto: false, mirror: false, random: false, hidden: false, fadeIn: false,
  flashlight: false, noFail: false, downScroll: false, speed: 1, constantSpeed: false, noTail: false,
};
export interface Settings {
  language: 'zh-CN' | 'en';
  playfieldScale: number;
  /** Hit position's distance from the screen bottom, as a height fraction.
   * Omitted preserves the skin's original anchor without changing note speed. */
  playfieldBottomGap?: number;
  /** Explicit disconnect persists until the player connects again. */
  serverDisconnected?: boolean;
  scrollSpeed: number; audioOffset: number; visualOffset: number; inputOffset: number;
  musicVolume: number; sfxVolume: number; previewVolume: number; fpsCap: number; resScale: number;
  sbEnabled: boolean; sbQuality: number; storyboardBrightness: number; videoBg: boolean; bgDim: number; particles: boolean; touchHint: boolean;
  keybinds: Record<string, string[]>; serverUrl: string; lastUsername: string; skinId: string; audioOffsetAuto?: boolean;
}
export const PLAYFIELD_SCALE_MIN = .5;
export const PLAYFIELD_SCALE_MAX = 2;
export const PLAYFIELD_BOTTOM_GAP_MAX = .4;
export const DEFAULT_SETTINGS: Settings = {
  language: 'zh-CN',
  playfieldScale: 1.08,
  scrollSpeed: 0.55, audioOffset: 0, visualOffset: 0, inputOffset: 0,
  musicVolume: 0.9, sfxVolume: 0.7, previewVolume: 0.35, fpsCap: 0, resScale: 1,
  sbEnabled: true, sbQuality: 0.75, storyboardBrightness: 1, videoBg: true, bgDim: 0.35, particles: true, touchHint: true,
  keybinds: {
    '4': ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
    '5': ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'],
    '6': ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
    '7': ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
    '8': ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
  },
  serverUrl: '', lastUsername: '', skinId: '',
};
