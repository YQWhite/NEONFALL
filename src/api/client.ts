// Central chart-server API client (web mode) — accounts, scores, chart repository.
import type { PlayResult, UserInfo, LeaderboardEntry } from '../core/types.ts';
import type { ChartEntry } from '../core/store.ts';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

interface ChartCache {
  getChartBytes(id: string): Promise<Uint8Array | null>;
  putChart(bytes: Uint8Array, name: string): Promise<unknown>;
  deleteChart(id: string): Promise<unknown>;
}

export function normalizeServerUrl(value: string): string {
  const input = value.trim().replace(/\/+$/, '');
  if (!input) return '';
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS server address without credentials, query or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export class ServerApi {
  base: string;
  private token: string;
  online = false;
  private downloads = new Map<string, Promise<Uint8Array>>();
  private chartBytes = new Map<string, Uint8Array>();
  private chartNames = new Map<string, string>();
  private cacheSize = 0;
  emailVerification = false;
  uploadsEnabled = true;
  avatarsEnabled = false;
  ratingVersion = 0;

  constructor(base = '', private cache?: ChartCache, private timeoutMs = 15000) {
    this.base = normalizeServerUrl(base);
    this.token = '';
  }

  setToken(t: string) {
    this.token = t;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: 'Bearer ' + this.token } : {};
  }

  private async request<T>(path: string, opts: RequestInit, consume: (res: Response) => Promise<T>, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(opts.signal?.reason);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener('abort', abort, { once: true });
    try {
      const headers = new Headers(opts.headers);
      for (const [name, value] of Object.entries(this.authHeaders())) headers.set(name, value);
      const res = await fetch(this.base + path, { ...opts, headers, signal: controller.signal, credentials: 'omit' });
      if (!res.ok) {
        let message = 'HTTP ' + res.status;
        try { const body = await res.json(); if (typeof body.error === 'string') message = body.error; } catch { /* keep status */ }
        throw new ApiError(message, res.status);
      }
      const value = await consume(res);
      this.online = true;
      return value;
    } catch (error) {
      if (!(error instanceof ApiError)) this.online = false;
      if (timedOut) throw new Error('Server request timed out. Check the connection and retry.');
      throw error;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
    }
  }

  async req(path: string, opts: RequestInit = {}, raw = false): Promise<any> {
    return this.request(path, opts, async res => {
      if (raw) return res;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('The address did not return a NEONFALL API response.');
      return res.json();
    });
  }

  async ping(): Promise<boolean> {
    try {
      const body = await this.request('/api/ping', { method: 'GET' }, res => res.json(), Math.min(this.timeoutMs, 5000));
      const ok = body?.ok === true && body?.name === 'neonfall-server';
      this.emailVerification = body?.emailVerification === true;
      this.uploadsEnabled = body?.uploadPolicy !== 'disabled';
      this.avatarsEnabled = body?.avatars === true;
      this.ratingVersion = ok && Number.isInteger(body?.ratingVersion) && body.ratingVersion >= 0 ? body.ratingVersion : 0;
      this.online = ok;
      return ok;
    } catch {
      this.online = false;
      this.ratingVersion = 0;
      return false;
    }
  }

  // ---------- charts ----------
  private downloadPath(id: string): string {
    const path = '/api/charts/' + encodeURIComponent(id);
    // Older servers did not send Vary: Origin on same-origin downloads. Separate
    // the URL cache key by client origin so existing proxy cache entries cannot
    // strip CORS from Windows, Android or a separately hosted web client.
    const origin = typeof location === 'undefined' ? '' : location.origin;
    return this.base && origin && new URL(this.base).origin !== origin
      ? path + '?nf_origin=' + encodeURIComponent(origin) : path;
  }

  async listCharts(): Promise<ChartEntry[]> {
    const entries = await this.req('/api/charts');
    if (!Array.isArray(entries)) throw new Error('Invalid chart library response.');
    return entries.map((entry: ChartEntry) => {
      this.chartNames.set(entry.id, entry.name);
      return { ...entry, server: true };
    });
  }

  async downloadChart(id: string): Promise<Uint8Array> {
    const existing = this.downloads.get(id);
    if (existing) return existing;
    const bytes = this.chartBytes.get(id);
    if (bytes) { this.chartBytes.delete(id); this.chartBytes.set(id, bytes); return bytes; }
    const pending = (async () => {
      const cached = await this.cache?.getChartBytes(id).catch(() => null);
      const data = cached ?? await this.request(this.downloadPath(id), {}, async res => new Uint8Array(await res.arrayBuffer()), Math.max(this.timeoutMs, 120000));
      if (!cached && this.cache) await this.cache.putChart(data, this.chartNames.get(id) || id + '.nfm').catch(() => {});
      if (data.byteLength <= 64 * 1024 * 1024) {
        while (this.cacheSize + data.byteLength > 64 * 1024 * 1024 && this.chartBytes.size) {
          const oldest = this.chartBytes.keys().next().value!;
          this.cacheSize -= this.chartBytes.get(oldest)!.byteLength; this.chartBytes.delete(oldest);
        }
        this.chartBytes.set(id, data); this.cacheSize += data.byteLength;
      }
      return data;
    })();
    this.downloads.set(id, pending);
    try { return await pending; } finally { this.downloads.delete(id); }
  }

  async uploadChart(bytes: Uint8Array, name: string): Promise<ChartEntry> {
    const res = await this.request(
      '/api/charts/upload?name=' + encodeURIComponent(name),
      { method: 'POST', body: bytes as unknown as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } },
      response => response.json(),
      Math.max(this.timeoutMs, 120000),
    );
    return { ...res.entry, server: true } as ChartEntry;
  }

  async deleteChartServer(id: string): Promise<void> {
    await this.req('/api/charts/' + encodeURIComponent(id), { method: 'DELETE' });
    const bytes = this.chartBytes.get(id);
    if (bytes) this.cacheSize -= bytes.byteLength;
    this.chartBytes.delete(id);
    // Deleting a remote entry must not remove a player's offline download.
  }

  // ---------- accounts ----------
  async register(username: string, nickname: string, password: string, email: string): Promise<{ token: string; user: UserInfo }> {
    const j = await this.req('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, nickname, password, email }),
    });
    this.token = j.token;
    return j;
  }

  async login(username: string, password: string): Promise<{ token: string; user: UserInfo }> {
    const j = await this.req('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    this.token = j.token;
    return j;
  }

  async me(): Promise<UserInfo> {
    return (await this.req('/api/me')) as UserInfo;
  }

  async uploadAvatar(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<UserInfo> {
    return this.req('/api/me/avatar', { method: 'PUT', body: bytes as unknown as BodyInit, headers: { 'Content-Type': mime }, signal });
  }

  async removeAvatar(): Promise<UserInfo> {
    return this.req('/api/me/avatar', { method: 'DELETE' });
  }

  avatarUrl(user: { avatar?: string }): string {
    const path = user.avatar || '';
    // The server owns this namespace; never let profile data supply an arbitrary
    // remote URL, executable scheme or authentication-bearing address.
    return /^\/api\/avatars\/[a-z0-9_]{3,16}\/[a-f0-9]{64}\.(png|jpg|webp)$/i.test(path) ? this.base + path : '';
  }

  async logout(): Promise<void> {
    const previous = this.token;
    await this.req('/api/logout', { method: 'POST' });
    if (this.token === previous) this.token = '';
  }

  async requestVerification(): Promise<{ ok: boolean; note: string }> {
    return (await this.req('/api/verify-email/send', { method: 'POST' })) as { ok: boolean; note: string };
  }

  async verifyEmail(code: string): Promise<{ ok: boolean; note: string }> {
    return (await this.req('/api/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })) as { ok: boolean; note: string };
  }

  // ---------- scores ----------
  async submitScore(play: PlayResult): Promise<{ ok: boolean; rating: number; rank?: number; ranked?: boolean }> {
    if (play.mods.some(mod => /^constantspeed$/i.test(mod)) && this.ratingVersion < 3) {
      const token = this.token, base = this.base;
      // Older servers silently recompute unknown mods at full pp. Keep this
      // score local until the host advertises the matching conversion policy.
      const online = await this.ping();
      if (this.token !== token || this.base !== base) throw new Error('Score submission cancelled because the connection changed.');
      if (!online) throw new Error('Could not check the server rating version.');
      if (this.ratingVersion < 3) throw new ApiError('Server update required for Constant Speed scores.', 426);
    }
    return (await this.req('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(play),
    })) as { ok: boolean; rating: number; rank?: number; ranked?: boolean };
  }

  async scores(chartId: string, keys: number): Promise<LeaderboardEntry[]> {
    return (await this.req(`/api/scores?chart=${encodeURIComponent(chartId)}&keys=${keys}`)) as LeaderboardEntry[];
  }

  async myScores(): Promise<PlayResult[]> {
    return (await this.req('/api/scores/mine')) as PlayResult[];
  }

  async leaderboard(): Promise<{ username: string; nickname: string; rating: number; bestPp: number }[]> {
    return (await this.req('/api/leaderboard')) as { username: string; nickname: string; rating: number; bestPp: number }[];
  }
}
