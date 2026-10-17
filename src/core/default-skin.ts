import { defaultMspBase64 } from '../assets/default-msp-data.ts';
import { defaultOsuBase64 } from '../assets/default-osu-data.ts';
import { base64ToBytes } from './zip.ts';
import { readNFSK } from './nfm.ts';

export type SkinArchive = ReturnType<typeof readNFSK>;

/** Empty is the persisted default ID; adding built-ins never rewrites imported
 * skin IDs or adds undeletable copies to the user's library. */
export const BUILTIN_SKINS = [
  { id: '', name: 'OSU皮肤示例' },
  { id: 'builtin:malody', name: 'Malody斜轨示例' },
] as const;

let osu: SkinArchive | undefined;
let malody: SkinArchive | undefined;

/** Embedded in the single-file Web build and APK: no server or first-run skin
 * import is required. Decode only the selected bundle, once per application. */
export function getDefaultSkin(): SkinArchive {
  return osu ??= readNFSK(base64ToBytes(defaultOsuBase64));
}

export function getBuiltinSkin(id: string): SkinArchive | null {
  if (id === '' || id === 'builtin:osu') return getDefaultSkin();
  if (id === 'builtin:malody') return malody ??= readNFSK(base64ToBytes(defaultMspBase64));
  return null;
}
