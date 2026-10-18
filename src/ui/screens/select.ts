// Song library: split panels, restrained typography, shared music preview.
import { tr } from '../i18n.ts';
import { Screen } from '../app.ts';
import { THEME, text, fillPanel, drawCover, drawScrollbar, setFont, type TextStyle } from '../theme.ts';
import { TextField } from '../widgets.ts';
import { fmtTime, sha1Hex } from '../../core/zip.ts';
import { readNFMCover } from '../../core/preview-archive.ts';
import type { ChartEntry, LocalChartStats } from '../../core/store.ts';
import type { LeaderboardEntry, PlayResult } from '../../core/types.ts';
import { listPlaybackCharts } from '../../api/library.ts';
import { groupSongs, songKey, type SongGroup, type SongSort } from '../song-groups.ts';
import { drawAvatar } from '../avatar-art.ts';
import { modsLabel } from '../mod-labels.ts';


type SortKey = SongSort;
type SongRow = { group: SongGroup; index: number; header: boolean; top: number; height: number };
type VisualSongRow = SongRow & { reveal: number; visibleHeight: number; interactive: boolean };
type TreeMotion = { from: number[]; target: number; elapsed: number };
const TREE_DURATION_MS = 360;
const smoothMotion = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

const coverCache = new Map<string, HTMLImageElement | null>();
// Keep a fallback song when the shared player's recording is absent from the
// current library. Entering selection otherwise follows the audible recording.
const lastSelections = new WeakMap<object, { id: string; server: boolean; group: string }>();

export class SelectScreen extends Screen {
  readonly name = 'select';
  private entries: ChartEntry[] = [];
  private view: ChartEntry[] = [];
  private groups: SongGroup[] = [];
  private rows: SongRow[] = [];
  private listHeight = 0;
  private visualRows: VisualSongRow[] = [];
  private visualRowCache = new Map<SongGroup, { header: VisualSongRow; children: VisualSongRow[] }>();
  private visualListHeight = 0;
  private treeMotion = new Map<string, TreeMotion>();
  private rendered = false;
  private scrollMotion: { from: number; to: number; elapsed: number } | null = null;
  private detailEntrance = 1;
  private expandedGroup: string | null = null;
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
    const change = () => { this.showMods = visible; if (visible) { this.searchField.blur(); this.showChartActions = false; } };
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
  private coverQueue = new Map<string, ChartEntry>();
  private visibleCovers = new Set<string>();
  private coverRequests = new Map<string, Promise<HTMLImageElement | null>>();
  private coverRetryAt = new Map<string, number>();
  private coverGeneration = 0;
  private coverAge = 0;
  private coverIdle = 0;
  private coverBusy = false;
  private labelCache = new Map<string, string>();
  private backdrop: HTMLImageElement | null = null;
  private backdropId = '';
  private backdropFade = 0;
  private backdropFrom: HTMLCanvasElement | null = null;
  private backdropTo: HTMLCanvasElement | null = null;
  private backdropMask: HTMLCanvasElement | null = null;
  private infoTab: 'rankings' | 'details' = 'rankings';
  private chartScores: LeaderboardEntry[] = [];
  private chartStats: (LocalChartStats & { personalBest?: PlayResult | LeaderboardEntry | null }) | null = null;
  private highScores: Record<string, PlayResult> = {};
  private remoteBest: PlayResult | LeaderboardEntry | null = null;
  private remoteBests = new Map<string, PlayResult | LeaderboardEntry>();
  private bestsGeneration = 0;
  private bestsLoading = false;
  private bestsApi = this.app.server;
  private bestsIdentity = '';
  private bestGroups = new Set<string>();
  private bestFetchActive = 0;
  private bestFetchWaiters: (() => void)[] = [];
  private infoGeneration = 0;
  private infoLoading = false;
  private infoError = '';
  private statsSource: 'server' | 'local' = 'local';
  private infoApi = this.app.server;
  private infoIdentity = '';

  async enter() {
    this.active = true;
    this.initialSelection = true;
    this.observedMusicKey = this.musicKey(this.playingEntry());
    // The shared player already owns decoded artwork. Seed the library at full
    // visibility so navigation cannot reveal an empty frame while loading it.
    const inherited = this.app.menuMusic.background;
    if (inherited?.complete && inherited.naturalWidth > 0) {
      this.backdrop = inherited;
      this.backdropId = this.observedMusicKey;
      this.backdropTo = this.backdropSurface(inherited);
      this.backdropFade = 1;
    }
    this.searchField.el.placeholder = tr('Search title, artist, creator…');
    void this.loadPersonalBests();
    void this.reloadLibrary();
  }

  leave() {
    this.active = false;
    ++this.previewGeneration;
    ++this.libraryGeneration;
    ++this.infoGeneration;
    ++this.bestsGeneration;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.searchField.destroy();
    this.showMods = false;
    this.listDrag = null;
    this.detailDrag = null;
    this.treeMotion.clear();
    this.scrollMotion = null;
    ++this.coverGeneration;
    this.coverQueue.clear(); this.visibleCovers.clear();
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
    this.listDrag = null;
    this.highScores = this.app.store?.getHighScores?.() || this.app.store?.getBestScores?.() || {};
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
    const remembered = lastSelections.get(this.app);
    const initial = this.initialSelection, playingKey = songKey(this.playingEntry());
    this.groups = groupSongs(list, this.sort);
    this.visualRowCache.clear();
    this.view = this.groups.flatMap(group => group.charts);
    const currentSong = initial && playingKey ? this.view.findIndex(e => songKey(e) === playingKey) : -1;
    const index = !initial && previous ? this.view.findIndex(e => e.id === previous.id && !!e.server === !!previous.server) : -1;
    const rememberedSong = initial && remembered ? this.view.findIndex(e => songKey(e) === remembered.group) : -1;
    this.sel = currentSong >= 0 ? currentSong : index >= 0 ? index : rememberedSong >= 0 ? rememberedSong : list.length ? 0 : -1;
    this.expandedGroup = songKey(this.entry()) || null;
    this.rememberSelection();
    this.rebuildRows();
    this.scroll = 0;
    this.revealSelection();
    this.detailScroll = 0;
    this.initialSelection = false;
    // Merely entering the library must not restart an audible harder difficulty
    // or cancel an in-flight player request; its first difficulty shares audio.
    this.schedulePreview(!initial || songKey(this.entry()) !== playingKey);
    void this.loadExpandedBests();
  }

  private entry(): ChartEntry | null {
    return this.view[this.sel] ?? null;
  }

