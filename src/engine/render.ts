// Playfield renderer — skin-owned stage artwork with a quiet, high-contrast default.
import type { NFSkin, Mods, Settings } from '../core/types.ts';
import { PLAYFIELD_SCALE_MIN, PLAYFIELD_SCALE_MAX } from '../core/types.ts';
import { clamp } from '../core/zip.ts';
import type { PlaySession } from './play.ts';
import { tr } from '../ui/i18n.ts';
import { mspArtPaths, mspCatPoses } from './msp-art.ts';
import { skinBounds } from '../ui/skin-art.ts';
import type { FieldOrigin } from './lane-geometry.ts';

export class SkinImages {
  private images = new Map<string, HTMLImageElement>();
  private pending = new Map<string, Promise<HTMLImageElement | null>>();
  private missing = new Set<string>();
  constructor(private getAsset: (p: string) => Uint8Array | undefined) {}

  load(path: string | undefined): Promise<HTMLImageElement | null> {
    if (!path) return Promise.resolve(null);
    const cached = this.images.get(path);
    if (cached) return Promise.resolve(cached);
    if (this.missing.has(path)) return Promise.resolve(null);
    const inflight = this.pending.get(path);
    if (inflight) return inflight;
    const data = this.getAsset(path);
    if (!data) {
      this.missing.add(path);
      return Promise.resolve(null);
    }
    const p = new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'image/png' }));
      img.onload = () => {
        URL.revokeObjectURL(url);
        this.images.set(path, img);
        this.pending.delete(path);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        this.pending.delete(path);
        this.missing.add(path);
        resolve(null);
      };
      img.src = url;
    });
    this.pending.set(path, p);
    return p;
  }

  /** synchronous lookup after load() resolved */
  get(path: string | undefined): HTMLImageElement | null {
    if (!path) return null;
    return this.images.get(path) ?? null;
  }

  preload(paths: (string | undefined)[]) {
    for (const p of paths) this.load(p).catch(() => undefined);
  }
}

interface Ctx2 {
  ctx: CanvasRenderingContext2D;
}

export class PlayfieldRenderer {
  skin: NFSkin | null;
  images: SkinImages;
  private settings: Settings;
  private mods: Mods;
  private indexedNotes: PlaySession['notes'] | null = null;
  private endTree = new Float64Array(0);
  private treeSize = 0;
  private oldHolds: number[] = [];
  private fieldTop = 0;
  private fieldBottom = 960;
  private rasterScaleY = 1;
  private rasterOffsetY = 0;
  private bodyPatterns = new WeakMap<CanvasRenderingContext2D, Map<HTMLImageElement, CanvasPattern>>();

  constructor(skin: NFSkin | null, getAsset: (p: string) => Uint8Array | undefined, settings: Settings, mods: Mods) {
    this.skin = skin;
    this.images = new SkinImages(getAsset);
    this.settings = settings;
    this.mods = mods;
  }

  beatHeight(): number {
    // Storage remains pixels/ms at 120 BPM; UI x1 is .55 (275px/beat).
    return 500 * this.settings.scrollSpeed * this.mods.speed;
  }

  /** Await while the loading screen is visible, including all animation frames. */
  prepareSkinArt(): Promise<unknown[]> {
    return Promise.all(mspArtPaths(this.skin).map(path => this.images.load(path)));
  }

  /** scale mapping 512x480 field into screen w,h */
  fieldScale(w: number, h: number): number {
    const zoom = clamp(this.settings.playfieldScale ?? 1.08, PLAYFIELD_SCALE_MIN, PLAYFIELD_SCALE_MAX);
    if (this.skin?.perspective) {
      const total = this.skin.columns.reduce((sum, col) => sum + (col.width || this.skin!.columnWidth || 512 / this.skin!.keys), 0);
      const left = this.skin.columnStart ?? (512 - total) / 2;
      // Fit the widest visible receptor/base edge, not a fixed 512px square.
      // Independent horizontal scaling makes landscape touch lanes usable.
      const reach = Math.max(Math.abs(this.projectX(left, 480) - 256), Math.abs(this.projectX(left + total, 480) - 256)) + 4;
      const fit = w * .98 / Math.max(1, reach * 2);
      return Math.min(fit, Math.min(w * .94 / 512, h * 1.5 / 480) * zoom);
    }
    return Math.min((w * 0.94) / 512, (h * 0.9) / 480 * zoom);
  }

  fieldOrigin(w: number, h: number): FieldOrigin {
    const scale = this.fieldScale(w, h);
    const gap = this.settings.playfieldBottomGap;
    const override = Number.isFinite(gap) ? h * (1 - clamp(gap!, 0, .4)) : undefined;
    if (this.skin?.perspective) {
      const hit = this.skin.hitPosition ?? 414;
      const scaleY = h * .86 / hit;
      const oy = (override ?? h * .86) - hit * scaleY;
      return { ox: (w - 512 * scale) / 2, oy, scale, scaleY, top: -oy / scaleY, bottom: (h - oy) / scaleY };
    }
    const base = Math.min(w * .94 / 512, h * .9 / 480);
    const hit = this.skin?.hitPosition ?? 464;
    const anchor = override ?? (h - 480 * base) / 2 + hit * base;
    const oy = anchor - hit * scale;
    return { ox: (w - 512 * scale) / 2, oy, scale, scaleY: scale, top: -oy / scale, bottom: (h - oy) / scale };
  }

