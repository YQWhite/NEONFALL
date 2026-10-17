import { tr } from './i18n.ts';

/** Missing metadata from older servers must not be mistaken for a no-mod play. */
export function modsLabel(mods?: readonly string[]): string {
  if (!Array.isArray(mods)) return tr('Mods unavailable');
  return mods.length ? mods.map(mod => tr(/^constantspeed$/i.test(mod) ? 'CONSTANT SPEED' : mod.toUpperCase())).join(' · ') : tr('NO MODS');
}
