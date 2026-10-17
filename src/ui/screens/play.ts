// Play screen — gameplay wrapper: background, storyboard, video, HUD, pause/fail, result hand-off.
import { Screen } from '../app.ts';
import { THEME, text, neonText, fillPanel, drawProgress, paragraph } from '../theme.ts';
import { tr } from '../i18n.ts';
import { skinBounds } from '../skin-art.ts';
import { readNFM, readNFSK, type NFMArchive } from '../../core/nfm.ts';
import { PlaySession } from '../../engine/play.ts';
import { PlayfieldRenderer } from '../../engine/render.ts';
import type { ChartEntry } from '../../core/store.ts';
import type { NFSkin } from '../../core/types.ts';
import { fmtTime, findCI } from '../../core/zip.ts';
import { selectSkinForKeys } from '../../core/osk.ts';
import type { SBPass } from '../../core/storyboard.ts';
import { getDefaultSkin } from '../../core/default-skin.ts';
import { scoreSync } from '../../api/score-sync.ts';
import { laneAtPoint } from '../../engine/lane-geometry.ts';

export class PlayScreen extends Screen {
  readonly name = 'play';
  private entry: ChartEntry | null = null;
  private sess: PlaySession | null = null;
  private renderer: PlayfieldRenderer | null = null;
  private sbCanvas: HTMLCanvasElement | null = null;
  private status = 'loading…';
  private statusPct = 0;
  private handoff = false;
  private transition = 0;
  private pausedT = 0;
  private visualPhase: PlaySession['phase'] | null = null;
  private loadToken = 0;
  private loadAbort: AbortController | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  async enter(p: { entry: ChartEntry }) {
    const token = ++this.loadToken;
    this.loadAbort?.abort();
    const abort = new AbortController(); this.loadAbort = abort;
    const current = () => token === this.loadToken && !abort.signal.aborted;
    if (this.errorTimer !== null) clearTimeout(this.errorTimer);
    this.errorTimer = null;
    this.visualPhase = null;
    this.handoff = false;
    this.entry = p.entry;
    this.status = 'loading chart…';
    this.statusPct = 0.1;
    try {
      const entry = p.entry;
      const bytes = entry.server
        ? await this.app.server.downloadChart(entry.id)
        : await this.app.store.getChartBytes(entry.id);
      if (!current()) return;
      if (!bytes) throw new Error('chart data not found');
      this.statusPct = 0.25;
      const archive: NFMArchive = await this.app.store.prepareChart(readNFM(bytes));
      if (!current()) return;
      archive.chart.id = entry.id;
      this.statusPct = 0.35;

      // selected skin
      let skin: NFSkin | null = null;
      let skinFiles: Map<string, Uint8Array> | null = null;
      const skinId = this.app.settings.skinId;
      if (skinId) {
        const skBytes = await this.app.store.getSkinBytes(skinId);
        if (!current()) return;
        if (skBytes) {
          try {
            const parsed = readNFSK(skBytes);
            skin = parsed.skin;
            skinFiles = parsed.files;
          } catch {
            skin = null;
          }
        }
      }
      const bundled = getDefaultSkin();
      const selectedSkin = selectSkinForKeys(skin, archive.chart.keys);
      const effectiveSkin = selectedSkin ?? selectSkinForKeys(bundled.skin, archive.chart.keys)
        ?? selectSkinForKeys(archive.chart.skin?.data, archive.chart.keys);
      const effectiveFiles = selectedSkin ? skinFiles : effectiveSkin?.source?.type === 'msp' ? bundled.files : null;
      const getAsset = (p: string) => (effectiveFiles ? findCI(effectiveFiles, p) : undefined) ?? findCI(archive.files, p);
      this.statusPct = 0.5;

      const audioBytes = archive.files.get(archive.chart.meta.audio);
      if (!audioBytes) throw new Error('chart audio missing');

      this.status = 'decoding audio…';
      this.sess = new PlaySession(
        archive.chart,
        archive,
        { skin: effectiveSkin, getAsset },
        this.app.mods,
        this.app.settings,
        this.app.audio,
        Math.floor(Math.random() * 0x7fffffff),
      );
      await this.app.audio.loadMusic(audioBytes, entry.id, abort.signal);
      if (!current()) return;
      this.statusPct = 0.85;

      this.renderer = new PlayfieldRenderer(effectiveSkin, getAsset, this.app.settings, this.app.mods);
      this.renderer.prepareNotes(this.sess);
      // preload skin images
      const paths: (string | undefined)[] = [];
      for (const c of effectiveSkin?.columns ?? []) {
        paths.push(c.keyImg, c.keyImgD, c.noteImg, c.noteImgH, c.noteImgT, c.bodyImg, c.bodyBegin, c.bodyEnd);
      }
      if (effectiveSkin?.stage) {
        paths.push(
          effectiveSkin.stage.left, effectiveSkin.stage.right, effectiveSkin.stage.bottom,
          effectiveSkin.stage.light, effectiveSkin.stage.hint, effectiveSkin.stage.warning,
        );
      }
      if (effectiveSkin?.judgments) {
        paths.push(
          effectiveSkin.judgments.perfect, effectiveSkin.judgments.great, effectiveSkin.judgments.good,
          effectiveSkin.judgments.ok, effectiveSkin.judgments.bad, effectiveSkin.judgments.miss,
        );
      }
      paths.push(...Object.values(effectiveSkin?.hud ?? {}), ...Object.values(effectiveSkin?.grades ?? {}));
      await Promise.all(paths.map(p => this.renderer!.images.load(p)));
      if (!current()) return;
      await this.renderer.prepareSkinArt();
      if (!current()) return;
      // Transparent HUD/grade bounds require a one-time pixel read. Do that
      // while loading, before the first timed gameplay frame.
      for (const path of new Set([...Object.values(effectiveSkin?.hud ?? {}), ...Object.values(effectiveSkin?.grades ?? {}), ...Object.values(effectiveSkin?.judgments ?? {})])) {
        const image = this.renderer.images.get(path);
        if (image) skinBounds(image);
      }
      // pre-decode skin hitsounds so first hit has zero decode latency
      const sfxPaths: (string | undefined)[] = [];
      const hs = effectiveSkin?.hitsounds;
      for (const set of ['normal', 'soft', 'drum'] as const) {
        const s = hs?.[set];
        if (s) sfxPaths.push(s.hit, s.whistle, s.finish, s.clap);
      }
      if (effectiveSkin?.misc?.combobreak) sfxPaths.push(effectiveSkin.misc.combobreak);
      for (const p of sfxPaths) {
        if (!p) continue;
        const data = getAsset(p);
        if (data) this.app.audio.decode(data, p).catch(() => undefined);
      }
      this.statusPct = 0.95;

      // storyboard canvas
      if (this.sess.sb) {
        this.status = 'loading storyboard…';
        await this.sess.sb.prepare(this.sess.initialTime());
        if (!current()) return;
        const q = this.app.settings.sbQuality;
        this.sbCanvas = document.createElement('canvas');
        this.sbCanvas.width = Math.round(640 * q);
        this.sbCanvas.height = Math.round(480 * q);
      }
      // video element (hidden in DOM, drawn via drawImage)
      if (this.sess.videoEl) {
        this.sess.videoEl.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0.01;pointer-events:none;';
        document.body.appendChild(this.sess.videoEl);
      }

      this.sess.input.attach(window);
      this.sess.input.setLaneRect(this.laneRect());
      this.sess.input.setLaneResolver((x, y) => this.touchLane(x, y));
      this.sess.beginPlay();
      if (this.sess.introSkipped) this.app.toast('intro skipped — 3s to the first note');
      this.status = '';
      this.statusPct = 1;
      if (this.app.animateViewChange) this.app.animateViewChange(() => {});
    } catch (e: any) {
      if (!current()) return;
      this.status = tr(e?.message || 'failed to load');
      console.error(e);
      this.errorTimer = setTimeout(() => { if (current()) this.app.gotoScreen('select'); }, 1800);
    }
  }

