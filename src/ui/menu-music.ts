// One owner for menu BGM and library preview; screen changes never create parallel players.
import type { App } from './app.ts';
import type { ChartEntry } from '../core/store.ts';
import { readNFM } from '../core/nfm.ts';
import { drawProgress, fillPanel, text } from './theme.ts';
import { fmtTime } from '../core/zip.ts';
import { listPlaybackCharts } from '../api/library.ts';
import { groupSongs, songKey } from './song-groups.ts';
import type { NFTimingPoint, NFBreak } from '../core/types.ts';
import { drawAvatar } from './avatar-art.ts';
import { tr } from './i18n.ts';

export interface MenuVisual {
  bands: Float32Array;
  pulse: number;
  energy: number;
  position: number;
  leftImpact: number;
  rightImpact: number;
  sectionBurst: number;
  fountainAgeMs?: number;
  fountainSeed?: number;
  previewSection: boolean;
  reducedMotion?: boolean;
}

/** Authored effect markers take precedence; fallback sections last 30 seconds. */
export function menuHighlightRanges(
  chart: { kiai?: readonly NFBreak[]; meta: { previewTime?: number; previewSource?: string } },
  durationMs: number,
  audioHighlight: () => number = () => 0,
): NFBreak[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const clampTime = (value: number) => Math.max(0, Math.min(durationMs, value));
  const ranges = (Array.isArray(chart.kiai) ? chart.kiai : [])
    .filter(range => range && Number.isFinite(range.t) && Number.isFinite(range.end) && range.end > range.t)
    .map(range => ({ t: clampTime(range.t), end: clampTime(range.end) }))
    .filter(range => range.end > range.t).sort((a, b) => a.t - b.t || a.end - b.end);
  if (ranges.length) {
    const merged: NFBreak[] = [];
    for (const range of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && range.t <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push(range);
    }
    return merged;
  }
  const preview = chart.meta.previewTime;
  const authored = chart.meta.previewSource !== 'generated' && Number.isFinite(preview) && preview! >= 0;
  let start = preview ?? 0;
  if (!authored) { try { start = audioHighlight(); } catch { start = 0; } }
  if (!Number.isFinite(start)) start = 0;
  start = clampTime(start);
  return start < durationMs ? [{ t: start, end: Math.min(durationMs, start + 30000) }] : [];
}

export class MenuMusic {
  entry: ChartEntry | null = null;
  private playingEntry: ChartEntry | null = null;
  loading = false;
  error = '';
  background: HTMLImageElement | null = null;
  private backgroundFrom: HTMLCanvasElement | null = null;
  private backgroundChangedAt = 0;
  private readonly backgroundFadeMs = 1000;
  private timing: NFTimingPoint[] = [];
  private pulse = 0;
  private previousBass = 0;
  private generation = 0;
  private enabled = false;
  private starting: Promise<void> | null = null;
  private observedLoops = 0;
  private autoAdvancing = false;
  private loopPolicy: 'playlist' | 'single' = 'playlist';
  private highlightRanges: NFBreak[] = [];
  private lastVisualTime = -1;
  private leftImpact = 0;
  private rightImpact = 0;
  private sectionBurst = 0;
  private fountainStartedAt = -1;
  private fountainSeed = 0;
  private lastHighlightStart: number | null = null;
  private pendingFountainStart: number | null = null;
  private lastPreviewRevision: number | null = null;
  private lastVisualLoops = 0;
  private awaitingPreviewUnlock = false;
  private lastEdgeEvent = '';
  private edgeStrength = 0;
  private silentBands = new Float32Array(17);
  private motionPreference: MediaQueryList | null = null;
  constructor(private app: App) {}

  /** Pre-game navigation shares one preview source, clock and user pause state. */
  setScreen(name: string) {
    // Returning from a submenu must not replay an entry which happened offscreen.
    this.resetFountainObservation();
    if (name === 'menu' || name === 'select') {
      this.loopPolicy = name === 'menu' ? 'playlist' : 'single';
      this.observedLoops = this.app.audio.previewLoopCount || 0;
    }
    this.setEnabled(name === 'menu' || name === 'select' || name === 'settings' || name === 'account' || name === 'import');
  }

