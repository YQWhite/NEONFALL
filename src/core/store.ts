// Store: settings, chart/skin library (desktop fs bridge | IndexedDB), local profile & best scores.
import type { Settings, PlayResult, UserInfo } from './types.ts';
import { DEFAULT_SETTINGS, PLAYFIELD_SCALE_MIN, PLAYFIELD_SCALE_MAX } from './types.ts';
import { sha1Hex, bytesToBase64, base64ToBytes, deepClone } from './zip.ts';
import { readNFM, readNFSK, type NFMArchive } from './nfm.ts';
import { idbPut, idbGet, idbDel, idbKeys, idbAll } from './idb.ts';
import { computeRating, isRankedResult, resultPP } from './rating.ts';
import { repairBundledStoryboard } from './storyboard-repair.ts';

export interface DesktopBridge {
  isDesktop: boolean;
  version: string;
  appPath: string;
  listCharts(): Promise<{ id: string; name: string; size: number; mtime: number }[]>;
  readChart(id: string): Promise<string | null>;
  readBundledChart?(name: string): Promise<string | null>;
  writeChart(id: string, name: string, b64: string): Promise<void>;
  deleteChart(id: string): Promise<void>;
  listSkins(): Promise<{ id: string; name: string; size: number; mtime: number }[]>;
  readSkin(id: string): Promise<string | null>;
  writeSkin(id: string, name: string, b64: string): Promise<void>;
  deleteSkin(id: string): Promise<void>;
  pickFiles(): Promise<{ name: string; data: string }[]>;
  quit(): void;
}

export function bridge(): DesktopBridge | null {
  return (typeof window !== 'undefined' && (window as any).neonfallBridge) || null;
}

export const isDesktop = !!bridge();
export const isAndroid = typeof window !== 'undefined' &&
  (window as any).Capacitor?.getPlatform?.() === 'android' &&
  (window as any).Capacitor?.isNativePlatform?.() === true;

export interface ChartEntry {
  id: string;
  name: string;
  title: string;
  artist: string;
  creator: string;
  version: string;
  keys: number;
  stars: number;
  notes: number;
  lengthMs: number;
  size: number;
  source?: string;
  bg?: string;
  addedAt: number;
  server?: boolean; // lives on the central server (all platforms)
  fileMtime?: number;
  contentHash?: string;
  downloaded?: boolean;
}

export interface SkinEntry {
  id: string;
  name: string;
  author: string;
  keys: number;
  size: number;
  addedAt: number;
}

export interface LocalProfile {
  username: string;
  nickname: string;
  email: string;
  emailVerified: boolean;
  rating: number;
  bestPp: number;
  plays: number;
  createdAt: number;
  local: boolean;
}

const LS_SETTINGS = 'nf.settings.v1';
const LS_CHARTMETA = 'nf.chartMeta.v1';
const LS_SKINMETA = 'nf.skinMeta.v1';
const LS_PROFILE = 'nf.profile.v1';
const LS_SCORES = 'nf.scores.v1';
const LS_TOKEN = 'nf.token.v1';

function lsGet(key: string): any {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: any) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full — ignore */
  }
}

export class Store {
  settings: Settings = deepClone(DEFAULT_SETTINGS);

  constructor() {
    const s = lsGet(LS_SETTINGS);
    if (s) this.settings = { ...deepClone(DEFAULT_SETTINGS), ...s };
    this.settings.language = s?.language === 'en' ? 'en' : 'zh-CN';
    this.settings.playfieldScale = Number.isFinite(s?.playfieldScale) ? Math.max(PLAYFIELD_SCALE_MIN, Math.min(PLAYFIELD_SCALE_MAX, s.playfieldScale)) : 1.08;
    this.settings.storyboardBrightness = Number.isFinite(s?.storyboardBrightness) ? Math.max(0, Math.min(1, s.storyboardBrightness)) : 1;
    // fold device latency hint into audioOffset on first run
    if (typeof s?.audioOffsetAuto !== 'boolean') {
      this.settings.audioOffsetAuto = true;
    }
  }

  saveSettings() {
    lsSet(LS_SETTINGS, this.settings);
  }

  resetSettings() {
    this.settings = deepClone(DEFAULT_SETTINGS);
    this.saveSettings();
  }

  // ---------- charts ----------
  private chartMeta(): Record<string, ChartEntry> {
    return lsGet(LS_CHARTMETA) || {};
  }
  private saveChartMeta(m: Record<string, ChartEntry>) {
    lsSet(LS_CHARTMETA, m);
  }

