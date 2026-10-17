import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildTimeMap } from '../src/core/nfm.ts';
import { importChartArchive, importSkinArchive } from '../src/core/import.ts';
import { readNFM, readNFSK } from '../src/core/nfm.ts';
import { selectSkinForKeys } from '../src/core/osk.ts';
import { PlayfieldRenderer } from '../src/engine/render.ts';
import { PlaySession } from '../src/engine/play.ts';
import { DEFAULT_SETTINGS, DEFAULT_MODS } from '../src/core/types.ts';
const samples = new URL('../../', import.meta.url);
for (const t of [-1000,-10,0,100,1234,10000]) {
  const tm=buildTimeMap([{t:100,bpm:120},{t:2000,bpm:240}],[{t:500,sv:2}],100);
  assert.ok(Math.abs(tm.msAtBeat(tm.beatAt(t))-t)<1e-7);
  assert.ok(Math.abs(tm.msAtSvBeat(tm.svBeatAt(t))-t)<1e-7);
}
const files=fs.readdirSync(samples);
for (const file of files.filter(f=>/\.(osz|mcz)$/.test(f))) {
  const charts=importChartArchive(file,fs.readFileSync(new URL(file,samples)));
  assert.ok(charts.length>0);
  for(const c of charts){
    const a=readNFM(c.nfm);
    assert.ok(a.files.get(a.chart.meta.audio)?.length>1000);
    assert.ok(a.chart.notes.every(n=>Number.isFinite(n.t)&&n.col>=0&&n.col<a.chart.keys));
    assert.ok(a.chart.notes.every(n=>!n.end||n.end>n.t));
    if (/\.mcz$/i.test(file) && file.includes('CURE')) {
      assert.equal(a.chart.notes.length,1386,'audio event must not become an opening key');
      assert.equal(a.chart.notes[0].t,8801.5,'positive MC audio cue delay must be SUBTRACTED');
      assert.equal(a.chart.offset,-261);
      assert.deepEqual(a.chart.notes.filter(n=>n.t===8801.5).map(n=>n.col),[0,2]);
    }
    const tm=buildTimeMap(c.chart.timing,c.chart.sv,c.chart.offset);
    for(const n of c.chart.notes) assert.ok(Math.abs(tm.msAtSvBeat(tm.svBeatAt(n.t))-n.t)<1e-5);
    console.log('ARCHIVE',file,c.version,c.notes,'notes',c.chart.notes[0].t,'first ms');
  }
}
const file=files.find(f=>f.endsWith('.osk'));
const parsed=importSkinArchive(file,fs.readFileSync(new URL(file,samples)));
const {skin,files:assets}=readNFSK(parsed.nfsk);
const layout=selectSkinForKeys(skin,4);
assert.ok(layout);
for (const c of layout.columns) {
  for(const key of ['keyImg','keyImgD','noteImg','noteImgH','bodyImg','noteImgT']) assert.ok(assets.get(c[key]),key+' '+c[key]);
}
const renderer=new PlayfieldRenderer(layout, p=>assets.get(p), {...DEFAULT_SETTINGS},{...DEFAULT_MODS});
assert.equal(renderer.beatHeight(),275);
const session = Object.create(PlaySession.prototype);
session.skin = layout; session.keys = 4;
assert.equal(session.laneStart(),124);
assert.equal((session.laneX(0)+session.laneX(3))/2,256);
// Track actual renderer draw calls with fake decoded images, independent of DOM.
const image={width:66,height:12};
for(const p of Object.keys(layout.assetDensity||{})) renderer.images.images.set(p,image);
for(const c of layout.columns) for(const p of [c.noteImg,c.noteImgH,c.bodyImg,c.noteImgT]) renderer.images.images.set(p,image);
const draws=[];
const ctx={save(){},restore(){},translate(){},scale(){},drawImage:(...args)=>draws.push(args)};
renderer.drawHold(ctx,{},0,100,66,-200,400,0);
assert.ok(draws.some(d=>d[0]===renderer.images.get(layout.columns[0].noteImgH)));
assert.ok(draws.length>=3);
console.log('PASS archive roundtrips, exact negative-time inverses, skin H/L/T assets, scroll units, hold draw');
