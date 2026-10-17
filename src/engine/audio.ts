// Low-latency WebAudio engine: music scheduling, preview, hitsounds, clock.
import type { Settings } from '../core/types.ts';
import { clamp } from '../core/zip.ts';

export class AudioEngine {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  musicGain: GainNode | null = null;
  sfxGain: GainNode | null = null;

  private musicBuffer: AudioBuffer | null = null;
  private musicLoadToken = 0;
  private musicSrc: AudioBufferSourceNode | null = null;
  private musicStartCtx = 0;
  private musicStartSec = 0;
  private pausedSec = 0;
  private playing = false;
  private decodeCache = new Map<string, AudioBuffer>();
  private synthCache = new Map<string, AudioBuffer>();
  baseLatencyMs = 0;

  ensure(): AudioContext {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.connect(this.master);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.connect(this.master);
      this.baseLatencyMs = ((this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0)) * 1000;
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined);
    }
    return this.ctx;
  }

  applySettings(s: Settings) {
    if (!this.ctx || !this.musicGain || !this.sfxGain) return;
    this.musicGain.gain.value = s.musicVolume;
    this.sfxGain.gain.value = s.sfxVolume;
    if (this.master) this.master.gain.value = 1;
  }

  async decode(bytes: Uint8Array, key: string): Promise<AudioBuffer> {
    const cached = this.decodeCache.get(key);
    if (cached) return cached;
    const ctx = this.ensure();
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let buf: AudioBuffer;
    try {
      buf = await ctx.decodeAudioData(ab);
    } catch {
      // some browsers fail on raw ArrayBuffer for certain containers; retry on a fresh copy
      const copy = new Uint8Array(bytes);
      buf = await ctx.decodeAudioData(
        copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
      );
    }
    if (this.decodeCache.size > 24) this.decodeCache.clear();
    this.decodeCache.set(key, buf);
    return buf;
  }

  async loadMusic(bytes: Uint8Array, key: string, signal?: AbortSignal) {
    const token = ++this.musicLoadToken;
    if (signal?.aborted) return;
    const buffer = await this.decode(bytes, key);
    if (token === this.musicLoadToken && !signal?.aborted) this.musicBuffer = buffer;
  }

  get isMusicLoaded(): boolean {
    return !!this.musicBuffer;
  }

  get musicDurationMs(): number {
    return (this.musicBuffer?.duration ?? 0) * 1000;
  }

  playMusic(fromSec = 0) {
    const ctx = this.ensure();
    this.stopMusicSrc();
    if (!this.musicBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.musicBuffer;
    src.connect(this.musicGain!);
    // The storyboard clock can run during a silent negative-time intro.
    // Schedule audio at its zero while retaining the negative clock on pause/seek.
    const clockStart = ctx.currentTime + 0.03;
    const when = clockStart + Math.max(0, -fromSec);
    src.start(when, Math.max(0, fromSec));
    this.musicSrc = src;
    this.musicStartCtx = clockStart;
    this.musicStartSec = fromSec;
    this.playing = true;
  }

  private stopMusicSrc() {
    if (this.musicSrc) {
      try {
        this.musicSrc.stop();
      } catch {
        /* already stopped */
      }
      this.musicSrc.disconnect();
      this.musicSrc = null;
    }
  }

  pauseMusic() {
    if (!this.playing) return;
    this.pausedSec = this.songTimeSec();
    this.stopMusicSrc();
    this.playing = false;
  }

  resumeMusic() {
    if (this.playing || !this.musicBuffer) return;
    this.playMusic(this.pausedSec);
  }

  stopMusic() {
    this.stopMusicSrc();
    this.playing = false;
    this.pausedSec = 0;
  }

  seekMusic(sec: number) {
    if (this.playing) this.playMusic(sec);
    else this.pausedSec = sec;
  }

  songTimeSec(): number {
    if (this.playing && this.ctx) {
      return this.musicStartSec + (this.ctx.currentTime - this.musicStartCtx);
    }
    return this.pausedSec;
  }

  songTimeMs(): number {
    return this.songTimeSec() * 1000;
  }

  /** one-shot sfx (hitsounds, ui clicks) — immediate, minimal latency */
  playBuffer(buf: AudioBuffer, opts?: { vol?: number; rate?: number; when?: number; gainNode?: GainNode }) {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (opts?.rate && Math.abs(opts.rate - 1) > 0.001) src.playbackRate.value = opts.rate;
    const g = ctx.createGain();
    g.gain.value = opts?.vol ?? 0.8;
    src.connect(g);
    g.connect(opts?.gainNode ?? this.sfxGain!);
    src.start(opts?.when ?? ctx.currentTime + 0.001);
  }

  async playFileOnce(bytes: Uint8Array, key: string, opts?: { vol?: number; rate?: number }) {
    try {
      const buf = await this.decode(bytes, key);
      this.playBuffer(buf, opts);
    } catch {
      /* undecodable sample — ignore */
    }
  }

  // ---------- synthesized default hitsounds ----------
  synth(kind: 'hit' | 'whistle' | 'finish' | 'clap' | 'tick' | 'ui' | 'count' | 'go'): AudioBuffer {
    const cached = this.synthCache.get(kind);
    if (cached) return cached;
    const ctx = this.ensure();
    const sr = ctx.sampleRate;
    let dur = 0.06;
    if (kind === 'whistle' || kind === 'count') dur = 0.14;
    if (kind === 'finish' || kind === 'go') dur = 0.3;
    if (kind === 'clap') dur = 0.05;
    if (kind === 'ui') dur = 0.07;
    const buf = ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d = buf.getChannelData(0);
    const expDecay = (t: number, tau: number) => Math.exp(-t / tau);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      let v = 0;
      switch (kind) {
        case 'hit':
          v = Math.sin(2 * Math.PI * 1040 * t) * expDecay(t, 0.02) + Math.sin(2 * Math.PI * 180 * t) * expDecay(t, 0.035) * 0.4;
          break;
        case 'tick':
          v = Math.sin(2 * Math.PI * 700 * t) * expDecay(t, 0.015) * 0.5;
          break;
        case 'whistle':
          v = Math.sin(2 * Math.PI * 1560 * t) * expDecay(t, 0.05) * 0.5;
          break;
        case 'finish':
          v = (Math.sin(2 * Math.PI * 660 * t) + Math.sin(2 * Math.PI * 990 * t) * 0.6) * expDecay(t, 0.12) * 0.4;
          break;
        case 'clap':
          v = (Math.random() * 2 - 1) * expDecay(t, 0.008) * 0.6;
          break;
        case 'ui':
          v = Math.sin(2 * Math.PI * 440 * t) * expDecay(t, 0.03) * 0.35;
          break;
        case 'count':
          v = Math.sin(2 * Math.PI * 880 * t) * expDecay(t, 0.07) * 0.4;
          break;
        case 'go':
          v = Math.sin(2 * Math.PI * 1320 * t) * expDecay(t, 0.16) * 0.45;
          break;
      }
      d[i] = v;
    }
    this.synthCache.set(kind, buf);
    return buf;
  }

  playSynth(kind: 'hit' | 'whistle' | 'finish' | 'clap' | 'tick' | 'ui' | 'count' | 'go', vol = 0.8) {
    this.playBuffer(this.synth(kind), { vol });
  }

  // ---------- preview ----------
  private previewSrc: AudioBufferSourceNode | null = null;
  private previewGain: GainNode | null = null;
  private previewToken = 0;
  private previewTransportRevision = 0;
  private previewBuffer: AudioBuffer | null = null;
  private previewStartCtx = 0;
  private previewOffset = 0;
  private previewLoopStart = 0;
  private previewVolume = 0;
  private previewDucking = 1;
  private previewPaused = false;
  private previewAnalysers: AnalyserNode[] = [];
  private previewSplitter: ChannelSplitterNode | null = null;
  private previewFrequency = new Uint8Array(512);
  private previewWaveform = new Uint8Array(1024);
  private previewBands = new Float32Array(17);
  private previewHighlights = new WeakMap<AudioBuffer, number>();

  /**
   * Find a 30-second high-energy section for charts without an authored preview.
   * Adjacent PCM differences emphasize high frequencies without needing an FFT,
   * AudioContext, new decoding, or any change to the current playback source.
   */
  previewHighlightMs(): number {
    const buffer = this.previewBuffer;
    if (!buffer) return 0;
    const cached = this.previewHighlights.get(buffer);
    if (cached !== undefined) return cached;
    let start = 0;
    try { start = this.analyzePreviewHighlight(buffer); } catch { /* An unavailable PCM buffer has no inferred highlight. */ }
    this.previewHighlights.set(buffer, start);
    return start;
  }

  private analyzePreviewHighlight(buffer: AudioBuffer): number {
    const durationMs = buffer.duration * 1000, frameCount = Math.floor(buffer.length);
    if (!Number.isFinite(durationMs) || durationMs <= 30000 || !Number.isFinite(frameCount) || frameCount < 2 || typeof buffer.getChannelData !== 'function') return 0;
    const channels = Math.min(2, Math.max(0, Math.floor(buffer.numberOfChannels)));
    if (!Number.isFinite(channels) || !channels) return 0;
    // Limit both CPU and allocations for long tracks and multichannel audio.
    const bins = Math.min(4096, Math.ceil(durationMs / 250)), binMs = durationMs / bins;
    const energy = new Float64Array(bins), counts = new Uint32Array(bins);
    const budgetPerChannel = Math.floor(131072 / channels);
    for (let channel = 0; channel < channels; channel++) {
      let pcm: Float32Array;
      try { pcm = buffer.getChannelData(channel); } catch { continue; }
      const frames = Math.min(frameCount, pcm.length), samples = Math.min(frames - 1, budgetPerChannel);
      if (!Number.isFinite(samples) || samples <= 0) continue;
      const step = (frames - 1) / samples;
      let phase = 0;
      for (let sample = 0; sample < samples; sample++) {
        // Deterministic jitter avoids always sampling the same phase of a sine
        // wave when its period happens to divide the downsampling stride.
        phase += .6180339887498949; if (phase >= 1) phase--;
        const index = Math.min(frames - 1, 1 + Math.floor((sample + phase) * step));
        const current = pcm[index], previous = pcm[index - 1];
        if (!Number.isFinite(current) || !Number.isFinite(previous)) continue;
        const a = clamp(current, -1, 1), b = clamp(previous, -1, 1);
        const bin = Math.min(bins - 1, Math.floor(index / frameCount * bins));
        energy[bin] += (a - b) ** 2 + .03 * a * a;
        counts[bin]++;
      }
    }
    // Piecewise-constant energy integral allows exact 30-second windows even
    // when the bounded time bins do not divide 30 seconds evenly.
    const integral = new Float64Array(bins + 1);
    for (let bin = 0; bin < bins; bin++) {
      energy[bin] = counts[bin] ? energy[bin] / counts[bin] : 0;
      integral[bin + 1] = integral[bin] + energy[bin] * binMs;
    }
    if (!(integral[bins] > 1e-9)) return 0;
    const at = (time: number) => {
      const bin = Math.min(bins - 1, Math.floor(time / binMs));
      return integral[bin] + energy[bin] * (time - bin * binMs);
    };
    const lastStart = durationMs - 30000;
    let bestStart = 0, bestEnergy = -1;
    const consider = (time: number) => {
      const start = clamp(time, 0, lastStart), sum = at(start + 30000) - at(start);
      if (sum > bestEnergy + 1e-9) { bestEnergy = sum; bestStart = start; }
    };
    // An optimum begins or ends at a bin boundary; also include the final span.
    for (let bin = 0; bin <= bins; bin++) { consider(bin * binMs); consider(bin * binMs - 30000); }
    return clamp(Math.round(bestStart), 0, lastStart);
  }

  /** Analyze only the preview bus, so UI sounds never make the menu beat. */
  samplePreviewSpectrum(): { bands: Float32Array; bass: number; energy: number } {
    this.previewBands.fill(0);
    if (!this.previewAnalysers.length || !this.previewSrc || this.ctx?.state !== 'running' || this.previewVolume <= 0) {
      return { bands: this.previewBands, bass: 0, energy: 0 };
    }
    let energy = 0;
    for (const analyser of this.previewAnalysers) {
      analyser.getByteFrequencyData(this.previewFrequency);
      analyser.getByteTimeDomainData(this.previewWaveform);
      const hzPerBin = this.ctx.sampleRate / analyser.fftSize;
      for (let band = 0; band < this.previewBands.length; band++) {
        const start = Math.max(1, Math.floor(40 * (11000 / 40) ** (band / this.previewBands.length) / hzPerBin));
        const end = Math.min(this.previewFrequency.length, Math.max(start + 1, Math.ceil(40 * (11000 / 40) ** ((band + 1) / this.previewBands.length) / hzPerBin)));
        let sum = 0;
        for (let i = start; i < end; i++) sum += this.previewFrequency[i] / 255;
        this.previewBands[band] = Math.max(this.previewBands[band], end > start ? sum / (end - start) : 0);
      }
      let rms = 0;
      for (const sample of this.previewWaveform) rms += ((sample - 128) / 128) ** 2;
      energy = Math.max(energy, Math.min(1, Math.sqrt(rms / this.previewWaveform.length) * 3));
    }
    return { bands: this.previewBands, bass: (this.previewBands[0] + this.previewBands[1] + this.previewBands[2] + this.previewBands[3]) / 4, energy };
  }

  /**
   * Song preview: plays from the preview point (or 0 if none) through the END of
   * the song, looping back to the preview point. Replaced atomically per call —
   * late-decoding buffers from a previous selection can never override the new one.
   */
  async previewMusic(bytes: Uint8Array, key: string, fromMs: number, volume: number) {
    const token = ++this.previewToken;
    let buf: AudioBuffer;
    try {
      buf = await this.decode(bytes, key);
    } catch {
      return false;
    }
    if (token !== this.previewToken) return false; // superseded while decoding
    this.previewBuffer = buf;
    this.previewLoopStart = clamp(Math.max(0, fromMs) / 1000, 0, Math.max(0, buf.duration - 0.1));
    this.previewVolume = volume;
    this.startPreviewAt(this.previewLoopStart, .3);
    return true;
  }

  private startPreviewAt(offset: number, fadeSeconds = .12) {
    const ctx = this.ensure();
    this.resume();
    this.stopPreviewSource(fadeSeconds);
    const buf = this.previewBuffer;
    if (!buf) return;
    const dur = buf.duration;
    const loopStart = this.previewLoopStart;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = loopStart;
    src.loopEnd = dur;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(Math.max(0, this.previewVolume * this.previewDucking), ctx.currentTime + fadeSeconds);
    // Analyze stereo channels separately: AnalyserNode's mono downmix would
    // cancel opposite-phase L/R audio even though both speakers are audible.
    // Keep the original stereo playback path and tap it before preview gain.
    if (typeof ctx.createAnalyser === 'function') {
      const channels = typeof ctx.createChannelSplitter === 'function' ? Math.max(1, Math.min(2, buf.numberOfChannels || 1)) : 1;
      const splitter = channels > 1 ? ctx.createChannelSplitter(channels) : null;
      if (splitter) { src.connect(g); src.connect(splitter); this.previewSplitter = splitter; }
      for (let channel = 0; channel < channels; channel++) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.62;
        analyser.minDecibels = -80;
        analyser.maxDecibels = -12;
        if (splitter) splitter.connect(analyser, channel);
        else { src.connect(analyser); analyser.connect(g); }
        this.previewAnalysers.push(analyser);
      }
    } else src.connect(g);
    g.connect(this.master!); // preview volume independent of music gain
    const start = clamp(offset, 0, Math.max(0, dur - 0.01));
    this.previewStartCtx = ctx.currentTime + 0.02;
    this.previewOffset = start;
    this.previewPaused = false;
    src.start(this.previewStartCtx, start);
    this.previewSrc = src;
    this.previewGain = g;
    this.previewTransportRevision++;
  }

  private stopPreviewSource(fadeSeconds = .08) {
    const src = this.previewSrc;
    const g = this.previewGain;
    const analysers = this.previewAnalysers;
    const splitter = this.previewSplitter;
    this.previewSrc = null;
    this.previewGain = null;
    this.previewAnalysers = [];
    this.previewSplitter = null;
    if (!src) return;
    try {
      const ctx = this.ctx!;
      if (g && ctx.state !== 'closed') {
        g.gain.cancelScheduledValues(ctx.currentTime);
        g.gain.setValueAtTime(Math.max(0, g.gain.value), ctx.currentTime);
        g.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeSeconds);
      }
      setTimeout(() => {
        try {
          src.stop();
          src.disconnect();
        } catch {
          /* noop */
        }
        try {
          g?.disconnect();
          for (const analyser of analysers) analyser.disconnect();
          splitter?.disconnect();
        } catch {
          /* noop */
        }
      }, fadeSeconds * 1000 + 40);
    } catch {
      try {
        src.stop();
      } catch {
        /* noop */
      }
    }
  }

  cancelPreviewLoad() { this.previewToken++; }

  stopPreview() {
    this.previewToken++; // cancel any in-flight decode
    this.previewTransportRevision++;
    this.stopPreviewSource();
    this.previewBuffer = null;
    this.previewOffset = 0;
    this.previewPaused = false;
  }

  pausePreview() {
    if (!this.previewSrc) return;
    this.previewTransportRevision++;
    this.previewOffset = this.previewTimeSec;
    this.previewPaused = true;
    this.stopPreviewSource();
  }

  resumePreview() {
    if (this.previewBuffer && !this.previewSrc) this.startPreviewAt(this.previewOffset);
  }

  seekPreview(sec: number) {
    if (!this.previewBuffer) return;
    const offset = clamp(sec, 0, Math.max(0, this.previewBuffer.duration - 0.01));
    if (this.previewPaused) { this.previewOffset = offset; this.previewTransportRevision++; }
    else this.startPreviewAt(offset);
  }

  setPreviewVolume(volume: number) {
    this.previewVolume = Math.max(0, volume);
    if (this.previewGain && this.ctx) {
      this.previewGain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.previewGain.gain.setValueAtTime(this.previewVolume * this.previewDucking, this.ctx.currentTime);
    }
  }

  /** Temporarily lower BGM during tap calibration without pausing its clock. */
  setPreviewDucking(multiplier: number) {
    const next = Number.isFinite(multiplier) ? clamp(multiplier, 0, 1) : 1;
    if (next === this.previewDucking) return;
    this.previewDucking = next;
    if (this.previewGain && this.ctx) {
      const gain = this.previewGain.gain, now = this.ctx.currentTime;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(this.previewVolume * next, now + .12);
    }
  }

  get previewTimeSec(): number {
    if (!this.previewSrc || !this.ctx || !this.previewBuffer) return this.previewOffset;
    const t = this.previewOffset + Math.max(0, this.ctx.currentTime - this.previewStartCtx);
    const duration = this.previewBuffer.duration;
    const span = duration - this.previewLoopStart;
    return t < duration || span <= 0 ? t : this.previewLoopStart + (t - duration) % span;
  }

  get previewDurationSec(): number { return this.previewBuffer?.duration ?? 0; }
  /** Changes only on transport actions, never on a slow frame or a natural loop. */
  get previewTimelineRevision(): number { return this.previewTransportRevision; }
  /** Completed loops of this source; a user seek/resume starts a new source. */
  get previewLoopCount(): number {
    if (!this.previewSrc || !this.ctx || !this.previewBuffer) return 0;
    const elapsed = this.previewOffset + Math.max(0, this.ctx.currentTime - this.previewStartCtx);
    const duration = this.previewBuffer.duration, span = duration - this.previewLoopStart;
    return elapsed < duration || span <= 0 ? 0 : Math.floor((elapsed - duration) / span) + 1;
  }
  get isPreviewPaused(): boolean { return this.previewPaused; }

  get previewActive(): boolean {
    return this.previewSrc !== null;
  }

  get previewInfo(): { loopStart: number; loopEnd: number } | null {
    if (!this.previewSrc) return null;
    return { loopStart: this.previewSrc.loopStart, loopEnd: this.previewSrc.loopEnd };
  }

  // ---------- ambient menu music (synthesized) ----------
  private ambientSrc: AudioBufferSourceNode | null = null;
  private ambientGain: GainNode | null = null;

  private makeAmbient(): AudioBuffer {
    const ctx = this.ensure();
    const sr = ctx.sampleRate;
    const dur = 16;
    const buf = ctx.createBuffer(2, Math.floor(sr * dur), sr);
    // chord progression: Am / F / C / G — soft sine-pad with slow tremolo
    const chords: number[][] = [
      [110, 164.81, 220, 261.63],
      [87.31, 130.81, 174.61, 220],
      [130.81, 164.81, 196, 261.63],
      [98, 123.47, 146.83, 196],
    ];
    for (let ch = 0; ch < 4; ch++) {
      const t0 = ch * 4;
      const len = 4.4;
      for (const f of chords[ch]) {
        for (const [mult, amp] of [[1, 0.045], [2, 0.016], [3, 0.007]] as const) {
          const data0 = buf.getChannelData(0);
          const data1 = buf.getChannelData(1);
          const start = Math.floor(t0 * sr);
          const end = Math.min(buf.length, Math.floor((t0 + len) * sr));
          const pan = (f * mult) % 2 < 1 ? 0.55 : 0.45;
          for (let i = start; i < end; i++) {
            const t = i / sr - t0;
            const env = Math.min(1, t / 1.2) * Math.min(1, (len - t) / 1.2);
            const trem = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.23 * t + ch);
            const v =
              (Math.sin(2 * Math.PI * f * mult * t) * 0.8 + Math.sin(2 * Math.PI * f * mult * 1.003 * t) * 0.2) *
              amp * env * trem;
            data0[i] += v * pan;
            data1[i] += v * (1 - pan);
          }
        }
      }
    }
    return buf;
  }

  startAmbient() {
    if (this.ambientSrc) return;
    try {
      const ctx = this.ensure();
      if (ctx.state === 'suspended') return;
      const buf = this.makeAmbient();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 2);
      src.connect(g);
      g.connect(this.musicGain!);
      src.start();
      this.ambientSrc = src;
      this.ambientGain = g;
    } catch {
      /* ambient is optional */
    }
  }

  stopAmbient() {
    if (this.ambientSrc) {
      try {
        this.ambientSrc.stop();
      } catch {
        /* noop */
      }
      this.ambientSrc.disconnect();
      this.ambientSrc = null;
    }
    if (this.ambientGain) {
      this.ambientGain.disconnect();
      this.ambientGain = null;
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined);
  }
}
