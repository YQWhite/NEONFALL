// Tap calibration uses the SAME WebAudio clock for scheduling and input sampling.
// Judgment = songTime - audioOffset - inputOffset; hence audioOffset = delay - inputOffset.
export const CALIBRATION = { interval: 0.5, warmup: 4, measured: 20, windowMs: 220 };
export interface CalibrationResult { ok: boolean; delayMs: number; audioOffset: number; spreadMs: number; accepted: number; rejected: number; reason: string }
export function median(values: number[]): number {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return NaN;
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}
export function evaluateCalibration(samples: number[], inputOffset: number): CalibrationResult {
  const finite = samples.filter(Number.isFinite);
  const center = median(finite);
  const mad = median(finite.map(v => Math.abs(v - center)));
  const kept = finite.filter(v => Math.abs(v - center) <= Math.max(15, 3 * mad));
  const delayMs = median(kept);
  const spreadMs = kept.length ? Math.sqrt(kept.reduce((s, v) => s + (v - delayMs) ** 2, 0) / kept.length) : Infinity;
  const audioOffset = Math.round(delayMs - inputOffset);
  const reason = kept.length < 12 ? 'Not enough consistent taps. Retry and follow the sound.' : spreadMs > 35 ? 'Timing varied too much. Retry with wired headphones.' : Math.abs(audioOffset) > 250 ? 'Result outside ±250 ms. Check your audio device and retry.' : '';
  return { ok: !reason, delayMs, audioOffset, spreadMs, accepted: kept.length, rejected: samples.length - kept.length, reason };
}
export class TapCalibration {
  state: 'idle' | 'starting' | 'running' | 'done' | 'cancelled' | 'error' = 'idle';
  error = '';
  beats: number[] = [];
  samples = new Map<number, number>();
  private sources: AudioBufferSourceNode[] = [];
  private gain: GainNode | null = null;
  private generation = 0;
  constructor(private ctx: AudioContext, private output?: AudioNode) {}
  get now() { return this.ctx.currentTime; }
  get progress() { return this.beats.length ? Math.max(0, Math.min(24, Math.floor((this.now - this.beats[0]) / CALIBRATION.interval) + 1)) : 0; }
  async start(volume: number) {
    this.cancel();
    const generation = ++this.generation;
    this.state = 'starting';
    this.samples.clear(); this.beats = [];
    try {
      await this.ctx.resume();
      if (generation !== this.generation) return;
      if (this.ctx.state !== 'running') throw new Error('Audio is unavailable. Enable audio and retry.');
      const gain = this.ctx.createGain(); this.gain = gain;
      gain.gain.value = Math.max(0, Math.min(1, volume)); gain.connect(this.output ?? this.ctx.destination);
      const buffer = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * 0.045), this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) { const t = i / this.ctx.sampleRate; data[i] = Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-t / 0.008) * Math.min(1, t / 0.001); }
      const first = this.now + 0.75;
      for (let i = 0; i < CALIBRATION.warmup + CALIBRATION.measured; i++) {
        const at = first + i * CALIBRATION.interval;
        this.beats.push(at);
        const source = this.ctx.createBufferSource(); source.buffer = buffer; source.connect(gain);
        source.onended = () => source.disconnect(); source.start(at); this.sources.push(source);
      }
      this.state = 'running';
    } catch (e) {
      if (generation !== this.generation) return;
      this.cleanup(); this.state = 'error'; this.error = e instanceof Error ? e.message : 'Audio could not start.';
    }
  }
  tap() {
    if (this.state !== 'running') return;
    const i = Math.round((this.now - this.beats[0]) / CALIBRATION.interval);
    if (i < CALIBRATION.warmup || i >= this.beats.length || this.samples.has(i)) return;
    const delta = (this.now - this.beats[i]) * 1000;
    if (Math.abs(delta) <= CALIBRATION.windowMs) this.samples.set(i, delta);
  }
  update() {
    if (this.state !== 'running') return;
    if (this.ctx.state !== 'running') { this.cancel(); this.state = 'error'; this.error = 'Audio was interrupted. Please retry.'; return; }
    if (this.now > this.beats[this.beats.length - 1] + 0.3) { this.cleanup(); this.state = 'done'; }
  }
  result(inputOffset: number) { return evaluateCalibration([...this.samples.values()], inputOffset); }
  private cleanup() {
    for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { /* ended */ } source.disconnect(); }
    this.sources = []; this.gain?.disconnect(); this.gain = null;
  }
  cancel() { ++this.generation; this.cleanup(); this.state = 'cancelled'; }
}