  leave() {
    this.loadToken++;
    this.loadAbort?.abort(); this.loadAbort = null;
    if (this.errorTimer !== null) clearTimeout(this.errorTimer);
    this.errorTimer = null;
    this.visualPhase = null;
    this.sess?.dispose();
    this.sess = null;
    this.renderer = null;
    if (this.sbCanvas) {
      this.sbCanvas.remove();
      this.sbCanvas = null;
    }
  }

  onHidden() {
    if (this.sess && this.sess.phase === 'playing') this.sess.pause();
  }

  private laneRect() {
    if (!this.renderer || !this.sess) return null;
    const { ox, oy, scale, scaleY } = this.renderer.fieldOrigin(this.app.w, this.app.h);
    const widths = this.renderer.laneWidths(this.sess);
    const totalW = widths.reduce((a, b) => a + b, 0);
    const x0 = this.sess.laneStart();
    return { x: ox + x0 * scale, y: oy, w: totalW * scale, h: 480 * scaleY };
  }

  private touchLane(x: number, y: number): number {
    if (!this.renderer || !this.sess || this.sess.phase !== 'playing') return -1;
    const origin = this.renderer.fieldOrigin(this.app.w, this.app.h);
    return laneAtPoint(x, y, origin, this.sess.laneStart(), this.renderer.laneWidths(this.sess),
      (x, y) => this.renderer!.projectX(x, y));
  }