  private rebuildRows(animate = false) {
    // Retarget from the visible state, including partially closing trees, so
    // fast selection changes never restart a row from an invisible position.
    const previous = this.visualRows;
    this.treeMotion.clear();
    if (animate && this.rendered && !this.reducedMotion()) {
      const reveals = new Map(previous.filter(row => !row.header).map(row => [row.index, row.reveal]));
      const visibleGroups = new Set(previous.filter(row => !row.header).map(row => row.group.key));
      let index = 0;
      for (const group of this.groups) {
        const target = group.key === this.expandedGroup ? 1 : 0;
        if (target || visibleGroups.has(group.key)) {
          const from = group.charts.map((_, i) => reveals.get(index + i) || 0);
          if (from.some(value => value !== target)) this.treeMotion.set(group.key, { from, target, elapsed: 0 });
        }
        index += group.charts.length;
      }
    } else this.scrollMotion = null;
    this.rows = [];
    let top = 0, index = 0;
    for (const group of this.groups) {
      const headerHeight = this.app.h < 450 ? 44 : this.app.h < 590 ? 58 : 68;
      this.rows.push({ group, index, header: true, top, height: headerHeight });
      top += headerHeight;
      for (const _entry of group.charts) {
        if (group.key === this.expandedGroup) {
          const height = this.cardH();
          this.rows.push({ group, index, header: false, top, height });
          top += height;
        }
        index++;
      }
      top += 8;
    }
    this.listHeight = top;
    this.layoutVisualRows();
  }

  private motionReveal(motion: TreeMotion, index: number) {
    const order = motion.target ? index : motion.from.length - index - 1;
    const delay = Math.min(order, 7) * 18;
    // Stagger the start, but share one finishing time with viewport scrolling.
    // Zero velocity/acceleration at both ends avoids a last-row stop then drift.
    const t = Math.max(0, Math.min(1, (motion.elapsed - delay) / (TREE_DURATION_MS - delay)));
    return motion.from[index] + (motion.target - motion.from[index]) * smoothMotion(t);
  }

  private reducedMotion() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private layoutVisualRows() {
    this.visualRows.length = 0;
    let top = 0, index = 0;
    for (const group of this.groups) {
      const height = this.app.h < 450 ? 44 : this.app.h < 590 ? 58 : 68;
      let cache = this.visualRowCache.get(group);
      if (!cache) {
        cache = { header: { group, index, header: true, top, height, visibleHeight: height, reveal: 1, interactive: true }, children: [] };
        this.visualRowCache.set(group, cache);
      }
      cache.header.index = index; cache.header.top = top; cache.header.height = cache.header.visibleHeight = height;
      this.visualRows.push(cache.header);
      top += height;
      const motion = this.treeMotion.get(group.key), open = group.key === this.expandedGroup;
      if (motion || open) group.charts.forEach((_, i) => {
        const reveal = motion ? this.motionReveal(motion, i) : 1, height = this.cardH();
        if (reveal > 0) {
          const row = cache.children[i] ||= { group, index: index + i, header: false, top, height, visibleHeight: 0, reveal: 0, interactive: open };
          row.top = top; row.height = height; row.visibleHeight = height * reveal; row.reveal = reveal; row.interactive = open;
          this.visualRows.push(row);
        }
        top += height * reveal;
      });
      index += group.charts.length;
      top += 8;
    }
    this.visualListHeight = top;
  }

  private revealSelection() {
    const row = this.rows.find(row => !row.header && row.index === this.sel)
      || this.rows.find(row => row.header && row.group.key === songKey(this.entry()));
    if (!row) return;
    const area = this.listArea();
    const header = this.rows.find(candidate => candidate.header && candidate.group === row.group);
    const top = header && row.top + row.height - header.top <= area.h ? header.top : row.top;
    let target = this.scroll;
    if (top < target) target = top;
    if (row.top + row.height > target + area.h) target = row.top + row.height - area.h;
    target = Math.max(0, Math.min(target, Math.max(0, this.listHeight - area.h)));
    if (this.treeMotion.size) this.scrollMotion = { from: this.scroll, to: target, elapsed: 0 };
    else this.scroll = target;
  }

