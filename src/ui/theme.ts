// NEONFALL visual theme & canvas drawing helpers.
import { tr } from './i18n.ts';
export const THEME = {
  bg: '#0d1218',
  bg2: '#141b22',
  panel: 'rgba(23,30,38,0.94)',
  panelSoft: 'rgba(23,30,38,0.72)',
  panelLine: 'rgba(166,189,178,0.16)',
  text: '#edf1ef',
  dim: '#87939f',
  accent: '#c9ded4',
  accent2: '#a6bdb2',
  gold: '#c6baa0',
  green: '#a9c8b5',
  orange: '#c9a588',
  red: '#d49396',
  violet: '#aaaec5',
  font: '"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
};

export interface TextStyle {
  size?: number;
  color?: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  weight?: number | string;
  glow?: boolean;
  glowColor?: string;
  alpha?: number;
  spacing?: string;
  font?: string;
  shadow?: boolean;
  maxWidth?: number;
  translate?: boolean;
}

export function setFont(ctx: CanvasRenderingContext2D, s: TextStyle) {
  const weight = s.weight ?? 600;
  const size = s.size ?? 16;
  ctx.font = `${weight} ${size}px ${s.font ?? THEME.font}`;
  ctx.textAlign = s.align ?? 'left';
  ctx.textBaseline = s.baseline ?? 'alphabetic';
  try {
    (ctx as any).letterSpacing = s.spacing ?? '0px';
  } catch {
    /* older canvas */
  }
}

export function text(ctx: CanvasRenderingContext2D, str: string, x: number, y: number, s: TextStyle = {}) {
  ctx.save();
  setFont(ctx, s);
  str = s.translate === false ? str : tr(str);
  if (s.maxWidth !== undefined) {
    const width = Math.max(0, s.maxWidth);
    if (ctx.measureText(str).width > width) {
      while (str.length && ctx.measureText(str + '…').width > width) str = str.slice(0, -1);
      str = str ? str + '…' : '';
    }
  }
  if (s.alpha !== undefined) ctx.globalAlpha = s.alpha;
  ctx.fillStyle = s.color ?? THEME.text;
  if (s.glow) {
    ctx.shadowColor = s.glowColor ?? s.color ?? THEME.accent;
    ctx.shadowBlur = 14;
  }
  if (s.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;
  }
  ctx.fillText(str, x, y);
  ctx.restore();
}

export function neonText(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'left',
  spacing = '2px',
) {
  text(ctx, str, x, y, {
    size,
    color,
    align,
    glow: false,
    glowColor: color,
    weight: 700,
    spacing,
    baseline: 'middle',
  });
}

export function rrPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function fillPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { r?: number; alpha?: number; fill?: string; line?: string; glow?: boolean } = {},
) {
  ctx.save();
  const r = opts.r ?? 14;
  ctx.fillStyle = opts.fill ?? THEME.panel;
  ctx.globalAlpha = opts.alpha ?? 1;
  rrPath(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = opts.line ?? THEME.panelLine;
  ctx.lineWidth = 1;
  rrPath(ctx, x, y, w, h, r);
  ctx.stroke();
  ctx.restore();
}

export function gradientRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  c1: string,
  c2: string,
  vertical = true,
  alpha = 1,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = vertical
    ? ctx.createLinearGradient(0, y, 0, y + h)
    : ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

export function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function drawProgress(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  p: number,
  c1 = THEME.accent,
  c2 = THEME.accent2,
) {
  ctx.save();
  rrPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fill();
  const pw = w * Math.max(0, Math.min(1, p));
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  if (pw > 0) { rrPath(ctx, x, y, pw, h, h / 2); ctx.fill(); }
  ctx.restore();
}

/** Wrap localized copy without squeezing or stretching the font. Returns used height. */
export function paragraph(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, width: number, style: TextStyle = {}, lineHeight = 22): number {
  const content = tr(value);
  ctx.save(); setFont(ctx, style);
  let line = '', row = 0;
  for (const part of content.split(/(\s+|(?<=[\u2e80-\u9fff])|(?=[\u2e80-\u9fff]))/u)) {
    if (line && ctx.measureText(line + part).width > width) {
      text(ctx, line.trim(), x, y + row++ * lineHeight, { ...style, translate: false });
      line = '';
    }
    line += part;
  }
  if (line) text(ctx, line.trim(), x, y + row++ * lineHeight, { ...style, translate: false });
  ctx.restore(); return row * lineHeight;
}

export function pageHeader(ctx: CanvasRenderingContext2D, title: string, subtitle: string, w: number) {
  text(ctx, title, 142, 40, { size: 24, weight: 600, baseline: 'middle', maxWidth: w - 170 });
  text(ctx, subtitle, 144, 65, { size: 11, color: THEME.dim, maxWidth: w - 175 });
  ctx.fillStyle = THEME.panelLine; ctx.fillRect(24, 86, w - 48, 1);
}

export function drawScrollbar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  h: number,
  total: number,
  view: number,
  offset: number,
) {
  if (total <= view) return;
  const trackH = h;
  const thumbH = Math.max(40, (view / total) * trackH);
  const maxOff = total - view;
  const thumbY = y + (offset / maxOff) * (trackH - thumbH);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  rrPath(ctx, x, y, 4, trackH, 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(147,174,160,0.5)';
  rrPath(ctx, x, thumbY, 4, thumbH, 2);
  ctx.fill();
  ctx.restore();
}

export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** draw a song cover: image fit-cover into rect with fallback gradient + title text */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  x: number,
  y: number,
  w: number,
  h: number,
  fallbackTitle: string,
  seedColor: string,
) {
  ctx.save();
  rrPath(ctx, x, y, w, h, 10);
  ctx.clip();
  if (img && img.complete && img.naturalWidth > 0) {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s;
    const dh = ih * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    gradientRect(ctx, x, y, w, h, 'rgba(0,0,0,0)', 'rgba(5,7,15,0.35)', true);
  } else {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, seedColor);
    g.addColorStop(1, '#141b22');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    text(ctx, fallbackTitle.slice(0, 1).toUpperCase(), x + w / 2, y + h / 2, {
      size: h * 0.5,
      color: 'rgba(255,255,255,0.28)',
      align: 'center',
      baseline: 'middle',
      weight: 800,
    });
  }
  ctx.restore();
}

const blurScratch: HTMLCanvasElement | null = null;

/** cheap gaussian-ish blur: downscale-upscale trick for full-screen backdrops */
export function drawBlurredBackdrop(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  w: number,
  h: number,
  alpha: number,
) {
  if (!img || !img.complete || img.naturalWidth <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  let scratch = (drawBlurredBackdrop as any)._scratch as HTMLCanvasElement | undefined;
  if (!scratch || scratch.width !== 48) {
    scratch = document.createElement('canvas');
    scratch.width = 48;
    scratch.height = Math.round((48 * h) / w);
    (drawBlurredBackdrop as any)._scratch = scratch;
  }
  const sc = scratch.getContext('2d')!;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const s = Math.max(scratch.width / iw, scratch.height / ih);
  const dw = iw * s;
  const dh = ih * s;
  sc.clearRect(0, 0, scratch.width, scratch.height);
  sc.drawImage(img, (scratch.width - dw) / 2, (scratch.height - dh) / 2, dw, dh);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(scratch, 0, 0, w, h);
  ctx.restore();
  void blurScratch;
}
