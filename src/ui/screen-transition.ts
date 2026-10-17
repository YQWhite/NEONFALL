/** A single frozen composite fades over the live destination screen. */
export class ScreenTransition {
  private frame: HTMLCanvasElement | null = null;
  private startedAt = 0;
  private duration = 280;

  capture(background: HTMLCanvasElement, foreground: HTMLCanvasElement, width: number, height: number, now: number, duration = 280) {
    if (width <= 0 || height <= 0 || !foreground.width || !foreground.height) return;
    // Only allocate on navigation; limit memory on high-DPI/4K devices.
    const density = Math.min(foreground.width / width, 1.5, Math.sqrt(3_000_000 / (width * height)));
    const frame = document.createElement('canvas');
    frame.width = Math.max(1, Math.round(width * density));
    frame.height = Math.max(1, Math.round(height * density));
    const ctx = frame.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.drawImage(background, 0, 0, frame.width, frame.height);
    // foreground already includes any interrupted transition: rapid navigation
    // starts at the exact composite the player was looking at.
    ctx.drawImage(foreground, 0, 0, frame.width, frame.height);
    this.frame = frame;
    this.startedAt = now;
    this.duration = duration;
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number, now: number) {
    if (!this.frame) return;
    const t = Math.max(0, Math.min(1, (now - this.startedAt) / this.duration));
    if (t >= 1) { this.frame = null; return; }
    const ease = t * t * (3 - 2 * t);
    ctx.save();
    ctx.globalAlpha = 1 - ease;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.frame, 0, 0, width, height);
    ctx.restore();
  }
}
