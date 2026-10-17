import type { NFSkin } from '../core/types.ts';

export function mspArtPaths(skin: NFSkin | null): string[] {
  const art = skin?.msp;
  if (!art) return [];
  return [...new Set([
    ...[art.trackLeft, art.trackLight, art.trackBottom, art.keyBackground, art.laneLine, art.press, art.perfectEffect].map(s => s?.image),
    ...(art.hit?.frames ?? []), ...(art.holdHit?.frames ?? []), art.cat?.background,
    ...(art.cat?.presses ?? []), ...(art.cat?.poses ?? []),
  ].filter((path): path is string => !!path))];
}

/** Native translation of RM rym.lua Bongocat, indexed by physical lane input. */
export function mspCatPoses(down: boolean[]): number[] {
  const bits = (start: number, count: number) => down.slice(start, start + count).reduce((v, b, i) => v | (b ? 1 << i : 0), 0);
  const two = [-1, 0, 2, 1];
  const three = [-1, 0, 2, 1, 4, 2, 3, 2];
  if (down.length === 4) return [two[bits(0, 2)], two[bits(2, 2)] < 0 ? -1 : two[bits(2, 2)] + 3].filter(p => p >= 0);
  if (down.length === 6) return [three[bits(0, 3)] < 0 ? -1 : three[bits(0, 3)] + 6,
    three[bits(3, 3)] < 0 ? -1 : three[bits(3, 3)] + 11].filter(p => p >= 0);
  if (down.length !== 5) return [];
  if (!down[2]) {
    const a = [-1, 6, 8, 7][bits(0, 2)], b = [-1, 13, 15, 14][bits(3, 2)];
    return [a, b].filter(p => p >= 0);
  }
  // Center key is played with either hand, following the author's 16 states.
  const center: number[][] = [
    [10], [6, 11], [8, 11], [7, 11], [10, 13], [6, 12], [9, 13], [7, 12],
    [10, 15], [8, 15], [9, 15], [8, 15], [10, 14], [6, 13], [9, 14], [8, 14],
  ];
  return center[bits(0, 2) | (bits(3, 2) << 2)];
}
