import assert from 'node:assert/strict';
import { scrollSpeedFromMultiplier, scrollSpeedMultiplier, scrollTimeMs, mainBeatLength } from '../src/core/scoring.ts';
import { DEFAULT_SETTINGS, DEFAULT_MODS } from '../src/core/types.ts';
import { PlaySession } from '../src/engine/play.ts';
import { PlayfieldRenderer } from '../src/engine/render.ts';
import { Store } from '../src/core/store.ts';

const near=(a,b,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<tolerance,`${a} = ${b}`);
const chart=bpm=>({format:'neonfall-chart',version:1,keys:4,od:8,stars:3,offset:0,meta:{title:'test',artist:'test',creator:'test',version:'test',audio:'',lengthMs:10000,audioLeadIn:0,previewTime:0},timing:[{t:0,bpm}],sv:[],notes:[{t:1000,col:0},{t:6000,col:1,end:6500}],breaks:[]});
near(scrollSpeedMultiplier(DEFAULT_SETTINGS.scrollSpeed),8);
for(const speed of [1,8,15.7,20,30,40]){near(scrollTimeMs(speed),11485/speed);near(402/scrollSpeedFromMultiplier(speed),scrollTimeMs(speed));near(scrollSpeedMultiplier(scrollSpeedFromMultiplier(speed)),speed);}
for(const saved of [.1,.4,.55,.85,1.2])near(scrollSpeedFromMultiplier(scrollSpeedMultiplier(saved)),saved);
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
storage.set('nf.settings.v1',JSON.stringify({scrollSpeed:.55}));near(new Store().settings.scrollSpeed,.55);
const settings={...DEFAULT_SETTINGS,scrollSpeed:scrollSpeedFromMultiplier(20)};
function session(c,constantSpeed=false){return new PlaySession(c,{}, {skin:null,getAsset:()=>undefined},{...DEFAULT_MODS,constantSpeed},settings,{songTimeMs:()=>0});}
for(const bpm of [60,120,180,240]){
 const s=session(chart(bpm)),r=new PlayfieldRenderer(null,()=>undefined,settings,{...DEFAULT_MODS});
 near((s.scrollMap.svBeatAt(2500)-s.scrollMap.svBeatAt(2000))*r.beatHeight(s),settings.scrollSpeed*500,.001);
 const before=r.beatHeight(s);settings.playfieldBottomGap=.35;r.fieldOrigin(1280,800);near(r.beatHeight(s),before);delete settings.playfieldBottomGap;
}
const c=chart(120);c.timing.push({t:8000,bpm:240});c.sv=[{t:4000,sv:2}];near(mainBeatLength(c),500);
const s=session(c),r=new PlayfieldRenderer(null,()=>undefined,settings,{...DEFAULT_MODS});
const distance=(s,start)=> (s.scrollMap.svBeatAt(start+100)-s.scrollMap.svBeatAt(start))*r.beatHeight(s);
near(distance(s,6000),distance(s,2000)*2);near(distance(s,8500),distance(s,2000)*4);
const fixed=session(c,true);near(distance(fixed,6000),distance(fixed,2000));near(distance(fixed,8500),distance(fixed,2000));
const shifted=chart(120);shifted.timing=[{t:-100,bpm:60},{t:1000,bpm:180},{t:9000,bpm:60}];near(mainBeatLength(shifted),333.333);
const outro=chart(180);outro.meta.lengthMs=200000;outro.timing.push({t:6600,bpm:30});near(mainBeatLength(outro),333.333);
const overlapping=chart(120);overlapping.notes=[{t:100,col:0,end:20000},{t:1000,col:1}];overlapping.timing.push({t:1100,bpm:240});near(mainBeatLength(overlapping),250);
const rounded=chart(120);rounded.notes=[{t:10000,col:0}];rounded.timing=[{t:0,bpm:120},{t:3000,bpm:120.00001},{t:6000,bpm:180}];near(mainBeatLength(rounded),500);
console.log('PASS official mania 1–40 scale, 11485/speed travel, 402-unit reference, saved-speed preservation, dominant-BPM normalisation, local SV/BPM and ConstantSpeed separation');