  private resetFountainObservation() {
    const audio = this.app.audio;
    const timeMs = audio.previewTimeSec * 1000;
    this.lastVisualTime = Number.isFinite(timeMs) ? timeMs : -1;
    this.lastHighlightStart = this.highlightRanges.find(range => timeMs >= range.t && timeMs < range.end)?.t ?? null;
    this.lastPreviewRevision = audio.previewTimelineRevision ?? null;
    this.lastVisualLoops = audio.previewLoopCount || 0;
    this.pendingFountainStart = null;
    this.fountainStartedAt = -1;
    this.awaitingPreviewUnlock = false;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      ++this.generation;
      this.loading = false;
      this.starting = null;
      this.observedLoops = 0;
      this.app.audio.stopPreview();
    } else void this.ensureStarted();
  }

  /** Keep the radio progressing even on submenus that do not draw its controls. */
  update() {
    if (!this.enabled) return;
    const loops = this.app.audio.previewLoopCount || 0;
    const finished = loops > this.observedLoops;
    this.observedLoops = loops;
    if (!finished || this.loopPolicy !== 'playlist' || this.loading || this.autoAdvancing || !this.app.audio.previewActive) return;
    this.autoAdvancing = true;
    void this.next(true).catch(() => undefined).finally(() => { this.autoAdvancing = false; });
  }

  async ensureStarted(): Promise<void> {
    if (!this.enabled || this.loading || this.app.audio.previewActive || this.app.audio.isPreviewPaused) return;
    if (this.entry) return this.select(this.entry);
    if (this.starting) return this.starting;
    const generation = this.generation;
    const starting = (async () => {
      const entries = await this.list();
      if (!this.enabled || generation !== this.generation || this.entry || !entries.length) return;
      const songs = groupSongs(entries);
      await this.select(songs[0].charts[0], true);
    })().catch(e => { if (generation === this.generation) this.error = String(e?.message || e); }).finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private async list(): Promise<ChartEntry[]> {
    return listPlaybackCharts(this.app);
  }

  /** Keep audible audio while invalidating downloads tied to the old server. */
  connectionChanged() {
    ++this.generation;
    this.loading = false; this.starting = null;
    this.app.audio.cancelPreviewLoad?.();
    // The decoded song remains playable; keep its metadata and transport
    // controls without retaining an old-server entry as a new download target.
    this.entry = this.playingEntry && !this.playingEntry.server ? this.playingEntry : null;
    this.error = '';
    void this.ensureStarted();
  }

  async select(entry: ChartEntry, fromStart = false): Promise<void> {
    if (!this.enabled) return;
    if (this.entry?.id === entry.id && !!this.entry.server === !!entry.server && (this.loading || this.app.audio.previewActive || this.app.audio.isPreviewPaused)) return;
    if (!this.loading && this.entry && songKey(this.entry) === songKey(entry) && (this.app.audio.previewActive || this.app.audio.isPreviewPaused)) {
      this.entry = entry; // selecting another difficulty keeps the recording and clock running
      this.playingEntry = entry;
      return;
    }
    const previousEntry = this.loading ? this.playingEntry : this.entry, previousTiming = this.timing;
    const token = ++this.generation;
    this.entry = entry;
    this.loading = true;
    this.error = '';
    // Invalidate old decodes, keeping the audible song until its replacement is ready.
    if (this.app.audio.cancelPreviewLoad) this.app.audio.cancelPreviewLoad();
    else this.app.audio.stopPreview();
    try {
      const bytes = entry.server ? await this.app.server.downloadChart(entry.id) : await this.app.store.getChartBytes(entry.id);
      if (token !== this.generation || !this.enabled) return;
      if (!bytes) throw new Error('chart data not found');
      const archive = readNFM(bytes);
      const audio = archive.files.get(archive.chart.meta.audio);
      if (!audio) throw new Error('chart audio missing');
      const timing = archive.chart.timing.filter(point => Number.isFinite(point.t) && point.bpm > 0).sort((a, b) => a.t - b.t);
      const background = archive.chart.meta.bg ? archive.files.get(archive.chart.meta.bg) : undefined;
      const imageReady = this.loadBackground(background);
      this.app.audio.stopAmbient();
      const started = await this.app.audio.previewMusic(audio, entry.id, fromStart ? 0 : Math.max(0, archive.chart.meta.previewTime), this.app.settings.previewVolume);
      if (token !== this.generation || !this.enabled) return;
      if (started === false || !this.app.audio.previewActive) throw new Error('Could not decode audio');
      const highlightRanges = menuHighlightRanges(archive.chart, this.app.audio.previewDurationSec * 1000,
        () => this.app.audio.previewHighlightMs?.() ?? 0);
      this.timing = timing;
      this.playingEntry = entry;
      this.observedLoops = this.app.audio.previewLoopCount || 0;
      this.highlightRanges = highlightRanges;
      this.app.previewChart = { id: entry.id, archive };
      this.resetFountainObservation();
      // Starting a recording at its preview is an entry, including when that
      // preview lies inside an authored or audio-computed kiai range. Wait for
      // the first audible sample rather than losing it during analyser warmup.
      this.pendingFountainStart = this.lastHighlightStart;
      this.awaitingPreviewUnlock = this.app.audio.ctx?.state === 'suspended';
      this.lastEdgeEvent = '';
      this.pulse = this.previousBass = this.leftImpact = this.rightImpact = this.sectionBurst = 0;
      // Keep the previous artwork while network/audio/image decoding is in flight.
      void imageReady.then(image => { if (token === this.generation && this.enabled) this.changeBackground(image); });
    } catch (e: any) {
      if (token === this.generation) { this.error = e?.message || String(e); this.entry = previousEntry; this.timing = previousTiming; }
    } finally {
      if (token === this.generation) this.loading = false;
    }
  }

  private loadBackground(bytes: Uint8Array | undefined): Promise<HTMLImageElement | null> {
    if (!bytes || typeof Image === 'undefined') return Promise.resolve(null);
    return new Promise(resolve => {
      const image = new Image();
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      image.src = url;
    });
  }

  private changeBackground(image: HTMLImageElement | null, now = performance.now()) {
    if (image === this.background) return;
    // Snapshot the visible blend so a second skip during a fade never flashes or jumps.
    if ((this.background || this.backgroundFrom) && typeof document !== 'undefined') {
      const frame = document.createElement('canvas');
      frame.width = Math.max(1, Math.round(Math.min(this.app.w, 1920)));
      frame.height = Math.max(1, Math.round(frame.width * this.app.h / this.app.w));
      const ctx = frame.getContext('2d');
      if (ctx) { this.drawBackgroundFrame(ctx, frame.width, frame.height, now); this.backgroundFrom = frame; }
    }
    this.background = image;
    this.backgroundChangedAt = now;
  }

  private drawBackgroundFrame(ctx: CanvasRenderingContext2D, w: number, h: number, now: number) {
    const p = Math.max(0, Math.min(1, (now - this.backgroundChangedAt) / this.backgroundFadeMs));
    const fade = p * p * (3 - 2 * p);
    ctx.save();
    ctx.fillStyle = '#0d1218'; ctx.fillRect(0, 0, w, h);
    if (this.backgroundFrom && p < 1) ctx.drawImage(this.backgroundFrom, 0, 0, w, h);
    const image = this.background;
    ctx.globalAlpha = fade;
    if (image?.complete && image.naturalWidth > 0) {
      const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight) * (1.025 + .02 * (1 - fade));
      ctx.drawImage(image, (w - image.naturalWidth * scale) / 2, (h - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
    } else {
      ctx.fillStyle = '#0d1218'; ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number, now = performance.now()) {
    this.drawBackgroundFrame(ctx, w, h, now);
    // Darken the composite once; dimming each image separately causes a brightness dip mid-fade.
    ctx.save();
    ctx.fillStyle = 'rgba(8,14,19,0.60)'; ctx.fillRect(0, 0, w, h);
    const shade = ctx.createLinearGradient(0, 0, w, h * .25);
    shade.addColorStop(0, 'rgba(10,17,22,0.82)');
    shade.addColorStop(.5, 'rgba(10,17,22,0.44)');
    shade.addColorStop(1, 'rgba(10,17,22,0.12)');
    ctx.fillStyle = shade; ctx.fillRect(0, 0, w, h);
    const bottom = ctx.createLinearGradient(0, h * .5, 0, h);
    bottom.addColorStop(0, 'rgba(10,17,22,0)'); bottom.addColorStop(1, 'rgba(10,17,22,0.64)');
    ctx.fillStyle = bottom; ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  async next(automatic = false) {
    const token = this.generation;
    const entries = await this.list().catch(() => []);
    if (!this.enabled || token !== this.generation || (automatic && this.loopPolicy !== 'playlist')) return;
    const songs = groupSongs(entries);
    const current = songs.findIndex(song => song.key === songKey(this.entry ?? this.playingEntry));
    if (songs.length > 1 || (songs.length && current < 0)) await this.select(songs[(current + 1) % songs.length].charts[0], true);
    // A library containing one recording keeps playing instead of restarting it.
  }

  /** Beat phase follows the audio clock (including pause/seek), with real bass transients. */
  visualizer(dt: number): MenuVisual {
    const sample = this.app.audio.samplePreviewSpectrum?.() ?? { bands: new Float32Array(17), bass: 0, energy: 0 };
    const audio = this.app.audio;
    const timeMs = audio.previewTimeSec * 1000;
    let point: NFTimingPoint | undefined;
    for (const candidate of this.timing) { if (candidate.t > timeMs) break; point = candidate; }
    if (!this.motionPreference && typeof window !== 'undefined' && typeof window.matchMedia === 'function') this.motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reducedMotion = this.motionPreference?.matches === true;
    const section = this.highlightRanges.find(range => timeMs >= range.t && timeMs < range.end);
    const elapsed = Math.max(0, dt);
    const advanced = timeMs - this.lastVisualTime;
    const revision = audio.previewTimelineRevision;
    const tracksTransport = typeof revision === 'number';
    // App caps dt at 50ms. Use explicit transport changes so ordinary frame
    // stalls cannot be mistaken for a seek. Keep a fallback for older adapters.
    const jumped = tracksTransport
      ? this.lastPreviewRevision !== null && revision !== this.lastPreviewRevision
      : this.lastVisualTime >= 0 && (advanced < 0 || advanced > Math.max(120, elapsed * 2 + 50));
    const loops = audio.previewLoopCount || 0;
    const looped = tracksTransport && !jumped && loops > this.lastVisualLoops;
    const playbackEnabled = audio.previewActive && audio.ctx?.state === 'running' && (this.app.settings?.previewVolume ?? 1) > 0;
    // settings.particles controls gameplay hit particles, not menu fountains.
    const fountainEnabled = playbackEnabled && !reducedMotion;
    // A fresh preview can be waiting for the browser's first user gesture.
    // Its frozen start is not an already-played entry; preserve only that
    // pending entry, never a fountain suspended later during playback.
    const waitingForUnlock = this.awaitingPreviewUnlock && audio.ctx?.state === 'suspended' && audio.previewActive
      && (this.app.settings?.previewVolume ?? 1) > 0 && !reducedMotion;
    if ((!fountainEnabled && !waitingForUnlock) || jumped) {
      this.pendingFountainStart = null;
      this.fountainStartedAt = -1;
      this.awaitingPreviewUnlock = false;
    } else if ((section?.t ?? null) !== this.lastHighlightStart || looped) {
      this.pendingFountainStart = null;
      // A real crossing remains an entry after a delayed frame. The 500ms
      // window is only for a first observation without a known crossing.
      const crossed = section && this.lastVisualTime >= 0 && this.lastVisualTime < section.t;
      const nearStart = section && timeMs - section.t < 500;
      if (section && (crossed || nearStart || looped)) this.pendingFountainStart = section.t;
    }
    if (!section || this.pendingFountainStart !== section.t) this.pendingFountainStart = null;
    this.lastHighlightStart = section?.t ?? null;
    this.lastPreviewRevision = tracksTransport ? revision : null;
    this.lastVisualLoops = loops;
    this.lastVisualTime = timeMs;
    if (audio.ctx?.state === 'running') this.awaitingPreviewUnlock = false;
    // Playback drives the spectrum/icon independently of decorative effects.
    // The particle setting must not turn an audible song into a silent sample.
    const audible = playbackEnabled && sample.energy > 0.015;
    if (!audible) {
      this.pulse = this.previousBass = this.leftImpact = this.rightImpact = this.sectionBurst = 0;
      // Silence hides effects, but does not consume a pending entry. An active
      // fountain keeps its original age across short gaps and never restarts.
      this.lastEdgeEvent = '';
      return { bands: this.silentBands, pulse: 0, energy: 0, position: audio.previewTimeSec || 0,
        leftImpact: 0, rightImpact: 0, sectionBurst: 0, fountainAgeMs: -1, fountainSeed: this.fountainSeed, previewSection: false, reducedMotion };
    }
    const beatMs = point ? 60000 / point.bpm : 500;
    const beatIndex = point ? Math.floor((timeMs - point.t) / beatMs) : 0;
    const phaseMs = point ? ((timeMs - point.t) % beatMs + beatMs) % beatMs : 0;
    const previewSection = !!section;
    if (fountainEnabled && section && this.pendingFountainStart === section.t) {
      this.fountainStartedAt = timeMs;
      this.fountainSeed++;
      this.pendingFountainStart = null;
    }
    let beat = 0;
    if (point) {
      beat = Math.exp(-phaseMs / 105) * Math.min(1, sample.energy * 1.8);
    }
    const onset = Math.max(0, sample.bass - this.previousBass) * 4;
    this.previousBass = sample.bass;
    this.pulse = Math.max(beat, Math.min(1, onset), this.pulse * Math.exp(-elapsed / 150));
    // The edges follow beat events, never off-beat bass onsets: two beats per
    // simultaneous pair normally; one alternating side per beat during kiai.
    const parity = (beatIndex % 2 + 2) % 2;
    const slot = previewSection ? beatIndex : Math.floor(beatIndex / 2);
    const edgeEvent = `${point?.t ?? 0}:${previewSection ? 'k' : 'n'}:${slot}`;
    if (edgeEvent !== this.lastEdgeEvent || jumped) {
      this.lastEdgeEvent = edgeEvent;
      this.edgeStrength = Math.min(1, sample.energy * 1.8);
    }
    const edgePhase = phaseMs + (previewSection ? 0 : parity * beatMs);
    // MenuSideFlashes fades out across one beat with an ease-in curve. The
    // normal two-beat cycle leaves the second beat clear; kiai swaps sides.
    const decay = Math.max(0, 1 - (edgePhase / beatMs) ** 2);
    const impact = point && beatIndex >= 0 && !reducedMotion
      ? this.edgeStrength * decay * (previewSection ? 1 : .58) : 0;
    this.leftImpact = !previewSection || parity === 0 ? impact : 0;
    this.rightImpact = !previewSection || parity === 1 ? impact : 0;
    this.sectionBurst = 0; // The old angular/triangle effect has been removed.
    let fountainAgeMs = this.fountainStartedAt < 0 ? -1 : timeMs - this.fountainStartedAt;
    if (fountainAgeMs < 0 || fountainAgeMs >= 1800) { this.fountainStartedAt = -1; fountainAgeMs = -1; }
    return { bands: sample.bands, pulse: this.pulse, energy: sample.energy, position: audio.previewTimeSec || 0,
      leftImpact: this.leftImpact, rightImpact: this.rightImpact, sectionBurst: 0, fountainAgeMs, fountainSeed: this.fountainSeed, previewSection, reducedMotion };
  }

  draw(ctx: CanvasRenderingContext2D) {
    const app = this.app;
    const menu = app.screen?.name === 'menu';
    const margin = app.w < 520 ? 12 : 20;
    const w = menu ? Math.min(340, app.w < 520 ? app.w - 140 : app.w * .52) : Math.min(340, app.w - 32);
    const x = app.w - w - margin, y = 16;
    if (menu) this.drawProfile(ctx, x, y, margin);
    fillPanel(ctx, x, y, w, 88, { r: 16, fill: 'rgba(20,30,36,0.97)', line: 'rgba(174,199,218,0.16)' });
    const audio = app.audio;
    const displayedEntry = this.entry ?? this.playingEntry;
    const blocked = audio.previewActive && audio.ctx?.state === 'suspended';
    text(ctx, this.loading ? 'LOADING AUDIO' : blocked ? 'Tap play to enable audio' : 'NOW PLAYING', x + 16, y + 17, { size: 9, spacing: '1.5px', color: '#87a4b5', weight: 700 });
    ctx.save(); ctx.beginPath(); ctx.rect(x + 16, y + 22, w - 110, 20); ctx.clip();
    text(ctx, displayedEntry?.title || 'No songs yet. Import a chart.', x + 16, y + 37, { size: 13, color: '#e9f0f4', weight: 600 });
    ctx.restore();
    if (app.ui.button('music-toggle', x + w - 88, y + 13, 32, 30, audio.previewActive && !blocked ? 'Ⅱ' : '▶', { small: true, disabled: (!this.entry && !audio.previewActive && !audio.isPreviewPaused) || this.loading })) {
      if (blocked) audio.resume();
      else if (audio.previewActive) audio.pausePreview();
      else if (audio.isPreviewPaused) audio.resumePreview();
      else if (this.entry) void this.select(this.entry);
    }
    if (app.ui.button('music-next', x + w - 48, y + 13, 32, 30, '»', { small: true, disabled: this.loading })) void this.next().catch(() => undefined);
    const duration = audio.previewDurationSec, position = audio.previewTimeSec;
    const trackW = w - 104;
    drawProgress(ctx, x + 16, y + 57, trackW, 3, duration ? position / duration : 0, '#b6d8bd', '#9db9aa');
    if (duration && app.ui.hover('music-seek', x + 16, y + 48, trackW, 18) && app.ui.p.down) audio.seekPreview((app.ui.p.x - x - 16) / trackW * duration);
    text(ctx, `${fmtTime(position * 1000)} / ${fmtTime(duration * 1000)}`, x + w - 16, y + 59, { size: 9, align: 'right', color: '#9aaebf' });
    ctx.save(); ctx.beginPath(); ctx.rect(x + 16, y + 65, w - 32, 17); ctx.clip();
    text(ctx, this.error || (displayedEntry ? displayedEntry.artist : 'LIBRARY RADIO'), x + 16, y + 77, { size: 9, color: this.error ? '#f0a6a6' : '#738a9a' });
    ctx.restore();
  }

  private drawProfile(ctx: CanvasRenderingContext2D, playerX: number, y: number, margin: number) {
    const app = this.app, w = Math.min(238, playerX - margin - 10), x = playerX - w - 10;
    if (w < 90) return;
    const user = app.account.user;
    const compact = w < 180;
    if (app.ui.button('music-profile', x, y, w, 88, '')) { app.uiSound(); app.gotoScreen('account'); }
    fillPanel(ctx, x, y, w, 88, { r: 16, fill: 'rgba(20,30,36,0.92)', line: 'rgba(174,199,218,0.16)' });
    drawAvatar(ctx, app, user, x + 12, y + (compact ? 10 : 17), compact ? 30 : 46);
    const tx = x + (compact ? 12 : 72), tw = w - (compact ? 24 : 84);
    text(ctx, user?.nickname || user?.username || 'GUEST', tx, y + (compact ? 54 : 29), { size: compact ? 11 : 13, weight: 600, color: '#e9f0f4', maxWidth: tw, translate: !user });
    text(ctx, `${Number(user?.rating || 0).toFixed(2)}  ·  ${tr('RATING')}`, tx, y + (compact ? 73 : 50), { size: compact ? 9 : 10, color: '#b9cfc2', maxWidth: tw, translate: false });
    const online = app.serverOnline;
    const statusX = compact ? x + w - 16 : tx + 3, statusY = y + (compact ? 19 : 68);
    ctx.beginPath(); ctx.arc(statusX, statusY, 3, 0, Math.PI * 2); ctx.fillStyle = online ? '#add3b6' : '#6b7984'; ctx.fill();
    if (!compact) text(ctx, online ? 'CONNECTED' : 'NOT CONNECTED', tx + 13, y + 71, { size: 8, spacing: '.3px', color: online ? '#a2b9aa' : '#7c8b97', maxWidth: tw - 13 });
  }
}
