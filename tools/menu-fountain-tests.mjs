import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { drawMenuFountains, sampleMenuFountains } from '../src/ui/menu-fountain.ts';

const out = path.resolve('test-results/edge-smoke');
fs.mkdirSync(out, { recursive: true });
let allocations = 0, gradients = 0;
globalThis.document = { createElement(tag) {
  assert.equal(tag, 'canvas'); allocations++;
  const canvas = createCanvas(1, 1), ctx = canvas.getContext('2d');
  const original = ctx.createRadialGradient.bind(ctx);
  ctx.createRadialGradient = (...args) => { gradients++; return original(...args); };
  return canvas;
} };

let assertions = 0;
const check = (condition, message) => { assertions++; assert.ok(condition, message); };
const width = 1280, height = 720, seed = 1972;
const stats = (canvas, x0 = 0, y0 = 0, x1 = canvas.width, y1 = canvas.height) => {
  const image = canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0);
  let count = 0, sum = 0, xsum = 0, ysum = 0, max = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const alpha = image.data[(y * image.width + x) * 4 + 3];
    if (alpha > 0) { count++; sum += alpha; xsum += (x + x0) * alpha; ysum += (y + y0) * alpha; max = Math.max(max, alpha); }
  }
  return { count, sum, x: xsum / sum, y: ysum / sum, max };
};
const render = (age, w = width, h = height, otherSeed = seed) => {
  const canvas = createCanvas(w, h);
  drawMenuFountains(canvas.getContext('2d'), w, h, age, otherSeed);
  return canvas;
};

for (const age of [-1, -100, 1800, 10000, NaN, Infinity]) {
  check(sampleMenuFountains(width, height, age, seed).length === 0, `inactive/end/nonfinite age ${age} has no particles`);
  check(stats(render(age)).count === 0, `inactive/end/nonfinite age ${age} touches no pixels`);
}
check(allocations === 0, 'inactive paths allocate no smoke sprite');
for (const size of [[0,720],[1280,0],[-1,720],[NaN,720],[1280,Infinity]])
  check(sampleMenuFountains(...size,200,seed).length === 0, 'invalid dimensions have no particles');

const born = sampleMenuFountains(width,height,0,seed);
check(born.length === 2, 'one particle starts immediately in each of exactly two emitters');
check(born[0].x === 250 * height / 768 && born[1].x === width - born[0].x, 'official 250-unit bottom inset');
check(born.every(p => p.y === height + 50 * height / 768), 'official 50-unit below-screen start');

let maxActive = 0;
for (let age = 0; age <= 1800; age += 25) {
  const particles = sampleMenuFountains(width,height,age,seed);
  maxActive = Math.max(maxActive,particles.length);
  check(particles.length <= 384, 'fixed 384-particle total budget');
  for (const particle of particles) {
    check(particle.durationMs >= 300 && particle.durationMs < 1000, 'upstream lifetime range');
    check(particle.spawnMs < 800 && particle.spawnMs <= age, 'only past particles from the 800ms emission');
    check(particle.alpha > 0 && particle.alpha <= 1, 'linear lifetime opacity bounded');
    const initialSize = 46 * height / 768;
    check(particle.size >= initialSize && particle.size < initialSize * 2.6, 'upstream expansion range');
  }
}
check(maxActive > 180, 'full paired fountain emits a plume, not isolated dots');
const early = sampleMenuFountains(width,height,150,seed);
for (const particle of early.filter(p => p.spawnMs < 80)) {
  const inset = particle.side === 0 ? 250 * height / 768 : width - 250 * height / 768;
  check((particle.x - inset) * (particle.side === 0 ? 1 : -1) > 0, 'first spray sweeps inward on both sides');
}
const late = sampleMenuFountains(width,height,780,seed);
for (const particle of late.filter(p => p.spawnMs > 650 && p.spawnMs < 730)) {
  const inset = particle.side === 0 ? 250 * height / 768 : width - 250 * height / 768;
  check((particle.x - inset) * (particle.side === 0 ? 1 : -1) < 0, 'last spray reverses outward on both sides');
}
const first = sampleMenuFountains(width,height,150,seed)[0];
const next = sampleMenuFountains(width,height,250,seed).find(p => p.side === first.side && p.spawnMs === first.spawnMs);
check(next && next.y < first.y - 90, 'same actual particle travels upward over time');
check(next.alpha < first.alpha && next.size > first.size, 'same puff expands and fades during flight');
const gravitySamples = [100,200,300].map(age => sampleMenuFountains(width,height,age,seed).find(p => p.side === 0 && p.spawnMs === 0));
check(Math.abs(gravitySamples[2].y - 2*gravitySamples[1].y + gravitySamples[0].y - 2*800*.1*.1*height/768) < 1e-8,
  'upstream ParticleSpewer gravity uses g*t*t with the exact 800-unit acceleration term');
