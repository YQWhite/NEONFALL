// PlaySession — the heart of NEONFALL: judgment, scoring, HP, video sync, storyboard.
import type {
  NFChart, Mods, Settings, PlayResult, PlayCounts, JudgeGrade, NFSkin,
} from '../core/types.ts';
import { JUDGE_WINDOWS } from '../core/types.ts';
import { buildTimeMap, type NFMArchive, type TimeMap } from '../core/nfm.ts';
import { AudioEngine } from './audio.ts';
import { InputManager } from './input.ts';
import { StoryboardPlayer, storyboardUsesBackground } from '../core/storyboard.ts';
import { computePP, computeStars } from '../core/rating.ts';
import { clamp, bytesToBlobUrl, guessMime } from '../core/zip.ts';

export type PlayPhase = 'loading' | 'playing' | 'paused' | 'failed' | 'finished';

export interface SkinAssets {
  skin: NFSkin | null;
  getAsset(path: string): Uint8Array | undefined;
}

interface Popup {
  label: string;
  color: string;
  t0: number;
  x: number;
  y: number;
  big: boolean;
}

interface Particle {
  x: number; y: number; vx: number; vy: number; life: number; ttl: number; color: string; size: number;
}

// Chart-time ticks: deterministic across FPS and speed mods (20 judgments/s).
export const HOLD_TICK_MS = 50;

export class PlaySession {
  chart: NFChart;
  keys: number;
  mods: Mods;
  settings: Settings;
  audio: AudioEngine;
  skin: NFSkin | null;
  getAsset: (p: string) => Uint8Array | undefined;

  timeMap: TimeMap;
  /** Visual-only map: constant speed leaves real BPM, audio and judgment clocks intact. */
  scrollMap: TimeMap;
  notes: NFChart['notes'] = [];
  windows: number[]; // scaled judgment windows
  od: number;
  lengthMs: number;
  stars: number;

  phase: PlayPhase = 'loading';
  musicStarted = false;

  // per-column judgment queues
  private colNotes: number[][] = [];
  private colPtr: number[] = [];
  private judged: boolean[] = [];
  private holding: (number | null)[] = [];
  private nextHoldTick: number[] = [];
  private holdResumeAt: number[] = [];
  private rewindUntil = -Infinity;
  private healthTime = -Infinity;
  private lastNoteEnd = 0;

  score = 0;
  combo = 0;
  maxCombo = 0;
  hp = 100;
  counts: PlayCounts = { perfect: 0, great: 0, good: 0, ok: 0, bad: 0, miss: 0, holdTicks: 0 };
  private accSum = 0;
  private accDen = 0;

  popups: Popup[] = [];
  particles: Particle[] = [];
  colFlash: number[] = [];
  comboPulse = 0;

  sb: StoryboardPlayer | null = null;
  bgImage: HTMLImageElement | null = null;
  videoEl: HTMLVideoElement | null = null;
  videoReady = false;

  input: InputManager;
  finishPending = false;
  introSkipped = false;

