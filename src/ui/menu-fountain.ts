/**
 * Original Canvas rendering of the twin kiai fountains, with soft smoke instead
 * of osu!'s default Menu/fountain-star texture. The trajectory/timing follow:
 * https://github.com/ppy/osu/blob/master/osu.Game/Screens/Menu/KiaiMenuFountains.cs
 * https://github.com/ppy/osu/blob/master/osu.Game/Screens/Menu/StarFountain.cs
 * https://github.com/ppy/osu/blob/master/osu.Game/Graphics/ParticleSpewer.cs
 * The upstream emitter uses 240/s for 800ms, 300–1000ms lives, gravity 800,
 * vy=-1400±100, and vx=direction*500*(1-2*spawn/800)±60. Its gravity term is
 * g*t*t (not the usual .5*g*t*t); preserve that same visible flight curve.
 */

const EMISSION_MS = 800;
const PARTICLES_PER_SIDE = 192;
const LIFETIME_MS = 1000;
const SPRITE_SIZE = 96;

export interface MenuFountainParticle {
  side: 0 | 1;
  spawnMs: number;
  durationMs: number;
  x: number;
  y: number;
  size: number;
  alpha: number;
}

// Integer hashing makes seeking/drawing deterministic without keeping an old
// emitter alive or accumulating a frame-rate-dependent particle queue.
function random(seed: number, index: number, channel: number) {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca6b)) | 0;
  value = Math.imul(value ^ value >>> 16, 0x7feb352d);
  value = Math.imul(value ^ value >>> 15, 0x846ca68b);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}

function visitParticles(width: number, height: number, ageMs: number, seed: number, visit: (particle: MenuFountainParticle) => void) {
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= EMISSION_MS + LIFETIME_MS ||
      !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const scale = height / 768;
  // Keep the official vertical curve, but fit the horizontal sweep to portrait
  // devices so the two bottom emitters don't immediately cross the whole menu.
  const horizontalScale = Math.min(scale, width / 1280);
  const inset = Math.min(250 * scale, width * .23);
  const lastSpawn = Math.min(PARTICLES_PER_SIDE - 1, Math.floor(ageMs * .24));
  for (let side = 0; side < 2; side++) {
    const direction = side === 0 ? 1 : -1;
    for (let index = 0; index <= lastSpawn; index++) {
      const spawnMs = index / .24;
      const elapsedMs = ageMs - spawnMs;
      const key = index + side * PARTICLES_PER_SIDE;
      const durationMs = 300 + random(seed, key, 0) * 700;
      if (elapsedMs < 0 || elapsedMs >= durationMs) continue;
      const progress = elapsedMs / durationMs;
      const seconds = elapsedMs / 1000;
      const vx = direction * (500 * (1 - 2 * spawnMs / EMISSION_MS) + (random(seed, key, 1) * 2 - 1) * 60);
      const vy = -1400 + (random(seed, key, 2) * 2 - 1) * 100;
      const endScale = 2.2 + (random(seed, key, 3) * 2 - 1) * .4;
      visit({
        side: side as 0 | 1,
        spawnMs,
        durationMs,
        x: (side === 0 ? inset : width - inset) + vx * seconds * horizontalScale,
        y: height + (50 + vy * seconds + 800 * seconds * seconds) * scale,
        size: 46 * scale * (1 + (endScale - 1) * progress),
        alpha: 1 - progress,
      });
    }
  }
}

/** Pure sampling is also used by the trajectory regression, never by the clock. */
export function sampleMenuFountains(width: number, height: number, ageMs: number, seed = 0) {
  const particles: MenuFountainParticle[] = [];
  visitParticles(width, height, ageMs, seed, particle => particles.push(particle));
  return particles;
}

type SmokeCanvas = HTMLCanvasElement | OffscreenCanvas;
const smokeSprites = new WeakMap<object, SmokeCanvas | null>();

function smokeSprite(): SmokeCanvas | null {
  const factory = typeof document !== 'undefined' ? document : typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : null;
  if (!factory) return null;
  if (smokeSprites.has(factory)) return smokeSprites.get(factory)!;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(SPRITE_SIZE, SPRITE_SIZE);
  canvas.width = canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) { smokeSprites.set(factory, null); return null; }
  // One original soft, irregular puff, rasterized once per Canvas factory.
  // No downloaded texture, polygon, pointed spark, or per-particle gradient.
  const lobes = [
    [48, 48, 44, .21], [35, 38, 27, .10], [59, 35, 29, .09],
    [62, 60, 27, .08], [32, 59, 25, .08],
  ];
  for (const [x, y, radius, opacity] of lobes) {
    const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, `rgba(255,255,255,${opacity})`);
    glow.addColorStop(.35, `rgba(255,255,255,${opacity * .66})`);
    glow.addColorStop(.7, `rgba(255,255,255,${opacity * .17})`);
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  }
  smokeSprites.set(factory, canvas);
  return canvas;
}

/** ageMs=-1 cancels immediately; nothing is emitted beyond the 800ms burst. */
export function drawMenuFountains(ctx: CanvasRenderingContext2D, width: number, height: number, ageMs: number, seed = 0) {
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= EMISSION_MS + LIFETIME_MS ||
      !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const sprite = smokeSprite();
  if (!sprite) return;
  ctx.save();
  const incomingAlpha = ctx.globalAlpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'rgba(0,0,0,0)';
  visitParticles(width, height, ageMs, seed, particle => {
    ctx.globalAlpha = incomingAlpha * particle.alpha * .38;
    ctx.drawImage(sprite, particle.x - particle.size / 2, particle.y - particle.size / 2, particle.size, particle.size);
  });
  ctx.restore();
}
