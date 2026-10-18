import type { SkinArchive } from './default-skin.ts';
import type { NFSkin } from './types.ts';
import { getDefaultSkin } from './default-skin.ts';
import { sha1Fallback } from './sha1.ts';
import { strToBytes } from './zip.ts';

// The v0.2.8/0.2.9 Remilia example and its unchanged imported copies. This
// content fingerprint covers every uncompressed path and byte, including the
// original manifest. ZIP entry order, compression and timestamps are excluded.
// SHA-1 is a content identifier, not an authentication or trust decision.
const LEGACY_REMILIA_CONTENT = 'bcbf4ce7a0cb272275cab1a45d37245ea11df0a1';
const LEGACY_FILE_COUNT = 51;
const LEGACY_ENCODED_LENGTH = 429011;

/** Repair only the exact known converter output, never a name-based match.
 * The archive and stored user bytes remain untouched. */
export function repairKnownLegacySkin(archive: SkinArchive): SkinArchive {
  if (archive.files.size !== LEGACY_FILE_COUNT) return archive;
  const entries = [...archive.files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, data]) => [strToBytes(path), data] as const);
  const length = entries.reduce((sum, [path, data]) => sum + 8 + path.length + data.length, 0);
  if (length !== LEGACY_ENCODED_LENGTH) return archive;
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  let offset = 0;
  for (const [path, data] of entries) {
    view.setUint32(offset, path.length, true); view.setUint32(offset + 4, data.length, true); offset += 8;
    bytes.set(path, offset); offset += path.length;
    bytes.set(data, offset); offset += data.length;
  }
  if (sha1Fallback(bytes) !== LEGACY_REMILIA_CONTENT) return archive;
  const reference = getDefaultSkin();
  // A future different built-in default must not replace this known skin.
  if (reference.skin.name !== archive.skin.name || reference.skin.author !== archive.skin.author ||
      !reference.skin.judgmentAnimations?.good?.frames.length) return archive;
  const skin: NFSkin = structuredClone(archive.skin), files = new Map(archive.files);
  const restore = (target: NFSkin, source: NFSkin) => {
    target.judgments = { ...source.judgments };
    target.judgmentAnimations = structuredClone(source.judgmentAnimations);
    target.assetDensity = { ...target.assetDensity };
    for (const animation of Object.values(source.judgmentAnimations ?? {})) {
      for (const path of animation?.frames ?? []) {
        const data = reference.files.get(path);
        if (data) files.set(path, data);
        target.assetDensity[path] = source.assetDensity?.[path] ?? 1;
      }
    }
  };
  restore(skin, reference.skin);
  for (const [keys, variant] of Object.entries(skin.variants ?? {})) {
    const source = reference.skin.variants?.[keys];
    if (source) restore(variant, source);
  }
  files.set('skin.nfskin', strToBytes(JSON.stringify(skin)));
  return { skin, files };
}
