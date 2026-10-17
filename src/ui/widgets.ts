// Immediate-mode widgets: buttons, chips, sliders + native-backed text fields.
import { THEME, rrPath, text, fillPanel, clamp01 } from './theme.ts';
import type { App } from './app.ts';

export interface PointerState {
  x: number;
  y: number;
  down: boolean;
  downX: number;
  downY: number;
  moved: boolean;
}

export class UI {
  app: App;
  p: PointerState = { x: 0, y: 0, down: false, downX: 0, downY: 0, moved: false };
  private hot: string | null = null;
  private active: string | null = null;
  private clicked: Set<string> = new Set();
  private sliderVals = new Map<string, number>();
  private sliderDrag: string | null = null;
  private consumed = false;
  private clip: { x: number; y: number; w: number; h: number } | null = null;
  setClip(x: number, y: number, w: number, h: number) { this.clip = { x, y, w, h }; }
  clearClip() { this.clip = null; }
  cancelPointer() { this.active = null; this.sliderDrag = null; this.clicked.clear(); this.consumed = true; }

  constructor(app: App) {
    this.app = app;
  }

  beginFrame(p: PointerState) {
    this.p = p;
    this.hot = null;
    this.clicked.clear();
    this.consumed = false;
  }

  endFrame() {
    if (!this.p.down) this.active = null;
  }

  private within(x: number, y: number, w: number, h: number): boolean {
    const c = this.clip;
    if (c && (this.p.x < c.x || this.p.x > c.x + c.w || this.p.y < c.y || this.p.y > c.y + c.h)) return false;
    return this.p.x >= x && this.p.x <= x + w && this.p.y >= y && this.p.y <= y + h;
  }

  /** clickable area; returns true when clicked this frame */
  button(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    opts: { accent?: boolean; danger?: boolean; disabled?: boolean; small?: boolean; icon?: string } = {},
  ): boolean {
    const hover = this.within(x, y, w, h);
    if (hover && !opts.disabled) this.hot = id;
    let clicked = false;
    if (hover && !opts.disabled && !this.p.moved && this.p.down && this.active === null && !this.consumed) {
      this.active = id;
    }
    if (this.active === id && !this.p.down) {
      if (hover && !opts.disabled && !this.p.moved) {
        clicked = true;
        this.clicked.add(id);
      }
      this.active = null;
    }
    const pressed = this.active === id && this.p.down && hover;
    const ctx = this.app.ctx;
    ctx.save();
    const r = opts.small ? 8 : 12;
    if (opts.disabled) {
      fillPanel(ctx, x, y, w, h, { r, fill: 'rgba(255,255,255,0.04)', line: 'rgba(255,255,255,0.06)', alpha: 0.7 });
      text(ctx, label, x + w / 2, y + h / 2, { size: opts.small ? 12 : 14, align: 'center', baseline: 'middle', color: 'rgba(135,147,159,0.5)', weight: 600, maxWidth: w - 16 });
    } else {
      const base = opts.accent ? '#c9ded4' : opts.danger ? 'rgba(212,147,150,0.08)' : 'rgba(23,30,38,0.95)';
      const hotFill = opts.accent ? '#e1eee7' : opts.danger ? 'rgba(212,147,150,0.18)' : 'rgba(40,51,59,0.98)';
      const line = opts.accent ? 'rgba(147,174,160,0.7)' : opts.danger ? 'rgba(255,75,92,0.6)' : THEME.panelLine;
      const col = opts.accent ? '#15251e' : opts.danger ? THEME.red : THEME.text;
      fillPanel(ctx, x, y, w, h, { r, fill: pressed ? hotFill : hover ? hotFill : base, line });
      if (pressed) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        rrPath(ctx, x, y, w, h, r);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      text(ctx, opts.icon ? opts.icon + ' ' + label : label, x + w / 2, y + h / 2, {
        size: opts.small ? 12 : 14,
        maxWidth: w - 16,
        align: 'center',
        baseline: 'middle',
        color: col,
        weight: 700,
        glow: false,
        glowColor: opts.accent ? THEME.accent : opts.danger ? THEME.red : THEME.accent,
      });
    }
    ctx.restore();
    return clicked;
  }

  hover(id: string, x: number, y: number, w: number, h: number): boolean {
    if (this.within(x, y, w, h)) {
      this.hot = id;
      return true;
    }
    return false;
  }

  isHot(id: string): boolean {
    return this.hot === id;
  }

