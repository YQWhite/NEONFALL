// Song library: split panels, restrained typography, shared music preview.
import { tr } from '../i18n.ts';
import { Screen } from '../app.ts';
import { THEME, text, fillPanel, drawCover, drawScrollbar, drawBlurredBackdrop, setFont, type TextStyle } from '../theme.ts';
import { TextField } from '../widgets.ts';
import { fmtTime } from '../../core/zip.ts';
import { readNFM } from '../../core/nfm.ts';
import type { ChartEntry } from '../../core/store.ts';
import { listPlaybackCharts } from '../../api/library.ts';
import { groupSongs, type SongGroup, type SongSort } from '../song-groups.ts';


type SortKey = SongSort;
type SongRow = { group: SongGroup; index: number; header: boolean; top: number; height: number };

const coverCache = new Map<string, HTMLImageElement | null>();

export class SelectScreen extends Screen {
  readonly name = 'select';
  private entries: ChartEntry[] = [];
  private view: ChartEntry[] = [];
  private groups: SongGroup[] = [];
  private rows: SongRow[] = [];
  private listHeight = 0;
  private listDrag: { y: number; scroll: number; row: SongRow | undefined; moved: boolean } | null = null;
  private sel = 0;
  private scroll = 0;
  private listHover = -1;
  private search = '';
  private sort: SortKey = 'recent';
  private keyFilter = 0; // 0 = all, else 4..7
  private searchField = new TextField('text', { maxLength: 60, placeholder: 'Search...' });
  private showMods = false;
  private setModsVisible(visible: boolean) {
    if (visible === this.showMods) return;
    const change = () => { this.showMods = visible; if (visible) this.searchField.blur(); };
    if (this.app.animateViewChange) this.app.animateViewChange(change); else change();
  }
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private previewGeneration = 0;
  private libraryGeneration = 0;
  private initialSelection = true;
  private observedMusicKey = '';
  private loading = false;
  private downloading = false;
  private loadError = '';
  private coversLoading = new Set<string>();
  private backdrop: HTMLImageElement | null = null;
  private backdropId = '';
  private backdropFade = 0;

  async enter() {
    this.active = true;
    this.initialSelection = true;
    this.observedMusicKey = this.musicKey(this.app.menuMusic.entry);
    this.searchField.el.placeholder = tr('Search title, artist, creator…');
    void this.reloadLibrary();
  }

  leave() {
    this.active = false;
    ++this.previewGeneration;
    ++this.libraryGeneration;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.searchField.destroy();
    this.showMods = false;
    this.listDrag = null;
    this.detailDrag = null;
  }

  async reloadLibrary() {
    const generation = ++this.libraryGeneration;
    this.loading = true;
    this.loadError = '';
    try {
      if (this.app.centralLibrary && !this.app.serverOnline) await this.app.pingServer();
      const entries = await listPlaybackCharts(this.app);
      if (!this.active || generation !== this.libraryGeneration) return;
      this.entries = entries;
    } catch (e: any) {
      if (!this.active || generation !== this.libraryGeneration) return;
      this.loadError = e?.message || 'failed to load library';
      this.entries = [];
    }
    this.loading = false;
    this.applyFilter();
  }

