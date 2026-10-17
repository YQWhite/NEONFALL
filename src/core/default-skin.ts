import { defaultMspBase64 } from '../assets/default-msp-data.ts';
import { base64ToBytes } from './zip.ts';
import { readNFSK } from './nfm.ts';

let bundled: ReturnType<typeof readNFSK> | undefined;

/** Embedded in the single-file Web build and APK: no server or first-run skin
 * import is required. Cache decoding and share immutable asset bytes. */
export function getDefaultSkin(): ReturnType<typeof readNFSK> {
  return bundled ??= readNFSK(base64ToBytes(defaultMspBase64));
}
