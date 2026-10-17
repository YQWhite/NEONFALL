import assert from 'node:assert/strict';
import { InputManager } from '../src/engine/input.ts';
import { PlayfieldRenderer } from '../src/engine/render.ts';
import { laneAtPoint } from '../src/engine/lane-geometry.ts';
import { getBuiltinSkin } from '../src/core/default-skin.ts';
import { selectSkinForKeys } from '../src/core/osk.ts';
import { DEFAULT_SETTINGS, DEFAULT_MODS } from '../src/core/types.ts';

for (const [w, h] of [[780, 360], [360, 780], [1280, 720]]) for (const keys of [4, 5, 6]) {
  const skin = selectSkinForKeys(getBuiltinSkin('builtin:malody').skin, keys);
  const renderer = new PlayfieldRenderer(skin, () => undefined, DEFAULT_SETTINGS, DEFAULT_MODS);
  const origin = renderer.fieldOrigin(w, h), widths = skin.columns.map(c => c.width), start = (512 - widths.reduce((a, b) => a + b, 0)) / 2;
  const input = new InputManager(keys, DEFAULT_SETTINGS);
  input.setLaneResolver((x, y) => laneAtPoint(x, y, origin, start, widths, (x, y) => renderer.projectX(x, y)));
  for (const logicalY of [200, 300, skin.hitPosition, 479]) {
    let left = start;
    for (let col = 0; col < keys; col++) {
      const x = origin.ox + renderer.projectX(left + widths[col] / 2, logicalY) * origin.scale;
      const y = origin.oy + logicalY * origin.scaleY;
      assert.equal(input.colAtXY(x, y), col, 'projected lane center hits exactly its visual lane');
      left += widths[col];
    }
    const outsideX = origin.ox + renderer.projectX(start, logicalY) * origin.scale - 1;
    assert.equal(input.colAtXY(outsideX, origin.oy + logicalY * origin.scaleY), -1);
  }
  assert.equal(input.colAtXY(w / 2, origin.oy), -1, 'HUD/top area is not a touch lane');
}
const input = new InputManager(4, DEFAULT_SETTINGS);
input.setLaneResolver(() => 0);
const events = [];
input.onPress = () => events.push('press'); input.onRelease = () => events.push('release');
const pointer = id => ({ pointerId: id, clientX: 10, clientY: 10, preventDefault() {} });
input.hPointerDown(pointer(1)); input.hPointerDown(pointer(2)); input.hPointerUp(pointer(1));
assert.deepEqual(events, ['press']); assert.equal(input.isDown(0), true, 'one remaining finger sustains the hold');
input.hPointerUp(pointer(2)); assert.deepEqual(events, ['press', 'release']);
console.log('PASS perspective touch lanes: 4/5/6K, portrait and landscape, projected centers, outside boundaries and same-lane multi-touch');
