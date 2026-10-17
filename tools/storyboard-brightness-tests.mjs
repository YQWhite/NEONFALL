import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { StoryboardPlayer } from '../src/core/storyboard.ts';

globalThis.document = { createElement: () => createCanvas(1, 1) };
const source = createCanvas(4, 4), sourceCtx = source.getContext('2d');
sourceCtx.fillStyle = 'rgba(200,100,50,0.5)'; sourceCtx.fillRect(0, 0, 4, 4);
const object = { type: 'sprite', layer: 4, origin: 0, path: 'test.png', x: 0, y: 0, cmds: [{ k: 'F', ease: 0, t1: 0, t2: 1000, a: [1, 1] }] };
const player = new StoryboardPlayer([object], () => undefined);
player.objects[0].img = { img: source, w: 4, h: 4 };
const render = (brightness, additive = false) => {
  object.additive = additive;
  const canvas = createCanvas(4, 4), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#14283c'; ctx.fillRect(0, 0, 4, 4);
  player.draw(ctx, 500, false, 'overlay', brightness);
  assert.equal(ctx.globalAlpha, 1); assert.equal(ctx.globalCompositeOperation, 'source-over');
  return [...ctx.getImageData(1, 1, 1, 1).data];
};
const full = render(1), half = render(.5), black = render(0);
for (let c = 0; c < 3; c++) {
  assert.ok(half[c] < full[c]); assert.ok(black[c] < half[c]);
  assert.ok(Math.abs((full[c] + black[c]) / 2 - half[c]) <= 1, 'brightness changes RGB linearly, retaining source alpha');
}
assert.deepEqual(render(NaN), full); assert.deepEqual(render(2), full); assert.deepEqual(render(-1), black);
assert.deepEqual(render(0, true), [20, 40, 60, 255], 'black additive sprite leaves backdrop unchanged');
const addFull = render(1, true), addHalf = render(.5, true);
assert.ok(addHalf[0] > 20 && addHalf[0] < addFull[0]);
assert.deepEqual(render(1, true), addFull, 'cached tint does not alter a later full-brightness frame');
console.log('PASS storyboard RGB brightness 0/50/100%, transparent and additive sprites, bounds and canvas state');