  private applyFilter() {
    const q = this.search.trim().toLowerCase();
    const list = this.entries.filter((e) => {
      if (this.keyFilter && e.keys !== this.keyFilter) return false;
      if (q) {
        const hay = `${e.title} ${e.artist} ${e.creator} ${e.version}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const previous = this.entry();
    const preferred = this.initialSelection ? (this.app.menuMusic.entry ?? previous) : previous;
    this.groups = groupSongs(list, this.sort);
    this.view = this.groups.flatMap(group => group.charts);
    const index = preferred ? this.view.findIndex(e => e.id === preferred.id && !!e.server === !!preferred.server) : -1;
    this.sel = index >= 0 ? index : list.length ? 0 : -1;
    this.rebuildRows();
    this.scroll = 0;
    this.revealSelection();
    this.detailScroll = 0;
    this.initialSelection = false;
    // Always schedule the first selection, even if its index was already zero.
    // The shared controller deduplicates the currently playing chart.
    this.schedulePreview();
  }

  private entry(): ChartEntry | null {
    return this.view[this.sel] ?? null;
  }

  private rebuildRows() {
    this.rows = [];
    let top = 0, index = 0;
    for (const group of this.groups) {
      const headerHeight = this.app.h < 450 ? 44 : this.app.h < 590 ? 58 : 68;
      this.rows.push({ group, index, header: true, top, height: headerHeight });
      top += headerHeight;
      for (const _entry of group.charts) {
        const height = this.cardH();
        this.rows.push({ group, index: index++, header: false, top, height });
        top += height;
      }
      top += 8;
    }
    this.listHeight = top;
  }

  private revealSelection() {
    const row = this.rows.find(row => !row.header && row.index === this.sel);
    if (!row) return;
    const area = this.listArea();
    if (row.top < this.scroll) this.scroll = row.top;
    if (row.top + row.height > this.scroll + area.h) this.scroll = row.top + row.height - area.h;
  }

  resize() { this.listDrag = null; this.detailDrag = null; this.rebuildRows(); this.revealSelection(); }

  keyDown(code: string, e: KeyboardEvent) {
    if (e.ctrlKey && code === 'KeyF') {
      this.searchField.focus();
      return;
    }
    switch (code) {
      case 'ArrowUp':
      case 'KeyW':
        this.setSel(this.sel - 1);
        this.app.uiSound();
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.setSel(this.sel + 1);
        this.app.uiSound();
        break;
      case 'Enter':
      case 'NumpadEnter':
        this.playSelected();
        break;
      case 'Escape':
        if (this.showMods) this.setModsVisible(false);
        else this.app.gotoScreen('menu');
        break;
      case 'F2':
        if (this.view.length) {
          this.setSel(Math.floor(Math.random() * this.view.length));
          this.app.uiSound();
        }
        break;
      case 'KeyM':
        this.setModsVisible(!this.showMods);
        this.app.uiSound();
        break;
      case 'KeyI':
        this.app.gotoScreen('import');
        break;
      case 'KeyR':
        this.reloadLibrary();
        break;
    }
  }

  async playSelected() {
    const entry = this.entry();
    if (!entry || this.loading) return;
    this.app.gotoScreen('play', { entry });
  }

  async exportNfm() {
    const entry = this.entry();
    if (!entry) return;
    try {
      const bytes = entry.server
        ? await this.app.server.downloadChart(entry.id)
        : await this.app.store.getChartBytes(entry.id);
      if (!bytes) throw new Error('chart bytes missing');
      const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${entry.title} [${entry.version}] (${entry.keys}K).nfm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      this.app.toast('exported .nfm');
    } catch (err: any) {
      this.app.toast(tr('export failed: {error}', { error: tr(String(err?.message || err)) }));
    }
  }

  async downloadSelected() {
    const entry = this.entry();
    if (!entry?.server || this.downloading) return;
    this.downloading = true;
    try {
      const bytes = await this.app.server.downloadChart(entry.id);
      await this.app.store.putChart(bytes, entry.name);
      entry.downloaded = true;
      this.app.toast('Downloaded for offline play.');
    } catch (error: any) { this.app.toast(tr('download failed: {error}', { error: error?.message || 'failed' })); }
    finally { this.downloading = false; }
  }

  async deleteSelected() {
    const entry = this.entry();
    if (!entry) return;
    if (entry.server && !(entry as ChartEntry & { canDelete?: boolean }).canDelete) return;
    try {
      if (entry.server) await this.app.server.deleteChartServer(entry.id);
      else await this.app.store.deleteChart(entry.id);
      coverCache.delete(entry.id);
      await this.reloadLibrary();
      this.app.toast('deleted');
    } catch (err: any) {
      this.app.toast(tr('delete failed: {error}', { error: tr(String(err?.message || err)) }));
    }
  }

  /** Selection changes once per gesture, not once per rendered frame. */
  private setSel(i: number) {
    const next = this.view.length ? Math.max(0, Math.min(this.view.length - 1, i)) : -1;
    if (next === this.sel) return;
    this.sel = next;
    this.detailScroll = 0;
    this.revealSelection();
    this.schedulePreview();
  }

  private musicKey(entry: ChartEntry | null) { return entry ? `${!!entry.server}:${entry.id}` : ''; }

  private schedulePreview(selectAudio = true) {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    const generation = ++this.previewGeneration;
    const entry = this.entry();
    if (!entry || !this.active) { this.backdrop = null; return; }
    const current = () => this.active && this.app.screen === this && generation === this.previewGeneration && this.entry() === entry;
    this.previewTimer = setTimeout(async () => {
      this.previewTimer = null;
      if (!current()) return;
      // Audio belongs to App; background loading can complete independently.
      if (selectAudio) {
        this.observedMusicKey = this.musicKey(entry);
        void this.app.menuMusic.select(entry).catch(() => {});
      }
      try {
        const cached = this.app.previewChart;
        const bytes = cached?.id === entry.id ? null : entry.server
          ? await this.app.server.downloadChart(entry.id) : await this.app.store.getChartBytes(entry.id);
        if (!current()) return;
        const arc = cached?.id === entry.id ? cached.archive : bytes ? await readNFM(bytes) : null;
        if (!arc || !current()) return;
        const data = arc.chart.meta.bg ? arc.files.get(arc.chart.meta.bg) : undefined;
        if (!data) { this.backdrop = null; return; }
        const img = new Image();
        const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'image/png' }));
        img.onload = () => {
          URL.revokeObjectURL(url);
          if (!current()) return;
          this.backdrop = img;
          this.backdropId = entry.id;
          this.backdropFade = 0;
        };
        img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
      } catch { /* Background failure must not interrupt shared playback. */ }
    }, 180);
  }
  private loadCover(entry: ChartEntry) {
    if (coverCache.has(entry.id) || this.coversLoading.has(entry.id)) return;
    this.coversLoading.add(entry.id);
    (async () => {
      try {
        const bytes = entry.server
          ? await this.app.server.downloadChart(entry.id)
          : await this.app.store.getChartBytes(entry.id);
        if (!bytes) {
          coverCache.set(entry.id, null);
          return;
        }
        const arc = await readNFM(bytes);
        const bg = arc.chart.meta.bg;
        const data = bg ? arc.files.get(bg) : undefined;
        if (data) {
          const img = new Image();
          const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'image/png' }));
          img.onload = () => { URL.revokeObjectURL(url); coverCache.set(entry.id, img); };
          img.onerror = () => { URL.revokeObjectURL(url); coverCache.set(entry.id, null); };
          img.src = url;
        } else {
          coverCache.set(entry.id, null);
        }
      } catch {
        coverCache.set(entry.id, null);
      } finally {
        this.coversLoading.delete(entry.id);
      }
    })();
  }

  // ---------- restrained local visual system (shared theme remains untouched) ----------
  private label(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, width: number, style: TextStyle = {}) {
    ctx.save();
    setFont(ctx, style);
    let result = style.translate === false ? value : tr(value);
    const available = Math.max(0, width);
    if (ctx.measureText(result).width > available) {
      let lo = 0, hi = result.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(result.slice(0, mid) + '…').width <= available) lo = mid;
        else hi = mid - 1;
      }
      result = lo ? result.slice(0, lo) + '…' : '';
    }
    ctx.restore();
    text(ctx, result, x, y, { baseline: 'middle', color: '#cbd3da', ...style });
  }

  private button(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, w: number, h: number, label: string, kind: 'normal' | 'primary' | 'danger' | 'selected' = 'normal') {
    const clicked = this.app.ui.button(id, x, y, w, h, '', { disabled: this.showMods && !id.startsWith('mod') });
    const hover = this.app.ui.hover(id, x, y, w, h);
    const primary = kind === 'primary', selected = kind === 'selected';
    fillPanel(ctx, x, y, w, h, { r: 8, fill: primary ? '#c9ded4' : selected ? '#2c3c36' : hover ? '#253039' : '#19212a', line: primary ? '#c9ded4' : selected ? '#648576' : '#313c45' });
    this.label(ctx, label, x + w / 2, y + h / 2, w - 8, { size: h > 42 ? 15 : 11, align: 'center', weight: 600, color: primary ? '#15251e' : kind === 'danger' ? '#d4a5a6' : selected ? '#c9ded4' : '#aab7c1' });
    return clicked;
  }

  private listArea() {
    const { w, h } = this.app;
    const gap = w < 700 ? 10 : 18;
    const usable = w - 40 - gap;
    const y = this.shortLandscape() ? 158 : 222;
    return { x: 20, y, w: Math.floor(usable * (w < 760 ? 0.48 : 0.53)), h: Math.max(36, h - y - 20) };
  }

  private shortLandscape() { return this.app.w >= 560 && this.app.h < 500; }

  private cardH(): number { return this.app.h < 450 ? 36 : this.app.h < 590 ? 46 : 56; }

  update(dt: number, _now: number) {
    const playing = this.app.menuMusic.entry;
    const key = this.musicKey(playing);
    if (key !== this.observedMusicKey) {
      this.observedMusicKey = key;
      const index = this.view.findIndex(entry => this.musicKey(entry) === key);
      if (index >= 0 && index !== this.sel) {
        this.sel = index;
        this.detailScroll = 0;
        this.revealSelection();
        this.schedulePreview(false);
      }
    }
    if (this.backdropFade < 1) this.backdropFade = Math.min(1, this.backdropFade + dt / 600);
    if (this.searchField.consumeDirty()) {
      this.search = this.searchField.value;
      this.applyFilter();
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app;
    ctx.fillStyle = '#0d1218'; ctx.fillRect(0, 0, w, h);
    drawBlurredBackdrop(ctx, this.backdrop, w, h, 0.16 * this.backdropFade);
    const area = this.listArea();
    const total = this.listHeight;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, total - area.h)));
    const e = this.entry();
    const gap = w < 700 ? 10 : 18;
    const dx = area.x + area.w + gap, dw = w - dx - 20;

    // Header never enters x=w-min(340,w-32)-20, y=16..104.
    const playerX = w - Math.min(340, w - 32) - 20;
    const shortLandscape = this.shortLandscape();
    if (!shortLandscape && playerX > 120) {
      this.label(ctx, 'COLLECTION', 24, 42, playerX - 44, { size: 11, color: '#8da69a', spacing: '1.5px' });
      this.label(ctx, 'Your next rhythm.', 24, 76, playerX - 44, { size: w > 800 ? 27 : 20, weight: 600, color: '#edf1ef' });
    }
    // On landscape phones the toolbar shares the player's top band, leaving
    // enough vertical space for both the song tree and fixed play actions.
    const rowY = shortLandscape ? 16 : 122, rowH = 36;
    const backW = w < 650 ? 48 : 68;
    const toolbarW = shortLandscape ? playerX - 32 : w - 40;
    const actionW = shortLandscape ? Math.min(82, (toolbarW - backW - 16) / 2) : w < 650 ? 56 : 82;
    if (this.button(ctx, 'back', 20, rowY, backW, rowH, '←')) { this.app.uiSound(); this.app.gotoScreen('menu'); }
    const sx = shortLandscape ? 20 : 20 + backW + 8;
    const searchY = shortLandscape ? 64 : rowY;
    const sw = shortLandscape ? toolbarW : Math.max(40, w - sx - 20 - (actionW + 8) * 2);
    const sf = this.searchField;
    fillPanel(ctx, sx, searchY, sw, rowH, { r: 8, fill: '#141c24', line: sf.focused ? '#789c89' : '#303b45' });
    this.label(ctx, sf.value || 'Search title, artist, creator…', sx + 12, searchY + rowH / 2, sw - 24, { size: 12, color: sf.value ? '#d6deda' : '#768592', weight: 400 });
    if (!this.showMods && this.app.ui.hover('search', sx, searchY, sw, rowH) && this.app.ui.p.down) sf.focus();
    if (sf.focused) {
      const r = this.app.canvas.getBoundingClientRect();
      sf.el.style.left = r.left + sx + 10 + 'px'; sf.el.style.top = r.top + searchY + 5 + 'px';
      sf.el.style.width = Math.max(1, sw - 20) + 'px'; sf.el.style.height = '26px';
    }
    const importX = shortLandscape ? 20 + backW + 8 : sx + sw + 8;
    const refreshX = shortLandscape ? importX + actionW + 8 : w - 20 - actionW;
    if (this.button(ctx, 'import', importX, rowY, actionW, rowH, 'IMPORT')) { this.app.uiSound(); this.app.gotoScreen('import'); }
    if (this.button(ctx, 'refresh', refreshX, rowY, actionW, rowH, 'RELOAD')) { this.app.uiSound(); void this.reloadLibrary(); }

    const filterY = shortLandscape ? 116 : 169, filterH = 28;
    // Cycle sort in one compact control; all five modes remain accessible.
    const sorts: SortKey[] = ['recent', 'title', 'artist', 'stars', 'keys'];
    const sortW = Math.min(152, Math.max(94, w * 0.18));
    if (this.button(ctx, 'sort-cycle', 20, filterY, sortW, filterH, tr('SORT / {sort} ↕', { sort: tr(this.sort.toUpperCase()) }))) {
      this.sort = sorts[(sorts.indexOf(this.sort) + 1) % sorts.length]; this.applyFilter(); this.app.uiSound();
    }
    const chipX = 20 + sortW + 12;
    const chipW = Math.min(46, Math.max(26, (w - chipX - 24 - 30) / 6));
    [0, 4, 5, 6, 7, 8].forEach((k, i) => {
      if (this.button(ctx, 'key-' + k, chipX + i * (chipW + 6), filterY, chipW, filterH, k ? k + 'K' : 'ALL', this.keyFilter === k ? 'selected' : 'normal')) {
        this.keyFilter = k; this.applyFilter(); this.app.uiSound();
      }
    });
    const countX = chipX + 6 * (chipW + 6) + 12;
    this.label(ctx, tr('{count} CHARTS / {source}', { count: this.view.length, source: tr(this.app.centralLibrary && this.app.serverOnline ? 'SERVER' : 'LOCAL') }), countX, filterY + filterH / 2, w - countX - 20, { size: 10, color: '#75848f', align: 'left' });

    fillPanel(ctx, area.x, area.y, area.w, area.h, { r: 12, fill: '#121a22', line: '#28333c' });
    ctx.save(); ctx.beginPath(); ctx.rect(area.x + 1, area.y + 1, area.w - 2, area.h - 2); ctx.clip();
    this.listHover = -1;
    for (const row of this.rows) {
      const { index: i, height: cardH } = row;
      const entry = this.view[i], y = area.y + row.top - this.scroll;
      if (y + cardH < area.y) continue;
      if (y > area.y + area.h) break;
      const hover = !this.showMods && this.app.ui.hover((row.header ? 'song-' : 'card-') + i, area.x, Math.max(area.y, y), area.w, Math.min(y + cardH, area.y + area.h) - Math.max(area.y, y));
      if (hover) this.listHover = i;
      const selected = i === this.sel;
      if (row.header) {
        const groupSelected = row.group.charts.includes(this.entry()!);
        fillPanel(ctx, area.x + 6, y + 4, area.w - 12, cardH - 6, { r: 9, fill: hover ? '#2b393f' : groupSelected ? '#23352e' : '#1a252d', line: '#31433c' });
        this.loadCover(entry);
        const showCover = area.w > 280, coverSize = cardH - 20;
        if (showCover) drawCover(ctx, coverCache.get(entry.id) ?? null, area.x + 13, y + 11, coverSize, coverSize, entry.title, '#293c37');
        const tx = area.x + (showCover ? coverSize + 23 : 15), tw = area.x + area.w - 24 - tx;
        this.label(ctx, entry.title, tx, y + cardH * .38, tw, { size: 14, color: '#e0eae4', weight: 600 });
        this.label(ctx, `${entry.artist} · ${row.group.charts.length} ${tr('CHARTS')}`, tx, y + cardH * .72, tw, { size: 10, color: '#91a79c', weight: 400 });
        continue;
      }
      const inset = area.w < 260 ? 21 : 29, tx = area.x + inset + 13;
      ctx.strokeStyle = '#3b5549'; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(area.x + 16, y); ctx.lineTo(area.x + 16, y + cardH / 2); ctx.lineTo(area.x + inset, y + cardH / 2);
      if (row.group.charts.at(-1) !== entry) { ctx.moveTo(area.x + 16, y + cardH / 2); ctx.lineTo(area.x + 16, y + cardH); }
      ctx.stroke();
      fillPanel(ctx, area.x + inset, y + 3, area.w - inset - 8, cardH - 6, { r: 7, fill: selected ? '#2c4939' : hover ? '#25363b' : '#17232b', line: selected ? '#759981' : 'rgba(0,0,0,0)' });
      const tw = area.x + area.w - 74 - tx;
      this.label(ctx, entry.version, tx, y + cardH * .35, tw, { size: 12, color: selected ? '#edf3ef' : '#bdccc5', weight: 600, translate: false });
      this.label(ctx, entry.creator, tx, y + cardH * .72, tw, { size: 10, color: '#80988c', weight: 400, translate: false });
      const bx = area.x + area.w - 17;
      text(ctx, entry.keys + 'K', bx, y + cardH * .34, { size: 10, color: '#b2cebd', align: 'right', baseline: 'middle' });
      text(ctx, (entry.stars || 0).toFixed(2) + ' ★', bx, y + cardH * .72, { size: 10, color: '#b4aa89', align: 'right', baseline: 'middle' });
    }
    if (!this.view.length) {
      this.label(ctx, this.loading ? 'Loading collection…' : this.loadError ? 'Could not load library' : 'No charts found', area.x + 18, area.y + 38, area.w - 36, { size: 15, color: '#a5b7ad' });
      this.label(ctx, this.loadError || 'Import a chart or adjust your search.', area.x + 18, area.y + 64, area.w - 36, { size: 11, color: '#788a95' });
    }
    ctx.restore();
    drawScrollbar(ctx, area.x + area.w - 6, area.y + 8, Math.max(1, area.h - 16), total, area.h, this.scroll);

    fillPanel(ctx, dx, area.y, dw, area.h, { r: 12, fill: '#141c24', line: '#2b363f' });
    if (e) this.drawDetail(ctx, e, dx, area.y, dw, area.h);
    else this.label(ctx, 'Select a chart to begin.', dx + 16, area.y + 38, dw - 32, { size: 13, color: '#788a95' });
    if (this.showMods) this.drawMods(ctx);
  }

  private detailScroll = 0;
  private detailContentH = 0;
  private detailViewport = { x: 0, y: 0, w: 0, h: 0 };
  private detailDrag: { y: number; scroll: number; moved: boolean } | null = null;
  private drawDetail(ctx: CanvasRenderingContext2D, e: ChartEntry, x: number, y: number, w: number, h: number) {
    const pad = w < 260 ? 12 : 20, inner = Math.max(1, w - pad * 2);
    const short = h < 350;
    const actionH = short ? 32 : 40;
    const footerH = actionH * 2 + 24;
    const viewport = Math.max(1, h - footerH - 12);
    this.detailViewport = { x, y, w, h: viewport };
    this.loadCover(e);
    const cramped = viewport < 150;
    const coverH = cramped ? 0 : Math.min(short ? 86 : 210, inner * 0.5);
    this.detailContentH = cramped ? 194 : coverH + 238;
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, this.detailContentH - viewport)));
    ctx.save(); ctx.beginPath(); ctx.rect(x + 1, y + 1, w - 2, viewport); ctx.clip();
    const top = y + pad - this.detailScroll;
    if (!cramped) drawCover(ctx, coverCache.get(e.id) ?? null, x + pad, top, inner, coverH, e.title, '#293c37');
    let ty = top + (cramped ? 12 : coverH + 25);
    if (!cramped) { this.label(ctx, 'SELECTED CHART', x + pad, ty, inner, { size: 9, color: '#86a392', spacing: '1.5px' }); ty += 29; }
    this.label(ctx, e.title, x + pad, ty, inner, { size: w < 300 ? 18 : 24, color: '#edf1ef', weight: 600 }); ty += 27;
    this.label(ctx, e.artist, x + pad, ty, inner, { size: 14, color: '#a6b4be', weight: 400 }); ty += 24;
    this.label(ctx, tr('{version} / by {creator}', { version: e.version, creator: e.creator }), x + pad, ty, inner, { size: 11, color: '#798e9a', weight: 400 }); ty += 34;
    this.label(ctx, tr('{keys} KEYS', { keys: e.keys }) + `   /   ${(e.stars || 0).toFixed(2)} ★   /   ${fmtTime(e.lengthMs)}`, x + pad, ty, inner, { size: 12, color: '#b1c8ba' }); ty += 24;
    this.label(ctx, tr('{count} notes', { count: e.notes.toLocaleString() }) + ` · ${(e.source || 'nfm').toUpperCase()} · ${(e.size / 1048576).toFixed(1)} MB`, x + pad, ty, inner, { size: 11, color: '#7b8e9a', weight: 400 }); ty += 29;
    const best = this.app.store.getBest(e.id);
    this.label(ctx, best ? `${tr('BEST')} / ${best.grade}  ${(best.acc * 100).toFixed(2)}%  ${best.score.toLocaleString()}  ${best.maxCombo}x  ${best.pp}pp` : 'No personal best yet.', x + pad, ty, inner, { size: 11, color: best ? '#b8cbbf' : '#6f828c', weight: 400 });
    ctx.restore();
    if (this.detailContentH > viewport) drawScrollbar(ctx, x + w - 6, y + 8, Math.max(1, viewport - 16), this.detailContentH, viewport, this.detailScroll);
    const by = y + h - footerH + 4;
    ctx.fillStyle = '#141c24'; ctx.fillRect(x + 1, by - 6, w - 2, footerH - 1);
    const modW = Math.min(84, inner * 0.34), playW = inner - modW - 8;
    if (this.button(ctx, 'play', x + pad, by, playW, actionH, 'PLAY ↗', 'primary')) { this.app.uiSound(); void this.playSelected(); }
    if (this.button(ctx, 'mods', x + pad + playW + 8, by, modW, actionH, 'MODS')) { this.app.uiSound(); this.setModsVisible(true); }
    const canDelete = !e.server || (e as ChartEntry & { canDelete?: boolean }).canDelete;
    const count = e.server ? canDelete ? 3 : 2 : 2, bw = (inner - (count - 1) * 8) / count;
    let bx = x + pad;
    if (e.server) {
      const label = this.downloading ? 'DOWNLOADING' : e.downloaded ? 'DOWNLOADED' : 'DOWNLOAD';
      if (this.button(ctx, 'download', bx, by + actionH + 8, bw, actionH, label) && !this.downloading && !e.downloaded) void this.downloadSelected();
      bx += bw + 8;
    }
    if (this.button(ctx, 'export', bx, by + actionH + 8, bw, actionH, 'EXPORT')) { this.app.uiSound(); void this.exportNfm(); }
    bx += bw + 8;
    if (canDelete && this.button(ctx, 'delete', bx, by + actionH + 8, bw, actionH, 'DELETE', 'danger')) { this.app.uiSound(); void this.deleteSelected(); }
  }
  private drawMods(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app;
    const pw = Math.min(480, w - 24), ph = Math.min(390, h - 24);
    const px = (w - pw) / 2, py = (h - ph) / 2;
    const step = Math.min(46, (ph - 186) / 3);
    ctx.fillStyle = 'rgba(4,8,12,0.8)'; ctx.fillRect(0, 0, w, h);
    fillPanel(ctx, px, py, pw, ph, { r: 14, fill: '#182129', line: '#3d4b53' });
    text(ctx, 'Play your way', px + 24, py + 30, { size: 21, color: '#e1e9e4', baseline: 'middle', weight: 600 });
    const mods = this.app.mods;
    const chips: { id: keyof typeof mods; label: string }[] = [
      { id: 'auto', label: 'AUTO' }, { id: 'mirror', label: 'MIRROR' },
      { id: 'random', label: 'RANDOM' }, { id: 'hidden', label: 'HIDDEN' },
      { id: 'fadeIn', label: 'FADE IN' }, { id: 'flashlight', label: 'FLASHLIGHT' },
      { id: 'noFail', label: 'NO FAIL' }, { id: 'downScroll', label: 'DOWN SCROLL' },
      { id: 'constantSpeed', label: 'CONSTANT SPEED' },
    ];
    const cw = (pw - 48) / 3;
    chips.forEach((c, i) => {
      const cx = px + 20 + (i % 3) * cw, cy = py + 60 + Math.floor(i / 3) * step;
      if (this.button(ctx, 'mod-' + c.id, cx, cy, cw - 8, Math.min(32, step - 4), c.label, mods[c.id] ? 'selected' : 'normal')) {
        (mods as any)[c.id] = !(mods as any)[c.id]; this.app.uiSound();
      }
    });
    const sy = py + 64 + step * 3;
    text(ctx, 'SCROLL SPEED', px + 24, sy + 6, { size: 11, color: '#95a69e', baseline: 'middle' });
    mods.speed = Math.round(this.app.ui.slider('mod-speed', px + 24, sy + 22, pw - 48, 20, mods.speed, 0.5, 2, 0.05) * 100) / 100;
    text(ctx, `x${mods.speed.toFixed(2)}`, px + pw - 24, sy + 6, { size: 12, color: '#bfd5c8', align: 'right', baseline: 'middle' });
    text(ctx, mods.constantSpeed ? 'Constant speed · 90% pp · music timing unchanged' : 'Constant speed ignores BPM and scroll changes', px + 24, sy + 58, { size: 10, color: THEME.dim, maxWidth: pw - 48 });
    if (this.button(ctx, 'mods-close', px + 24, py + ph - 50, pw - 48, 34, 'DONE', 'selected')) { this.setModsVisible(false); this.app.uiSound(); }
  }

  pointerDown(x: number, y: number) {
    if (this.showMods) return;
    this.listDrag = null;
    const detail = this.detailViewport;
    this.detailDrag = this.app.isTouch && x >= detail.x && x <= detail.x + detail.w && y >= detail.y && y <= detail.y + detail.h
      ? { y, scroll: this.detailScroll, moved: false } : null;
    const area = this.listArea();
    if (x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h) {
      this.searchField.blur();
      const offset = y - area.y + this.scroll;
      const row = this.rows.find(row => offset >= row.top && offset < row.top + row.height);
      this.listDrag = { y, scroll: this.scroll, row, moved: false };
    }
  }

  pointerMove(_x: number, y: number) {
    const detail = this.detailDrag;
    if (detail && !this.showMods) {
      if (Math.abs(y - detail.y) > 6) detail.moved = true;
      if (detail.moved) {
        this.detailScroll = Math.max(0, Math.min(detail.scroll + detail.y - y, Math.max(0, this.detailContentH - this.detailViewport.h)));
        this.app.ui.p.moved = true; this.app.ui.cancelPointer();
      }
    }
    const drag = this.listDrag;
    if (!drag || this.showMods) return;
    if (Math.abs(y - drag.y) > 6) drag.moved = true;
    if (drag.moved) {
      this.scroll = Math.max(0, Math.min(drag.scroll + drag.y - y, Math.max(0, this.listHeight - this.listArea().h)));
      this.app.ui.p.moved = true; this.app.ui.cancelPointer();
    }
  }

  pointerUp(x: number, y: number) {
    if (this.detailDrag?.moved) { this.app.ui.p.moved = true; this.app.ui.cancelPointer(); }
    this.detailDrag = null;
    const drag = this.listDrag;
    this.listDrag = null;
    if (!drag || drag.moved || this.showMods) return;
    const area = this.listArea();
    if (x < area.x || x > area.x + area.w || y < area.y || y > area.y + area.h) return;
    const row = drag.row;
    if (row && (!row.header || !row.group.charts.includes(this.entry()!))) this.setSel(row.index);
    void this.app.menuMusic.ensureStarted().catch(() => {});
  }

  wheel(dy: number) {
    if (this.showMods) return;
    const area = this.listArea(), p = this.app.ui.p;
    if (p.y < area.y || p.y > area.y + area.h) return;
    if (p.x >= area.x && p.x <= area.x + area.w) {
      this.scroll = Math.max(0, Math.min(this.scroll + dy * 0.6, Math.max(0, this.listHeight - area.h)));
    } else if (p.x > area.x + area.w && p.x < this.app.w - 20) {
      this.detailScroll = Math.max(0, this.detailScroll + dy * 0.6);
    }
  }
}
