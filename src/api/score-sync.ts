import type { App } from '../ui/app.ts';
import type { PlayResult, UserInfo } from '../core/types.ts';
import { isRankedResult } from '../core/rating.ts';
import { ApiError } from './client.ts';
import { sha1Hex } from '../core/zip.ts';

const STORAGE_KEY = 'nf.score-sync.v1';
type SyncState = 'pending' | 'synced' | 'missing-chart' | 'update-required' | 'rejected';
export interface ScoreSyncStatus {
  state: SyncState;
  rating?: number;
  rank?: number;
}
interface PendingScore {
  server: string;
  username: string;
  result: PlayResult;
  rejected?: boolean;
  missingChart?: boolean;
  updateRequired?: boolean;
  serverChartId?: string;
}
interface SavedSync {
  users: Record<string, UserInfo>;
  pending: PendingScore[];
}
const playKey = (result: PlayResult) => [result.chartId, result.keys, result.playedAt, result.score, result.acc].join(':');

/** Event-triggered score synchronization; credentials remain in the existing token store. */
export class ScoreSync {
  private saved: SavedSync = { users: {}, pending: [] };
  private statuses = new Map<string, ScoreSyncStatus>();
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private sending = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private wake = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void this.sync(); };

  constructor(private app: App) {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (value?.users && typeof value.users === 'object' && !Array.isArray(value.users) && Array.isArray(value.pending)) {
        this.saved.users = value.users;
        this.saved.pending = value.pending.filter((item: PendingScore) => item && typeof item.server === 'string' && typeof item.username === 'string' && item.result && typeof item.result.chartId === 'string' && isRankedResult(item.result));
      }
    } catch { /* New installation or unavailable browser storage. */ }
  }

  private get serverKey(): string {
    return this.app.server.base || (typeof location !== 'undefined' ? location.origin : 'same-origin');
  }

  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.saved)); }
    catch { this.app.toast('自动同步队列保存失败，请检查设备存储空间。'); }
  }

  remember(user: UserInfo) {
    this.saved.users[this.serverKey] = { ...user };
    this.save();
  }

  /** Called once at boot, after initial account restoration. */
  start() {
    if (this.started) return;
    this.started = true;
    this.restoreCachedAccount();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.wake);
      window.addEventListener('focus', this.wake);
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.wake);
    this.timer = setInterval(this.wake, 20000);
    void this.sync();
  }

  stop() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined; this.started = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.wake);
      window.removeEventListener('focus', this.wake);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.wake);
  }

  restoreCachedAccount() {
    if (this.app.settings.serverDisconnected) return;
    if (!this.app.store.getToken()) return;
    if (this.app.account.server && this.app.account.user) this.remember(this.app.account.user);
    else {
      const user = this.saved.users[this.serverKey];
      if (user) this.app.account = { server: true, user: { ...user } };
    }
  }

  signedIn(user: UserInfo) {
    this.app.serverOnline = true;
    this.app.account = { server: true, user };
    this.remember(user);
    if (this.inFlight) this.rerun = true;
    else void this.sync();
  }

  get pendingCount(): number {
    const username = this.app.account.server ? this.app.account.user?.username.toLowerCase() : undefined;
    return this.saved.pending.filter(item => item.server === this.serverKey && item.username === username && !item.rejected).length;
  }

  status(result: PlayResult): ScoreSyncStatus | undefined {
    const status = this.statuses.get(playKey(result));
    if (status) return status;
    const username = this.app.account.server ? this.app.account.user?.username.toLowerCase() : undefined;
    const pending = this.saved.pending.find(item => item.server === this.serverKey && item.username === username && playKey(item.result) === playKey(result));
    return pending ? { state: pending.rejected ? 'rejected' : pending.updateRequired ? 'update-required' : pending.missingChart ? 'missing-chart' : 'pending' } : undefined;
  }

  /** Save locally before returning, then send without blocking the result screen. */
  submit(result: PlayResult): { rating: number; ratingBefore: number } {
    this.restoreCachedAccount();
    const ratingBefore = this.app.account.user?.rating ?? 0;
    const local = this.app.store.submitLocalScore(result);
    if (!this.app.store.getToken() || !this.app.account.server || !this.app.account.user) {
      this.app.account = { server: false, user: this.app.store.getProfile() };
      return { rating: local.rating, ratingBefore };
    }
    const user = this.app.account.user, server = this.serverKey, username = user.username.toLowerCase();
    if (isRankedResult(result)) {
      const previous = this.saved.pending.find(item => item.server === server && item.username === username && item.result.chartId === result.chartId && item.result.keys === result.keys);
      // Keep only the best unsent result per chart. Replaying never adds another rating slot.
      if (!previous || result.pp > previous.result.pp || result.pp === previous.result.pp && (result.acc > previous.result.acc || result.acc === previous.result.acc && result.score >= previous.result.score)) {
        if (previous) this.saved.pending.splice(this.saved.pending.indexOf(previous), 1);
        this.saved.pending.push({ server, username, result: { ...result, counts: { ...result.counts }, mods: [...result.mods] } });
        this.statuses.set(playKey(result), { state: 'pending' });
        this.save();
      }
      // The play screen changes to results in this same turn before synchronization starts.
      void Promise.resolve().then(() => {
        if (this.inFlight) { if (this.sending) this.rerun = true; }
        else void this.sync();
      });
    }
    return { rating: user.rating || 0, ratingBefore };
  }

  sync(): Promise<void> {
    if (this.app.settings.serverDisconnected) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    // Periodic retries never compete with active gameplay for CPU/network resources.
    if (this.app.screen?.name === 'play') return Promise.resolve();
    this.inFlight = this.flush().finally(() => {
      this.inFlight = null; this.sending = false;
      if (this.rerun) { this.rerun = false; void this.sync(); }
    });
    return this.inFlight;
  }

  private async flush() {
    if (this.app.settings.serverDisconnected) return;
    const api = this.app.server, server = this.serverKey, token = this.app.store.getToken();
    if (!this.app.centralLibrary && !this.app.settings.serverUrl && !token) return;
    if (!token) {
      const online = await api.ping();
      if (this.app.server === api && !this.app.settings.serverDisconnected) this.app.serverOnline = online;
      return;
    }
    api.setToken(token);
    const sameConnection = () => !this.app.settings.serverDisconnected && this.app.server === api && this.serverKey === server && this.app.store.getToken() === token;
    try {
      const user = await api.me();
      if (!sameConnection()) return;
      const username = user.username.toLowerCase();
      const sameAccount = () => sameConnection() && this.app.account.server && this.app.account.user?.username.toLowerCase() === username;
      this.app.serverOnline = true;
      this.app.account = { server: true, user };
      this.remember(user);
      const pending = this.saved.pending.filter(item => item.server === server && item.username === username && !item.rejected);
      this.sending = true;
      // Avoid repeatedly POSTing missing charts and consuming the score quota.
      // Polling the catalogue also notices when an upload from another device arrives.
      const available = pending.some(item => item.missingChart) ? new Set((await api.listCharts()).map(entry => entry.id)) : undefined;
      let uploaded = false;
      for (const item of pending) {
        if (!sameAccount()) return;
        // Desktop seed/legacy libraries use filenames as IDs. The API always
        // addresses NFM packages by their content hash; retain the local ID for
        // best scores, retries and result-screen status.
        if (!item.serverChartId && !/^[a-f0-9]{40}$/i.test(item.result.chartId)) {
          const bytes = await this.app.store.getChartBytes(item.result.chartId).catch(() => null);
          if (!sameAccount()) return;
          if (bytes) {
            item.serverChartId = await sha1Hex(bytes);
            if (!sameAccount()) return;
            this.app.store.rememberChartHash(item.result.chartId, item.serverChartId);
            this.save();
          }
        }
        const serverChartId = item.serverChartId || item.result.chartId;
        if (item.missingChart && !available?.has(serverChartId)) continue;
        try {
          const response = await api.submitScore({ ...item.result, chartId: serverChartId });
          if (!sameAccount()) return;
          if (!response.ok) throw new Error('Score was not acknowledged.');
          this.saved.pending = this.saved.pending.filter(candidate => candidate !== item);
          this.statuses.set(playKey(item.result), { state: 'synced', rating: response.rating, rank: response.rank });
          this.app.account.user!.rating = response.rating;
          this.remember(this.app.account.user!);
          uploaded = true;
        } catch (error) {
          if (!sameAccount()) return;
          if (error instanceof ApiError && error.status === 426) {
            item.updateRequired = true;
            this.statuses.set(playKey(item.result), { state: 'update-required' });
            this.save();
            continue;
          }
          if (error instanceof ApiError && error.status === 404) {
            // Score sync does not publish a player's private chart/audio files.
            item.missingChart = true;
            item.updateRequired = false;
            this.statuses.set(playKey(item.result), { state: 'missing-chart' });
            this.save();
            continue;
          }
          if (error instanceof ApiError && [400, 403, 422].includes(error.status)) {
            item.rejected = true;
            item.updateRequired = false;
            this.statuses.set(playKey(item.result), { state: 'rejected' });
            this.save();
            continue;
          }
          throw error;
        }
      }
      if (uploaded && sameAccount()) {
        const refreshed = await api.me();
        if (sameAccount()) { this.app.account = { server: true, user: refreshed }; this.remember(refreshed); }
      }
    } catch (error) {
      if (!sameConnection()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.app.store.setToken(''); api.setToken('');
        this.app.account = { server: false, user: this.app.store.getProfile() };
      } else if (!(error instanceof ApiError)) this.app.serverOnline = false;
      // Keep the account and queue during an outage; online/focus/poll will retry.
    }
  }
}

const instances = new WeakMap<App, ScoreSync>();
export function scoreSync(app: App): ScoreSync {
  let sync = instances.get(app);
  if (!sync) { sync = new ScoreSync(app); instances.set(app, sync); }
  return sync;
}