  constructor(
    chart: NFChart,
    archive: NFMArchive,
    skinAssets: SkinAssets,
    mods: Mods,
    settings: Settings,
    audio: AudioEngine,
    autoplaySeed?: number,
  ) {
    this.chart = chart;
    this.keys = chart.keys;
    this.mods = mods;
    this.settings = settings;
    this.audio = audio;
    this.skin = skinAssets.skin;
    this.getAsset = skinAssets.getAsset;
    this.stars = chart.stars ?? computeStars(chart).stars;
    this.od = clamp(isFinite(chart.od) ? chart.od : 8, 0, 10);
    this.lengthMs = chart.meta.lengthMs;

    const scale = 1 + (8 - this.od) * 0.08;
    this.windows = JUDGE_WINDOWS.map((w) => w.ms * scale);

    // apply mods
    const perm = this.randomPerm(autoplaySeed);
    const mapCol = (col: number): number => {
      let c = col;
      if (mods.mirror) c = this.keys - 1 - col;
      if (mods.random) c = perm[c % perm.length];
      return c;
    };
    this.notes = chart.notes
      .map((n) => ({ ...n, col: mapCol(n.col) }))
      .sort((a, b) => a.t - b.t || a.col - b.col);
    this.notes.forEach((n, i) => {
      n.idx = i;
      this.lastNoteEnd = Math.max(this.lastNoteEnd, n.end ?? n.t);
    });
    this.judged = this.notes.map(() => false);
    this.colNotes = Array.from({ length: this.keys }, () => [] as number[]);
    this.notes.forEach((n, i) => this.colNotes[n.col].push(i));
    this.colPtr = new Array(this.keys).fill(0);
    this.holding = new Array(this.keys).fill(null);
    this.nextHoldTick = new Array(this.keys).fill(0);
    this.holdResumeAt = new Array(this.keys).fill(-Infinity);
    this.colFlash = new Array(this.keys).fill(0);

    this.timeMap = buildTimeMap(chart.timing, chart.sv, chart.offset);
    this.scrollMap = mods.constantSpeed ? buildTimeMap([{ t: 0, bpm: 120 }], [], 0) : this.timeMap;
    this.input = new InputManager(this.keys, settings);
    this.input.now = () => this.chartTime();
    this.input.onPress = (p) => this.press(p.col, p.timeMs);
    this.input.onRelease = (col, t) => this.release(col, t);

    if (chart.storyboard && settings.sbEnabled) {
      this.sb = new StoryboardPlayer(chart.storyboard.objects, (p) => this.getAsset(p));
    }
    if (chart.meta.bg && !(this.sb && storyboardUsesBackground(chart.storyboard!.objects, chart.meta.bg))) {
      const data = this.getAsset(chart.meta.bg);
      if (data) {
        const img = new Image();
        img.src = bytesToBlobUrl(data, guessMime(data));
        this.bgImage = img;
      }
    }
    if (chart.meta.video && settings.videoBg) {
      const data = this.getAsset(chart.meta.video);
      if (data) {
        const v = document.createElement('video');
        v.src = bytesToBlobUrl(data, guessMime(data));
        v.loop = true;
        v.muted = true;
        v.playsInline = true;
        (v as any).webkitPlaysInline = true;
        v.setAttribute('playsinline', '');
        v.preload = 'auto';
        this.videoEl = v;
        v.addEventListener('canplay', () => {
          this.videoReady = true;
          v.play().catch(() => undefined);
        });
      }
    }
    void archive;
  }