assert.deepEqual(sampleMenuFountains(width,height,450,seed),sampleMenuFountains(width,height,450,seed));
assert.notDeepEqual(sampleMenuFountains(width,height,450,seed),sampleMenuFountains(width,height,450,seed+1));
assertions += 2;

const canvas = createCanvas(width,height), ctx = canvas.getContext('2d');
ctx.globalAlpha = .61; ctx.globalCompositeOperation = 'source-over'; ctx.translate(3,5);
ctx.fillStyle = '#ac9134'; ctx.shadowBlur = 14; ctx.shadowColor='#ff0000';
const state = { alpha:ctx.globalAlpha, composite:ctx.globalCompositeOperation, transform:ctx.getTransform(),fill:ctx.fillStyle,shadow:ctx.shadowColor };
drawMenuFountains(ctx,width,height,350,seed);
check(ctx.globalAlpha === state.alpha && ctx.globalCompositeOperation === state.composite && ctx.fillStyle === state.fill, 'Canvas alpha/composite/fill restored');
check(ctx.shadowBlur===14&&ctx.shadowColor===state.shadow,'caller shadow state restored');
assert.deepEqual(ctx.getTransform(),state.transform); assertions++;
const stable = render(350).toBuffer('image/png');
assert.deepEqual(render(350).toBuffer('image/png'),stable); assertions++;
check(allocations === 1 && gradients === 5, 'one cached original smoke sprite, no per-frame/per-particle gradients');
const alphaFull = stats(render(350)).sum;
const fadedCanvas = createCanvas(width,height), fadedContext = fadedCanvas.getContext('2d'); fadedContext.globalAlpha = .25;
drawMenuFountains(fadedContext,width,height,350,seed);
check(stats(fadedCanvas).sum < alphaFull * .4, 'respects incoming screen-transition opacity');

const frames = [100,250,450,650,850,1100,1450,1800];
const reportFrames = [];
const gallery = createCanvas(1280,720), galleryContext = gallery.getContext('2d');
galleryContext.fillStyle = '#0d1422'; galleryContext.fillRect(0,0,1280,720);
for (let index=0;index<frames.length;index++) {
  const age = frames[index], frame = render(age);
  const full = stats(frame), left=stats(frame,0,0,width/2,height),right=stats(frame,width/2,0,width,height);
  reportFrames.push({age,full,left,right});
  if (age >= 100 && age <= 850) {
    check(left.count > 100 && right.count > 100, 'two visibly separate bottom plumes');
    check(left.x < width*.4 && right.x > width*.6, 'plumes retain their own screen sides');
    const middle = stats(frame,width*.46,0,width*.54,height);
    check(middle.sum < (left.sum+right.sum)*.04, 'central menu is clear during main emission');
  }
  fs.writeFileSync(path.join(out,`fountain-${age}.png`),frame.toBuffer('image/png'));
}
// A clean, scaled sequence avoids misleading an accumulating particle trace.
galleryContext.fillStyle='#0d1422'; galleryContext.fillRect(0,0,1280,720);
for (let index=0;index<frames.length;index++) {
  const x=(index%4)*320,y=Math.floor(index/4)*360;
  const frame=render(frames[index],640,640);
  galleryContext.drawImage(frame,x,y,320,320);
  galleryContext.fillStyle='#aabbd0';galleryContext.font='15px sans-serif';galleryContext.fillText(`${frames[index]} ms`,x+12,y+342);
}
fs.writeFileSync(path.join(out,'fountain-sequence.png'),gallery.toBuffer('image/png'));
for (const [w,h] of [[360,780],[780,360]]) {
  const frame=render(450,w,h),left=stats(frame,0,0,Math.floor(w/2),h),right=stats(frame,Math.floor(w/2),0,w,h);
  check(left.count>100&&right.count>100,'both emitters remain visible in portrait/landscape');
  check(left.x<w*.45&&right.x>w*.55,'portrait/landscape emitters remain distinct');
  fs.writeFileSync(path.join(out,`fountain-${w}x${h}.png`),frame.toBuffer('image/png'));
}
check(stats(render(1450)).sum < stats(render(650)).sum*.12,'remaining smoke dissipates without continuing emission');
const replacedFactory = document;
globalThis.document={createElement:replacedFactory.createElement}; render(350);
check(allocations===2&&gradients===10,'a distinct Canvas factory receives one compatible cached sprite');
fs.writeFileSync(path.join(out,'fountain-metrics.json'),JSON.stringify({assertions,maxActive,frames:reportFrames},null,2)+'\n');
console.log(`PASS ${assertions} fountain checks: official dual sweep/lifetimes/gravity, deterministic bounded particles, cached soft sprite, real Canvas/mobile pixels and decay`);
