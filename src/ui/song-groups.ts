import type { ChartEntry } from '../core/store.ts';

export interface SongGroup { key: string; charts: ChartEntry[]; }
export type SongSort = 'recent' | 'title' | 'artist' | 'stars' | 'keys';

/** A difficulty/version and its mapper do not identify a different recording. */
export function songKey(entry: ChartEntry | null): string {
  if (!entry) return '';
  const normalize = (value = '') => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const title = normalize(entry.title), artist = normalize(entry.artist);
  return title ? JSON.stringify([artist, title]) : `${!!entry.server}:${entry.id}`;
}

export function groupSongs(entries: ChartEntry[], sort: SongSort = 'title'): SongGroup[] {
  const groups = new Map<string, SongGroup>();
  for (const entry of entries) {
    const key = songKey(entry);
    let group = groups.get(key);
    if (!group) { group = { key, charts: [] }; groups.set(key, group); }
    group.charts.push(entry);
  }
  for (const group of groups.values()) group.charts.sort((a, b) =>
    (a.stars || 0) - (b.stars || 0) || a.keys - b.keys || a.version.localeCompare(b.version) || a.id.localeCompare(b.id));
  return [...groups.values()].sort((a, b) => {
    const firstA = a.charts[0], firstB = b.charts[0];
    let order = 0;
    switch (sort) {
      case 'recent': order = Math.max(...b.charts.map(c => c.addedAt)) - Math.max(...a.charts.map(c => c.addedAt)); break;
      case 'artist': order = firstA.artist.localeCompare(firstB.artist); break;
      case 'stars': order = b.charts.at(-1)!.stars - a.charts.at(-1)!.stars; break;
      case 'keys': order = Math.min(...a.charts.map(c => c.keys)) - Math.min(...b.charts.map(c => c.keys)); break;
    }
    return order || firstA.title.localeCompare(firstB.title) || a.key.localeCompare(b.key);
  });
}
