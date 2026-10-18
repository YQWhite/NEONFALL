import { Screen } from '../app.ts';
import { text, fillPanel, drawScrollbar } from '../theme.ts';
import { tr } from '../i18n.ts';
import { drawAvatar } from '../avatar-art.ts';
import type { GlobalLeaderboardEntry } from '../../api/client.ts';

const METRICS = [
  { id: 'rating', label: 'OVERALL', detail: 'Weighted rating · best performance on each chart' },
  { id: 'bestPp', label: 'BEST PP', detail: 'Highest single-chart performance points' },
  { id: 'totalScore', label: 'TOTAL SCORE', detail: 'Sum of each chart best · million-point rules only' },
  { id: 'accuracy', label: 'ACCURACY', detail: 'Average chart-best accuracy · million-point rules only' },
  { id: 'clears', label: 'CLEARS', detail: 'Distinct difficulties cleared · million-point rules only' },
] as const;
type Metric = typeof METRICS[number]['id'];

/** Public server boards. Separate request generations prevent stale tab/server results. */
export class RankingsScreen extends Screen {
  readonly name = 'rankings';
  private metric: Metric = 'rating';
  private rows: GlobalLeaderboardEntry[] = [];
  private active = false;
  private request = 0;
  private loading = false;
  private error = '';
  private scroll = 0;
  private maxScroll = 0;
  private observedApi = this.app.server;
  private observedOnline = this.app.serverOnline;
  private drag: { y: number; scroll: number; moved: boolean } | null = null;