  resize() {
    this.listDrag = null; this.detailDrag = null; this.rebuildRows(); this.revealSelection();
    if (this.backdropTo) this.backdropTo = this.backdropSurface(this.backdrop);
  }

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
      case 'ArrowLeft':
        this.expandedGroup = null; this.rebuildRows(true); this.revealSelection();
        break;
      case 'ArrowRight':
        this.expandedGroup = songKey(this.entry()) || null; this.rebuildRows(true); this.revealSelection();
        break;
      case 'Enter':
      case 'NumpadEnter':
        this.playSelected();
        break;
      case 'Escape':
        if (this.showMods) this.setModsVisible(false);
        else if (this.showChartActions) this.showChartActions = false;
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
      coverCache.delete(this.coverKey(entry));
      await this.reloadLibrary();
      this.app.toast('deleted');
    } catch (err: any) {
      this.app.toast(tr('delete failed: {error}', { error: tr(String(err?.message || err)) }));
    }
  }

  /** Selection changes once per gesture, not once per rendered frame. */
  private setSel(i: number) {
    const next = this.view.length ? Math.max(0, Math.min(this.view.length - 1, i)) : -1;
    if (next === this.sel) {
      if (this.expandedGroup !== songKey(this.entry())) { this.expandedGroup = songKey(this.entry()) || null; this.rebuildRows(true); this.revealSelection(); }
      return;
    }
    this.sel = next;
    this.showChartActions = false;
    this.expandedGroup = songKey(this.entry()) || null;
    this.rememberSelection();
    this.rebuildRows(true);
    this.detailEntrance = this.rendered && !this.reducedMotion() ? 0 : 1;
    this.detailScroll = 0;
    this.revealSelection();
    this.schedulePreview();
    void this.loadExpandedBests();
  }

  private musicKey(entry: ChartEntry | null) { return entry ? `${!!entry.server}:${entry.id}` : ''; }

  private playingEntry(): ChartEntry | null {
    const music = this.app.menuMusic;
    return music.playingChart ?? (!music.loading ? music.entry : null);
  }

  private rememberSelection() {
    const entry = this.entry();
    if (entry) lastSelections.set(this.app, { id: entry.id, server: !!entry.server, group: songKey(entry) });
  }

  private identity() { return `${this.app.serverOnline}:${!!this.app.settings.serverDisconnected}:${this.app.account.server}:${this.app.account.user?.username || ''}:${this.app.store.getToken?.() || ''}`; }

  private personalBest(entry: ChartEntry): PlayResult | LeaderboardEntry | null {
    if (this.app.account.server) {
      if (this.bestsApi !== this.app.server || this.bestsIdentity !== this.identity()) return null;
      return this.remoteBests.get(`${entry.contentHash || entry.id}:${entry.keys}`)
        || (entry === this.entry() ? this.remoteBest : null) || null;
    }
    return this.highScores[entry.id] || (entry.contentHash ? this.highScores[entry.contentHash] : null) || null;
  }

  private rememberBest(id: string, keys: number, score: PlayResult | LeaderboardEntry) {
    const key = `${id}:${keys}`, previous = this.remoteBests.get(key);
    const newerRules = previous && (score.scoreVersion === 2) !== (previous.scoreVersion === 2);
    if (!previous || (newerRules ? score.scoreVersion === 2 : score.score > previous.score || score.score === previous.score && score.acc > previous.acc)) this.remoteBests.set(key, score);
  }

  private async loadPersonalBests() {
    const generation = ++this.bestsGeneration, api = this.app.server, identity = this.identity();
    this.bestsApi = api; this.bestsIdentity = identity; this.bestsLoading = false;
    this.remoteBests.clear(); this.remoteBest = null; this.bestGroups.clear();
    if (!this.active || !this.app.account.server || !this.app.serverOnline || this.app.settings.serverDisconnected || typeof api.myScores !== 'function') return;
    this.bestsLoading = true;
    const current = () => this.active && generation === this.bestsGeneration && this.app.server === api && this.identity() === identity;
    try {
      const scores = await api.myScores(true);
      if (!current()) return;
      for (const score of scores) this.rememberBest(score.chartId, score.keys, score);
    } catch { /* The per-chart request remains available on older servers. */ }
    finally { if (current()) this.bestsLoading = false; }
  }

  /** A 0.2.9 host truncates /mine to 100 rows. Fill every visible difficulty
   * from its statistics endpoint, including a PB outside the public top 20. */
  private async loadExpandedBests() {
    const api = this.app.server, identity = this.identity(), group = this.groups.find(g => g.key === this.expandedGroup);
    if (!group || !this.active || !this.app.account.server || !this.app.serverOnline || this.app.settings.serverDisconnected || !api.statisticsVersion || this.bestGroups.has(group.key)) return;
    this.bestGroups.add(group.key);
    const generation = this.bestsGeneration, pending = [...group.charts];
    const current = () => this.active && generation === this.bestsGeneration && this.app.server === api && this.identity() === identity;
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (pending.length && current()) {
        const entry = pending.shift()!;
        await this.withBestFetchSlot(async () => {
          if (!current()) return;
          try {
            let id = entry.contentHash || entry.id;
            if (!entry.server && !/^[a-f0-9]{40}$/i.test(id)) {
              const bytes = await this.app.store.getChartBytes(entry.id);
              if (!current()) return;
              if (bytes) id = await sha1Hex(bytes);
            }
            if (!current()) return;
            const stats = await api.chartStats(id, entry.keys);
            if (current() && stats.personalBest) {
              this.rememberBest(id, entry.keys, stats.personalBest);
              this.rememberBest(entry.id, entry.keys, stats.personalBest);
            }
          } catch { /* Missing charts/statistics do not hide other scores. */ }
        });
      }
    }));
  }

  private async withBestFetchSlot(task: () => Promise<void>) {
    if (this.bestFetchActive < 3) this.bestFetchActive++;
    else await new Promise<void>(resolve => this.bestFetchWaiters.push(resolve));
    try { await task(); }
    finally {
      // Hand an occupied slot directly to a waiter. Decrementing first would
      // let a fast new song request jump the queue and exceed the cap.
      const next = this.bestFetchWaiters.shift();
      if (next) next(); else this.bestFetchActive--;
    }
  }

  private async loadChartInfo() {
    if (!this.active) return;
    if (this.bestsApi !== this.app.server || this.bestsIdentity !== this.identity()) void this.loadPersonalBests();
    const generation = ++this.infoGeneration, entry = this.entry(), api = this.app.server;
    this.infoApi = api; this.infoIdentity = this.identity();
    void this.loadExpandedBests();
    const identity = this.infoIdentity;
    this.chartScores = []; this.remoteBest = null; this.infoError = ''; this.infoLoading = false;
    this.chartStats = entry ? this.app.store.getChartStats?.(entry.id) || null : null;
    this.statsSource = 'local';
    if (!entry || !this.active || !this.app.serverOnline || this.app.settings.serverDisconnected) return;
    const current = () => this.active && generation === this.infoGeneration && this.entry() === entry && this.app.server === api && this.identity() === identity;
    this.infoLoading = true;
    try {
      let id = entry.contentHash || entry.id;
      if (!entry.server && !/^[a-f0-9]{40}$/i.test(id)) {
        const bytes = await this.app.store.getChartBytes(entry.id);
        if (!current()) return;
        if (bytes) id = await sha1Hex(bytes);
      }
      if (!current()) return;
      const [scores, stats] = await Promise.allSettled([
        api.scores(id, entry.keys, api.scoreVersion >= 2 ? 2 : 1),
        api.statisticsVersion ? api.chartStats(id, entry.keys) : Promise.resolve(null),
      ]);
      if (!current()) return;
      if (scores.status === 'fulfilled') {
        this.chartScores = scores.value;
        this.remoteBest = scores.value.find(score => score.isSelf || score.username === this.app.account.user?.username) || null;
      } else this.infoError = scores.reason?.message || 'Could not load rankings.';
      if (stats.status === 'fulfilled' && stats.value) {
        this.chartStats = stats.value; this.statsSource = 'server';
        this.remoteBest = stats.value.personalBest || this.remoteBest;
      }
      if (this.remoteBest && this.app.account.server) this.rememberBest(id, entry.keys, this.remoteBest);
      if (this.remoteBest && this.app.account.server) this.rememberBest(entry.id, entry.keys, this.remoteBest);
    } catch (error: any) { if (current()) this.infoError = error?.message || 'Could not load rankings.'; }
    finally { if (current()) this.infoLoading = false; }
  }

  private setInfoTab(tab: 'rankings' | 'details') {
    if (tab === this.infoTab) return;
    const change = () => { this.infoTab = tab; this.detailScroll = 0; };
    if (this.app.animateViewChange) this.app.animateViewChange(change); else change();
    this.app.uiSound();
  }

  private schedulePreview(selectAudio = true) {
    void this.loadChartInfo();
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    const generation = ++this.previewGeneration;
    const entry = this.entry();
    if (!entry || !this.active) { this.changeBackdrop(null, ''); return; }
    const current = () => this.active && this.app.screen === this && generation === this.previewGeneration && this.entry() === entry;
    this.previewTimer = setTimeout(async () => {
      this.previewTimer = null;
      if (!current()) return;
      // Let the shared player populate previewChart before asking for its art.
      // Downloading/unzipping the same archive twice during the tree transition
      // can block the main thread near its final frames, especially on mobile.
      if (selectAudio) {
        await this.app.menuMusic.select(entry).catch(() => {});
        if (!current()) return;
      }
      try {
        const image = await this.coverImage(entry);
        if (current()) this.changeBackdrop(image, this.musicKey(entry));
      } catch { /* Background failure must not interrupt shared playback. */ }
    }, 180);
  }

  /** Small opaque surfaces preserve the existing blurred style. Darkening is
   * applied once after blending, rather than fading both pictures to black. */
  private backdropSurface(image: HTMLImageElement | null) {
    const surface = document.createElement('canvas');
    surface.width = 48;
    surface.height = Math.max(1, Math.round(48 * this.app.h / Math.max(1, this.app.w)));
    const ctx = surface.getContext('2d');
    if (!ctx) return surface;
    ctx.fillStyle = '#0d1218'; ctx.fillRect(0, 0, surface.width, surface.height);
    if (image?.complete && image.naturalWidth > 0) {
      const scale = Math.max(surface.width / image.naturalWidth, surface.height / image.naturalHeight);
      const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
      ctx.drawImage(image, (surface.width - w) / 2, (surface.height - h) / 2, w, h);
    }
    return surface;
  }

  private changeBackdrop(image: HTMLImageElement | null, id: string) {
    if (id === this.backdropId && this.backdropTo) return;
    if (!image && !this.backdropTo) { this.backdropId = id; return; }
    const from = this.backdropSurface(null), ctx = from.getContext('2d');
    // Capture the actual mixed frame, not just the previous destination. A
    // second selection during a transition therefore continues without a cut.
    if (ctx) this.drawBackdropFrame(ctx, from.width, from.height);
    this.backdropFrom = from;
    this.backdrop = image;
    this.backdropId = id;
    this.backdropTo = this.backdropSurface(image);
    this.backdropFade = this.reducedMotion() ? 1 : 0;
    if (this.backdropFade === 1) this.backdropFrom = null;
  }

  private drawBackdropFrame(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.save();
    ctx.fillStyle = '#0d1218'; ctx.fillRect(0, 0, w, h);
    if (this.backdropFrom && this.backdropFade < 1) ctx.drawImage(this.backdropFrom, 0, 0, w, h);
    const target = this.backdropTo;
    if (target && this.backdropFade >= 1) ctx.drawImage(target, 0, 0, w, h);
    else if (target && this.backdropFade > 0) {
      const mask = this.backdropMask ||= document.createElement('canvas');
      if (mask.width !== target.width || mask.height !== target.height) { mask.width = target.width; mask.height = target.height; }
      const blend = mask.getContext('2d');
      if (blend) {
        blend.clearRect(0, 0, mask.width, mask.height);
        blend.drawImage(target, 0, 0);
        const t = this.backdropFade, eased = t * t * (3 - 2 * t);
        const feather = mask.width * .65, edge = -feather + eased * (mask.width + feather * 2);
        const shade = blend.createLinearGradient(edge - feather, 0, edge + feather, 0);
        shade.addColorStop(0, '#fff'); shade.addColorStop(1, 'rgba(255,255,255,0)');
        blend.save(); blend.globalCompositeOperation = 'destination-in';
        blend.fillStyle = shade; blend.fillRect(0, 0, mask.width, mask.height); blend.restore();
        ctx.drawImage(mask, 0, 0, w, h);
      }
    }
    ctx.restore();
  }

  private drawBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number) {
    this.drawBackdropFrame(ctx, w, h);
    ctx.save(); ctx.fillStyle = 'rgba(13,18,24,0.84)'; ctx.fillRect(0, 0, w, h); ctx.restore();
  }
  private coverKey(entry: ChartEntry) { return `${entry.server ? this.app.server.base || 'server' : 'local'}:${songKey(entry)}`; }

  private rememberCover(key: string, image: HTMLImageElement | null) {
    coverCache.delete(key); coverCache.set(key, image);
    if (coverCache.size > 64) coverCache.delete(coverCache.keys().next().value!);
  }

  private sharedCover(entry: ChartEntry) {
    const music = this.app.menuMusic;
    const source = music.backgroundChart;
    return source && songKey(source) === songKey(entry) && music.background?.complete && music.background.naturalWidth > 0 ? music.background : null;
  }

  private async coverData(entry: ChartEntry) {
    const cached = this.app.previewChart;
    if (cached && (cached.id === entry.id || songKey({ ...entry, title: cached.archive.chart.meta.title, artist: cached.archive.chart.meta.artist }) === songKey(entry))) {
      const bg = cached.archive.chart.meta.bg;
      return bg ? cached.archive.files.get(bg) : undefined;
    }
    const generation = this.coverGeneration;
    const bytes = entry.server ? await this.app.server.downloadChart(entry.id, { persist: false }) : await this.app.store.getChartBytes(entry.id);
    if (!this.active || generation !== this.coverGeneration) throw new Error('cover request no longer active');
    if (!bytes) throw new Error('chart unavailable');
    return readNFMCover(bytes, entry.bg);
  }

  private coverImage(entry: ChartEntry): Promise<HTMLImageElement | null> {
    const key = this.coverKey(entry), shared = this.sharedCover(entry);
    if (shared) { this.rememberCover(key, shared); return Promise.resolve(shared); }
    if (coverCache.has(key)) return Promise.resolve(coverCache.get(key)!);
    const pending = this.coverRequests.get(key);
    if (pending) return pending;
    const generation = this.coverGeneration, api = this.app.server;
    const current = () => this.active && generation === this.coverGeneration && (!entry.server || api === this.app.server && key === this.coverKey(entry));
    const request = (async () => {
      const data = await this.coverData(entry);
      if (!current()) throw new Error('cover request no longer active');
      const image = data ? await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image(), url = URL.createObjectURL(new Blob([data as BlobPart]));
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('cover image unavailable')); };
        img.src = url;
      }) : null;
      if (!current()) throw new Error('cover request no longer active');
      this.rememberCover(key, image);
      return image;
    })().finally(() => this.coverRequests.delete(key));
    this.coverRequests.set(key, request);
    return request;
  }

  /** Drawing records visible demand only. Downloads and image decoding begin
   * after the screen/tree settles, one at a time rather than a cold-frame burst. */
  private loadCover(entry: ChartEntry) {
    const key = this.coverKey(entry);
    this.visibleCovers.add(key);
    if (coverCache.has(key)) return;
    const shared = this.sharedCover(entry);
    if (shared) { this.rememberCover(key, shared); return; }
    if ((this.coverRetryAt.get(key) || 0) <= this.coverAge) this.coverQueue.set(key, entry);
  }

  private pumpCovers() {
    if (!this.active || this.coverBusy || this.coverAge < 340 || this.coverIdle < 120 || this.treeMotion.size || this.scrollMotion || this.listDrag) return;
    for (const [key, entry] of this.coverQueue) {
      this.coverQueue.delete(key);
      if (!this.visibleCovers.has(key) || coverCache.has(key) || (this.coverRetryAt.get(key) || 0) > this.coverAge) continue;
      this.coverBusy = true;
      void this.coverImage(entry).catch(() => { this.coverRetryAt.set(key, this.coverAge + 10000); }).finally(() => { this.coverBusy = false; this.coverIdle = 0; });
      break;
    }
  }

  // ---------- restrained local visual system (shared theme remains untouched) ----------
  private label(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, width: number, style: TextStyle = {}) {
    const content = style.translate === false ? value : tr(value);
    const available = Math.max(0, width);
    const key = `${available}\0${style.size ?? 16}\0${style.weight ?? 600}\0${style.font ?? THEME.font}\0${style.spacing ?? '0px'}\0${content}`;
    let result = this.labelCache.get(key);
    if (result === undefined) {
      result = content;
      ctx.save(); setFont(ctx, style);
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
      this.labelCache.set(key, result);
      if (this.labelCache.size > 512) this.labelCache.delete(this.labelCache.keys().next().value!);
    }
    text(ctx, result, x, y, { baseline: 'middle', color: '#cbd3da', ...style, translate: false });
  }

  private button(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, w: number, h: number, label: string, kind: 'normal' | 'primary' | 'danger' | 'selected' = 'normal') {
    const popupBlocks = this.showChartActions && !['chart-actions', 'download', 'export', 'delete', 'play', 'mods'].includes(id);
    const clicked = this.app.ui.button(id, x, y, w, h, '', { disabled: this.showMods && !id.startsWith('mod') || popupBlocks });
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

  private cardH(): number { return this.app.h < 450 ? 58 : this.app.h < 590 ? 66 : 76; }

  update(dt: number, _now: number) {
    this.coverAge += Math.max(0, dt);
    this.coverIdle = this.treeMotion.size || this.scrollMotion || this.listDrag ? 0 : this.coverIdle + Math.max(0, dt);
    const reduced = this.reducedMotion();
    if (this.treeMotion.size) {
      for (const [key, motion] of this.treeMotion) {
        motion.elapsed += Math.max(0, dt);
        if (reduced || motion.elapsed >= TREE_DURATION_MS) this.treeMotion.delete(key);
      }
      this.layoutVisualRows();
    }
    if (this.scrollMotion) {
      const motion = this.scrollMotion;
      motion.elapsed += Math.max(0, dt);
      const t = reduced ? 1 : Math.min(1, motion.elapsed / TREE_DURATION_MS);
      this.scroll = motion.from + (motion.to - motion.from) * smoothMotion(t);
      if (t === 1) this.scrollMotion = null;
    }
    this.detailEntrance = reduced ? 1 : Math.min(1, this.detailEntrance + Math.max(0, dt) / 220);
    if (this.infoApi !== this.app.server || this.infoIdentity !== this.identity()) void this.loadChartInfo();
    const playing = this.playingEntry();
    const key = this.musicKey(playing);
    if (key !== this.observedMusicKey) {
      this.observedMusicKey = key;
      const playingSong = songKey(playing), index = this.view.findIndex(entry => songKey(entry) === playingSong);
      if (index >= 0 && playingSong !== songKey(this.entry())) {
        this.sel = index;
        this.expandedGroup = songKey(this.entry()) || null;
        this.rememberSelection();
        this.rebuildRows(true);
        this.detailEntrance = this.rendered && !reduced ? 0 : 1;
        this.detailScroll = 0;
        this.revealSelection();
        this.schedulePreview(false);
      }
    }
    if (this.backdropFade < 1) {
      this.backdropFade = reduced ? 1 : Math.min(1, this.backdropFade + Math.max(0, dt) / 650);
      if (this.backdropFade === 1) this.backdropFrom = null;
    }
    if (this.searchField.consumeDirty()) {
      this.search = this.searchField.value;
      this.applyFilter();
    }
    this.pumpCovers();
  }

  draw(ctx: CanvasRenderingContext2D) {
    this.rendered = true;
    this.visibleCovers.clear();
    const { w, h } = this.app;
    this.drawBackdrop(ctx, w, h);
    const area = this.listArea();
    const total = this.visualListHeight;
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
    for (const row of this.visualRows) {
      const { index: i, height: cardH } = row;
      const entry = this.view[i], y = area.y + row.top - this.scroll;
      if (y + row.visibleHeight < area.y) continue;
      if (y > area.y + area.h) break;
      const hover = row.interactive && !this.showMods && this.app.ui.hover((row.header ? 'song-' : 'card-') + i, area.x, Math.max(area.y, y), area.w, Math.min(y + row.visibleHeight, area.y + area.h) - Math.max(area.y, y));
      if (hover) this.listHover = i;
      const selected = i === this.sel;
      if (row.header) {
        const groupSelected = row.group.charts.includes(this.entry()!);
        fillPanel(ctx, area.x + 6, y + 4, area.w - 12, cardH - 6, { r: 9, fill: hover ? '#2b393f' : groupSelected ? '#23352e' : '#1a252d', line: '#31433c' });
        const showCover = area.w > 280, coverSize = cardH - 20;
        if (showCover) {
          this.loadCover(entry);
          drawCover(ctx, coverCache.get(this.coverKey(entry)) ?? null, area.x + 13, y + 11, coverSize, coverSize, entry.title, '#293c37');
        }
        const tx = area.x + (showCover ? coverSize + 23 : 15), tw = area.x + area.w - 44 - tx;
        this.label(ctx, entry.title, tx, y + cardH * .38, tw, { size: 14, color: '#e0eae4', weight: 600 });
        this.label(ctx, `${entry.artist} · ${row.group.charts.length} ${tr('CHARTS')}`, tx, y + cardH * .72, tw, { size: 10, color: '#91a79c', weight: 400 });
        const cx = area.x + area.w - 26, cy = y + cardH / 2;
        ctx.strokeStyle = '#9fb9aa'; ctx.lineWidth = 1.6; ctx.beginPath();
        if (row.group.key === this.expandedGroup) { ctx.moveTo(cx - 4, cy - 2); ctx.lineTo(cx, cy + 2); ctx.lineTo(cx + 4, cy - 2); }
        else { ctx.moveTo(cx - 2, cy - 4); ctx.lineTo(cx + 2, cy); ctx.lineTo(cx - 2, cy + 4); }
        ctx.stroke();
        continue;
      }
      ctx.save();
      ctx.beginPath(); ctx.rect(area.x + 1, y, area.w - 2, row.visibleHeight); ctx.clip();
      ctx.translate((1 - row.reveal) * 20, 0);
      ctx.globalAlpha *= Math.min(1, row.reveal * 1.4);
      const inset = area.w < 260 ? 21 : 29, tx = area.x + inset + 13;
      ctx.strokeStyle = '#3b5549'; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(area.x + 16, y); ctx.lineTo(area.x + 16, y + cardH / 2); ctx.lineTo(area.x + inset, y + cardH / 2);
      if (row.group.charts.at(-1) !== entry) { ctx.moveTo(area.x + 16, y + cardH / 2); ctx.lineTo(area.x + 16, y + cardH); }
      ctx.stroke();
      fillPanel(ctx, area.x + inset, y + 3, area.w - inset - 8, cardH - 6, { r: 7, fill: selected ? '#2c4939' : hover ? '#25363b' : '#17232b', line: selected ? '#759981' : 'rgba(0,0,0,0)' });
      const rowBest = this.personalBest(entry);
      const tw = area.x + area.w - 74 - tx, scoreY = y + cardH * .32;
      const rowLabel = this.app.account.server ? 'PERSONAL BEST' : 'DEVICE BEST';
      if (rowBest) {
        const gradeW = cardH < 65 ? 28 : 34;
        const statusW = rowBest.scoreVersion !== 2 ? 48 : area.w > 380 ? 94 : 0;
        fillPanel(ctx, tx - 3, scoreY - 13, gradeW, 26, { r: 5, fill: '#3c4939', line: '#8d9c64' });
        this.label(ctx, rowBest.grade || '—', tx - 3 + gradeW / 2, scoreY, gradeW - 4, { size: 15, weight: 700, align: 'center', color: '#f0dfa1', translate: false });
        this.label(ctx, rowBest.score.toLocaleString(), tx + gradeW + 4, scoreY, Math.max(0, area.x + area.w - 17 - tx - gradeW - 4 - statusW), { size: cardH < 65 ? 18 : 21, weight: 700, color: '#ecf5d8', translate: false });
        if (statusW) this.label(ctx, rowBest.scoreVersion === 2 ? rowLabel : 'LEGACY', area.x + area.w - 17, scoreY, statusW - 3, { size: 8, align: 'right', color: '#9fae8f' });
      } else this.label(ctx, this.bestsLoading && this.app.account.server ? 'Loading personal best…' : 'No personal best yet.', tx, scoreY, area.x + area.w - 17 - tx, { size: 11, color: '#879b90' });
      this.label(ctx, entry.version, tx, y + cardH * .75, tw, { size: 12, color: selected ? '#edf3ef' : '#bdccc5', weight: 600, translate: false });
      const bx = area.x + area.w - 17;
      text(ctx, `${entry.keys}K · ${(entry.stars || 0).toFixed(2)} ★`, bx, y + cardH * .75, { size: 9, color: '#c2b88f', align: 'right', baseline: 'middle' });
      ctx.restore();
    }
    if (!this.view.length) {
      this.label(ctx, this.loading ? 'Loading collection…' : this.loadError ? 'Could not load library' : 'No charts found', area.x + 18, area.y + 38, area.w - 36, { size: 15, color: '#a5b7ad' });
      this.label(ctx, this.loadError || 'Import a chart or adjust your search.', area.x + 18, area.y + 64, area.w - 36, { size: 11, color: '#788a95' });
    }
    ctx.restore();
    for (const key of this.coverQueue.keys()) if (!this.visibleCovers.has(key)) this.coverQueue.delete(key);
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
  private showChartActions = false;
  private actionPopup: { x: number; y: number; w: number; h: number } | null = null;
  private drawDetail(ctx: CanvasRenderingContext2D, e: ChartEntry, x: number, y: number, w: number, h: number) {
    this.actionPopup = null;
    const compact = h < 320, tiny = h < 200, pad = w < 260 ? 10 : 16, inner = Math.max(1, w - pad * 2);
    const headerH = tiny ? 26 : compact ? 45 : 91, tabH = compact ? 24 : 32;
    const actionH = compact ? 28 : 38, footerH = compact ? actionH + 12 : actionH * 2 + 25;
    const tabY = y + headerH, bodyY = tabY + tabH + (compact ? 5 : 8), viewport = Math.max(1, y + h - footerH - bodyY);
    this.detailViewport = { x, y: bodyY, w, h: viewport };
    // Header, tabs, scrollable information, and actions occupy separate bands.
    // The personal record belongs above each difficulty in the song tree.
    const entrance = 1 - Math.pow(1 - this.detailEntrance, 3);
    ctx.save(); ctx.beginPath(); ctx.rect(x + 1, y + 1, w - 2, headerH - 1); ctx.clip();
    ctx.translate((1 - entrance) * 16, 0); ctx.globalAlpha *= .45 + entrance * .55;
    this.label(ctx, e.title, x + pad, y + (compact ? 15 : 25), inner, { size: compact ? 15 : 23, weight: 600, color: '#edf1ef', translate: false });
    if (!compact) this.label(ctx, e.artist, x + pad, y + 48, inner, { size: 11, color: '#96a99e', translate: false });
    if (!tiny) this.label(ctx, `${e.version} · ${e.keys}K · ${(e.stars || 0).toFixed(2)} ★`, x + pad, y + (compact ? 33 : 72), inner, { size: compact ? 10 : 12, color: '#b6cdbf', translate: false });
    ctx.restore();
    const tabW = (inner - 8) / 2;
    if (this.button(ctx, 'chart-rankings', x + pad, tabY, tabW, tabH, compact ? 'SCORES' : 'CHART RANKINGS', this.infoTab === 'rankings' ? 'selected' : 'normal')) this.setInfoTab('rankings');
    if (this.button(ctx, 'chart-details', x + pad + tabW + 8, tabY, tabW, tabH, compact ? 'DETAILS' : 'SONG DETAILS', this.infoTab === 'details' ? 'selected' : 'normal')) this.setInfoTab('details');

    const rowH = compact ? 58 : inner < 210 ? 75 : 69;
    this.detailContentH = this.infoTab === 'rankings' ? Math.max(84, (compact ? 2 : 26) + this.chartScores.length * rowH) : 333;
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, this.detailContentH - viewport)));
    ctx.save(); ctx.beginPath(); ctx.rect(x + 1, bodyY, w - 2, viewport); ctx.clip();
    this.app.ui.setClip?.(x + 1, bodyY, w - 2, viewport);
    let ty = bodyY + 11 - this.detailScroll;
    if (this.infoTab === 'rankings') {
      if (compact) ty = bodyY + 2 - this.detailScroll;
      else { this.label(ctx, this.app.server.scoreVersion >= 2 ? 'MILLION-POINT SCORES' : this.app.serverOnline ? 'LEGACY SCORES' : 'SERVER RANKINGS', x + pad, ty, inner, { size: 9, color: '#8caa98' }); ty += 15; }
      if (!this.chartScores.length) {
        const message = !this.app.serverOnline ? 'Connect to a server to view rankings.' : this.infoLoading ? 'Loading rankings…' : this.infoError || 'No ranked scores yet.';
        this.label(ctx, message, x + pad, ty + 20, inner, { size: 11, color: '#879c90' });
      }
      this.chartScores.forEach((score, i) => {
        const ry = ty + i * rowH;
        if (ry + rowH < bodyY || ry > bodyY + viewport) return;
        const self = score.isSelf || this.app.account.server && score.username === this.app.account.user?.username;
        fillPanel(ctx, x + pad, ry, inner, rowH - 7, { r: 7, fill: self ? '#273e31' : '#19262c', line: self ? '#597d64' : '#293b37' });
        const avatar = !compact && inner >= 280, nameX = x + pad + (avatar ? 65 : 35), right = x + w - pad - 10, nameY = compact ? 13 : 17;
        this.label(ctx, '#' + score.rank, x + pad + 8, ry + nameY, 26, { size: 10, color: i < 3 ? '#d0bc87' : '#7e968a', translate: false });
        if (avatar) drawAvatar(ctx, this.app, score, x + pad + 34, ry + 7, 25);
        this.label(ctx, score.nickname || score.username, nameX, ry + nameY, Math.max(1, right - nameX - 35), { size: 11, color: '#d3dfd6', translate: false });
        this.label(ctx, score.grade || '—', right, ry + nameY, 30, { size: 17, weight: 600, color: '#d8c78a', align: 'right', translate: false });
        const scoreW = Math.min(115, inner * .56);
        this.label(ctx, score.score.toLocaleString(), x + pad + 10, ry + (compact ? 33 : 43), scoreW, { size: 18, weight: 600, color: self ? '#eef4da' : '#bdd4c4', translate: false });
        this.label(ctx, `${(score.acc * 100).toFixed(2)}%`, right, ry + (compact ? 29 : 38), inner - scoreW - 22, { size: 10, color: '#aec1b5', align: 'right', translate: false });
        this.label(ctx, modsLabel(score.mods), right, ry + (compact ? 40 : 53), Math.max(1, inner - scoreW - 22), { size: 8, color: '#829f8d', align: 'right', translate: false });
      });
    } else {
      this.label(ctx, tr('MAPPER / {name}', { name: e.creator }), x + pad, ty + 3, inner, { size: 12, color: '#d4dfd7', translate: false }); ty += 26;
      this.label(ctx, e.artist, x + pad, ty, inner, { size: 11, color: '#94a99c', translate: false }); ty += 23;
      this.label(ctx, `${fmtTime(e.lengthMs)} · ${tr('{count} notes', { count: e.notes.toLocaleString() })} · ${(e.source || 'nfm').toUpperCase()}`, x + pad, ty, inner, { size: 10, color: '#94a99c', translate: false }); ty += 22;
      const stats = this.chartStats, statH = 69;
      fillPanel(ctx, x + pad, ty, inner, statH, { r: 7, fill: '#20332b', line: '#3e5746' });
      this.label(ctx, tr('PASS RATE') + ' · ' + tr(this.statsSource === 'server' ? 'SERVER ATTEMPTS' : 'DEVICE ATTEMPTS'), x + pad + 10, ty + 15, inner - 20, { size: 9, color: '#95b49f', translate: false });
      this.label(ctx, stats?.attempts ? `${((stats.passRate || 0) * 100).toFixed(1)}%` : '—', x + pad + 10, ty + 44, inner * .48, { size: 25, color: '#e1edda', weight: 600, translate: false });
      this.label(ctx, stats?.attempts ? `${stats.passes} / ${stats.attempts}` : 'No attempts recorded yet.', x + w - pad - 10, ty + 43, inner * .49, { size: 11, color: '#a8bdad', align: 'right', translate: !stats?.attempts });
      ty += statH + 25;
      this.label(ctx, 'FAILURE LOCATIONS', x + pad, ty, inner, { size: 10, color: '#b9c3af' }); ty += 16;
      this.drawFailureGraph(ctx, stats, e, x + pad, ty, inner, 70); ty += 98;
      this.label(ctx, 'Recorded attempts only; older records have no failure location.', x + pad, ty, inner, { size: 9, color: '#7c9184' });
    }
    this.app.ui.clearClip?.(); ctx.restore();
    if (this.detailContentH > viewport) drawScrollbar(ctx, x + w - 6, bodyY + 4, Math.max(1, viewport - 8), this.detailContentH, viewport, this.detailScroll);

    const by = y + h - footerH + 7, toolW = compact ? 34 : 0, modW = Math.min(84, inner * .29), playW = inner - modW - 8 - (compact ? toolW + 7 : 0);
    ctx.fillStyle = '#141c24'; ctx.fillRect(x + 1, by - 6, w - 2, footerH - 1);
    ctx.strokeStyle = '#2d3c36'; ctx.beginPath(); ctx.moveTo(x + pad, by - 6); ctx.lineTo(x + w - pad, by - 6); ctx.stroke();
    if (this.button(ctx, 'play', x + pad, by, playW, actionH, 'PLAY →', 'primary')) { this.app.uiSound(); void this.playSelected(); }
    if (this.button(ctx, 'mods', x + pad + playW + 8, by, modW, actionH, 'MODS')) { this.app.uiSound(); this.setModsVisible(true); }
    if (compact && this.button(ctx, 'chart-actions', x + w - pad - toolW, by, toolW, actionH, '···', this.showChartActions ? 'selected' : 'normal')) { this.showChartActions = !this.showChartActions; this.app.uiSound(); }
    if (!compact || this.showChartActions) {
      const canDelete = !e.server || (e as ChartEntry & { canDelete?: boolean }).canDelete;
      const count = e.server ? canDelete ? 3 : 2 : 2, bw = (inner - (count - 1) * 8) / count;
      let bx = x + pad;
      const actionY = compact ? by - actionH - 13 : by + actionH + 8;
      if (compact) {
        this.actionPopup = { x, y: actionY - 6, w, h: by + actionH - actionY + 6 };
        fillPanel(ctx, x + 5, actionY - 6, w - 10, actionH + 12, { r: 9, fill: '#101e1b', line: '#607b69' });
      }
      if (e.server) {
        const label = this.downloading ? 'DOWNLOADING' : e.downloaded ? 'DOWNLOADED' : 'DOWNLOAD';
        if (this.button(ctx, 'download', bx, actionY, bw, actionH, label) && !this.downloading && !e.downloaded) { void this.downloadSelected(); this.showChartActions = false; }
        bx += bw + 8;
      }
      if (this.button(ctx, 'export', bx, actionY, bw, actionH, 'EXPORT')) { this.app.uiSound(); void this.exportNfm(); this.showChartActions = false; }
      bx += bw + 8;
      if (canDelete && this.button(ctx, 'delete', bx, actionY, bw, actionH, 'DELETE', 'danger')) { this.app.uiSound(); void this.deleteSelected(); this.showChartActions = false; }
    }
  }

  private drawFailureGraph(ctx: CanvasRenderingContext2D, stats: LocalChartStats | null, entry: ChartEntry, x: number, y: number, w: number, h: number) {
    ctx.fillStyle = '#101a20'; ctx.fillRect(x, y, w, h);
    const bins = stats?.failureBins || [], max = Math.max(1, ...bins), count = Math.max(1, bins.length), step = w / count;
    ctx.strokeStyle = '#34443c'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.stroke();
    bins.forEach((value, i) => {
      if (value <= 0) return;
      const bh = Math.max(3, value / max * (h - 8));
      ctx.fillStyle = '#a67774'; ctx.fillRect(x + i * step + 1, y + h - bh, Math.max(1, step - 2), bh);
    });
    if (!stats?.failureSamples) this.label(ctx, 'No failure locations recorded.', x + w / 2, y + h / 2, w - 12, { size: 10, align: 'center', color: '#758d80' });
    const p = this.app.ui.p;
    if (stats?.failureSamples && p.x >= x && p.x < x + w && p.y >= y && p.y <= y + h) {
      const index = Math.min(count - 1, Math.floor((p.x - x) / step));
      this.label(ctx, `${fmtTime(entry.lengthMs * index / count)} · ${bins[index]} ${tr('FAILURES')}`, x + w / 2, y + 11, w - 8, { size: 10, align: 'center', color: '#e1ccc3', translate: false });
    }
    this.label(ctx, '0%', x, y + h + 14, 35, { size: 8, color: '#758d80', translate: false });
    this.label(ctx, '50%', x + w / 2, y + h + 14, 35, { size: 8, color: '#758d80', align: 'center', translate: false });
    this.label(ctx, '100%', x + w, y + h + 14, 35, { size: 8, color: '#758d80', align: 'right', translate: false });
  }
  private drawMods(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app;
    const pw = Math.min(480, w - 24), ph = Math.min(390, h - 24);
    const px = (w - pw) / 2, py = (h - ph) / 2;
    const step = Math.min(42, (ph - 186) / 4);
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
      { id: 'noTail', label: 'NO TAIL' },
    ];
    const cw = (pw - 48) / 3;
    chips.forEach((c, i) => {
      const cx = px + 20 + (i % 3) * cw, cy = py + 60 + Math.floor(i / 3) * step;
      if (this.button(ctx, 'mod-' + c.id, cx, cy, cw - 8, Math.min(32, step - 4), c.label, mods[c.id] ? 'selected' : 'normal')) {
        (mods as any)[c.id] = !(mods as any)[c.id]; this.app.uiSound();
      }
    });
    const sy = py + 64 + step * 4;
    text(ctx, 'SCROLL SPEED', px + 24, sy + 6, { size: 11, color: '#95a69e', baseline: 'middle' });
    mods.speed = Math.round(this.app.ui.slider('mod-speed', px + 24, sy + 22, pw - 48, 20, mods.speed, 0.5, 2, 0.05) * 100) / 100;
    text(ctx, `x${mods.speed.toFixed(2)}`, px + pw - 24, sy + 6, { size: 12, color: '#bfd5c8', align: 'right', baseline: 'middle' });
    const policy = mods.noTail ? mods.constantSpeed ? 'No Tail + Constant Speed · 90% score · 81% pp' : 'No Tail · 90% score · 90% pp · hold to the end' : mods.constantSpeed ? 'Constant speed · 90% pp · music timing unchanged' : 'Constant speed ignores BPM and scroll changes';
    text(ctx, policy, px + 24, sy + 58, { size: 10, color: THEME.dim, maxWidth: pw - 48 });
    if (this.button(ctx, 'mods-close', px + 24, py + ph - 50, pw - 48, 34, 'DONE', 'selected')) { this.setModsVisible(false); this.app.uiSound(); }
  }

  pointerDown(x: number, y: number) {
    if (this.showMods) return;
    const popup = this.actionPopup;
    if (this.showChartActions && (!popup || x < popup.x || x > popup.x + popup.w || y < popup.y || y > popup.y + popup.h)) this.showChartActions = false;
    this.listDrag = null;
    const detail = this.detailViewport;
    this.detailDrag = !this.showChartActions && this.app.isTouch && x >= detail.x && x <= detail.x + detail.w && y >= detail.y && y <= detail.y + detail.h
      ? { y, scroll: this.detailScroll, moved: false } : null;
    const area = this.listArea();
    if (x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h) {
      this.coverIdle = 0;
      this.scrollMotion = null;
      this.searchField.blur();
      const offset = y - area.y + this.scroll;
      const row = this.visualRows.find(row => row.interactive && offset >= row.top && offset < row.top + row.visibleHeight);
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
      this.scroll = Math.max(0, Math.min(drag.scroll + drag.y - y, Math.max(0, this.visualListHeight - this.listArea().h)));
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
    if (row?.header) {
      if (!row.group.charts.includes(this.entry()!)) this.setSel(row.index);
      else {
        this.expandedGroup = this.expandedGroup === row.group.key ? null : row.group.key;
        this.rebuildRows(true); this.revealSelection();
        void this.loadExpandedBests();
      }
      this.app.uiSound();
    } else if (row) this.setSel(row.index);
    void this.app.menuMusic.ensureStarted().catch(() => {});
  }

  wheel(dy: number) {
    if (this.showMods) return;
    const area = this.listArea(), p = this.app.ui.p;
    if (p.y < area.y || p.y > area.y + area.h) return;
    if (p.x >= area.x && p.x <= area.x + area.w) {
      this.coverIdle = 0;
      this.scrollMotion = null;
      this.scroll = Math.max(0, Math.min(this.scroll + dy * 0.6, Math.max(0, this.visualListHeight - area.h)));
    } else if (p.x > area.x + area.w && p.x < this.app.w - 20 && p.y >= this.detailViewport.y && p.y <= this.detailViewport.y + this.detailViewport.h) {
      this.detailScroll = Math.max(0, this.detailScroll + dy * 0.6);
    }
  }
}
