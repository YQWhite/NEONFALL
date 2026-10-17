// Main menu: quiet editorial typography and an abstract rhythm sculpture.
import { tr } from '../i18n.ts';
import { Screen } from '../app.ts';
import { text, fillPanel, clamp01 } from '../theme.ts';
import { bridge } from '../../core/store.ts';
import type { MenuVisual } from '../menu-music.ts';
import { drawMenuFountains } from '../menu-fountain.ts';

/** osu-style additive edge-to-centre gradients, kept narrow around the content. */
export function drawMenuBeatEdges(ctx: CanvasRenderingContext2D, w: number, h: number, visual: MenuVisual) {
  const sideWidth = visual.previewSection ? Math.min(52, w * .05) : Math.min(32, w * .032);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const side of [0, 1]) {
    const impact = side ? visual.rightImpact : visual.leftImpact;
    if (!(impact > .008)) continue;
    ctx.save();
    ctx.translate(side ? w : 0, 0); ctx.scale(side ? -1 : 1, 1);
    if (visual.previewSection) {
      // A very faint wash on this half only: max 3.5% white at the outer edge,
      // falling to transparent at the centre, behind all labels and controls.
      const wash = ctx.createLinearGradient(0, 0, w / 2, 0);
      wash.addColorStop(0, 'rgba(255,255,255,0.035)');
      wash.addColorStop(.5, 'rgba(255,255,255,0.012)');
      wash.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = impact * impact;
      ctx.fillStyle = wash; ctx.fillRect(0, 0, w / 2, h);
    }
    const glow = ctx.createLinearGradient(0, 0, sideWidth, 0);
    glow.addColorStop(0, 'rgba(255,255,255,0.48)');
    glow.addColorStop(.18, 'rgba(255,255,255,0.24)');
    glow.addColorStop(.55, 'rgba(255,255,255,0.075)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = impact;
    ctx.fillStyle = glow; ctx.fillRect(0, 0, sideWidth, h);
    ctx.globalAlpha = impact * (visual.previewSection ? .65 : .52);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1, h);
    ctx.restore();
  }
  ctx.restore();
}

export class MenuScreen extends Screen {
  readonly name = 'menu';
  private t0 = 0;
  private visual: MenuVisual = { bands: new Float32Array(17), pulse: 0, energy: 0, position: 0, leftImpact: 0, rightImpact: 0, sectionBurst: 0, previewSection: false };

  enter() { this.t0 = performance.now(); }
  update(dt: number, _now: number) { this.visual = this.app.menuMusic.visualizer(dt); }

  keyDown(code: string) {
    if (code === 'Enter' || code === 'NumpadEnter') {
      this.app.uiSound();
      this.app.gotoScreen('select');
    } else if (code === 'Escape' && bridge()) this.app.quitApp();
  }

  private action(id: string) {
    this.app.uiSound();
    if (id === 'quit') this.app.quitApp();
    else this.app.gotoScreen(id === 'play' ? 'select' : id);
  }

  private button(ctx: CanvasRenderingContext2D, id: string, label: string, x: number, y: number, w: number, h: number, primary = false) {
    const clicked = this.app.ui.button('menu-' + id, x, y, w, h, '');
    const hover = this.app.ui.hover('menu-' + id, x, y, w, h);
    fillPanel(ctx, x, y, w, h, { r: primary ? 16 : 10, fill: primary ? (hover ? '#e0ece7' : '#c9ded4') : (hover ? '#232c34' : '#171e26'), line: primary ? '#c9ded4' : '#303942' });
    text(ctx, label, x + (primary ? 24 : w / 2), y + h / 2, { size: primary ? 22 : 12, weight: primary ? 700 : 600, color: primary ? '#111b19' : '#c4cdd4', align: primary ? 'left' : 'center', baseline: 'middle', spacing: primary ? '2px' : '0.8px' });
    if (primary) text(ctx, '↗', x + w - 24, y + h / 2, { size: 25, color: '#223b32', align: 'right', baseline: 'middle' });
    if (clicked) this.action(id);
  }

