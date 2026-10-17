// Many osu skins pad HUD/rank images to an entire reference screen.
// Fit the visible artwork, preserving its proportions and original colours.
const boundsCache = new WeakMap<HTMLImageElement, { x: number; y: number; w: number; h: number }>();
export function skinBounds(image: HTMLImageElement) {
  const cached = boundsCache.get(image); if (cached) return cached;
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0); const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (pixels[(y * canvas.width + x) * 4 + 3] > 8) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  const bounds = right >= left ? { x: left, y: top, w: right - left + 1, h: bottom - top + 1 } : { x: 0, y: 0, w: canvas.width, h: canvas.height };
  canvas.width = canvas.height = 1; boundsCache.set(image, bounds); return bounds;
}
export function drawSkinArt(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const b = skinBounds(image), scale = Math.min(w / b.w, h / b.h);
  ctx.drawImage(image, b.x, b.y, b.w, b.h, x + (w - b.w * scale) / 2, y + (h - b.h * scale) / 2, b.w * scale, b.h * scale);
}