  private randomPerm(seed?: number): number[] {
    const n = this.keys;
    const arr = Array.from({ length: n }, (_, i) => i);
    let s = seed ?? 12345;
    for (let i = n - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- clock ----------
  chartTime(): number {
    return this.audio.songTimeMs() - this.settings.audioOffset;
  }
  drawTime(): number {
    return this.chartTime() + this.settings.visualOffset;
  }

  // ---------- lifecycle ----------
  /** Keep authored intros and allow three seconds before an early first note. */
  initialTime(): number {
    const storyboardStart = this.sb && Number.isFinite(this.sb.startTime) ? this.sb.startTime : 0;
    const preparationStart = this.notes.length ? this.notes[0].t - 3000 : 0;
    return Math.min(0, storyboardStart, preparationStart);
  }

  preparationRemainingMs(): number {
    const first = this.notes[0]?.t, t = this.chartTime();
    return first !== undefined && first < 3000 && t >= first - 3000 && t < first ? first - t : 0;
  }

  /** Audio duration is authoritative; metadata is a fallback for undecoded/test audio. */
  playbackEndTime(): number {
    const duration = this.audio.musicDurationMs;
    return Number.isFinite(duration) && duration > 0 ? duration - this.settings.audioOffset : this.lengthMs;
  }

  private notesSettled(): boolean {
    return this.holding.every(note => note === null) && this.colNotes.every((_, col) => this.nextNote(col) < 0);
  }

  beginPlay() {
    this.phase = 'playing';
    this.musicStarted = true;
    const startChartMs = this.initialTime();
    this.introSkipped = false;
    const audioPosSec = (startChartMs + this.settings.audioOffset) / 1000;
    this.audio.playMusic(audioPosSec);
    this.healthTime = startChartMs;
    if (this.videoEl && this.videoReady) this.videoEl.play().catch(() => undefined);
  }

  update(dtMs: number, nowPerf: number) {
    if (this.phase !== 'playing') return;

    const t = this.chartTime();
    // Recover during authored breaks only, once per chart-time interval.
    // Seeking backwards must never farm health.
    if (t > this.healthTime) {
      for (const b of this.chart.breaks) {
        const elapsed = Math.max(0, Math.min(t, b.end) - Math.max(this.healthTime, b.t));
        this.hp = clamp(this.hp + elapsed * 0.004, 0, 100);
      }
      this.healthTime = t;
    }
    this.syncVideo(t);
    if (this.sb) this.sb.warm(t);

    const judgeTime = t - this.settings.inputOffset;
    for (let c = 0; c < this.keys; c++) {
      // Resolve an existing tail before a following head in the same lane.
      this.updateHold(c, this.mods.auto ? t : judgeTime);
      let i = this.nextNote(c);
      if (this.mods.auto) {
        while (i >= 0 && this.notes[i].t <= t) {
          this.judgeNote(i, 'perfect');
          if (this.notes[i].end) {
            this.startHold(c, i, this.notes[i].t);
            this.updateHold(c, t);
          }
          i = this.nextNote(c);
        }
      } else {
        while (i >= 0 && this.notes[i].t < judgeTime - this.windows[4]) {
          this.judgeNote(i, 'miss');
          // A missed head must not silently remove its tail from accuracy.
          if (this.notes[i].end) { this.startHold(c, i, judgeTime); this.completeHold(c, 'miss', false); }
          i = this.nextNote(c);
        }
      }
    }

    this.particles = this.particles.filter((p) => {
      const k = dtMs / 16;
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.vy += 0.15 * k;
      p.life += dtMs;
      return p.life < p.ttl;
    });
    this.popups = this.popups.filter((p) => t - p.t0 < 900);
    this.comboPulse = Math.max(0, this.comboPulse - dtMs / 300);

    if (this.hp <= 0 && !this.mods.noFail && !this.mods.auto && !this.finishPending) {
      this.phase = 'failed';
      this.audio.pauseMusic();
      if (this.videoEl) this.videoEl.pause();
    }

    if (!this.finishPending && this.phase === 'playing' && this.notesSettled()) {
      // Retain the final storyboard frame, and a full second after audio ends.
      if (t >= this.playbackEndTime() + 1000 && t > (this.sb?.endTime ?? -Infinity)) this.finish();
    }
  }

  private nextNote(col: number): number {
    const q = this.colNotes[col];
    let p = this.colPtr[col];
    while (p < q.length && this.judged[this.notes[q[p]].idx!]) p++;
    this.colPtr[col] = p;
    return p < q.length ? q[p] : -1;
  }

  /** whether the note at global notes-array position i has been judged (renderer visibility) */
  isJudged(i: number): boolean {
    return this.judged[i] ?? false;
  }

  /** whether the note at global position i is currently being held */
  isHeld(i: number): boolean {
    const n = this.notes[i];
    if (!n) return false;
    return this.holding[n.col] === i;
  }

  isHoldingColumn(col: number): boolean {
    return this.holding[col] !== null && this.holding[col] !== undefined;
  }

  private syncVideo(t: number) {
    const v = this.videoEl;
    if (!v || !this.videoReady) return;
    if (v.paused) {
      v.play().catch(() => undefined);
      return;
    }
    const target = Math.max(0, (t + this.settings.audioOffset) / 1000);
    const dur = v.duration || 0;
    if (dur > 0) {
      const tt = target % dur;
      if (Math.abs(tt - v.currentTime) > 0.08) {
        try {
          v.currentTime = tt;
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ---------- input ----------
  press(col: number, rawTimeMs: number) {
    if (this.phase !== 'playing') return;
    const t = rawTimeMs - this.settings.inputOffset;
    const i = this.nextNote(col);
    if (i < 0) {
      this.audio.playSynth('tick', this.settings.sfxVolume * 0.25);
      return;
    }
    const n = this.notes[i];
    const dt = t - n.t;
    if (dt < -this.windows[4]) return;
    if (dt > this.windows[4]) {
      this.audio.playSynth('tick', this.settings.sfxVolume * 0.25);
      return;
    }
    if (this.holding[col] !== null) this.updateHold(col, t);
    this.judgeNote(i, this.gradeOf(Math.abs(dt)));
    if (n.end) this.startHold(col, i, t);
    this.flash(col);
  }

  release(col: number, rawTimeMs: number) {
    if (this.phase !== 'playing') return;
    const t = rawTimeMs - this.settings.inputOffset;
    if (t < this.holdResumeAt[col]) return;
    const holdIdx = this.holding[col];
    if (holdIdx !== null && holdIdx !== undefined && holdIdx >= 0) {
      const n = this.notes[holdIdx];
      this.awardHoldTicks(col, t);
      const dt = t - (n.end ?? n.t);
      if (Math.abs(dt) <= this.windows[4]) {
        this.completeHold(col, this.gradeOf(Math.abs(dt)));
      } else {
        this.breakHold(col);
      }
    }
  }

  private gradeOf(absDt: number): JudgeGrade {
    if (absDt <= this.windows[0]) return 'perfect';
    if (absDt <= this.windows[1]) return 'great';
    if (absDt <= this.windows[2]) return 'good';
    if (absDt <= this.windows[3]) return 'ok';
    return 'bad';
  }

  private flash(col: number) {
    this.colFlash[col] = performance.now();
    this.spawnParticles(col);
  }

  private spawnParticles(col: number) {
    if (!this.settings.particles) return;
    const l = this.layoutOf(col);
    const colors = ['#ffffff', '#7df9ff', '#ff4bd8', '#ffd166'];
    for (let i = 0; i < 7; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const sp = 2 + Math.random() * 4;
      this.particles.push({
        x: l.x,
        y: l.hitY,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: 0,
        ttl: 260 + Math.random() * 240,
        color: colors[(Math.random() * colors.length) | 0],
        size: 2 + Math.random() * 3,
      });
    }
  }

  // ---------- judgment ----------
  private changeHealth(grade: JudgeGrade, tail = false) {
    // Consistent good hits sustain a run; a miss takes a few good hits to recover.
    const difficulty = clamp(this.chart.hp ?? 5, 0, 10);
    const damageScale = 0.8 + difficulty * 0.04;
    const delta = { perfect: 1.4, great: 1, good: 0.4, ok: -0.25, bad: -1.2, miss: tail ? -2.4 : -4.8 }[grade];
    const recovery = this.hp < 30 ? 1.25 : 1;
    this.hp = clamp(this.hp + (delta > 0 ? delta * recovery : delta * damageScale), 0, 100);
  }

  private judgeNote(i: number, grade: JudgeGrade) {
    const n = this.notes[i];
    if (this.judged[n.idx!]) return;
    this.judged[n.idx!] = true;
    const w = JUDGE_WINDOWS.find((x) => x.g === grade)!;
    this.counts[grade] = (this.counts[grade] as number) + 1;

    if (grade === 'miss') {
      this.combo = 0;
      this.changeHealth(grade);
      this.accDen++;
      this.playMissSfx();
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      const mult = 1 + Math.min(this.combo / 100, 9);
      this.score += Math.round(w.value * mult);
      this.accSum += w.value;
      this.accDen++;
      this.changeHealth(grade);
      this.playHitSfx(n);
    }
    const l = this.layoutOf(n.col);
    this.popups.push({
      label: w.label,
      color: w.color,
      t0: this.chartTime(),
      x: l.x,
      y: l.hitY,
      big: grade === 'perfect' || grade === 'miss',
    });
    if (grade === 'perfect' || grade === 'great') this.flash(n.col);
    if (this.holding[n.col] === i) this.holding[n.col] = null;
  }

  private startHold(col: number, i: number, pressedAt: number) {
    if (this.holding[col] !== null) this.breakHold(col);
    this.holding[col] = i;
    this.holdResumeAt[col] = -Infinity;
    // Store the NEXT absolute chart-time tick, never accumulated render dt.
    const start = this.notes[i].t;
    this.nextHoldTick[col] = start + Math.max(1, Math.ceil((pressedAt - start) / HOLD_TICK_MS)) * HOLD_TICK_MS;
  }

  private awardHoldTicks(col: number, until: number) {
    const i = this.holding[col];
    if (i === null || i === undefined) return;
    const end = this.notes[i].end!;
    // The endpoint is a separate release judgment, not another body tick.
    while (this.nextHoldTick[col] <= until && this.nextHoldTick[col] < end) {
      this.nextHoldTick[col] += HOLD_TICK_MS;
      this.counts.holdTicks++;
      this.counts.perfect++;
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.score += Math.round(32 * (1 + Math.min(this.combo / 100, 9)));
      this.accSum += 320;
      this.accDen++;
      this.hp = clamp(this.hp + 0.06, 0, 100);
      this.comboPulse = 1;
    }
  }

  private updateHold(col: number, t: number) {
    const i = this.holding[col];
    if (i === null || i === undefined) return;
    // Keep an already-hit hold and its tick cursor through the replayed section.
    // The player can re-grab it before reaching the original pause point.
    if (t < this.holdResumeAt[col]) return;
    if (!this.mods.auto && !this.input.isDown(col) && t <= this.holdResumeAt[col] + this.windows[4]) return;
    const end = this.notes[i].end!;
    if (this.mods.auto) {
      this.awardHoldTicks(col, Math.min(t, end));
      if (t >= end) this.completeHold(col, 'perfect');
    } else if (!this.input.isDown(col)) {
      // Blur/focus loss has no accurate release timestamp; never award unseen ticks.
      this.breakHold(col);
    } else {
      this.awardHoldTicks(col, Math.min(t, end));
      // Holding through the endpoint is NOT an automatic perfect release.
      if (t > end + this.windows[4]) this.completeHold(col, 'miss');
    }
  }

  private completeHold(col: number, grade: JudgeGrade, affectHealth = true) {
    const holdIdx = this.holding[col];
    if (holdIdx === null || holdIdx === undefined || holdIdx < 0) return;
    this.holding[col] = null;
    const w = JUDGE_WINDOWS.find((x) => x.g === grade)!;
    this.counts[grade] = (this.counts[grade] as number) + 1;
    this.nextHoldTick[col] = 0;
    this.holdResumeAt[col] = -Infinity;
    this.accDen++;
    if (grade === 'miss') {
      this.combo = 0;
      if (affectHealth) this.changeHealth(grade, true);
      this.playMissSfx();
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      const mult = 1 + Math.min(this.combo / 100, 9);
      this.score += Math.round(w.value * mult);
      this.accSum += w.value;
      if (affectHealth) this.changeHealth(grade, true);
    }
    const l = this.layoutOf(col);
    this.popups.push({
      label: 'TAIL ' + w.label,
      color: w.color,
      t0: this.chartTime(),
      x: l.x,
      y: l.hitY,
      big: grade === 'perfect' || grade === 'miss',
    });
    if (grade !== 'miss') this.flash(col);
  }

  private breakHold(col: number) {
    const holdIdx = this.holding[col];
    if (holdIdx === null || holdIdx === undefined || holdIdx < 0) return;
    this.completeHold(col, 'miss');
  }

  // ---------- sfx ----------
  private playHitSfx(n: NFChart['notes'][number]) {
    const s = this.skin;
    const sets = ['normal', 'soft', 'drum'] as const;
    const set = sets[n.sampleSet ?? 0] || 'normal';
    const kind = (n.sound ?? 0) & 2 ? 'finish' : (n.sound ?? 0) & 4 ? 'clap' : (n.sound ?? 0) & 1 ? 'whistle' : 'hit';
    const file = s?.hitsounds?.[set]?.[kind as 'hit'];
    if (file) {
      const data = this.getAsset(file);
      if (data) {
        this.audio.playFileOnce(data, file, { vol: this.settings.sfxVolume });
        return;
      }
    }
    this.audio.playSynth(kind as 'hit', this.settings.sfxVolume * 0.9);
  }

  private playMissSfx() {
    const file = this.skin?.misc?.combobreak;
    if (file) {
      const data = this.getAsset(file);
      if (data) {
        this.audio.playFileOnce(data, file, { vol: this.settings.sfxVolume * 0.7 });
        return;
      }
    }
    this.audio.playSynth('clap', this.settings.sfxVolume * 0.25);
  }

  // ---------- layout (512x384 osu-style space) ----------
  laneWidths(): number[] {
    const skin = this.skin;
    const w: number[] = [];
    for (let i = 0; i < this.keys; i++) {
      w.push(skin?.columns?.[i]?.width || skin?.columnWidth || 512 / this.keys);
    }
    return w;
  }

  laneStart(): number {
    // OSK ColumnStart belongs to osu's screen layout, not our centered 512px field.
    // Preserve lane widths, but center the complete playfield on every platform.
    return (512 - this.laneWidths().reduce((a, b) => a + b, 0)) / 2;
  }

  laneX(col: number): number {
    const widths = this.laneWidths();
    let x = this.laneStart();
    for (let i = 0; i < col; i++) x += widths[i];
    return x + widths[col] / 2;
  }

  hitY(): number {
    return this.skin?.hitPosition ?? 464;
  }

  layoutOf(col: number): { x: number; y: number; hitY: number; w: number; scale: number } {
    return { x: this.laneX(col), y: this.hitY(), hitY: this.hitY(), w: this.laneWidths()[col], scale: 1 };
  }

  // ---------- pause / seek ----------
  pause() {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.audio.pauseMusic();
    this.input.reset();
    if (this.videoEl) this.videoEl.pause();
  }

  resume() {
    if (this.phase !== 'paused') return;
    const pausedAt = this.chartTime();
    const target = Math.max(Math.min(0, this.initialTime()), pausedAt - 3000);
    this.rewindUntil = Math.max(this.rewindUntil, pausedAt);
    for (let col = 0; col < this.keys; col++) {
      if (this.holding[col] !== null) {
        this.holdResumeAt[col] = Math.max(this.holdResumeAt[col], pausedAt - this.settings.inputOffset);
      }
    }
    this.popups = [];
    this.particles = [];
    this.colFlash.fill(0);
    this.audio.seekMusic((target + this.settings.audioOffset) / 1000);
    this.phase = 'playing';
    this.audio.resumeMusic();
    if (this.videoEl && this.videoReady) {
      const duration = this.videoEl.duration;
      this.videoEl.currentTime = duration > 0 ? Math.max(0, (target + this.settings.audioOffset) / 1000) % duration : 0;
    }
    this.sb?.warm(target);
    if (this.videoEl && this.videoReady) this.videoEl.play().catch(() => undefined);
  }

  rewindRemainingMs(): number {
    return Math.max(0, this.rewindUntil - this.chartTime());
  }

  retry() {
    this.audio.stopMusic();
    this.musicStarted = false;
    this.judged = this.notes.map(() => false);
    this.colPtr = new Array(this.keys).fill(0);
    this.holding = new Array(this.keys).fill(null);
    this.nextHoldTick = new Array(this.keys).fill(0);
    this.holdResumeAt = new Array(this.keys).fill(-Infinity);
    this.rewindUntil = -Infinity;
    this.input.reset();
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.hp = 100;
    this.counts = { perfect: 0, great: 0, good: 0, ok: 0, bad: 0, miss: 0, holdTicks: 0 };
    this.accSum = 0;
    this.accDen = 0;
    this.popups = [];
    this.particles = [];
    this.finishPending = false;
    this.colFlash.fill(0);
    this.comboPulse = 0;
    this.beginPlay();
  }

  quit() {
    this.audio.stopMusic();
    this.audio.stopPreview();
    this.phase = 'finished';
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.videoEl.load();
    }
  }

  trySkip(): boolean {
    if (this.phase !== 'playing') return false;
    if (this.canSkipOutro()) { this.finish(); return true; }
    if (this.canSkipIntro()) {
      this.audio.seekMusic((this.notes[0].t - 3000 + this.settings.audioOffset) / 1000);
      this.introSkipped = true;
      return true;
    }
    const t = this.chartTime();
    for (const b of this.chart.breaks) {
      if (t >= b.t && t <= b.end) {
        this.audio.seekMusic((b.end + this.settings.audioOffset) / 1000);
        return true;
      }
    }
    return false;
  }

  inBreak(): boolean {
    const t = this.chartTime();
    return this.chart.breaks.some((b) => t >= b.t && t <= b.end);
  }

  canSkipIntro(): boolean {
    return this.phase === 'playing' && this.notes.length > 0 && this.notes[0].t > 6500 && this.chartTime() < this.notes[0].t - 3000;
  }

  canSkipOutro(): boolean {
    return this.phase === 'playing' && this.notes.length > 0 && this.chartTime() >= this.lastNoteEnd && this.notesSettled();
  }

  finish() {
    this.finishPending = true;
    this.phase = 'finished';
    this.audio.stopMusic();
    if (this.videoEl) this.videoEl.pause();
  }

  accuracy(): number {
    return this.accDen > 0 ? this.accSum / (320 * this.accDen) : 1;
  }

  grade(): string {
    if (this.phase === 'failed' || this.hp <= 0) return 'F';
    const acc = this.accuracy();
    if (acc >= 0.9999 && this.counts.miss === 0 && this.counts.bad === 0 && this.counts.ok === 0) return 'SS';
    if (acc >= 0.95) return 'S';
    if (acc >= 0.9) return 'A';
    if (acc >= 0.8) return 'B';
    if (acc >= 0.7) return 'C';
    return 'D';
  }

  isRanked(): boolean {
    return !this.mods.auto && !this.mods.mirror && !this.mods.random;
  }

  buildResult(): PlayResult {
    const acc = this.accuracy();
    const pp = this.isRanked() ? computePP(this.stars, acc, this.lengthMs, this.modsUsed()) : 0;
    return {
      chartId: this.chart.id || 'local',
      keys: this.keys,
      score: this.score,
      acc,
      maxCombo: this.maxCombo,
      counts: { ...this.counts },
      stars: this.stars,
      pp,
      grade: this.grade(),
      mods: this.modsUsed(),
      passed: this.hp > 0 && this.phase !== 'failed',
      playedAt: Date.now(),
      title: this.chart.meta.title,
      version: this.chart.meta.version,
      durationMs: this.lengthMs,
    };
  }

  modsUsed(): string[] {
    const out: string[] = [];
    if (this.mods.auto) out.push('Auto');
    if (this.mods.mirror) out.push('Mirror');
    if (this.mods.random) out.push('Random');
    if (this.mods.hidden) out.push('Hidden');
    if (this.mods.fadeIn) out.push('FadeIn');
    if (this.mods.flashlight) out.push('Flashlight');
    if (this.mods.noFail) out.push('NoFail');
    if (this.mods.downScroll) out.push('DownScroll');
    if (this.mods.constantSpeed) out.push('ConstantSpeed');
    if (this.mods.speed !== 1) out.push(`Speed x${this.mods.speed.toFixed(2)}`);
    return out;
  }

  dispose() {
    this.input.detach(window);
    this.audio.stopMusic();
    this.audio.stopPreview();
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.videoEl.load();
      this.videoEl.remove();
      this.videoEl = null;
    }
  }
}
