// Input: keyboard binds + multi-touch lanes. Timestamps taken from the audio clock
// at event time for minimal input-latency error.
import type { Settings } from '../core/types.ts';

export interface PressInfo {
  col: number;
  timeMs: number; // song-clock time at press
}

export class InputManager {
  binds: string[] = [];
  private keysDown = new Set<string>();
  private touchCols = new Map<number, number>(); // pointerId -> col
  private laneRect: { x: number; y: number; w: number; h: number } | null = null;
  private laneResolver: ((x: number, y: number) => number) | null = null;
  onPress: ((p: PressInfo) => void) | null = null;
  onRelease: ((col: number, timeMs: number) => void) | null = null;
  onAnyKey: ((code: string) => void) | null = null;
  now: () => number = () => performance.now();

  constructor(keys: number, settings: Settings) {
    this.setBinds(keys, settings);
  }

  setBinds(keys: number, settings: Settings) {
    const list = settings.keybinds[String(keys)] || settings.keybinds['4'];
    this.binds = (list || []).slice(0, keys);
    while (this.binds.length < keys) this.binds.push('');
  }

  setLaneRect(r: { x: number; y: number; w: number; h: number } | null) {
    this.laneRect = r;
  }

  setLaneResolver(resolver: ((x: number, y: number) => number) | null) { this.laneResolver = resolver; }

  private colOfCode(code: string): number {
    const i = this.binds.indexOf(code);
    return i;
  }

  private hKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const col = this.colOfCode(e.code);
    if (col >= 0) {
      e.preventDefault();
      const wasDown = this.isDown(col);
      this.keysDown.add(e.code);
      if (!wasDown) this.onPress?.({ col, timeMs: this.now() });
      return;
    }
    this.onAnyKey?.(e.code);
  };

  private hKeyUp = (e: KeyboardEvent) => {
    const col = this.colOfCode(e.code);
    if (col >= 0) {
      e.preventDefault();
      this.keysDown.delete(e.code);
      if (!this.isDown(col)) this.onRelease?.(col, this.now());
    }
  };

  private hBlur = () => {
    // release everything on focus loss
    for (const code of [...this.keysDown]) {
      const col = this.colOfCode(code);
      if (col >= 0) this.onRelease?.(col, this.now());
    }
    this.keysDown.clear();
    this.touchCols.clear();
  };

  /** Pause/retry discard physical state without creating release judgments. */
  reset() {
    this.keysDown.clear();
    this.touchCols.clear();
  }

  private hPointerDown = (e: PointerEvent) => {
    const col = this.colAtXY(e.clientX, e.clientY);
    if (col >= 0) {
      e.preventDefault();
      const wasDown = this.isDown(col);
      this.touchCols.set(e.pointerId, col);
      if (!wasDown) this.onPress?.({ col, timeMs: this.now() });
    }
  };

  private hPointerUp = (e: PointerEvent) => {
    const col = this.touchCols.get(e.pointerId);
    if (col !== undefined) {
      this.touchCols.delete(e.pointerId);
      if (!this.isDown(col)) this.onRelease?.(col, this.now());
    }
  };

  private colAtXY(x: number, y: number): number {
    if (this.laneResolver) return this.laneResolver(x, y);
    const r = this.laneRect;
    if (!r) return -1;
    // touch zone: extend beyond lanes vertically for comfort
    if (x < r.x || x > r.x + r.w) return -1;
    if (y < r.y + r.h * 0.4 || y > r.y + r.h) return -1;
    const n = this.binds.length;
    const lane = Math.floor(((x - r.x) / r.w) * n);
    return Math.max(0, Math.min(n - 1, lane));
  }

  attach(win: Window) {
    win.addEventListener('keydown', this.hKeyDown, { passive: false });
    win.addEventListener('keyup', this.hKeyUp, { passive: false });
    win.addEventListener('blur', this.hBlur);
    win.addEventListener('pointerdown', this.hPointerDown, { passive: false });
    win.addEventListener('pointerup', this.hPointerUp, { passive: false });
    win.addEventListener('pointercancel', this.hPointerUp);
  }

  detach(win: Window) {
    win.removeEventListener('keydown', this.hKeyDown);
    win.removeEventListener('keyup', this.hKeyUp);
    win.removeEventListener('blur', this.hBlur);
    win.removeEventListener('pointerdown', this.hPointerDown);
    win.removeEventListener('pointerup', this.hPointerUp);
    win.removeEventListener('pointercancel', this.hPointerUp);
  }

  isDown(col: number): boolean {
    return this.keysDown.has(this.binds[col] ?? '') || [...this.touchCols.values()].includes(col);
  }
}