  /** chip toggle; returns {hover, clicked} */
  chip(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    on: boolean,
    accent?: string,
  ): { hover: boolean; clicked: boolean } {
    const hover = this.within(x, y, w, h);
    if (hover) this.hot = id;
    let clicked = false;
    if (hover && !this.p.moved && this.p.down && this.active === null && !this.consumed) this.active = id;
    if (this.active === id && !this.p.down) {
      if (hover && !this.p.moved) clicked = true;
      this.active = null;
    }
    const ctx = this.app.ctx;
    const col = accent ?? THEME.accent;
    ctx.save();
    fillPanel(ctx, x, y, w, h, {
      r: 9,
      fill: on ? col + '33' : 'rgba(23,30,38,0.8)',
      line: on ? col : hover ? 'rgba(255,255,255,0.3)' : THEME.panelLine,
    });
    text(ctx, label, x + w / 2, y + h / 2, {
      size: 13,
      maxWidth: w - 12,
      align: 'center',
      baseline: 'middle',
      color: on ? col : hover ? THEME.text : THEME.dim,
      weight: 700,
      glow: false,
      glowColor: col,
    });
    ctx.restore();
    return { hover, clicked };
  }

  /** slider; returns current value (kept per id) */
  slider(id: string, x: number, y: number, w: number, h: number, value: number, min: number, max: number, step = 0.01): number {
    if (this.sliderDrag !== id) this.sliderVals.set(id, value);
    let v = this.sliderVals.get(id)!;
    const hover = this.within(x - 6, y - 8, w + 12, h + 16);
    if (hover) this.hot = id;
    if (this.p.down && !this.p.moved && hover && (this.active === null || this.active === id) && !this.consumed) {
      this.active = id;
      this.sliderDrag = id;
    }
    if (this.sliderDrag === id) {
      if (this.p.down) {
        const p = clamp01((this.p.x - x) / w);
        v = min + (max - min) * p;
        v = Math.round(v / step) * step;
        v = Math.max(min, Math.min(max, v));
        this.sliderVals.set(id, v);
        this.consumed = true;
      } else {
        this.sliderDrag = null;
      }
    }
    const ctx = this.app.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    rrPath(ctx, x, y + h / 2 - 3, w, 6, 3);
    ctx.fill();
    const p = (v - min) / (max - min || 1);
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, THEME.accent);
    g.addColorStop(1, THEME.accent2);
    ctx.fillStyle = g;
    rrPath(ctx, x, y + h / 2 - 3, w * p, 6, 3);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + w * p, y + h / 2, this.sliderDrag === id ? 9 : 7, 0, Math.PI * 2);
    ctx.fillStyle = this.sliderDrag === id ? '#ffffff' : '#c9ded4';
    ctx.fill();
    ctx.restore();
    return v;
  }

  /** textual value display next to a slider */
  sliderLabel(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, fmt: string) {
    text(ctx, label, x, y, { size: 13, color: THEME.dim, baseline: 'middle', weight: 600 });
    text(ctx, fmt, x, y, { size: 13, color: '#c9ded4', baseline: 'middle', weight: 700 });
  }

  consume() {
    this.consumed = true;
  }

  anyConsumed(): boolean {
    return this.consumed;
  }
}

/** native-input backed text field (opens real keyboard on Android) */
export class TextField {
  el: HTMLInputElement;
  private dirty = false;
  onEnter: (() => void) | null = null;

  constructor(
    type: 'text' | 'password' | 'email' = 'text',
    opts: { maxLength?: number; placeholder?: string } = {},
  ) {
    this.el = document.createElement('input');
    this.el.type = type;
    this.el.autocomplete = 'off';
    this.el.spellcheck = false;
    if (opts.maxLength) this.el.maxLength = opts.maxLength;
    if (opts.placeholder) this.el.placeholder = opts.placeholder;
    this.el.style.cssText =
      'position:fixed;z-index:9999;opacity:0;pointer-events:none;width:1px;height:1px;border:0;background:transparent;color:transparent;';
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.el.blur();
        this.onEnter?.();
      }
      e.stopPropagation();
    });
    this.el.addEventListener('input', () => {
      this.dirty = true;
    });
    document.body.appendChild(this.el);
  }

  get value(): string {
    return this.el.value;
  }

  set value(v: string) {
    if (this.el.value !== v) this.el.value = v;
  }

  get focused(): boolean {
    return document.activeElement === this.el;
  }

  focus() {
    this.el.focus();
  }

  blur() {
    this.el.blur();
  }

  consumeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  destroy() {
    this.el.remove();
  }
}
