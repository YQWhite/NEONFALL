import type { Store } from './store.ts';
import { sha1Hex } from './zip.ts';

const MARKER = 'nf.android-bundled.v1';

/** Install packaged examples only into a new Android library; never replace user files. */
export async function installAndroidExamples(store: Pick<Store, 'listCharts' | 'putChart'>): Promise<void> {
  if (localStorage.getItem(MARKER) === 'done') return;
  const installing = localStorage.getItem(MARKER) === 'installing';
  const existing = await store.listCharts();
  if (!installing && existing.length) { localStorage.setItem(MARKER, 'done'); return; }
  const response = await fetch('./bundled-charts/manifest.json');
  if (!response.ok) throw new Error('Bundled chart manifest unavailable');
  const manifest: { name: string; file: string; sha1: string }[] = await response.json();
  if (!Array.isArray(manifest)) throw new Error('Invalid bundled chart manifest');
  localStorage.setItem(MARKER, 'installing');
  const installed = new Set(existing.map(entry => entry.id));
  for (const entry of manifest) {
    if (!/^[a-z0-9-]+\.nfm$/i.test(entry.file) || !/^[a-f0-9]{40}$/.test(entry.sha1)) throw new Error('Invalid bundled chart entry');
    if (installed.has(entry.sha1)) continue;
    const data = await fetch('./bundled-charts/' + entry.file);
    if (!data.ok) throw new Error('Bundled chart unavailable');
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (await sha1Hex(bytes) !== entry.sha1) throw new Error('Bundled chart checksum mismatch');
    await store.putChart(bytes, entry.name);
  }
  localStorage.setItem(MARKER, 'done');
}