  enter() { this.active = true; void this.reload(); }
  leave() { this.active = false; ++this.request; this.drag = null; }
  resize() { this.drag = null; this.scroll = Math.min(this.scroll, this.maxScroll); }
  keyDown(code: string) {
    if (code === 'Escape') this.app.gotoScreen('menu');
    if (code === 'KeyR') void this.reload();
  }
  update() {
    if (this.observedApi !== this.app.server || this.observedOnline !== this.app.serverOnline) void this.reload();
  }
  private setMetric(metric: Metric) {
    if (metric === this.metric) return;
    const change = () => { this.metric = metric; this.scroll = 0; void this.reload(); };
    if (this.app.animateViewChange) this.app.animateViewChange(change); else change();
    this.app.uiSound();
  }
  async reload() {
    const request = ++this.request, api = this.app.server, metric = this.metric;
    this.observedApi = api; this.observedOnline = this.app.serverOnline;
    this.rows = []; this.error = ''; this.loading = false;
    if (!this.app.serverOnline || this.app.settings.serverDisconnected) return;
    if (!api.statisticsVersion && metric !== 'rating') {
      this.error = 'This server only supports the overall ranking.';
      return;
    }
    this.loading = true;
    const current = () => this.active && request === this.request && this.app.server === api && this.app.serverOnline && !this.app.settings.serverDisconnected;
    try {
      const rows = await api.leaderboard(metric);
      if (current()) this.rows = rows;
    } catch (error: any) {
      if (current()) this.error = error?.message || 'Could not load rankings.';
    } finally { if (current()) this.loading = false; }
  }
  private area() { return { x: 20, y: this.app.h < 500 ? 136 : 164, w: this.app.w - 40, h: this.app.h - (this.app.h < 500 ? 156 : 184) }; }
  private value(row: GlobalLeaderboardEntry) {
    const value = Number(row[this.metric]) || 0;
    if (this.metric === 'accuracy') return (value * 100).toFixed(2) + '%';
    if (this.metric === 'rating' || this.metric === 'bestPp') return value.toFixed(2) + (this.metric === 'bestPp' ? ' pp' : '');
    return Math.round(value).toLocaleString();
  }
  draw(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app, compact = h < 500;
    ctx.fillStyle = '#0d1218'; ctx.fillRect(0, 0, w, h);
    text(ctx, 'SERVER RANKINGS', 22, compact ? 33 : 42, { size: compact ? 19 : 27, color: '#e0eae4', weight: 600 });
    if (this.app.ui.button('rank-back', w - 180, 16, 72, 32, 'BACK', { small: true })) this.app.gotoScreen('menu');
    if (this.app.ui.button('rank-refresh', w - 100, 16, 80, 32, 'RELOAD', { small: true })) void this.reload();
    const tabY = compact ? 60 : 78, tabW = (w - 40 - 8 * 4) / 5;
    METRICS.forEach((metric, i) => {
      if (this.app.ui.chip('rank-' + metric.id, 20 + i * (tabW + 8), tabY, tabW, 30, metric.label, this.metric === metric.id).clicked) this.setMetric(metric.id);
    });
    const selected = METRICS.find(metric => metric.id === this.metric)!;
    text(ctx, selected.detail, 22, tabY + 50, { size: 11, color: '#8ca399', maxWidth: w - 44 });
    const area = this.area(), rowH = compact ? 60 : 72;
    fillPanel(ctx, area.x, area.y, area.w, area.h, { r: 12, fill: '#141d25', line: '#2a3b35' });
    this.maxScroll = Math.max(0, this.rows.length * rowH + 16 - area.h);
    this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll));
    if (!this.rows.length) {
      const message = !this.app.serverOnline || this.app.settings.serverDisconnected ? 'Connect to a server to view rankings.' : this.loading ? 'Loading rankings…' : this.error || 'No ranked scores yet.';
      text(ctx, message, area.x + 18, area.y + 36, { size: 13, color: '#9db1a8', maxWidth: area.w - 36 });
      if (!this.app.serverOnline && this.app.ui.button('rank-connect', area.x + 18, area.y + 54, 142, 32, 'ACCOUNT', { small: true })) this.app.gotoScreen('account');
    }
    ctx.save(); ctx.beginPath(); ctx.rect(area.x + 1, area.y + 1, area.w - 2, area.h - 2); ctx.clip();
    this.rows.forEach((row, i) => {
      const y = area.y + 8 + i * rowH - this.scroll;
      if (y + rowH < area.y || y > area.y + area.h) return;
      const self = this.app.account.server && row.username === this.app.account.user?.username;
      if (self) fillPanel(ctx, area.x + 8, y, area.w - 16, rowH - 4, { r: 8, fill: '#263c31', line: '#4e735b' });
      const rank = row.rank || i + 1, avatarSize = compact ? 36 : 44, ax = area.x + 58;
      text(ctx, '#' + rank, area.x + 16, y + rowH * .48, { size: 13, color: rank <= 3 ? '#d0bd82' : '#8d9e95', baseline: 'middle' });
      drawAvatar(ctx, this.app, row, ax, y + (rowH - avatarSize - 4) / 2, avatarSize);
      const tx = ax + avatarSize + 14, right = area.x + area.w - 20, valueW = w < 700 ? 112 : 180;
      text(ctx, row.nickname || row.username, tx, y + rowH * .36, { size: compact ? 13 : 16, color: '#dfebe3', maxWidth: Math.max(20, right - tx - valueW), translate: false });
      text(ctx, '@' + row.username, tx, y + rowH * .7, { size: 10, color: '#8ca399', maxWidth: Math.max(20, right - tx - valueW), translate: false });
      text(ctx, this.value(row), right, y + rowH * .39, { size: compact ? 17 : 22, color: '#bed7c6', weight: 600, align: 'right', maxWidth: valueW, translate: false });
      const detail = this.metric === 'rating' ? `${tr('BEST PP')} ${(Number(row.bestPp) || 0).toFixed(1)}` : `${tr('RATING')} ${(Number(row.rating) || 0).toFixed(2)}`;
      text(ctx, detail, right, y + rowH * .73, { size: 10, color: '#8ca399', align: 'right', maxWidth: valueW, translate: false });
    });
    ctx.restore();
    drawScrollbar(ctx, area.x + area.w - 6, area.y + 8, area.h - 16, this.rows.length * rowH + 16, area.h, this.scroll);
  }
  wheel(dy: number) { this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + dy * .6)); }
  pointerDown(x: number, y: number) {
    const area = this.area();
    this.drag = x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h ? { y, scroll: this.scroll, moved: false } : null;
  }
  pointerMove(_x: number, y: number) {
    const drag = this.drag; if (!drag) return;
    if (Math.abs(y - drag.y) > 6) drag.moved = true;
    if (drag.moved) { this.scroll = Math.max(0, Math.min(this.maxScroll, drag.scroll + drag.y - y)); this.app.ui.p.moved = true; this.app.ui.cancelPointer(); }
  }
  pointerUp() { if (this.drag?.moved) this.app.ui.cancelPointer(); this.drag = null; }
}
