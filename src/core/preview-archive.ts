// Menu media extraction deliberately skips video/storyboard assets. The full
// archive remains a gameplay concern; fflate offloads large compressed entries.
import { unzip } from 'fflate';
import { parseNFMFiles, type NFMArchive } from './nfm.ts';
import { findCI, normPath } from './zip.ts';

const previews = new WeakMap<Uint8Array, Promise<NFMArchive>>();
const metadata = new WeakMap<Uint8Array, Promise<NFMArchive>>();
const covers = new WeakMap<Uint8Array, Map<string, Promise<Uint8Array | undefined>>>();

async function extract(data: Uint8Array, names: string[]): Promise<Map<string, Uint8Array>> {
  const paths = new Set(names.map(name => normPath(name).toLowerCase()));
  // Do not chain decompression into the same task that just painted navigation.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  return new Promise((resolve, reject) => {
    unzip(data, { filter: file => paths.has(normPath(file.name).toLowerCase()) }, (error, files) => {
      if (error) { reject(error); return; }
      resolve(new Map(Object.entries(files).map(([name, bytes]) => [normPath(name), bytes])));
    });
  });
}

function chartMetadata(data: Uint8Array): Promise<NFMArchive> {
  const cached = metadata.get(data);
  if (cached) return cached;
  const pending = extract(data, ['chart.nf']).then(parseNFMFiles);
  metadata.set(data, pending);
  void pending.catch(() => metadata.delete(data));
  return pending;
}

/** Only chart.nf, the recording and its background; not a gameplay archive. */
export function readNFMPreview(data: Uint8Array): Promise<NFMArchive> {
  const cached = previews.get(data);
  if (cached) return cached;
  const pending = (async () => {
    const { chart, files } = await chartMetadata(data);
    const paths = [chart.meta.audio, chart.meta.bg].filter((name): name is string => !!name);
    const media = await extract(data, paths);
    // Keep metadata's original spelling usable, including older backslash paths.
    for (const name of paths) { const bytes = findCI(media, name); if (bytes) media.set(name, bytes); }
    return { chart, files: new Map([...files, ...media]) };
  })();
  previews.set(data, pending);
  void pending.catch(() => previews.delete(data));
  return pending;
}

/** A catalogue bg path lets thumbnails skip chart JSON and all other assets. */
export function readNFMCover(data: Uint8Array, backgroundPath?: string): Promise<Uint8Array | undefined> {
  let cache = covers.get(data);
  if (!cache) { cache = new Map(); covers.set(data, cache); }
  const key = normPath(backgroundPath || '').toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const preview = previews.get(data);
    if (preview) { const archive = await preview; return findCI(archive.files, backgroundPath || archive.chart.meta.bg || ''); }
    const bg = backgroundPath || (await chartMetadata(data)).chart.meta.bg;
    return bg ? findCI(await extract(data, [bg]), bg) : undefined;
  })();
  cache.set(key, pending);
  void pending.catch(() => cache!.delete(key));
  return pending;
}