  async listCharts(): Promise<ChartEntry[]> {
    const b = bridge();
    if (b) {
      const list = await b.listCharts();
      const metas = this.chartMeta();
      const out: ChartEntry[] = [];
      for (const f of list) {
        let meta = metas[f.id];
        if (!meta || !meta.title || !meta.contentHash || meta.size !== f.size || meta.fileMtime !== f.mtime) {
          // lazy parse + cache (first run, or charts seeded outside the app)
          try {
            const s = await b.readChart(f.id);
            if (s) {
              const bytes = base64ToBytes(s);
              const archive = readNFM(bytes);
              const c = archive.chart;
              meta = {
                id: f.id,
                name: f.name || `${c.meta.title} [${c.meta.version}]`,
                title: c.meta.title,
                artist: c.meta.artist,
                creator: c.meta.creator,
                version: c.meta.version,
                keys: c.keys,
                stars: c.stars ?? 0,
                notes: c.notes.length,
                lengthMs: c.meta.lengthMs,
                size: f.size,
                source: c.source?.type,
                bg: c.meta.bg,
                addedAt: f.mtime,
                fileMtime: f.mtime,
                contentHash: await sha1Hex(bytes),
              };
              metas[f.id] = meta;
            }
          } catch {
            meta = { ...(metas[f.id] || {}), id: f.id, name: f.name, size: f.size, addedAt: f.mtime } as ChartEntry;
          }
        }
        if (meta) out.push(meta);
      }
      this.saveChartMeta(metas);
      return out.sort((a, b) => b.addedAt - a.addedAt);
    }
    const metas = this.chartMeta();
    const ids = await idbKeys('charts');
    return ids
      .map((id) => metas[id])
      .filter(Boolean)
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  async getChartBytes(id: string): Promise<Uint8Array | null> {
    const b = bridge();
    if (b) {
      let s = await b.readChart(id);
      if (!s && /^[a-f0-9]{40}$/i.test(id)) {
        // Older desktop libraries use filenames. A merged server row keeps
        // its content ID but must still read the existing offline copy.
        for (const entry of Object.values(this.chartMeta())) {
          if (entry.id === id || entry.contentHash !== id) continue;
          s = await b.readChart(entry.id);
          if (s) break;
        }
      }
      return s ? base64ToBytes(s) : null;
    }
    const data = await idbGet<{ bytes: string }>('charts', id);
    return data ? base64ToBytes(data.bytes) : null;
  }

  async loadChart(id: string): Promise<NFMArchive | null> {
    const bytes = await this.getChartBytes(id);
    if (!bytes) return null;
    return this.prepareChart(readNFM(bytes));
  }

  /** Repair known legacy storyboard data for playback without rewriting the library. */
  async prepareChart(archive: NFMArchive): Promise<NFMArchive> {
    const b = bridge();
    if (!b?.readBundledChart) return archive;
    return repairBundledStoryboard(archive, async name => {
      const bytes = await b.readBundledChart!(name);
      return bytes ? readNFM(base64ToBytes(bytes)) : null;
    });
  }

  async putChart(bytes: Uint8Array, name: string): Promise<{ id: string; entry: ChartEntry }> {
    const id = await sha1Hex(bytes);
    const b = bridge();
    if (b) {
      await b.writeChart(id, name, bytesToBase64(bytes));
    } else {
      await idbPut('charts', id, { bytes: bytesToBase64(bytes), name });
    }
    const archive = await readNFM(bytes);
    const c = archive.chart;
    const entry: ChartEntry = {
      id,
      name,
      title: c.meta.title,
      artist: c.meta.artist,
      creator: c.meta.creator,
      version: c.meta.version,
      keys: c.keys,
      stars: c.stars ?? 0,
      notes: c.notes.length,
      lengthMs: c.meta.lengthMs,
      size: bytes.length,
      source: c.source?.type,
      bg: c.meta.bg,
      addedAt: Date.now(),
      contentHash: id,
    };
    const metas = this.chartMeta();
    metas[id] = entry;
    this.saveChartMeta(metas);
    return { id, entry };
  }

  async deleteChart(id: string) {
    const b = bridge();
    if (b) await b.deleteChart(id);
    else await idbDel('charts', id);
    const metas = this.chartMeta();
    delete metas[id];
    this.saveChartMeta(metas);
  }

  // ---------- skins ----------
  private skinMeta(): Record<string, SkinEntry> {
    return lsGet(LS_SKINMETA) || {};
  }
  private saveSkinMeta(m: Record<string, SkinEntry>) {
    lsSet(LS_SKINMETA, m);
  }

  async listSkins(): Promise<SkinEntry[]> {
    const b = bridge();
    if (b) {
      const list = await b.listSkins();
      return list.map((f) => ({
        id: f.id,
        name: f.name,
        author: '',
        keys: 0,
        size: f.size,
        addedAt: f.mtime,
      }));
    }
    const metas = this.skinMeta();
    const ids = await idbKeys('skins');
    return ids
      .map((id) => metas[id])
      .filter(Boolean)
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  async getSkinBytes(id: string): Promise<Uint8Array | null> {
    const b = bridge();
    if (b) {
      const s = await b.readSkin(id);
      return s ? base64ToBytes(s) : null;
    }
    const data = await idbGet<{ bytes: string }>('skins', id);
    return data ? base64ToBytes(data.bytes) : null;
  }

  async putSkin(bytes: Uint8Array, name: string): Promise<{ id: string; entry: SkinEntry }> {
    const id = await sha1Hex(bytes);
    const b = bridge();
    if (b) await b.writeSkin(id, name, bytesToBase64(bytes));
    else await idbPut('skins', id, { bytes: bytesToBase64(bytes), name });
    let entry: SkinEntry = { id, name, author: '', keys: 0, size: bytes.length, addedAt: Date.now() };
    try {
      const { skin } = readNFSK(bytes);
      entry = { ...entry, name: skin.name, author: skin.author || '', keys: skin.keys };
    } catch {
      /* keep defaults */
    }
    const metas = this.skinMeta();
    metas[id] = entry;
    this.saveSkinMeta(metas);
    return { id, entry };
  }

  async deleteSkin(id: string) {
    const b = bridge();
    if (b) await b.deleteSkin(id);
    else await idbDel('skins', id);
    const metas = this.skinMeta();
    delete metas[id];
    this.saveSkinMeta(metas);
  }

  // ---------- profile (local / offline) ----------
  getProfile(): LocalProfile | null {
    const profile = lsGet(LS_PROFILE) as LocalProfile | null;
    if (profile) {
      const pp = this.ratingValues(this.getBestScores());
      profile.rating = computeRating(pp);
      profile.bestPp = pp.reduce((best, value) => Math.max(best, value), 0);
    }
    return profile;
  }

  createLocalProfile(username: string, nickname: string, email: string): LocalProfile {
    const p: LocalProfile = {
      username,
      nickname,
      email,
      emailVerified: false,
      rating: 0,
      bestPp: 0,
      plays: 0,
      createdAt: Date.now(),
      local: true,
    };
    lsSet(LS_PROFILE, p);
    return p;
  }

  saveLocalProfile(p: LocalProfile) {
    lsSet(LS_PROFILE, p);
  }

  // ---------- best scores & local rating ----------
  rememberChartHash(id: string, hash: string) {
    if (!/^[a-f0-9]{40}$/i.test(hash)) return;
    const aliases = lsGet('nf.chart-aliases.v1') || {};
    aliases[id] = hash;
    lsSet('nf.chart-aliases.v1', aliases);
  }

  private ratingValues(scores: Record<string, PlayResult>): number[] {
    const metas = this.chartMeta(), aliases = lsGet('nf.chart-aliases.v1') || {}, best = new Map<string, number>();
    for (const result of Object.values(scores)) {
      const key = metas[result.chartId]?.contentHash || aliases[result.chartId] || result.chartId;
      best.set(key, Math.max(best.get(key) || 0, resultPP(result)));
    }
    return [...best.values()];
  }

  getBestScores(): Record<string, PlayResult> {
    const scores: Record<string, PlayResult> = lsGet(LS_SCORES) || {};
    for (const result of Object.values(scores)) {
      // Legacy/incomplete records remain readable without inventing fields.
      if (Number.isFinite(result.durationMs) && typeof result.passed === 'boolean' && Array.isArray(result.mods)) result.pp = resultPP(result);
    }
    return scores;
  }

  getBest(chartId: string): PlayResult | undefined {
    return this.getBestScores()[chartId];
  }

  submitLocalScore(result: PlayResult): { rating: number; improved: boolean } {
    result.pp = resultPP(result);
    const scores = this.getBestScores();
    const prev = scores[result.chartId];
    let improved = false;
    const ranked = isRankedResult(result), prevRanked = prev && isRankedResult(prev);
    if (!prev || ranked && !prevRanked || ranked === !!prevRanked && (result.pp > prev.pp || result.pp === prev.pp && (result.acc > prev.acc || result.acc === prev.acc && result.score > prev.score))) {
      scores[result.chartId] = result;
      improved = true;
      lsSet(LS_SCORES, scores);
    }
    const ppList = this.ratingValues(scores);
    const rating = computeRating(ppList);
    const p = this.getProfile();
    if (p) {
      p.rating = rating;
      p.bestPp = ppList.length ? Math.max(...ppList) : 0;
      p.plays = (p.plays || 0) + 1;
      this.saveLocalProfile(p);
    }
    return { rating, improved };
  }

  // ---------- server token ----------
  getToken(): string {
    return (localStorage.getItem(LS_TOKEN) || '').replace(/^"|"$/g, '');
  }
  setToken(t: string) {
    if (t) localStorage.setItem(LS_TOKEN, JSON.stringify(t));
    else localStorage.removeItem(LS_TOKEN);
  }
}

export { idbAll };
