/** One background sample per song; the menu never reads a full-size image per frame. */
export type MenuEdgeColor = readonly [number, number, number];
export const DEFAULT_MENU_EDGE_COLOR: MenuEdgeColor = [166, 203, 181];

function hueOf(r: number, g: number, b: number, max: number, delta: number): number {
  const hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

/** Pick a coherent hue family rather than averaging complementary colours into grey. */
export function menuEdgeColorFromPixels(pixels: ArrayLike<number>): MenuEdgeColor {
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255, alpha = pixels[i + 3] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    // Shadows, transparent margins and white/grey areas should not drown out the art's colour.
    if (alpha < .1 || max < .16 || delta < .07 || delta / max < .18) continue;
    const saturation = delta / max;
    const weight = alpha * saturation * saturation * (.3 + max * .7);
    const bin = bins[Math.round(hueOf(r, g, b, max, delta) / 15) % bins.length];
    bin.weight += weight; bin.r += r * weight; bin.g += g * weight; bin.b += b * weight;
  }
  let winner = -1, bestWeight = 0;
  for (let i = 0; i < bins.length; i++) {
    const weight = bins[i].weight + (bins[(i + 23) % 24].weight + bins[(i + 1) % 24].weight) * .5;
    if (weight > bestWeight) { winner = i; bestWeight = weight; }
  }
  if (winner < 0) return DEFAULT_MENU_EDGE_COLOR;
  let r = 0, g = 0, b = 0, weight = 0;
  for (const offset of [-1, 0, 1]) {
    const bin = bins[(winner + offset + 24) % 24], influence = offset === 0 ? 1 : .5;
    r += bin.r * influence; g += bin.g * influence; b += bin.b * influence; weight += bin.weight * influence;
  }
  r /= weight; g /= weight; b /= weight;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const hue = hueOf(r, g, b, max, delta) / 60;
  // Keep the sampled hue, with enough lightness for a glow on the darkened artwork.
  const saturation = Math.max(.45, Math.min(.78, delta / Math.max(.001, 1 - Math.abs(max + min - 1))));
  const lightness = .70, chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(hue % 2 - 1)), m = lightness - chroma / 2;
  const rgb = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x]
    : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return rgb.map(value => Math.round((value + m) * 255)) as unknown as MenuEdgeColor;
}

/** A tainted/unavailable canvas is a normal fallback, never a playback failure. */
export function extractMenuEdgeColor(image: HTMLImageElement | null, aspect = 1): MenuEdgeColor {
  if (!image || typeof document === 'undefined') return DEFAULT_MENU_EDGE_COLOR;
  try {
    const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
    if (!(iw > 0 && ih > 0)) return DEFAULT_MENU_EDGE_COLOR;
    const canvas = document.createElement('canvas');
    canvas.width = 40; canvas.height = 40;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return DEFAULT_MENU_EDGE_COLOR;
    const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : iw / ih;
    const sw = Math.min(iw, ih * ratio), sh = Math.min(ih, iw / ratio);
    ctx.drawImage(image, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, 40, 40);
    return menuEdgeColorFromPixels(ctx.getImageData(0, 0, 40, 40).data);
  } catch { return DEFAULT_MENU_EDGE_COLOR; }
}

export function mixMenuEdgeColors(from: MenuEdgeColor, to: MenuEdgeColor, progress: number): MenuEdgeColor {
  const t = Math.max(0, Math.min(1, progress));
  return [Math.round(from[0] + (to[0] - from[0]) * t), Math.round(from[1] + (to[1] - from[1]) * t), Math.round(from[2] + (to[2] - from[2]) * t)];
}