  resize() {
    this.sess?.input.setLaneRect(this.laneRect());
  }

  keyDown(code: string, e?: KeyboardEvent) {
    const s = this.sess;
    if (!s || e?.repeat) return;
    if (s.phase === 'failed' && code === 'Escape') { s.quit(); this.app.gotoScreen('select'); return; }
    if (code === 'Escape') {
      if (s.phase === 'playing') {
        s.pause();
        this.pausedT = performance.now();
        this.app.uiSound();
      } else if (s.phase === 'paused') {
        s.resume();
        this.app.uiSound();
      }
      return;
    }
    if (s.phase === 'paused') {
      if (code === 'KeyR') {
        s.retry();
        this.app.uiSound();
      } else if (code === 'KeyQ') {
        s.quit();
        this.app.gotoScreen('select');
      } else if (code === 'Enter' || code === 'NumpadEnter') {
        s.resume();
        this.app.uiSound();
      }
      return;
    }
    if (s.phase === 'failed') {
      if (code === 'KeyR' || code === 'Enter') {
        s.retry();
        this.app.uiSound();
      } else if (code === 'KeyQ' || code === 'Escape') {
        s.quit();
        this.app.gotoScreen('select');
      }
      return;
    }
    if (code === 'Space' && s.phase === 'playing' && (s.canSkipIntro() || s.canSkipOutro() || s.inBreak())) {
      e?.preventDefault();
      s.trySkip();
    }
  }

  update(dt: number, now: number) {
    const s = this.sess;
    if (!s) return;
    s.update(dt, now);
    if (this.visualPhase !== s.phase) {
      if (this.visualPhase && ['playing', 'paused', 'failed'].includes(s.phase) && this.app.animateViewChange) this.app.animateViewChange(() => {});
      this.visualPhase = s.phase;
    }
    if (s.phase === 'finished' && !this.handoff) {
      this.handoff = true;
      const result = s.buildResult();
      this.submitAndGo(result);
    }
    // transition fade
    if (this.transition > 0) this.transition = Math.max(0, this.transition - dt);
  }

  private async submitAndGo(result: ReturnType<PlaySession['buildResult']>) {
    const { rating, ratingBefore } = scoreSync(this.app).submit(result);
    const gradeImage = this.renderer?.images.get(this.sess?.skin?.grades?.[result.grade as 'SS']);
    this.app.gotoScreen('result', { result, entry: this.entry, rating, ratingBefore, gradeImage, cover: this.sess?.bgImage });
  }