  draw(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app;
    this.app.menuMusic.drawBackground(ctx, w, h);
    drawMenuBeatEdges(ctx, w, h, this.visual);
    drawMenuFountains(ctx, w, h, this.visual.fountainAgeMs ?? -1, this.visual.fountainSeed ?? 0);
    const pad = Math.max(24, Math.min(76, w * 0.065));
    const compact = h < 580;
    const shortLandscape = w > h && h < 500;
    const top = shortLandscape ? 116 : Math.max(126, Math.min(h * 0.27, 230));
    const contentW = Math.min(420, w - pad * 2);
    const titleSize = Math.min(shortLandscape ? Math.max(28, Math.min(44, (h - 240) * .4)) : compact ? 54 : 72, contentW / 6.1);

    // Decorative art lives below the shared player's reserved top-right space.
    if (w >= 860 && h >= 420) {
      ctx.save();
      const cx = w * 0.77, cy = Math.max(250, h * 0.53);
      // Reduced motion keeps a restrained, live music meter without orbiting
      // decorations or side flashes; it never blanks the audio feedback.
      const pulse = this.visual.pulse * (this.visual.reducedMotion ? .22 : 1);
      const radius = Math.min(w * 0.21, h * 0.32) * (1 + pulse * .075);
      ctx.translate(cx, cy);
      // The glow is cast by the icon paths themselves; no rectangular light layer.
      ctx.shadowColor = 'rgba(158,203,175,0.55)';
      ctx.shadowBlur = 4 + pulse * 9;
      for (let i = 0; i < 17; i++) {
        const barH = 8 + this.visual.bands[i] ** 1.7 * (this.visual.reducedMotion ? 36 : 90);
        ctx.fillStyle = i % 3 === 0 ? '#a6cbb5' : '#507d63';
        ctx.fillRect(-80 + i * 10, -barH / 2, 3, barH);
      }
      ctx.rotate(-0.42);
      for (let i = 0; i < 5; i++) {
        const rx = radius * (0.4 + i * 0.15);
        ctx.beginPath(); ctx.ellipse(0, 0, rx, radius * (0.18 + i * 0.085), 0, 0, Math.PI * 2);
        ctx.shadowBlur = i === 3 ? 8 + pulse * 14 : 3 + pulse * 5;
        ctx.strokeStyle = i === 3 ? `rgba(167,203,183,${.5 + pulse * .4})` : `rgba(151,174,167,${.18 + pulse * .18})`; ctx.lineWidth = i === 3 ? 1.5 + pulse : 1; ctx.stroke();
        const a = (this.visual.reducedMotion ? 0 : this.visual.position / (18 + i * 7)) + i * 1.5;
        ctx.beginPath(); ctx.arc(Math.cos(a) * rx, Math.sin(a) * radius * (0.18 + i * 0.085), i === 3 ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = i === 3 ? '#c9ded4' : '#63776f'; ctx.fill();
      }
      ctx.restore();
      text(ctx, 'R H Y T H M  /  I N  M O T I O N', w * 0.77, Math.min(h - 90, cy + radius + 38), { size: 10, color: '#65736f', align: 'center' });
    }

    ctx.save();
    ctx.globalAlpha = clamp01((performance.now() - this.t0) / 500);
    if (h >= 500) {
      const connected = this.app.serverOnline;
      ctx.beginPath(); ctx.arc(pad + 3, top - 27, 3, 0, Math.PI * 2); ctx.fillStyle = connected ? '#add3b6' : '#6b7984'; ctx.fill();
      text(ctx, connected ? 'CONNECTED' : 'NOT CONNECTED', pad + 14, top - 24, { size: 9, color: connected ? '#a9c8b5' : '#77848e', spacing: '.8px' });
    }
    if (!shortLandscape) text(ctx, 'A FALLING-NOTE RHYTHM EXPERIENCE', pad, top, { size: 10, spacing: '1.8px', color: '#8da69a', weight: 600 });
    text(ctx, 'NEONFALL', pad - 3, top + titleSize + 14, { size: titleSize, weight: 600, spacing: '-2px', color: '#edf1ef' });
    const subtitleY = top + titleSize + 48;
    if (!shortLandscape) text(ctx, 'Find your rhythm. Make it yours.', pad, subtitleY, { size: compact ? 13 : 15, color: '#87939f', weight: 400 });
    const playY = shortLandscape ? top + titleSize + 30 : subtitleY + (compact ? 24 : 40);
    this.button(ctx, 'play', 'PLAY', pad, playY, contentW, shortLandscape ? 46 : compact ? 58 : 72, true);
    const secondaryY = playY + (shortLandscape ? 56 : compact ? 70 : 86);
    const gap = 8, bw = (contentW - gap * 2) / 3;
    ['settings', 'account', 'import'].forEach((id, i) => this.button(ctx, id, id.toUpperCase(), pad + i * (bw + gap), secondaryY, bw, 40));
    const acc = this.app.account.user;
    let label = acc ? tr('{name} · {rating} rating', { name: acc.nickname || acc.username, rating: (acc.rating || 0).toFixed(0) }) : this.app.serverOnline ? tr('Connected · sign in to sync your scores') : 'Offline session · your library, your pace';
    if (label.length > 47) label = label.slice(0, 44) + '…';
    if (secondaryY + 70 < h - 40) text(ctx, label, pad, secondaryY + 69, { size: 11, color: '#72808d', weight: 400 });
    ctx.restore();

    // Small utility marker stays left of (never beneath) the shared player.
    if (w >= 1080) text(ctx, 'NF / RHYTHM SYSTEM', pad, 49, { size: 10, color: '#7b8a96', spacing: '1.5px' });
    if (bridge()) this.button(ctx, 'quit', 'QUIT', w - 94, h - 49, 70, 30);
    text(ctx, `v${this.app.version}  /  ${this.app.platform.toUpperCase()}  /  4–8K`, pad, h - 27, { size: 10, color: '#596774', weight: 500, spacing: '1px' });
  }
}
