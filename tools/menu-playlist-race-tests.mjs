import assert from 'node:assert/strict';
import { AudioEngine } from '../src/engine/audio.ts';
import { MenuMusic } from '../src/ui/menu-music.ts';
import { buildNFM } from '../src/core/nfm.ts';
import { readNFMPreview } from '../src/core/preview-archive.ts';
const gain = () => ({ gain: { value:0, linearRampToValueAtTime(v){this.value=v;},cancelScheduledValues(){},setValueAtTime(v){this.value=v;} },connect(){},disconnect(){} });
const defer = () => { let resolve; const promise = new Promise(done=>{resolve=done;}); return {promise,resolve}; };
const waitFor = async predicate => { const end=Date.now()+3000; while(!predicate()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5)); assert.ok(predicate(),'async operation finishes'); };
const entries=['Alpha','Beta'].map((title,i)=>({id:`song${i}`,title,artist:'Artist',creator:'Mapper',version:'Easy',stars:1,keys:4,addedAt:10-i}));
const archive=entry=>buildNFM({format:'neonfall-chart',version:1,keys:4,timing:[{t:0,bpm:120}],sv:[],notes:[],meta:{title:entry.title,audio:'a.ogg',previewTime:30000}},{'a.ogg':new Uint8Array([1,2,3])});
async function fixture(phase, fail=false) {
  const ctx={currentTime:0,state:'running',createGain:gain,createBufferSource(){return {connect(){},disconnect(){},start(){},stop(){}};}};
  const audio=new AudioEngine();audio.ctx=ctx;audio.master=gain();
  const gate=defer();let reads=0,decodes=0;
  audio.decode=async()=>{decodes++;if(phase==='decode'&&decodes>1)await gate.promise;return {duration:100};};
  const app={audio,settings:{musicVolume:.5},store:{listCharts:async()=>entries,getChartBytes:async id=>{
    reads++;if(id==='song0')return archive(entries[0]);if(fail)throw Error('next unavailable');
    return phase==='decode'?archive(entries[1]):gate.promise;
  }},w:1280,h:800};
  const music=new MenuMusic(app);music.setScreen('menu');await waitFor(()=>music.playingChart?.id==='song0');
  if(phase==='prepared'){ctx.currentTime=94;music.update();await waitFor(()=>reads===2);}
  ctx.currentTime=106;music.update();
  if(!fail)await waitFor(()=>phase==='decode'?decodes===2:reads===2);
  return {ctx,audio,music,gate,reads:()=>reads};
}
let cases=0;
for(const phase of ['prepared','download','decode'])for(const action of ['pause','seek','select-menu']){
  const f=await fixture(phase);
  if(action==='pause')f.audio.pausePreview();
  else if(action==='seek')f.audio.seekPreview(40);
  else {f.music.setScreen('select');f.music.setScreen('menu');}
  f.gate.resolve(archive(entries[1]));await waitFor(()=>!f.music.autoAdvancing);
  assert.equal(f.music.playingChart.id,'song0',`${phase}/${action}: stale automatic advance cannot replace current recording`);
  assert.equal(f.music.entry.id,'song0',`${phase}/${action}: cancelled pending metadata is restored`);
  if(action==='pause')assert.equal(f.audio.isPreviewPaused,true);
  if(action==='seek')assert.equal(f.audio.previewTimeSec,40);
  f.music.setScreen('play');cases++;
}
for(const phase of ['prepared','download']){
  const f=await fixture(phase,true);await waitFor(()=>!f.music.autoAdvancing);const before=f.reads();
  for(let i=0;i<5;i++){f.music.update();await waitFor(()=>!f.music.autoAdvancing);}
  assert.equal(f.reads(),before,'failed automatic load is not retried each frame');
  assert.ok(f.music.nextRetryAt>performance.now(),'failed load applies retry delay');
  f.music.nextRetryAt=0;f.music.update();await waitFor(()=>!f.music.autoAdvancing);
  assert.ok(f.reads()>before,'next song can retry after the cooldown');
  f.music.setScreen('play');cases++;
}
for(const phase of ['prepared','download','decode']){
  const f=await fixture(phase), gamma={...entries[0],id:'song2',title:'Gamma'};
  f.music.app.store.listCharts=async()=>[...entries,gamma];
  f.music.setScreen('select');
  f.audio.decode=async()=>({duration:100});
  await f.music.select(gamma,true,await readNFMPreview(archive(gamma)));
  f.music.setScreen('menu');f.ctx.currentTime+=101;f.music.update();
  await waitFor(()=>f.music.playingChart?.id==='song0');
  assert.equal(f.music.autoAdvancing,false,'cancelled next-song wait cannot block later natural endings');
  f.gate.resolve(archive(entries[1]));await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.music.playingChart.id,'song0','late cancelled task cannot replace newer recording');
  assert.equal(f.music.nextRetryAt,0,'stale finally cannot set a retry delay on a newer task');
  f.music.setScreen('play');cases++;
}
console.log(`PASS ${cases} playlist cancellation/retry cases: prepared/download/decode boundaries, pause, seek, screen round trip, metadata restoration, bounded retries and immediate task release`);