  laneWidths(sess: PlaySession): number[] {
    const skin = this.skin;
    const w: number[] = [];
    for (let i = 0; i < sess.keys; i++) {
      w.push(skin?.columns?.[i]?.width || skin?.columnWidth || 512 / sess.keys);
    }
    return w;
  }

  columnTint(col: number): string {
    const tint = this.skin?.columns?.[col]?.tint;
    return tint ? `rgb(${tint.join(',')})` : ['#dce5ef', '#9fc8e3'][col % 2];
  }

  // ================== main draw ==================
  draw(ctx: CanvasRenderingContext2D, sess: PlaySession, w: number, h: number, nowPerf: number) {
    const { ox, oy, scale, scaleY, top, bottom } = this.fieldOrigin(w, h);
    this.fieldTop = Math.min(0, top!);
    this.fieldBottom = Math.max(480, bottom!);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scaleY);
    const transform = ctx.getTransform?.();
    this.rasterScaleY = Math.max(.01, transform?.d ?? scaleY);
    this.rasterOffsetY = transform?.f ?? oy;
    this.drawField(ctx, sess, nowPerf);
    ctx.restore();
    this.drawMspCompanion(ctx, sess, w, h);
  }

  private drawField(ctx: CanvasRenderingContext2D, sess: PlaySession, nowPerf: number) {
    const widths = this.laneWidths(sess);
    const totalW = widths.reduce((a, b) => a + b, 0);
    const x0 = sess.laneStart();
    const hitY = sess.hitY();
    if (this.skin?.perspective) {
      this.drawPerspectiveField(ctx, sess, x0, widths, hitY, nowPerf);
      return;
    }

    // Default decoration must never leak into imported skins, including skins
    // whose stage/columns are intentionally transparent over the song background.
    if (!this.skin) {
      ctx.fillStyle = '#10151e';
      ctx.fillRect(x0, this.fieldTop, totalW, 480 - this.fieldTop);
    }

    // Draw only within this frame's transform; async callbacks must never paint.
    const stage = this.skin?.stage;
    const left = this.images.get(stage?.left), right = this.images.get(stage?.right);
    const bottom = this.images.get(stage?.bottom);
    if (left) this.drawExtendedRail(ctx, left, x0 - 90, 90);
    if (right) this.drawExtendedRail(ctx, right, x0 + totalW, 90);
    if (bottom) ctx.drawImage(bottom, x0 - 90, hitY, totalW + 180, 480 - hitY);

    // column zones
    let cx = x0;
    for (let c = 0; c < sess.keys; c++) {
      const colW = widths[c];
      const background = this.skin?.columns?.[c]?.background;
      if (background) {
        ctx.fillStyle = `rgba(${background[0]},${background[1]},${background[2]},${background[3] / 255})`;
        ctx.fillRect(cx, this.fieldTop, colW, 480 - this.fieldTop);
      }
      if (!this.skin) {
        ctx.strokeStyle = 'rgba(215,225,240,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, this.fieldTop);
        ctx.lineTo(cx, 480);
        ctx.stroke();
      }
      cx += colW;
    }
    if (!this.skin) {
      ctx.beginPath();
      ctx.moveTo(cx, this.fieldTop);
      ctx.lineTo(cx, 480);
      ctx.stroke();
    }
    // mania-stage-hint is one stage-wide hit target, not a per-column top arrow.
    const hint = this.images.get(stage?.hint);
    if (hint) {
      const ih = totalW * hint.height / Math.max(1, hint.width);
      ctx.drawImage(hint, x0, hitY - ih / 2, totalW, ih);
    }

    if (this.skin?.keyUnderNotes) this.drawReceptors(ctx, sess, x0, widths, hitY, nowPerf);
    this.drawNotes(ctx, sess, x0, widths, hitY, nowPerf);
    if (!this.skin?.keyUnderNotes) this.drawReceptors(ctx, sess, x0, widths, hitY, nowPerf);
    if (this.skin?.judgementLine !== false) this.drawHitline(ctx, sess, x0, totalW, hitY, nowPerf);
    this.drawParticles(ctx, sess);

    // flashlight overlay
    if (this.mods.flashlight) this.drawFlashlight(ctx, sess, x0, widths, hitY);
  }

  /** Shared by note art and lane edges; the judgement position is invariant. */
  projectX(x: number, y: number): number {
    const p = this.skin?.perspective;
    if (!p) return x;
    const top = clamp(p.topWidth, .08, 1);
    const ratio = Math.max(.025, top + (1 - top) * Math.min(y / (this.skin?.hitPosition ?? 414), 1.35));
    return 256 + (x - 256) * ratio;
  }

  private projectSlope(x: number, y: number): number {
    const p = this.skin?.perspective;
    if (!p) return 0;
    const top = clamp(p.topWidth, .08, 1), hit = this.skin?.hitPosition ?? 414;
    if (y >= hit * 1.35 || top + (1 - top) * y / hit <= .025) return 0;
    return (x - 256) * (1 - top) / hit;
  }

  /** Perspective depth accelerates notes towards the receptor. Both endpoints
   * of every sprite use this transform, so distant caps shrink vertically too. */
  projectY(y: number): number {
    const depth = this.skin?.msp?.depth;
    if (depth === undefined || depth >= 1) return y;
    const hit = this.skin?.hitPosition ?? 414, q = (hit - y) / hit;
    if (q < 0) return hit + (y - hit) / depth;
    return hit - hit * q / (depth + (1 - depth) * q);
  }

  /** Undo depth only for candidate bounds; note timing itself stays unchanged. */
  private unprojectY(y: number): number {
    const depth = this.skin?.msp?.depth;
    if (depth === undefined || depth >= 1) return y;
    const hit = this.skin?.hitPosition ?? 414;
    if (y > hit) return hit + (y - hit) * depth;
    const ratio = (hit - y) / hit;
    const denominator = 1 - (1 - depth) * ratio;
    return denominator > 0 ? hit - hit * depth * ratio / denominator : -Infinity;
  }

  /** Preserve authored stage art at its original size; extend its top edge when
   * the hit line moves down instead of stretching the complete playfield. */
  private drawExtendedRail(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, width: number, slope = 0) {
    ctx.drawImage(image, x, 0, width, 480);
    if (this.fieldTop < 0) {
      ctx.save();
      if (slope) ctx.transform(1, 0, slope, 1, 0, 0);
      ctx.drawImage(image, 0, 0, image.width, 1, x, this.fieldTop, width, -this.fieldTop);
      ctx.restore();
    }
  }

  private lanePolygon(ctx: CanvasRenderingContext2D, x: number, width: number, top: number, bottom: number) {
    ctx.beginPath(); ctx.moveTo(this.projectX(x, top), top); ctx.lineTo(this.projectX(x + width, top), top);
    if (top < 0 && bottom > 0) ctx.lineTo(this.projectX(x + width, 0), 0);
    ctx.lineTo(this.projectX(x + width, bottom), bottom); ctx.lineTo(this.projectX(x, bottom), bottom);
    if (top < 0 && bottom > 0) ctx.lineTo(this.projectX(x, 0), 0);
    ctx.closePath();
  }

  private drawPerspectiveField(ctx: CanvasRenderingContext2D, sess: PlaySession, x0: number, widths: number[], hitY: number, nowPerf: number) {
    const total = widths.reduce((a, b) => a + b, 0);
    const art = this.skin?.msp;
    this.drawMspRails(ctx, sess, x0, total, hitY);
    let x = x0;
    for (let col = 0; col < widths.length; col++) {
      const bg = this.skin?.columns[col]?.background ?? [14, 20, 28, 235];
      this.lanePolygon(ctx, x, widths[col], this.fieldTop, 480);
      ctx.fillStyle = `rgba(${bg[0]},${bg[1]},${bg[2]},${bg[3] / 255})`; ctx.fill();
      if (!art?.laneLine) { ctx.strokeStyle = 'rgba(155,209,235,.24)'; ctx.lineWidth = .8; ctx.stroke(); }
      const age = nowPerf - (sess.colFlash[col] || 0);
      const pressed = sess.input.isDown(col);
      if (pressed || (age >= 0 && age < 160)) {
        const press = this.images.get(art?.press?.image);
        if (press) {
          ctx.save(); ctx.globalAlpha *= pressed ? .5 : .35 * (1 - age / 160);
          this.perspectiveImage(ctx, press, x + 1, hitY - 280, widths[col] - 2, 280); ctx.restore();
        } else {
          const gradient = ctx.createLinearGradient(0, hitY - 155, 0, 480);
          gradient.addColorStop(0, 'rgba(84,212,255,0)');
          gradient.addColorStop(1, `rgba(84,212,255,${pressed ? .44 : .3 * (1 - age / 160)})`);
          this.lanePolygon(ctx, x + 1, widths[col] - 2, Math.max(0, hitY - 155), 480);
          ctx.fillStyle = gradient; ctx.fill();
        }
      }
      const line = this.images.get(art?.laneLine?.image);
      if (line && col > 0) {
        this.perspectiveImage(ctx, line, x - 1.3, 0, 2.6, hitY);
        if (this.fieldTop < 0) this.perspectiveImage(ctx, line, x - 1.3, this.fieldTop, 2.6, -this.fieldTop, false, [0, 0, 1, 1 / line.height]);
      }
      x += widths[col];
    }
    ctx.save(); this.lanePolygon(ctx, x0, total, this.fieldTop, 480); ctx.clip();
    this.drawPerspectiveReceptors(ctx, sess, x0, widths, hitY, nowPerf);
    this.drawNotes(ctx, sess, x0, widths, hitY, nowPerf);
    ctx.restore();
    this.drawMspHits(ctx, sess, x0, widths, hitY, nowPerf);
    if (this.skin?.judgementLine !== false) this.drawHitline(ctx, sess, x0, total, hitY, nowPerf);
    this.drawParticles(ctx, sess);
    if (this.mods.flashlight) this.drawFlashlight(ctx, sess, x0, widths, hitY);
  }

  /** Small clipped strips preserve image detail on a trapezoid without a frame
   * buffer, shader, or per-frame image allocations. Long bodies are bounded to
   * the visible field; tap notes need only a handful of strips. */
  private perspectiveImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, width: number, height: number, flip = false, crop?: number[], flipX = false) {
    if (height <= 0 || y >= 480 || y + height <= this.fieldTop) return;
    const paint = () => {
      if (flipX) { ctx.translate(2 * x + width, 0); ctx.scale(-1, 1); }
      if (crop) ctx.drawImage(img, crop[0] * img.width, crop[1] * img.height, crop[2] * img.width, crop[3] * img.height, x, y, width, height);
      else ctx.drawImage(img, x, y, width, height);
    };
    if (height <= 70 || width <= 4) {
      // A cap is short enough for one affine projection. It follows its lane's
      // slope and avoids the raster seams of many subpixel source slices. Thin
      // dividers need the same single transform, rather than 100 strips each.
      const mid = y + height / 2, center = x + width / 2;
      const ratio = (this.projectX(x + width, mid) - this.projectX(x, mid)) / width;
      const slope = this.projectSlope(center, mid);
      ctx.save(); ctx.transform(ratio, 0, slope, 1, 256 * (1 - ratio) - slope * mid, 0);
      if (flip) { ctx.translate(0, 2 * y + height); ctx.scale(1, -1); }
      paint(); ctx.restore(); return;
    }
    const from = Math.max(this.fieldTop, y), end = Math.min(480, y + height);
    const strip = 4;
    for (let at = from; at < end;) {
      // Adjacent clips meet on device-pixel boundaries. Fractional clip edges
      // otherwise alpha-blend twice and create a ladder across translucent art.
      const next = Math.min(end, (Math.floor((at + strip) * this.rasterScaleY + this.rasterOffsetY) + 1 - this.rasterOffsetY) / this.rasterScaleY);
      const span = next - at;
      const mid = at + span / 2, center = x + width / 2;
      const ratio = (this.projectX(x + width, mid) - this.projectX(x, mid)) / width;
      const slope = this.projectSlope(center, mid);
      // Clip a complete transformed image, rather than independently resampling
      // cropped source bands (which creates horizontal seams on Canvas backends).
      ctx.save(); ctx.beginPath(); ctx.rect(-2048, at, 4096, span); ctx.clip();
      ctx.transform(ratio, 0, slope, 1, 256 * (1 - ratio) - slope * mid, 0);
      if (flip) { ctx.translate(0, 2 * y + height); ctx.scale(1, -1); }
      paint(); ctx.restore();
      at = next;
    }
  }

  private drawPerspectiveReceptors(ctx: CanvasRenderingContext2D, sess: PlaySession, x0: number, widths: number[], hitY: number, nowPerf: number) {
    const keyBackground = this.skin?.msp?.keyBackground;
    const background = this.images.get(keyBackground?.image);
    const total = widths.reduce((a, b) => a + b, 0), keyHeight = this.skin?.msp ? 53 : undefined;
    const bottom = this.images.get(this.skin?.msp?.trackBottom?.image);
    if (bottom) this.perspectiveImage(ctx, bottom, x0, hitY, total, 66);
    if (background) this.perspectiveImage(ctx, background, x0, hitY, total, keyHeight ?? 53, false, undefined, keyBackground?.flipX);
    for (let col = 0; col < widths.length; col++) {
      const c = this.skin!.columns[col], width = widths[col], x = this.laneCenter(x0, widths, col) - width / 2;
      const age = nowPerf - (sess.colFlash[col] || 0), pressed = sess.input.isDown(col) || (age >= 0 && age < 140);
      const normal = this.images.get(c.keyImg), active = pressed ? this.images.get(c.keyImgD) : null;
      const height = keyHeight ?? Math.min(60, width * .52), y = this.skin?.msp ? hitY : hitY + 4;
      if (normal) {
        const crop = c.keyCrop ?? [0, 0, 1, 1];
        const sx = c.keyFlip ? 1 - crop[0] - crop[2] : crop[0];
        this.perspectiveImage(ctx, normal, x, y, width, height, false, [sx, crop[1], crop[2], crop[3]], c.keyFlip);
      } else this.generatedReceptor(ctx, col, x + width / 2, width, hitY + height / 2, pressed);
      if (active) {
        ctx.save(); ctx.globalAlpha *= .5;
        this.perspectiveImage(ctx, active, x, y, width, height, false, undefined, c.keyPressedFlip); ctx.restore();
      }
    }
  }

  private drawMspRails(ctx: CanvasRenderingContext2D, sess: PlaySession, x0: number, total: number, hitY: number) {
    const art = this.skin?.msp;
    if (!art) return;
    const width = Math.max(12, this.projectX(x0, 0) - this.projectX(x0, 480));
    const left = this.projectX(x0, 480) - 4;
    for (const [sprite, light] of [[art.trackLeft, false], [art.trackLight, true]] as const) {
      const img = this.images.get(sprite?.image); if (!img) continue;
      ctx.save();
      if (light) {
        const beat = sess.timeMap.beatAt?.(sess.drawTime()) ?? sess.drawTime() / 500;
        ctx.globalAlpha *= .45 * Math.exp(-((beat % 1 + 1) % 1) * 5);
      }
      if (sprite?.additive) ctx.globalCompositeOperation = 'lighter';
      this.drawExtendedRail(ctx, img, left, width + 8, this.projectSlope(x0, this.fieldTop / 2));
      ctx.translate(512, 0); ctx.scale(-1, 1);
      this.drawExtendedRail(ctx, img, left, width + 8, this.projectSlope(x0, this.fieldTop / 2));
      ctx.restore();
    }
    void total; void hitY;
  }

  private drawMspHits(ctx: CanvasRenderingContext2D, sess: PlaySession, x0: number, widths: number[], hitY: number, nowPerf: number) {
    const art = this.skin?.msp; if (!art) return;
    for (let col = 0; col < widths.length; col++) {
      const age = nowPerf - (sess.colFlash[col] || 0);
      const held = !!sess.isHoldingColumn?.(col) && (sess.input.isDown(col) || this.mods.auto);
      if (!held && !sess.colFlash[col]) continue;
      const animation = held ? art.holdHit : art.hit;
      if (!animation?.frames.length || age < 0 || (!held && age >= animation.frames.length * 1000 / animation.fps)) continue;
      const index = Math.floor(age / 1000 * animation.fps) % animation.frames.length;
      const image = this.images.get(animation.frames[index]); if (!image) continue;
      const size = widths[col] * 1.65, center = this.laneCenter(x0, widths, col);
      ctx.save(); if (animation.additive) ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha *= held ? .55 : .65;
      ctx.drawImage(image, center - size / 2, hitY - size * .65, size, size * .9); ctx.restore();
    }
  }

  private drawMspCompanion(ctx: CanvasRenderingContext2D, sess: PlaySession, w: number, h: number) {
    const cat = this.skin?.msp?.cat; if (!cat) return;
    const image = this.images.get(cat.background); if (!image) return;
    const origin = this.fieldOrigin(w, h), side = (w - 480 * origin.scale) / 2;
    // Keep authored decoration clear of the notes and touch targets on phones.
    const size = Math.min(190, h * .26, side - 18);
    if (size < 58) return;
    const x = w - size - 12, y = h - size - Math.max(14, h * .06);
    const down = Array.from({ length: sess.keys }, (_, col) => sess.input.isDown(col));
    ctx.save(); ctx.drawImage(image, x, y, size, size);
    for (let col = 0; col < down.length; col++) if (down[col]) {
      const pressed = this.images.get(cat.presses[col]); if (pressed) ctx.drawImage(pressed, x, y, size, size);
    }
    for (const pose of mspCatPoses(down)) {
      const frame = this.images.get(cat.poses[pose]); if (frame) ctx.drawImage(frame, x, y, size, size);
    }
    ctx.restore();
  }

  // ================== notes ==================
  /** Build once during loading; the fallback also supports renderer previews. */
  prepareNotes(sess: PlaySession) {
    if (this.indexedNotes === sess.notes) return;
    const notes = sess.notes;
    this.indexedNotes = notes;
    this.treeSize = 1;
    while (this.treeSize < notes.length) this.treeSize *= 2;
    this.endTree = new Float64Array(this.treeSize * 2);
    this.endTree.fill(-Infinity);
    for (let i = 0; i < notes.length; i++) {
      this.endTree[this.treeSize + i] = Math.max(notes[i].t, notes[i].end ?? notes[i].t);
    }
    for (let i = this.treeSize - 1; i > 0; i--) {
      this.endTree[i] = Math.max(this.endTree[i * 2], this.endTree[i * 2 + 1]);
    }
  }

  /** Find earlier holds that still cross the visible window, in chart order. */
  private collectOldHolds(node: number, left: number, right: number, before: number, time: number) {
    if (left >= before || this.endTree[node] < time) return;
    if (right - left === 1) {
      this.oldHolds.push(left);
      return;
    }
    const mid = (left + right) >>> 1;
    this.collectOldHolds(node * 2, left, mid, before, time);
    this.collectOldHolds(node * 2 + 1, mid, right, before, time);
  }

  private noteAlpha(sess: PlaySession, y: number, hitY: number): number {
    if (this.mods.hidden) {
      return clamp(1 - (hitY - y) / (hitY * 0.55) - 0.15, 0.06, 1);
    }
    if (this.mods.fadeIn) {
      return clamp((hitY - y) / (hitY * 0.55) - 0.15, 0.06, 1);
    }
    return 1;
  }

  private drawNotes(
    ctx: CanvasRenderingContext2D,
    sess: PlaySession,
    x0: number,
    widths: number[],
    hitY: number,
    nowPerf: number,
  ) {
    const bh = this.beatHeight();
    const t = sess.drawTime();
    const scrollMap = sess.scrollMap ?? sess.timeMap;
    const svNow = scrollMap.svBeatAt(t);
    // A tall skin sprite can extend back into the viewport from below it.
    // Include its full height instead of assuming all note images are 18px.
    let capHeight = 40;
    for (let col = 0; col < widths.length; col++) {
      const c = this.skin?.columns?.[col];
      for (const path of [c?.noteImg, c?.noteImgH, c?.noteImgT, c?.bodyBegin, c?.bodyEnd]) {
        const img = this.images.get(path);
        if (img) capHeight = Math.max(capHeight, widths[col] * img.height / Math.max(1, img.width));
      }
    }
    // Increasing the visible track length reveals earlier notes at the same
    // velocity. Depth projection needs its inverse for the new top boundary.
    const visibleTop = this.unprojectY(this.fieldTop) - capHeight;
    const svTop = svNow + Math.max(740, hitY - visibleTop) / bh;
    const svBottom = svNow - Math.max(0, this.fieldBottom + capHeight - hitY) / bh;
    const tLo = scrollMap.msAtSvBeat(svBottom);
    const tHi = scrollMap.msAtSvBeat(svTop) + 50;

    const notes = sess.notes;
    // Query a bounded time window, plus long holds beginning before that window.
    // The interval index handles seek/rewind without scanning the elapsed chart.
    this.prepareNotes(sess);
    const lo = this.lowerBoundT(notes, tLo);
    const hi = this.upperBoundT(notes, tHi);
    this.oldHolds.length = 0;
    this.collectOldHolds(1, 0, this.treeSize, lo, tLo);

    const flash = (col: number): number => {
      const f = sess.colFlash[col] || 0;
      const age = nowPerf - f;
      return age < 180 ? 1 - age / 180 : 0;
    };

    for (let j = 0, count = this.oldHolds.length + Math.max(0, hi - lo); j < count; j++) {
      const i = j < this.oldHolds.length ? this.oldHolds[j] : lo + j - this.oldHolds.length;
      const n = notes[i];
      const isHold = n.end !== undefined && n.end > n.t;
      if (sess.isJudged(i)) {
        // judged holds stay visible while they are being held
        if (isHold && sess.isHeld(i)) {
          const colW = widths[n.col];
          const cx = this.laneCenter(x0, widths, n.col);
          const svEnd = scrollMap.svBeatAt(n.end!);
          const yTail = hitY - (svEnd - svNow) * bh;
          // The consumed head must not sit on the hitline and overlap the tail.
          // Fade the last 45ms on the visual clock instead of hard-cutting a
          // full cap when its endpoint crosses the line. Judgment stays separate.
          ctx.globalAlpha = 0.85 * clamp((n.end! - t) / 45, 0, 1);
          this.drawHold(ctx, sess, n.col, cx, colW, yTail, hitY, flash(n.col), true);
          ctx.globalAlpha = 1;
        }
        continue;
      }
      const colW = widths[n.col];
      const cx = this.laneCenter(x0, widths, n.col);
      const svN = scrollMap.svBeatAt(n.t);
      const yHead = hitY - (svN - svNow) * bh;
      const alpha = this.noteAlpha(sess, this.projectY(yHead), hitY);
      if (alpha <= 0.02) continue;
      ctx.globalAlpha = alpha;

      if (isHold) {
        const svEnd = scrollMap.svBeatAt(n.end!);
        const yTail = hitY - (svEnd - svNow) * bh;
        this.drawHold(ctx, sess, n.col, cx, colW, yTail, yHead, flash(n.col));
      } else {
        const noteH = 18;
        this.drawTap(ctx, sess, n.col, cx, colW, yHead, noteH, flash(n.col));
      }
      ctx.globalAlpha = 1;
    }
  }

  private lowerBoundT(notes: { t: number }[], t: number): number {
    let lo = 0, hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private upperBoundT(notes: { t: number }[], t: number): number {
    let lo = 0, hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private laneCenter(x0: number, widths: number[], col: number): number {
    let x = x0;
    for (let i = 0; i < col; i++) x += widths[i];
    return x + widths[col] / 2;
  }

  private drawTap(
    ctx: CanvasRenderingContext2D,
    sess: PlaySession,
    col: number,
    cx: number,
    colW: number,
    y: number,
    h: number,
    flash: number,
  ) {
    const imgPath = this.skin?.columns?.[col]?.noteImg;
    const img = imgPath ? this.cached(imgPath) : null;
    if (this.skin?.perspective) {
      const ih = img ? colW * img.height / Math.max(1, img.width) * (this.skin.columns[col]?.noteScaleY ?? 1) : h;
      const bottom = this.projectY(y), top = this.projectY(y - ih * (this.skin.msp?.depth ?? 1));
      if (img) this.perspectiveImage(ctx, img, cx - colW / 2, top, colW, bottom - top);
      else this.generatedTap(ctx, col, this.projectX(cx, bottom), this.projectX(cx + colW / 2, bottom) - this.projectX(cx - colW / 2, bottom), bottom, bottom - top, flash);
      return;
    }
    if (img) {
      const ih = colW * img.height / Math.max(1, img.width);
      ctx.drawImage(img, cx - colW / 2, y - ih, colW, ih);
      return;
    }
    this.generatedTap(ctx, col, cx, colW, y, h, flash);
  }

  private drawHold(
    ctx: CanvasRenderingContext2D,
    sess: PlaySession,
    col: number,
    cx: number,
    colW: number,
    yTop: number,
    yHead: number,
    flash: number,
    held = false,
  ) {
    if (held && ctx.globalAlpha <= 0) return;
    const skinCol = this.skin?.columns?.[col];
    const head = this.images.get(skinCol?.noteImgH ?? skinCol?.bodyBegin ?? skinCol?.noteImg);
    const tail = this.images.get(skinCol?.noteImgT ?? skinCol?.bodyEnd) ?? head;
    const body = this.images.get(skinCol?.bodyImg);
    if (this.skin?.perspective) {
      const depth = this.skin.msp?.depth ?? 1;
      const headH = head ? colW * head.height / Math.max(1, head.width) * (skinCol?.holdHeadScaleY ?? skinCol?.noteScaleY ?? 1) * depth : 18;
      const tailH = tail ? colW * tail.height / Math.max(1, tail.width) * (skinCol?.holdTailScaleY ?? skinCol?.noteScaleY ?? 1) * depth : 0;
      // Consuming the head removes its artwork, not its body attachment point.
      // Switching to yHead stretched spherical holds by half a cap on keydown.
      const top = this.projectY(yTop - tailH / 2), bottom = this.projectY(yHead - (head ? headH / 2 : held ? 0 : headH / 2));
      if (yHead < yTop) return;
      if (body && bottom > top) this.perspectiveImage(ctx, body, cx - colW / 2, top, colW, bottom - top);
      else if (bottom > top) {
        this.lanePolygon(ctx, cx - colW * .32, colW * .64, Math.max(this.fieldTop, top), Math.min(480, bottom));
        ctx.fillStyle = this.columnTint(col); ctx.fill();
      }
      if (tail) this.perspectiveImage(ctx, tail, cx - colW / 2, this.projectY(yTop - tailH), colW, this.projectY(yTop) - this.projectY(yTop - tailH), skinCol?.tailFlip !== false);
      if (!held) {
        if (head) this.perspectiveImage(ctx, head, cx - colW / 2, this.projectY(yHead - headH), colW, this.projectY(yHead) - this.projectY(yHead - headH));
        else this.drawTap(ctx, sess, col, cx, colW, yHead, 18, flash);
      }
      return;
    }
    const headH = head ? colW * head.height / Math.max(1, head.width) : 18;
    const tailH = tail ? colW * tail.height / Math.max(1, tail.width) : 0;
    // Both cap END-TIME edges stay at their mapped y. Tail artwork is vertically
    // reflected INSIDE that bottom-anchored rectangle, not rotated or shifted
    // below yTop. Extend the body half-way under each cap (osu DrawableHoldNote)
    // so rounded/transparent cap edges join without a seam or body protrusion.
    // Do not impose a minimum hold length: that moves the real tail timestamp.
    const top = Math.max(Math.min(-480, this.fieldTop), yTop - tailH / 2);
    const bottom = Math.min(this.fieldBottom, yHead - (head ? headH / 2 : held ? 0 : headH / 2));
    if (yHead < yTop) return;
    if (body && bottom > top) {
      if (this.skin?.noteBodyStyle === 1) {
        const tileH = Math.max(1, colW * body.height / body.width);
        // Very short tiled textures formerly issued hundreds of drawImage calls
        // per hold per frame. A repeated pattern preserves the same tile origin.
        let patterns = this.bodyPatterns.get(ctx);
        if (!patterns) { patterns = new Map(); this.bodyPatterns.set(ctx, patterns); }
        let pattern = patterns.get(body);
        if (!pattern) {
          pattern = ctx.createPattern?.(body, 'repeat') ?? undefined;
          if (pattern) patterns.set(body, pattern);
        }
        if (pattern) {
          ctx.save();
          ctx.translate(cx - colW / 2, top);
          ctx.scale(colW / body.width, tileH / body.height);
          ctx.fillStyle = pattern;
          ctx.fillRect(0, 0, body.width, (bottom - top) * body.height / tileH);
          ctx.restore();
        } else for (let y = top; y < bottom; y += tileH) {
            const h = Math.min(tileH, bottom - y);
            ctx.drawImage(body, 0, 0, body.width, body.height * h / tileH, cx - colW / 2, y, colW, h);
        }
      } else ctx.drawImage(body, cx - colW / 2, top, colW, Math.max(1, bottom - top));
    } else if (!body && bottom > top) this.generatedHoldBody(ctx, col, cx, colW, top, bottom);
    if (tail) {
      ctx.save();
      ctx.translate(cx - colW / 2, yTop);
      if (skinCol?.tailFlip !== false) {
        ctx.scale(1, -1);
        ctx.drawImage(tail, 0, 0, colW, tailH);
      } else ctx.drawImage(tail, 0, -tailH, colW, tailH);
      ctx.restore();
    }
    if (held) return;
    if (head) {
      ctx.drawImage(head, cx - colW / 2, yHead - headH, colW, headH);
    } else this.generatedTap(ctx, col, cx, colW, yHead, 18, flash);
  }

  private cached(path: string): HTMLImageElement | null {
    return this.images.get(path);
  }

  // ---- generated neon notes ----
  private generatedTap(ctx: CanvasRenderingContext2D, col: number, cx: number, colW: number, y: number, h: number, flash: number) {
    const color = this.columnTint(col);
    const r = Math.min(colW, h) * 0.18;
    const inset = Math.min(4, colW * 0.07);
    const x = cx - colW / 2 + inset;
    const width = colW - inset * 2;
    ctx.fillStyle = flash > 0 ? '#f4f7fb' : color;
    this.rr(ctx, x, y - h, width, h, r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 1;
    this.rr(ctx, x, y - h, width, h, r);
    ctx.stroke();
  }

  private generatedHold(ctx: CanvasRenderingContext2D, col: number, cx: number, colW: number, yTop: number, yHead: number, flash: number) {
    const color = this.columnTint(col);
    this.generatedHoldBody(ctx, col, cx, colW, yTop, yHead);
    const capH = clamp(colW * 0.55, 12, 40);
    this.generatedTap(ctx, col, cx, colW, yHead, capH, flash);
    void color;
  }

  private generatedHoldBody(ctx: CanvasRenderingContext2D, col: number, cx: number, colW: number, yTop: number, yHead: number) {
    const height = yHead - yTop;
    if (height <= 0) return;
    const color = this.columnTint(col);
    const width = colW * 0.64;
    const x = cx - width / 2;
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha *= 0.32;
    ctx.fillRect(x, yTop, width, height);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha *= 0.65;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, yTop, width, height);
    ctx.restore();
  }

  private rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  // ---- receptors ----
  private drawReceptors(
    ctx: CanvasRenderingContext2D,
    sess: PlaySession,
    x0: number,
    widths: number[],
    hitY: number,
    nowPerf: number,
  ) {
    for (let c = 0; c < sess.keys; c++) {
      const colW = widths[c];
      const cx = this.laneCenter(x0, widths, c);
      const f = sess.colFlash[c] || 0;
      const flashAge = nowPerf - f;
      const flashing = flashAge < 180;
      const pressed = sess.input.isDown(c) || flashing;

      // stage light flash across the lane
      const light = this.skin?.stage?.light;
      if (light && flashing) {
        const img = this.cached(light);
        if (img) {
          ctx.globalAlpha = (1 - flashAge / 180) * 0.9;
          this.drawExtendedRail(ctx, img, cx - colW / 2, colW);
          ctx.globalAlpha = 1;
        }
      }

      const imgPath = pressed
        ? this.skin?.columns?.[c]?.keyImgD || this.skin?.columns?.[c]?.keyImg
        : this.skin?.columns?.[c]?.keyImg;
      const img = imgPath ? this.cached(imgPath) : null;
      if (img) {
        const kH = colW * (img.height / Math.max(1, img.width));
        // Legacy key artwork is bottom-anchored to the stage, independent of
        // HitPosition. Its transparent padding locates rings/keys in that stage.
        // Never animate its scale: pressed images may encode their own geometry.
        ctx.drawImage(img, cx - colW / 2, 480 - kH, colW, kH);
      } else {
        this.generatedReceptor(ctx, c, cx, colW, hitY, pressed);
      }
    }
  }

  private generatedReceptor(ctx: CanvasRenderingContext2D, col: number, cx: number, colW: number, hitY: number, pressed: boolean) {
    const color = this.columnTint(col);
    const w = colW * 0.86;
    const h = clamp(colW * 0.2, 10, 18);
    const x = cx - w / 2;
    const y = hitY - h / 2;
    ctx.save();
    ctx.translate(cx, hitY);
    ctx.fillStyle = pressed ? color : '#1c2633';
    this.rr(ctx, -w / 2, -h / 2, w, h, 5);
    ctx.fill();
    ctx.strokeStyle = pressed ? '#ffffff' : color;
    ctx.globalAlpha = pressed ? 1 : 0.55;
    ctx.lineWidth = 1.6;
    this.rr(ctx, -w / 2, -h / 2, w, h, 5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // A small registration mark rather than a competing arrow motif.
    ctx.fillStyle = pressed ? '#ffffff' : color;
    ctx.fillRect(-w * 0.16, -1, w * 0.32, 2);
    ctx.restore();
  }

  private drawHitline(
    ctx: CanvasRenderingContext2D,
    sess: PlaySession,
    x0: number,
    totalW: number,
    hitY: number,
    nowPerf: number,
  ) {
    ctx.strokeStyle = 'rgba(224,233,244,0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, hitY);
    ctx.lineTo(x0 + totalW, hitY);
    ctx.stroke();
    void sess; void nowPerf;
  }

  private drawParticles(ctx: CanvasRenderingContext2D, sess: PlaySession) {
    for (const p of sess.particles) {
      ctx.globalAlpha = 1 - p.life / p.ttl;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  /** HUD-space judgement: one readable grade below combo, independent of lane
   * perspective, field width and the column that was hit. */
  drawJudgement(ctx: CanvasRenderingContext2D, sess: PlaySession, x: number, y: number, maxWidth: number) {
    const now = sess.chartTime();
    const grades = ['PERFECT', 'GREAT', 'GOOD', 'OK', 'MEH', 'MISS'];
    let popup: PlaySession['popups'][number] | undefined;
    for (let i = sess.popups.length - 1; i >= 0; i--) {
      const p = sess.popups[i], age = now - p.t0;
      if (age < 0 || age > 900) continue;
      if (!popup || p.t0 > popup.t0 || (p.t0 === popup.t0 && grades.indexOf(p.label.replace(/^TAIL /, '')) > grades.indexOf(popup.label.replace(/^TAIL /, '')))) popup = p;
    }
    if (!popup) return;
    const age = now - popup.t0, label = popup.label.replace(/^TAIL /, '');
    const grade = (label === 'MEH' ? 'bad' : label.toLowerCase()) as keyof NonNullable<NFSkin['judgments']>;
    const scale = .92 + .08 * clamp(age / 70, 0, 1);
    const fade = age > 600 ? 1 - (age - 600) / 300 : 1;
    const imgPath = this.skin?.judgments?.[grade], img = imgPath ? this.cached(imgPath) : null;
    ctx.save(); ctx.globalAlpha *= fade;
    const effect = grade === 'perfect' ? this.images.get(this.skin?.msp?.perfectEffect?.image) : null;
    if (effect && age < 400) {
      const width = Math.min(200, maxWidth * 1.6), height = Math.min(40, width * effect.height / effect.width);
      ctx.save(); if (this.skin?.msp?.perfectEffect?.additive) ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha *= (1 - age / 400) * .65;
      ctx.drawImage(effect, x - width / 2, y - height / 2, width, height); ctx.restore();
    }
    if (img) {
      const b = skinBounds(img), fit = Math.min(maxWidth / b.w, 30 / b.h) * scale;
      ctx.drawImage(img, b.x, b.y, b.w, b.h, x - b.w * fit / 2, y - b.h * fit / 2, b.w * fit, b.h * fit);
    } else {
      ctx.translate(x, y); ctx.scale(scale, scale);
      ctx.font = `700 ${Math.min(24, maxWidth / 4)}px "Segoe UI", Arial`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = popup.color; ctx.shadowBlur = 10; ctx.fillStyle = popup.color;
      ctx.fillText(tr(label), 0, 0, maxWidth);
    }
    ctx.restore();
  }

  private drawFlashlight(ctx: CanvasRenderingContext2D, sess: PlaySession, x0: number, widths: number[], hitY: number) {
    ctx.save();
    ctx.fillStyle = 'rgba(2,4,10,0.84)';
    ctx.fillRect(0, this.fieldTop, 512, this.fieldBottom - this.fieldTop);
    ctx.globalCompositeOperation = 'destination-out';
    for (let c = 0; c < sess.keys; c++) {
      const cx = this.laneCenter(x0, widths, c);
      const w = widths[c] * 0.62;
      const grad = ctx.createRadialGradient(cx, hitY - 60, 10, cx, hitY - 60, 190);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - w, hitY - 240, w * 2, 330);
    }
    ctx.restore();
  }
}
