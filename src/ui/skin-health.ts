import type { NFSkin } from '../core/types.ts';

interface HealthImages { get(path: string | undefined): HTMLImageElement | undefined | null; }
interface HealthImage { image: HTMLImageElement; width: number; height: number; bottom: number; }

// Only used to leave space for the song label. Drawing never trims the authored
// transparent margins: the scorebar layers share one coordinate system.
const visibleBottom = new WeakMap<HTMLImageElement, number>();
function imageBottom(image: HTMLImageElement) {
  const cached = visibleBottom.get(image);
  if (cached !== undefined) return cached;
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  let bottom = 0;
  try {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    // Full-screen scorebar backgrounds can include score decorations on the
    // right. Only reserve the top-left health region for the song information.
    const right = Math.min(width, Math.max(360, width * .4));
    for (let y = height - 1; y >= 0 && !bottom; y--) {
      for (let x = 0; x < right; x++) if (pixels[(y * width + x) * 4 + 3] > 8) { bottom = y + 1; break; }
    }
    canvas.width = canvas.height = 1;
  } catch {
    bottom = Math.min(72, height);
  }
  visibleBottom.set(image, bottom);
  return bottom;
}

function healthImage(skin: NFSkin, images: HealthImages, path: string | undefined): HealthImage | null {
  if (!path) return null;
  const image = images.get(path);
  if (!image) return null;
  const density = skin.assetDensity?.[path] || (/@2x\.[^.]+$/i.test(path) ? 2 : 1);
  return { image, width: (image.naturalWidth || image.width) / density, height: (image.naturalHeight || image.height) / density, bottom: imageBottom(image) / density };
}

export function prepareSkinHealth(skin: NFSkin | null | undefined, images: HealthImages) {
  if (!skin?.hud) return;
  for (const path of Object.values(skin.hud)) {
    const image = images.get(path);
    if (image) imageBottom(image);
  }
}

/** Draw the legacy scorebar horizontally in NEONFALL's top-left HUD.
 * osu's bg origin is (0,0), fill is (5,16), or (12,12) with a marker.
 * Full-screen bg art and @2x assets retain their shared proportions/offsets.
 * Returns the song-title baseline, or null when there is no loaded custom art.
 */
export function drawSkinHealth(ctx: CanvasRenderingContext2D, skin: NFSkin | null | undefined, images: HealthImages | null | undefined, health: number, width: number, height: number): number | null {
  if (!skin?.hud || !images) return null;
  const bg = healthImage(skin, images, skin.hud.healthBackground);
  const fill = healthImage(skin, images, skin.hud.healthFill);
  const marker = healthImage(skin, images, skin.hud.healthMarker);
  if (!bg && !fill && !marker) return null;

  const hp = Math.max(0, Math.min(1, health));
  const x = marker ? 12 : 5, y = marker ? 12 : 16;
  const localWidth = fill ? x + fill.width + (marker?.width ?? 0) / 2 : Math.min(bg?.width ?? 0, 360);
  // Small HUD skins stay readable; a screen-sized background is fitted as a
  // complete overlay instead of being squeezed into the former 230px box.
  const scale = Math.min(height / 768, width / Math.max(640, bg?.width ?? 0), Math.min(360, width * .38) / Math.max(1, localWidth));
  ctx.save();
  ctx.scale(scale, scale);
  if (bg) ctx.drawImage(bg.image, 0, 0, bg.width, bg.height);
  if (fill && hp > 0) {
    const sourceWidth = (fill.image.naturalWidth || fill.image.width) * hp;
    ctx.drawImage(fill.image, 0, 0, sourceWidth, fill.image.naturalHeight || fill.image.height, x, y, fill.width * hp, fill.height);
  }
  if (marker && fill) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha *= Math.min(1, hp / .2);
    ctx.drawImage(marker.image, x + fill.width * hp - marker.width / 2, 16 - marker.height / 2, marker.width, marker.height);
  }
  ctx.restore();
  const bottom = Math.max(bg?.bottom ?? 0, fill?.bottom ? y + fill.bottom : 0, marker?.bottom ? 16 + marker.height / 2 : 0);
  return Math.max(73, Math.min(height * .25, bottom * scale + 20));
}