  draw(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app;
    const s = this.sess;
    if (!s || this.status) {
      ctx.fillStyle = '#0d1218';
      ctx.fillRect(0, 0, w, h);
      text(ctx, this.status, w / 2, h / 2 - 20, { size: 18, color: THEME.accent, align: 'center', baseline: 'middle', maxWidth: w - 48 });
      drawProgress(ctx, w / 2 - 150, h / 2 + 20, 300, 8, this.statusPct);
      return;
    }

    const dim = this.app.settings.bgDim, drawnPhase = s.phase;

    // background image
    if (s.bgImage && s.bgImage.complete && s.bgImage.naturalWidth > 0) {
      const iw = s.bgImage.naturalWidth;
      const ih = s.bgImage.naturalHeight;
      const sc = Math.max(w / iw, h / ih);
      ctx.drawImage(s.bgImage, (w - iw * sc) / 2, (h - ih * sc) / 2, iw * sc, ih * sc);
      ctx.fillStyle = `rgba(5,7,15,${dim})`;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = '#0d1218';
      ctx.fillRect(0, 0, w, h);
      const g = ctx.createRadialGradient(w / 2, h * 0.4, 10, w / 2, h * 0.4, w * 0.7);
      g.addColorStop(0, 'rgba(16,32,64,0.6)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // video background
    const v = s.videoEl;
    if (v && s.videoReady && v.readyState >= 2) {
      const vw = v.videoWidth || 1280;
      const vh = v.videoHeight || 720;
      const sc = Math.max(w / vw, h / vh);
      ctx.save();
      ctx.globalAlpha = 1 - dim;
      ctx.drawImage(v, (w - vw * sc) / 2, (h - vh * sc) / 2, vw * sc, vh * sc);
      ctx.restore();
      ctx.fillStyle = `rgba(5,7,15,${dim * 0.6})`;
      ctx.fillRect(0, 0, w, h);
    }

    this.drawStoryboard(ctx, 'background');

    // playfield
    if (this.renderer) {
      this.renderer.draw(ctx, s, w, h, performance.now());
    }

    // osu Overlay is above hit objects, below the HUD and pause controls.
    // Drawing it with the background hid every SB object in Mopemope Suic!de.
    this.drawStoryboard(ctx, 'overlay');

    // pause darken
    if (drawnPhase === 'paused' || drawnPhase === 'failed') {
      ctx.fillStyle = 'rgba(2,4,10,0.72)';
      ctx.fillRect(0, 0, w, h);
    }

    this.drawHUD(ctx, s);
    if (drawnPhase === 'paused') this.drawPause(ctx);
    if (drawnPhase === 'failed') this.drawFail(ctx);
  }

  private drawStoryboard(ctx: CanvasRenderingContext2D, pass: SBPass) {
    const s = this.sess;
    if (!this.sbCanvas || !s?.sb) return;
    const { w, h } = this.app;
    if (s.sb.needsBackdrop(pass)) {
      // Additive colour must blend with the existing scene, not transparent
      // pixels in an intermediate canvas. Keep these passes at native quality.
      ctx.save();
      const scale = h / 480;
      ctx.translate((w - 640 * scale) / 2, 0);
      ctx.scale(scale, scale);
      s.sb.draw(ctx, s.chartTime(), s.hp < 50, pass, this.app.settings.storyboardBrightness);
      ctx.restore();
      return;
    }
    const sbc = this.sbCanvas.getContext('2d')!;
    const q = Math.max(0.25, Math.min(1, this.app.settings.sbQuality || 1));
    // osu's 640×480 stage expands horizontally on widescreen.
    const logicalWidth = Math.max(640, w / h * 480);
    const pixelWidth = Math.round(logicalWidth * q), pixelHeight = Math.round(480 * q);
    if (this.sbCanvas.width !== pixelWidth || this.sbCanvas.height !== pixelHeight) {
      this.sbCanvas.width = pixelWidth; this.sbCanvas.height = pixelHeight;
    }
    sbc.setTransform(pixelWidth / logicalWidth, 0, 0, pixelHeight / 480, 0, 0);
    sbc.clearRect(0, 0, logicalWidth, 480);
    sbc.translate((logicalWidth - 640) / 2, 0);
    s.sb.draw(sbc, s.chartTime(), s.hp < 50, pass, this.app.settings.storyboardBrightness);
    const dw = logicalWidth * h / 480;
    ctx.drawImage(this.sbCanvas, (w - dw) / 2, 0, dw, h);
  }

  private drawHUD(ctx: CanvasRenderingContext2D, s: PlaySession) {
    const { w, h } = this.app, compact = w < 800;
    const margin = compact ? 18 : 28, hpw = Math.min(230, w * .29);
    // The active skin owns the health artwork. Empty skins use the shared theme.
    text(ctx, 'HEALTH', margin, 23, { size: 9, color: '#aebfb4', spacing: '1.5px', shadow: true });
    const fill = this.renderer?.images.get(s.skin?.hud?.healthFill);
    const bg = this.renderer?.images.get(s.skin?.hud?.healthBackground);
    const marker = this.renderer?.images.get(s.skin?.hud?.healthMarker);
    const hp = Math.max(0, Math.min(1, s.hp / 100));
    const hpHeight = fill ? Math.min(22, hpw * skinBounds(fill).h / skinBounds(fill).w) : 7;
    fillPanel(ctx, margin, 32, hpw, hpHeight, { r: 3, fill: 'rgba(4,10,15,.8)', line: 'rgba(255,255,255,.14)' });
    if (bg) {
      const b = skinBounds(bg);
      // Some scorebar-bg files decorate the entire screen; only compact art fits here.
      if (b.w / b.h < 12) ctx.drawImage(bg, b.x, b.y, b.w, b.h, margin, 32, hpw, hpHeight);
    }
    if (fill && hp > 0) {
      const b = skinBounds(fill);
      ctx.drawImage(fill, b.x, b.y, b.w * hp, b.h, margin, 32, hpw * hp, hpHeight);
    } else if (!fill) {
      ctx.fillStyle = hp > .4 ? THEME.green : hp > .2 ? THEME.orange : THEME.red;
      ctx.fillRect(margin, 32, hpw * hp, hpHeight);
    }
    if (marker) {
      const b = skinBounds(marker), mh = Math.max(12, hpHeight + 5), mw = mh * b.w / b.h;
      ctx.drawImage(marker, b.x, b.y, b.w, b.h, margin + hpw * hp - mw / 2, 32 - (mh - hpHeight) / 2, mw, mh);
    }
    if (this.entry) {
      text(ctx, this.entry.title, margin, 73, { size: 12, color: '#d1dbd5', maxWidth: w * .32, shadow: true, translate: false });
      text(ctx, `${this.entry.version} · ${this.entry.keys}K`, margin, 92, { size: 10, color: THEME.dim, maxWidth: w * .32, translate: false });
      if (s.modsUsed().length) text(ctx, s.modsUsed().map(m => tr(m.toUpperCase())).join(' · '), margin, 110, { size: 10, color: THEME.accent2, maxWidth: w * .32 });
    }
    text(ctx, s.score.toLocaleString(), w - margin, 38, { size: compact ? 26 : 32, color: '#ffffff', align: 'right', weight: 600, shadow: true });
    text(ctx, (s.accuracy() * 100).toFixed(2) + '%', w - margin, 62, { size: 14, color: THEME.accent, align: 'right', shadow: true });
    if (s.combo >= 2) {
      const label = `${s.combo}x combo`, size = Math.min(compact ? 24 : 34, w * .36 / (label.length * .6));
      text(ctx, label, w / 2, 55, { size, color: '#e0dfcf', align: 'center', weight: 600, shadow: true, translate: false });
    }
    this.renderer?.drawJudgement(ctx, s, w / 2, 83, Math.min(160, w * .36));
    // Desktop pause is keyboard-only. Touch retains an accessible control.
    if (this.app.isTouch && this.app.platform !== 'desktop' && s.phase === 'playing') {
      if (this.app.ui.button('pbtn', w - margin - 44, 82, 44, 40, 'Ⅱ', { small: true })) s.pause();
    }
    if (s.phase === 'playing' && (s.canSkipIntro() || s.canSkipOutro() || s.inBreak())) {
      const shortLabel = s.canSkipOutro() ? 'SKIP OUTRO' : s.canSkipIntro() ? 'SKIP INTRO' : 'SKIP BREAK';
      const label = s.canSkipOutro() ? 'SPACE — SKIP OUTRO' : s.canSkipIntro() ? 'SPACE — SKIP INTRO' : 'SPACE — SKIP BREAK';
      if (this.app.isTouch) {
        if (this.app.ui.button('skip', w / 2 - 90, h - 58, 180, 38, shortLabel)) s.trySkip();
      } else text(ctx, label, w / 2, h - 30, { size: 12, color: THEME.accent, align: 'center', shadow: true });
    }
    const remaining = s.rewindRemainingMs();
    const prepare = s.preparationRemainingMs();
    if (!remaining && prepare > 0 && s.phase === 'playing') {
      fillPanel(ctx, w / 2 - 80, 92, 160, 30, { r: 15, fill: 'rgba(12,23,27,.86)' });
      text(ctx, tr('GET READY') + '  ' + Math.ceil(prepare / 1000), w / 2, 112, { size: 11, align: 'center', color: THEME.accent });
    }
    if (remaining > 0 && s.phase === 'playing') {
      fillPanel(ctx, w / 2 - 100, 92, 200, 30, { r: 15, fill: 'rgba(12,23,27,.86)' });
      text(ctx, tr('BACK IN RHYTHM') + '  ' + Math.ceil(remaining / 1000), w / 2, 112, { size: 11, align: 'center', color: THEME.accent });
    }
    if (this.app.isTouch && this.app.settings.touchHint && this.renderer && !s.skin?.perspective && s.phase === 'playing') {
      const { ox, scale } = this.renderer.fieldOrigin(w, h), widths = this.renderer.laneWidths(s);
      let lx = ox + s.laneStart() * scale;
      widths.forEach((width, col) => { const lw = width * scale; ctx.fillStyle = s.input.isDown(col) ? 'rgba(147,174,160,.15)' : 'rgba(255,255,255,.025)'; ctx.fillRect(lx, h - 110, lw, 106); lx += lw; });
    }
    // Four physical CSS pixels, flush with the bottom edge, without timestamps.
    const progress = Math.max(0, Math.min(1, s.chartTime() / Math.max(1, s.playbackEndTime())));
    ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(0, h - 4, w, 4);
    ctx.fillStyle = THEME.accent; ctx.fillRect(0, h - 4, w * progress, 4);
  }

  private drawPause(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app, s = this.app.settings;
    const pw = Math.min(680, w - 40), ph = Math.min(410, h - 32), px = (w - pw) / 2, py = (h - ph) / 2;
    const short = ph < 390;
    fillPanel(ctx, px, py, pw, ph, { r: 22, fill: 'rgba(18,28,35,.98)', line: '#3b5148' });
    text(ctx, 'PAUSED', px + 28, py + 45, { size: 30, weight: 600 });
    text(ctx, 'Take a breath. Find the beat.', px + 30, py + 70, { size: 12, color: THEME.dim });
    const by = py + (short ? 98 : 116), half = (pw - 72) / 2;
    const dim = this.app.ui.slider('pause-bgdim', px + 28, by + 24, half, 24, s.bgDim, 0, .9, .02);
    const speed = this.app.ui.slider('pause-speed', px + 44 + half, by + 24, half, 24, s.scrollSpeed, .4, 2, .05);
    text(ctx, 'Background dim', px + 28, by + 10, { size: 12, color: THEME.dim });
    text(ctx, Math.round(dim * 100) + '%', px + 28 + half, by + 10, { size: 12, align: 'right', color: THEME.accent });
    text(ctx, 'Scroll speed', px + 44 + half, by + 10, { size: 12, color: THEME.dim });
    text(ctx, '×' + speed.toFixed(2), px + pw - 28, by + 10, { size: 12, align: 'right', color: THEME.accent });
    if (dim !== s.bgDim || speed !== s.scrollSpeed) { s.bgDim = dim; s.scrollSpeed = speed; this.app.saveSettings(); }
    const resumeY = by + 78;
    if (this.app.ui.button('p-resume', px + 28, resumeY, pw - 56, 48, 'RESUME', { accent: true })) this.sess?.resume();
    text(ctx, 'Music rewinds 3 seconds. Your hits are kept.', px + pw / 2, resumeY + 69, { size: 11, align: 'center', color: THEME.dim, maxWidth: pw - 56 });
    if (this.app.ui.button('p-retry', px + 28, resumeY + 88, half, 40, 'RETRY')) this.sess?.retry();
    if (this.app.ui.button('p-quit', px + 44 + half, resumeY + 88, half, 40, 'QUIT TO SELECT')) { this.sess?.quit(); this.app.gotoScreen('select'); }
    if (!this.app.isTouch) text(ctx, 'ESC resume · R retry · Q quit', px + pw / 2, py + ph - 16, { size: 10, align: 'center', color: THEME.dim });
  }

  private drawFail(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app, pw = Math.min(460, w - 40), ph = 280, px = (w - pw) / 2, py = (h - ph) / 2;
    fillPanel(ctx, px, py, pw, ph, { r: 22, fill: '#161f27', line: '#65484c' });
    text(ctx, 'FAILED', px + 28, py + 54, { size: 29, color: THEME.red });
    text(ctx, 'One more try?', px + 28, py + 82, { size: 13, color: THEME.dim });
    if (this.app.ui.button('f-retry', px + 28, py + 119, pw - 56, 48, 'RETRY', { accent: true })) this.sess?.retry();
    if (this.app.ui.button('f-quit', px + 28, py + 183, pw - 56, 42, 'QUIT TO SELECT')) { this.sess?.quit(); this.app.gotoScreen('select'); }
  }

  pointerMove(x: number, y: number) {
    void x; void y;
  }
}
