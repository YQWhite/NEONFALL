// Recover an exactly identified legacy conversion from a verified bundled chart.
// Never infer lane positions: an absent MX is also valid storyboard syntax.
import type { NFMArchive } from './nfm.ts';
import type { NFChart, NFStoryboard } from './types.ts';
import { findCI, strToBytes } from './zip.ts';

const repairs = [{
  // Historical converter dropped constant shorthand commands, including 2485 MXs.
  objects: 2765, commands: 7282,
  before: '60f82fb0217b5d5601b244bc7fbcf7ba8ca469acd4bfd7cc8829468a36ea293a',
  after: '8261992a8b10b7804bf1ab67af520552feb534bd0c7b3b914028e8878fa1e7f5',
  bundled: 'もぺもぺ [-_Suic!de.-.].nfm',
}];

async function fingerprint(storyboard: NFStoryboard): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', strToBytes(JSON.stringify(storyboard)) as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function identity(chart: NFChart): string {
  // Scores, package IDs and historical star ratings remain attached to the old
  // package. Gameplay, source difficulty and resources must match exactly.
  // Preview provenance was added after the legacy package was released. It
  // describes menu highlighting, not the identity of this playable difficulty.
  const { previewSource: _previewSource, ...meta } = chart.meta;
  return JSON.stringify([chart.format, chart.version, chart.source, meta,
    chart.keys, chart.od, chart.hp, chart.offset, chart.timing, chart.sv,
    chart.breaks, chart.notes, chart.skin]);
}

export async function repairBundledStoryboard(
  archive: NFMArchive,
  loadBundled: (name: string) => Promise<NFMArchive | null>,
): Promise<NFMArchive> {
  const sb = archive.chart.storyboard;
  if (archive.chart.source?.type !== 'osz' || !sb) return archive;
  const commands = sb.objects.reduce((sum, object) => sum + object.cmds.length, 0);
  const candidates = repairs.filter(repair => repair.objects === sb.objects.length && repair.commands === commands);
  if (!candidates.length) return archive;
  try {
    const before = await fingerprint(sb);
    const repair = candidates.find(candidate => candidate.before === before);
    if (!repair) return archive;
    const reference = await loadBundled(repair.bundled);
    const restored = reference?.chart.storyboard;
    if (!reference || !restored || identity(archive.chart) !== identity(reference.chart)
      || await fingerprint(restored) !== repair.after) return archive;
    // Reuse only identical assets already in the old package. No new files are
    // injected, and a modified or incomplete package is left untouched.
    const paths = new Set([archive.chart.meta.audio, ...restored.objects.map(object => object.path)]);
    for (const path of paths) {
      const existing = findCI(archive.files, path), expected = findCI(reference.files, path);
      if (!existing || !expected || existing.length !== expected.length
        || !existing.every((byte, index) => byte === expected[index])) return archive;
    }
    return { ...archive, chart: { ...archive.chart, storyboard: structuredClone(restored) } };
  } catch {
    // Missing optional bundle/bridge must not stop playback of other charts.
    return archive;
  }
}
