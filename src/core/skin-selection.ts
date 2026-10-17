import type { NFSkin } from './types.ts';
import { getBuiltinSkin, getDefaultSkin } from './default-skin.ts';
import { readNFSK } from './nfm.ts';
import { selectSkinForKeys } from './osk.ts';

/** Keep preview and gameplay on the same layout and its matching asset archive. */
export async function resolveSelectedSkin(id: string, keys: number, readCustom: (id: string) => Promise<Uint8Array | null>) {
  let archive = getBuiltinSkin(id);
  if (!archive && id) {
    const bytes = await readCustom(id);
    if (bytes) {
      try { archive = readNFSK(bytes); } catch { /* Invalid imported skin uses the default. */ }
    }
  }
  let skin: NFSkin | null = selectSkinForKeys(archive?.skin, keys);
  if (!skin) {
    archive = getDefaultSkin();
    skin = selectSkinForKeys(archive.skin, keys);
  }
  return { skin, files: skin ? archive!.files : null };
}
