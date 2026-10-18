// Zip helpers built on fflate — one code path for Web / Electron / Android / Node.
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { sha1Fallback } from './sha1.ts';
export type ByteMap = Map<string, Uint8Array>;
export function unzipToMap(data: Uint8Array, paths?: ReadonlySet<string>): ByteMap {
  const files = unzipSync(data, paths ? { filter: file => paths.has(normPath(file.name).toLowerCase()) } : undefined);
  const map: ByteMap = new Map();
  for (const key of Object.keys(files)) map.set(normPath(key), files[key]);
  return map;
}
export function zipFromMap(files: Record<string, Uint8Array>, opts?: { level?: number | Record<string, number> }): Uint8Array {
  const level: Record<string, number> = {};
  if (opts?.level) {
    if (typeof opts.level === 'number') for (const k of Object.keys(files)) level[k] = opts.level;
    else Object.assign(level, opts.level);
  }
  return zipSync(files, { level: level as any });
}
export function normPath(p: string): string { return p.replace(/\\/g, '/'); }
export function findCI(map: ByteMap, path: string): Uint8Array | undefined {
  const want = normPath(path).toLowerCase();
  const direct = map.get(normPath(path));
  if (direct) return direct;
  for (const [k, v] of map) if (normPath(k).toLowerCase() === want) return v;
  return undefined;
}
export interface AssetLookupOptions {
  /** Prefer 2x assets when available. Default keeps 1x, with 2x fallback. */
  prefer2x?: boolean;
  extensions?: string[];
}
/** Full-path, case-insensitive lookup; supports extensionless names and @2x fallback. */
export function findBaseCI(map: ByteMap, basePath: string, opts: AssetLookupOptions = {}): { path: string; data: Uint8Array; density: number } | undefined {
  const requested = normPath(basePath).toLowerCase();
  const extension = /\.([a-z0-9]+)$/.exec(requested)?.[1];
  const base = extension ? requested.slice(0, -(extension.length + 1)) : requested;
  const explicit2x = /@2x$/.test(base);
  const logicalBase = base.replace(/@2x$/, '');
  const allowed = opts.extensions?.map((ext) => ext.toLowerCase().replace(/^\./, ''));
  const candidates: { path: string; data: Uint8Array; density: number; rank: number }[] = [];
  for (const [path, data] of map) {
    const normalized = normPath(path).toLowerCase();
    const ext = /\.([a-z0-9]+)$/.exec(normalized)?.[1];
    if (extension && ext !== extension) continue;
    if (allowed && (!ext || !allowed.includes(ext))) continue;
    const stem = ext ? normalized.slice(0, -(ext.length + 1)) : normalized;
    const density = /@2x$/.test(stem) ? 2 : 1;
    if (stem.replace(/@2x$/, '') !== logicalBase) continue;
    const preferredDensity = explicit2x || opts.prefer2x ? 2 : 1;
    const extRank = allowed && ext ? allowed.indexOf(ext) : 0;
    candidates.push({ path, data, density, rank: (density === preferredDensity ? 0 : 100) + extRank });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.path.toLowerCase().localeCompare(b.path.toLowerCase()) || a.path.localeCompare(b.path));
  const best = candidates[0];
  return best ? { path: best.path, data: best.data, density: best.density } : undefined;
}
export function strToBytes(s: string): Uint8Array { return strToU8(s); }
export function bytesToStr(b: Uint8Array): string { return strFromU8(b); }
export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < b.length; i += chunk) s += String.fromCharCode(...b.subarray(i, i + chunk));
  return btoa(s);
}
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToBlob(b: Uint8Array, mime = 'application/octet-stream'): Blob { return new Blob([b as BlobPart], { type: mime }); }
export function bytesToBlobUrl(b: Uint8Array, mime?: string): string { return URL.createObjectURL(bytesToBlob(b, mime ?? guessMime(b))); }
export function guessMime(b: Uint8Array): string {
  if (b.length > 8) {
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
    if (b[0] === 0x4f && b[1] === 0x67) return 'audio/ogg';
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video/mp4';
    const tag = String.fromCharCode(...b.subarray(0, 4));
    if (tag === 'RIFF') return 'audio/wav';
    if (tag === 'OggS') return 'audio/ogg';
    if (tag === 'fLaC') return 'audio/flac';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  }
  return 'application/octet-stream';
}
export function extOf(name: string): string { const m = /\.([A-Za-z0-9]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
export function sanitizeFileName(name: string): string { return (name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120); }
export async function sha1Hex(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) return sha1Fallback(data);
  const buf = await crypto.subtle.digest('SHA-1', data as BufferSource);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function deepClone<T>(o: T): T { return JSON.parse(JSON.stringify(o)); }
export function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}
export function easeVal(ease: number, p: number): number {
  p = clamp(p, 0, 1);
  switch (ease) {
    case 0: return 0;
    case 1: return p;
    case 2: return p * p;
    case 3: return p * (2 - p);
    case 4: return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    case 5: return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    case 6: return p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2;
    case 7: return p < 0.5 ? 16 * p * p * p * p * p : 1 - Math.pow(-2 * p + 2, 5) / 2;
    case 8: return 1 - Math.sin((1 - p) * Math.PI / 2);
    case 9: return Math.sin(p * Math.PI / 2);
    case 10: return 1 - Math.cos(p * Math.PI / 2);
    case 11: return 1 - Math.pow(1 - p, 3);
    case 12: return p * p * p;
    case 13: return 1 - Math.pow(1 - p, 4);
    case 14: return p * p * p * p;
    case 15: return 1 - Math.pow(1 - p, 5);
    case 16: return p * p * p * p * p;
    case 17: return p;
    default: return p;
  }
}
