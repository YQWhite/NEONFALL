import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BUILTIN_SKINS, getBuiltinSkin, getDefaultSkin } from '../src/core/default-skin.ts';
import { readNFSK } from '../src/core/nfm.ts';
import { selectSkinForKeys } from '../src/core/osk.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';
import { resolveSelectedSkin } from '../src/core/skin-selection.ts';

const root = new URL('../', import.meta.url);
assert.deepEqual(BUILTIN_SKINS, [
  { id: '', name: 'OSU皮肤示例' },
  { id: 'builtin:malody', name: 'Malody斜轨示例' },
]);
assert.equal(DEFAULT_SETTINGS.skinId, '', 'A fresh install selects the OSU example');
const osu = getDefaultSkin(), malody = getBuiltinSkin('builtin:malody');
assert.equal(getBuiltinSkin(DEFAULT_SETTINGS.skinId), osu);
assert.equal(getBuiltinSkin('builtin:osu'), osu, 'Explicit OSU alias uses the same cache');
assert.equal(getDefaultSkin(), osu, 'The default example is decoded only once');
assert.equal(getBuiltinSkin('builtin:malody'), malody, 'Switching examples reuses decoded asset bytes');
assert.notEqual(osu, malody);
assert.equal(getBuiltinSkin('an-imported-skin-id'), null, 'Imported IDs remain under library ownership');
assert.equal(getBuiltinSkin('builtin:unknown'), null, 'Unknown built-ins cannot silently select a different example');

for (const [stem, archive, modes] of [['osu', osu, [4]], ['msp', malody, [4, 5, 6]]]) {
  const checkedIn = readNFSK(fs.readFileSync(new URL(`src/assets/default-${stem}.nfsk`, root)));
  assert.deepEqual(archive, checkedIn, `${stem} bundled data and reviewable NFSK agree`);
  assert.deepEqual(Object.keys(archive.skin.variants).map(Number), modes);
  for (const keys of modes) {
    const skin = selectSkinForKeys(archive.skin, keys);
    assert.equal(skin.columns.length, keys);
    for (const col of skin.columns) for (const property of ['keyImg', 'keyImgD', 'noteImg', 'noteImgH', 'bodyImg', 'noteImgT']) {
      assert.ok(archive.files.get(col[property])?.length, `${stem} ${keys}K ${property} loads without server or library data`);
    }
  }
  assert.equal(selectSkinForKeys(archive.skin, 8), null, 'Unsupported modes preserve the generated fallback');
}
assert.match(osu.skin.name, /Remilia Scarlet/);
assert.ok(!selectSkinForKeys(osu.skin, 4).perspective, 'Default OSU example has straight lanes');
assert.equal(selectSkinForKeys(malody.skin, 4).perspective.angle, 43, 'Inclination belongs to the selected Malody skin');
assert.equal(malody.skin.author, 'dreamcat', 'Original skin credits are retained');

const reads = [], customBytes = fs.readFileSync(new URL('src/assets/default-msp.nfsk', root));
const readCustom = async id => {
  reads.push(id);
  return id === 'custom-msp' ? customBytes : id === 'corrupt' ? new Uint8Array([1, 2, 3]) : null;
};
let resolved = await resolveSelectedSkin('', 4, readCustom);
assert.equal(resolved.skin, selectSkinForKeys(osu.skin, 4));
assert.equal(resolved.files, osu.files);
resolved = await resolveSelectedSkin('builtin:malody', 5, readCustom);
assert.equal(resolved.skin, selectSkinForKeys(malody.skin, 5));
assert.equal(resolved.files, malody.files);
assert.deepEqual(reads, [], 'Built-ins are usable with an empty or unavailable local library');
resolved = await resolveSelectedSkin('custom-msp', 5, readCustom);
assert.equal(resolved.skin.keys, 5);
assert.deepEqual(resolved.files, malody.files, 'Imported layout uses assets from the same archive');
for (const id of ['missing', 'corrupt']) {
  resolved = await resolveSelectedSkin(id, 4, readCustom);
  assert.equal(resolved.skin, selectSkinForKeys(osu.skin, 4), 'Missing/corrupt custom skin falls back to OSU');
  assert.equal(resolved.files, osu.files, 'Fallback never pairs OSU layout with custom assets');
}
for (const [id, keys] of [['', 5], ['builtin:malody', 7], ['custom-msp', 8]]) {
  resolved = await resolveSelectedSkin(id, keys, readCustom);
  assert.equal(resolved.skin, null, 'An unsupported key mode must use correctly counted generated lanes');
  assert.equal(resolved.files, null);
}
console.log('PASS two offline built-ins: OSU default, named Malody selection, cached bytes, complete assets, mode isolation and imported-skin fallback');
