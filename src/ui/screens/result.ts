// Result summary — quiet typography, responsive stats, unchanged retry/score behavior.
import { Screen } from '../app.ts';
import { THEME, text, fillPanel, drawBlurredBackdrop } from '../theme.ts';
import { tr } from '../i18n.ts';
import { drawSkinArt } from '../skin-art.ts';
import type { PlayResult, LeaderboardEntry } from '../../core/types.ts';
import type { ChartEntry } from '../../core/store.ts';
import { scoreSync, type ScoreSyncStatus } from '../../api/score-sync.ts';
import { isRankedResult } from '../../core/rating.ts';
import { sha1Hex } from '../../core/zip.ts';
import { modsLabel } from '../mod-labels.ts';
export class ResultScreen extends Screen {
  readonly name = 'result';
  private result: PlayResult | null = null;
  private entry: ChartEntry | null = null;
  private gradeImage: HTMLImageElement | null = null;
  private cover: HTMLImageElement | null = null;
  private rating = 0;
  private ratingBefore = 0;
  private serverRank: number | undefined;
  private leaderboard: LeaderboardEntry[] = [];
  private leaderboardRequest = 0;
  private showLeaderboard = false;
  private syncStatus: ScoreSyncStatus | undefined;
  enter(p: { result: PlayResult; entry: ChartEntry; rating: number; ratingBefore?: number; serverRank?: number; gradeImage?: HTMLImageElement; cover?: HTMLImageElement }) {
    this.gradeImage = p.gradeImage ?? null; this.cover = p.cover ?? null;
    this.result = p.result; this.entry = p.entry; this.rating = p.rating; this.serverRank = p.serverRank;
    this.ratingBefore = p.ratingBefore ?? this.app.account.user?.rating ?? 0;
    this.syncStatus = undefined;
    this.leaderboard = [];
    this.showLeaderboard = false;
    void this.loadLeaderboard();
  }
  update() {
    if (!this.result) return;
    const status = scoreSync(this.app).status(this.result);
    if (status?.state === 'synced' && this.syncStatus?.state !== 'synced') {
      this.rating = status.rating ?? this.rating;
      this.serverRank = status.rank;
      void this.loadLeaderboard();
    }
    this.syncStatus = status;
  }
  async loadLeaderboard() {
    const request = ++this.leaderboardRequest, result = this.result, api = this.app.server;
    if (!this.app.serverOnline || !result) return;
    const current = () => request === this.leaderboardRequest && this.result === result && this.app.server === api;
    try {
      let id = this.entry?.contentHash || result.chartId;
      if (!/^[a-f0-9]{40}$/i.test(id)) {
        const bytes = await this.app.store.getChartBytes(result.chartId);
        if (!current()) return;
        if (bytes) id = await sha1Hex(bytes);
      }
      if (!current()) return;
      const scores = await api.scores(id, result.keys);
      if (current()) this.leaderboard = scores;
    } catch { if (current()) this.leaderboard = []; }
  }
  leave() { this.leaderboardRequest++; }
  keyDown(code: string) {
    if (['Enter', 'NumpadEnter', 'KeyR'].includes(code)) this.retry();
    if (code === 'Escape') this.app.gotoScreen('select');
  }
  retry() { if (this.entry) { this.app.uiSound(); this.app.gotoScreen('play', { entry: this.entry }); } }
  private setLeaderboard(visible: boolean) {
    if (visible === this.showLeaderboard) return;
    const change = () => { this.showLeaderboard = visible; };
    if (this.app.animateViewChange) this.app.animateViewChange(change); else change();
  }
  draw(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app, r = this.result; if (!r) return;
    const compact = h < 560, pad = w < 700 ? 20 : 36;
    drawBlurredBackdrop(ctx, this.cover, w, h, .12);
    text(ctx, 'RESULT', pad, 30, { size: 10, color: THEME.accent2, spacing: '2px' });
    text(ctx, r.title, pad, 62, { size: compact ? 21 : 28, weight: 600, maxWidth: w - pad * 2, translate: false });
    text(ctx, `${r.version} · ${r.keys}K · ${r.stars.toFixed(2)} ★`, pad, 84, { size: 12, color: THEME.dim, maxWidth: w - pad * 2, translate: false });
    const py = compact ? 100 : 118, ph = h - py - 88;
    const heroW = Math.max(155, Math.min(320, w * .29)), gap = 18, px = pad + heroW + gap, pw = w - px - pad;
    fillPanel(ctx, pad, py, heroW, ph, { r: 20, fill: '#1b2b27', line: '#3b5148' });
    const fullCombo = r.passed && r.counts.miss === 0 && r.counts.bad === 0;
    text(ctx, r.passed ? (r.grade === 'SS' ? 'PERFECT RUN' : fullCombo ? 'FULL COMBO' : 'CLEAR') : 'FAILED', pad + heroW / 2, py + 32, { size: 11, color: r.passed ? THEME.accent : THEME.red, align: 'center', maxWidth: heroW - 20 });
    const artSize = Math.min(heroW - 44, ph * .46), artY = py + (ph - artSize) / 2 - 4;
    if (this.gradeImage) drawSkinArt(ctx, this.gradeImage, pad + (heroW - artSize) / 2, artY, artSize, artSize);
    else text(ctx, r.grade, pad + heroW / 2, artY + artSize / 2, { size: Math.min(compact ? 85 : 124, artSize), weight: 600, color: r.passed ? '#e5e9d5' : THEME.red, baseline: 'middle', align: 'center' });
    text(ctx, isRankedResult(r) ? r.pp.toFixed(1) + ' pp' : 'UNRANKED', pad + heroW / 2, py + ph - 38, { size: compact ? 16 : 24, align: 'center', color: THEME.accent });
    if (r.mods.length) text(ctx, modsLabel(r.mods), pad + heroW / 2, py + ph - 16, { size: 9, color: THEME.dim, align: 'center', maxWidth: heroW - 20, translate: false });
    fillPanel(ctx, px, py, pw, ph, { r: 20, fill: '#151f27' });
    const ip = compact ? 18 : 28, x = px + ip, inner = pw - ip * 2;
    text(ctx, 'SCORE', x, py + 28, { size: 10, color: THEME.dim, spacing: '1px' });
    text(ctx, r.score.toLocaleString(), x, py + (compact ? 62 : 83), { size: compact ? 30 : 48, weight: 600, color: '#edf4ef', maxWidth: inner });
    let y = py + (compact ? 87 : 122);
    for (const [i, item] of [['ACCURACY', (r.acc * 100).toFixed(2) + '%'], ['MAX COMBO', r.maxCombo + '×']].entries()) {
      const sx = x + i * (inner / 2);
      text(ctx, item[0], sx, y, { size: 9, color: THEME.dim });
      text(ctx, item[1], sx, y + (compact ? 22 : 32), { size: compact ? 18 : 28, color: THEME.accent });
    }
    y += compact ? 42 : 64;
    ctx.fillStyle = THEME.panelLine; ctx.fillRect(x, y, inner, 1); y += compact ? 18 : 28;
    if (!compact) { text(ctx, 'JUDGMENT BREAKDOWN', x, y, { size: 10, color: THEME.dim }); y += 28; }
    const counts = [['PERFECT', r.counts.perfect, THEME.gold], ['GREAT', r.counts.great, THEME.accent], ['GOOD', r.counts.good, THEME.green], ['OK', r.counts.ok, THEME.violet], ['BAD', r.counts.bad, THEME.orange], ['MISS', r.counts.miss, THEME.red]] as const;
    const step = compact ? 23 : 44;
    counts.forEach(([label, count, color], i) => {
      const cx = x + i % 3 * (inner / 3), cy = y + Math.floor(i / 3) * step;
      text(ctx, label, cx, cy, { size: 9, color, maxWidth: inner / 3 - 8 });
      text(ctx, String(count), cx + inner / 3 - 12, cy, { size: compact ? 11 : 16, color: count ? THEME.text : THEME.dim, align: 'right' });
    });
    if (!compact && y + step * 2 + 25 < py + ph) {
      const rating = this.app.account.user ? tr('RATING') + '  ' + this.rating.toFixed(2) + '  (' + (this.rating - this.ratingBefore >= 0 ? '+' : '') + (this.rating - this.ratingBefore).toFixed(2) + ')' : '';
      const label = [rating, this.serverRank ? tr('Your rank #{rank}', { rank: this.serverRank }) : ''].filter(Boolean).join(' · ');
      text(ctx, label, x, py + ph - 24, { size: 12, color: THEME.accent2, maxWidth: inner });
    }
    if (this.syncStatus) {
      const state = this.syncStatus.state;
      const label = state === 'synced' ? 'Score synced' : state === 'update-required' ? 'Saved · update server to sync Constant Speed scores' : state === 'missing-chart' ? 'Saved · chart must be on the server to sync' : state === 'rejected' ? 'Saved locally · server rejected this score' : 'Saved · syncing automatically';
      text(ctx, label, pad, h - 76, { size: 10, color: state === 'synced' ? THEME.accent : THEME.dim, maxWidth: w - pad * 2 });
    }
    if (this.app.serverOnline && this.app.ui.button('result-rankings', px + pw - 122, py + 12, 108, 28, 'RANKINGS', { small: true })) this.setLeaderboard(!this.showLeaderboard);
    if (this.showLeaderboard) {
      fillPanel(ctx, px, py, pw, ph, { r: 20, fill: '#151f27', line: '#3b5148' });
      text(ctx, 'CHART RANKINGS', x, py + 32, { size: 12, color: THEME.accent });
      if (this.app.ui.button('close-rankings', px + pw - 54, py + 12, 38, 28, '×', { small: true })) this.setLeaderboard(false);
      if (!this.leaderboard.length) text(ctx, 'No ranked scores yet.', x, py + 92, { size: 12, color: THEME.dim, maxWidth: inner });
      const rows = Math.max(0, Math.floor((ph - 76) / 44));
      this.leaderboard.slice(0, rows).forEach((player, i) => {
        const ry = py + 82 + i * 44;
        text(ctx, '#' + player.rank, x, ry, { size: 11, color: i < 3 ? THEME.gold : THEME.dim });
        text(ctx, player.nickname || player.username, x + 38, ry, { size: 12, maxWidth: inner - 150, translate: false });
        text(ctx, player.score.toLocaleString(), x + inner, ry, { size: 12, color: THEME.accent, align: 'right' });
        text(ctx, modsLabel(player.mods), x + 38, ry + 16, { size: 9, color: THEME.accent2, maxWidth: Math.max(40, inner - 130), translate: false });
        text(ctx, (player.acc * 100).toFixed(2) + '%', x + inner, ry + 16, { size: 9, color: THEME.dim, align: 'right' });
      });
    }
    const bw = Math.min(190, (w - pad * 2 - 24) / 3), bx = w - pad - bw * 3 - 24, by = h - 64;
    if (this.app.ui.button('r-menu', bx, by, bw, 42, 'MAIN MENU')) this.app.gotoScreen('menu');
    if (this.app.ui.button('r-list', bx + bw + 12, by, bw, 42, 'SONG SELECT')) this.app.gotoScreen('select');
    if (this.app.ui.button('r-retry', bx + (bw + 12) * 2, by, bw, 42, 'RETRY', { accent: true })) this.retry();
  }
}
