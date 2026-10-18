import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { MenuMusic, menuHighlightRanges } from '../src/ui/menu-music.ts';
import { drawMenuBeatEdges, MenuScreen } from '../src/ui/screens/menu.ts';
import { UI } from '../src/ui/widgets.ts';
import { buildNFM } from '../src/core/nfm.ts';
import { AudioEngine } from '../src/engine/audio.ts';

for (const font of ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/segoeui.ttf']) if (fs.existsSync(font)) GlobalFonts.registerFromPath(font, font.includes('msyh') ? 'Microsoft YaHei' : 'Segoe UI');

let reduced = false, bass = .2, energy = .6;
globalThis.window = { matchMedia: () => ({ get matches() { return reduced; } }) };
const settings = { particles: true, previewVolume: .4 };
const audio = { previewTimeSec: 0, previewActive: true, ctx: { state: 'running' },
  samplePreviewSpectrum: () => ({ bands: new Float32Array(17).fill(.35), bass, energy }) };
const music = new MenuMusic({ settings, audio });
music.timing = [{ t: 0, bpm: 120 }, { t: 4000, bpm: 240 }];
music.highlightRanges = menuHighlightRanges({meta:{previewTime:2000}},90000);
let visual = music.visualizer(16);
assert.ok(visual.leftImpact > .5 && visual.rightImpact > .5, 'first normal downbeat pulses both sides');
assert.equal(visual.leftImpact,visual.rightImpact,'normal downbeat sides are synchronous');
const first = visual;
audio.previewTimeSec = .25; visual = music.visualizer(250);
assert.ok(Math.abs(visual.leftImpact / first.leftImpact - .75) < .001, 'normal half-beat impact follows osu quadratic fade to 75%');
audio.previewTimeSec = .5; visual = music.visualizer(250);
assert.ok(visual.rightImpact < .08 && visual.leftImpact < .08, 'intermediate normal beat does not start another flash');
audio.previewTimeSec = .73; bass = 0; visual = music.visualizer(230);
const beforeTransient = {left:visual.leftImpact,right:visual.rightImpact,pulse:visual.pulse};
audio.previewTimeSec = .75; bass = .4; visual = music.visualizer(20);
assert.ok(visual.pulse > beforeTransient.pulse, 'actual bass onset drives the icon between beats');
assert.ok(visual.leftImpact <= beforeTransient.left && visual.rightImpact <= beforeTransient.right, 'offbeat bass cannot create an extra edge flash');
bass = .2; audio.previewTimeSec = 1.96; music.visualizer(1210);
audio.previewTimeSec = 2; visual = music.visualizer(40);
assert.ok(visual.previewSection && visual.leftImpact > first.leftImpact * 1.5, 'preview section strengthens beat impact');
assert.equal(visual.fountainAgeMs,0,'crossing authored kiai boundary starts smoke fountains');
assert.ok(Number.isFinite(visual.fountainSeed),'fountain trigger has a deterministic seed');
assert.equal(visual.sectionBurst,0,'old triangle burst is retired');
const section = visual;
audio.previewTimeSec = 2.1; visual = music.visualizer(100);
assert.ok(visual.fountainAgeMs >= 99 && visual.fountainAgeMs <= 101,'active fountain ages with real playback');
assert.equal(visual.fountainSeed,section.fountainSeed,'remaining inside kiai does not retrigger the fountain');
audio.previewTimeSec = 4.25; visual = music.visualizer(2150);
assert.ok(visual.rightImpact > .9 && visual.leftImpact < .01, 'new BPM uses current point and beat parity');
const fastBeatPeak = visual.rightImpact;
audio.previewTimeSec = 4.375; visual = music.visualizer(125);
assert.ok(Math.abs(visual.rightImpact / fastBeatPeak - .75) < .001, 'faster tempo scales the same quadratic fade to the current beat length');
audio.previewTimeSec = 1; music.visualizer(16);
audio.previewTimeSec = 2.2; visual = music.visualizer(16);
assert.equal(visual.fountainAgeMs,-1,'seeking past preview point does not manufacture a fountain');
audio.previewTimeSec = 10; visual = music.visualizer(7800);
assert.equal(visual.previewSection, true, 'preview fallback remains active for a fixed 30 seconds despite BPM changes');
audio.previewTimeSec = 31.999; visual = music.visualizer(21999); assert.equal(visual.previewSection,true);
audio.previewTimeSec = 32; visual = music.visualizer(1);
assert.equal(visual.previewSection, false, 'preview fallback ends exactly 30 seconds after the authored preview');

const expectQuiet = reason => {
  visual = music.visualizer(16);
  for (const field of ['pulse', 'leftImpact', 'rightImpact', 'sectionBurst', 'energy']) assert.equal(visual[field], 0, `${reason}: ${field}`);
  assert.equal(visual.fountainAgeMs,-1,reason+': smoke fountain cancelled');
  assert.ok(visual.bands.every(value => value === 0), reason + ': spectrum rests');
};
audio.previewActive = false; expectQuiet('paused'); audio.previewActive = true;
energy = 0; expectQuiet('silent audio'); energy = .6;
settings.previewVolume = 0; expectQuiet('preview muted'); settings.previewVolume = .4;
audio.ctx.state = 'suspended'; expectQuiet('audio suspended'); audio.ctx.state = 'running';
settings.particles = false;
audio.previewTimeSec = 1.96; music.visualizer(16); audio.previewTimeSec = 2; visual = music.visualizer(40);
assert.ok(visual.pulse > .9 && visual.energy > 0 && visual.bands.some(value => value > 0), 'particles off preserves audible spectrum and icon beat');
assert.ok(visual.leftImpact > .9, 'particles off preserves rhythmic side impact');
assert.equal(visual.fountainAgeMs,0,'hit particles off preserves menu smoke fountains');
assert.equal(visual.reducedMotion,false);
settings.particles = true;
audio.previewTimeSec = 1.96; music.visualizer(16); audio.previewTimeSec = 2;
assert.equal(music.visualizer(40).fountainAgeMs,0,'hit particles on also allows fountains on a new natural kiai entry');
reduced = true;
audio.previewTimeSec = 1.96; music.visualizer(16); audio.previewTimeSec = 2; visual = music.visualizer(40);
assert.ok(visual.pulse > .9 && visual.energy > 0 && visual.bands.some(value => value > 0), 'reduced motion preserves audible spectrum and icon beat');
assert.equal(visual.reducedMotion,true,'reduced motion is reported to the real menu renderer');
for (const field of ['leftImpact','rightImpact','sectionBurst']) assert.equal(visual[field],0,'reduced motion suppresses edge/triangle flashes: '+field);
assert.equal(visual.fountainAgeMs,-1,'reduced motion suppresses smoke fountains');
reduced = false;

// Normal two-beat synchronous cadence and kiai's one-side-each-beat cadence.
const cadenceMusic=new MenuMusic({settings,audio});cadenceMusic.timing=[{t:0,bpm:120}];
for(let beat=0;beat<=4;beat++){
  audio.previewTimeSec=beat*.5;const cadence=cadenceMusic.visualizer(beat?500:16);
  if(beat%2===0){assert.ok(cadence.leftImpact>.5&&cadence.rightImpact>.5,`normal beat ${beat}: both sides flash`);assert.equal(cadence.leftImpact,cadence.rightImpact);}
  else assert.ok(cadence.leftImpact<.08&&cadence.rightImpact<.08,`normal beat ${beat}: no fresh intermediate flash`);
}
cadenceMusic.highlightRanges=[{t:3000,end:7000}];
for(let beat=6;beat<=9;beat++){
  audio.previewTimeSec=beat*.5;const cadence=cadenceMusic.visualizer(500);
  const active=beat%2===0?'leftImpact':'rightImpact',inactive=beat%2===0?'rightImpact':'leftImpact';
  assert.ok(cadence[active]>.9,`kiai beat ${beat}: alternate active side`);assert.ok(cadence[inactive]<.08,`kiai beat ${beat}: inactive side stays dark`);
}
// A louder transient inside the active first beat must not relatch its edge
// amplitude; compare to the already observed peak while the icon reacts.
const latchedMusic=new MenuMusic({settings,audio});latchedMusic.timing=[{t:0,bpm:120}];
audio.previewTimeSec=0;energy=.1;bass=0;const latchedPeak=latchedMusic.visualizer(16);
audio.previewTimeSec=.125;energy=.6;bass=.4;const louderOffbeat=latchedMusic.visualizer(125);
assert.ok(louderOffbeat.pulse>latchedPeak.pulse,'louder offbeat transient remains visible in the icon');
assert.ok(Math.abs(louderOffbeat.leftImpact/latchedPeak.leftImpact-.9375)<.001,'active normal edge retains event amplitude and only follows quarter-beat quadratic fade');
assert.equal(louderOffbeat.leftImpact,louderOffbeat.rightImpact,'offbeat transient preserves synchronous normal sides');
bass=.2;
const triggerMusic=new MenuMusic({settings,audio});triggerMusic.timing=[{t:0,bpm:120}];triggerMusic.highlightRanges=[{t:1000,end:5000}];
audio.previewTimeSec=.9;triggerMusic.visualizer(16);audio.previewTimeSec=1.3;
let trigger=triggerMusic.visualizer(400);assert.equal(trigger.fountainAgeMs,0,'natural kiai entry within 500ms starts a fountain');
const triggerSeed=trigger.fountainSeed;
audio.previewTimeSec=1.45;trigger=triggerMusic.visualizer(150);
assert.ok(Math.abs(trigger.fountainAgeMs-150)<.001);assert.equal(trigger.fountainSeed,triggerSeed,'remaining in kiai keeps the same fountain trigger');
audio.previewActive=false;assert.equal(triggerMusic.visualizer(16).fountainAgeMs,-1,'pause immediately cancels an active fountain');
audio.previewActive=true;audio.previewTimeSec=1.5;assert.equal(triggerMusic.visualizer(50).fountainAgeMs,-1,'resume inside same kiai does not replay fountains');
audio.previewTimeSec=.95;triggerMusic.visualizer(16);audio.previewTimeSec=1.25;
assert.equal(triggerMusic.visualizer(16).fountainAgeMs,-1,'a short 300ms forward seek across kiai entry must not create a fountain');
audio.previewTimeSec=.95;triggerMusic.visualizer(16);audio.previewTimeSec=1;
assert.equal(triggerMusic.visualizer(50).fountainAgeMs,0,'leaving kiai then naturally entering can trigger again');
audio.previewTimeSec=2.8;assert.equal(triggerMusic.visualizer(1800).fountainAgeMs,-1,'fountain completely ends by 1800ms');
const lateMusic=new MenuMusic({settings,audio});lateMusic.timing=[{t:0,bpm:120}];lateMusic.highlightRanges=[{t:1000,end:5000}];
audio.previewTimeSec=1.5;assert.equal(lateMusic.visualizer(16).fountainAgeMs,-1,'first observing a kiai section 500ms late does not replay fountain');

// Importers provide original kiai markers where available. Only missing markers
// fall back to authored/legacy previews, then current decoded-audio analysis.
let analysisCalls = 0;
const analysis = () => { analysisCalls++; return 42000; };
assert.deepEqual(menuHighlightRanges({kiai:[{t:10000,end:15000},{t:12000,end:18000},{t:-10,end:1000},{t:95000,end:110000}],meta:{previewTime:2000}},100000,analysis),
  [{t:0,end:1000},{t:10000,end:18000},{t:95000,end:100000}], 'original kiai is clipped, sorted, merged and preferred');
assert.equal(analysisCalls,0,'real kiai never invokes fallback analysis');
assert.deepEqual(menuHighlightRanges({meta:{previewTime:0,previewSource:'authored'}},90000,analysis),[{t:0,end:30000}],'explicit zero preview is authored');
assert.deepEqual(menuHighlightRanges({meta:{previewTime:80000}},90000,analysis),[{t:80000,end:90000}],'legacy preview clamps at audio end');
assert.equal(analysisCalls,0,'legacy nonnegative preview remains authored');
assert.deepEqual(menuHighlightRanges({meta:{previewTime:1000,previewSource:'generated'}},90000,analysis),[{t:42000,end:72000}],'generated preview uses decoded-audio highlight');
assert.deepEqual(menuHighlightRanges({meta:{previewTime:-1}},90000,analysis),[{t:42000,end:72000}],'absent authored preview uses decoded audio');
assert.equal(analysisCalls,2);
assert.deepEqual(menuHighlightRanges({meta:{previewTime:-1}},0,analysis),[]);
assert.deepEqual(menuHighlightRanges({meta:{previewTime:-1}},NaN,analysis),[]);
assert.equal(analysisCalls,2,'unknown/invalid duration has no accent and performs no analysis');
assert.deepEqual(menuHighlightRanges({meta:{previewTime:-1}},8000,()=>0),[{t:0,end:8000}],'short clips use available duration');
assert.deepEqual(menuHighlightRanges({meta:{previewTime:-1}},10000,()=>NaN),[{t:0,end:10000}],'unavailable analysis has a finite fallback');
music.highlightRanges=[{t:5000,end:5500},{t:8000,end:9000}];
audio.previewTimeSec=4.96;music.visualizer(16);audio.previewTimeSec=5;
assert.equal(music.visualizer(40).previewSection,true,'actual marker start activates section');
audio.previewTimeSec=5.5;assert.equal(music.visualizer(500).previewSection,false,'actual marker end deactivates section');
audio.previewTimeSec=7.96;music.visualizer(2460);audio.previewTimeSec=8;
assert.equal(music.visualizer(40).fountainAgeMs,0,'second original kiai interval emits its own fountain');
music.highlightRanges=menuHighlightRanges({meta:{previewTime:-1,previewSource:'generated'}},90000,()=>42000);
audio.previewTimeSec=41.96;music.visualizer(33960);audio.previewTimeSec=42;
assert.equal(music.visualizer(40).previewSection,true,'audio-derived range starts at the analyzed section');
audio.previewTimeSec=72;assert.equal(music.visualizer(30000).previewSection,false,'audio-derived range also ends at 30 seconds');

const chart = { format:'neonfall-chart',version:1,keys:4,od:8,offset:0,timing:[{t:0,bpm:120}],sv:[],breaks:[],notes:[],
  meta:{title:'Song',artist:'Artist',creator:'Mapper',version:'Hard',audio:'song.ogg',audioLeadIn:0,previewTime:2000,lengthMs:90000} };
const packageChart = overrides => buildNFM({...chart,...overrides,meta:{...chart.meta,...overrides.meta}},{'song.ogg':new Uint8Array([1,2,3])});

// Use the real archive selection and AudioEngine clock/control methods here:
// hand-written section fixtures miss decoder/analyser warm-up at preview start,
// and manually advancing previewTime cannot distinguish an actual seek from a
// clamped UI frame delta after a main-thread stall.
const entrySources = [
  {name:'native',chart:{kiai:[{t:1000,end:31000}],meta:{previewTime:5000,previewSource:'authored'}}},
  {name:'authored-preview',chart:{meta:{previewTime:1000,previewSource:'authored'}}},
  {name:'computed',chart:{meta:{previewTime:5000,previewSource:'generated'}}},
];
const entryGain=()=>({gain:{value:0,linearRampToValueAtTime(v){this.value=v;},cancelScheduledValues(){},setValueAtTime(v){this.value=v;}},connect(){},disconnect(){}});
async function entryFixture(source,fromStart=true,initialState='running'){
  const clock={currentTime:10,state:initialState,gestureUnlocked:false,
    resume(){if(this.gestureUnlocked)this.state='running';return Promise.resolve();},
    createGain:entryGain,createBufferSource(){return {connect(){},disconnect(){},start(){},stop(){}};}};
  const engine=new AudioEngine();engine.ctx=clock;engine.master=entryGain();engine.decode=async()=>({duration:90});
  let sampleEnergy=.6,analysisCount=0;
  engine.samplePreviewSpectrum=()=>({bands:new Float32Array(17).fill(sampleEnergy),bass:.2,energy:sampleEnergy});
  engine.previewHighlightMs=()=>{analysisCount++;return 1000;};
  const app={settings:{particles:true,previewVolume:.4},screen:{name:'menu'},audio:engine,
    store:{getChartBytes:async()=>packageChart(source.chart),listCharts:async()=>[]}};
  const controller=new MenuMusic(app);controller.enabled=true;
  await controller.select({id:'entry-'+source.name,title:source.name},fromStart);
  clock.currentTime+=.02; // AudioEngine schedules the source 20ms ahead.
  assert.deepEqual(controller.highlightRanges,[{t:1000,end:31000}],source.name+': real NFM/decode selection resolves the expected kiai range');
  assert.equal(analysisCount,source.name==='computed'?1:0,source.name+': only generated preview invokes audio analysis');
  return {app,audio:engine,music:controller,clock,
    energy(value){sampleEnergy=value;},
    advance(ms,dt=ms){clock.currentTime+=ms/1000;return controller.visualizer(dt);},
    frame(dt=16){return controller.visualizer(dt);},
    screen(name){app.screen={name};controller.setScreen(name);},
    dispose(){engine.stopPreview();},
  };
}
for(const source of entrySources){
  const f=await entryFixture(source);
  f.advance(960);f.energy(0);
  assert.equal(f.advance(40).fountainAgeMs,-1,source.name+': silent boundary does not draw a fountain');
  assert.equal(f.advance(700).fountainAgeMs,-1,source.name+': analyser warm-up longer than 500ms remains visually quiet');
  f.energy(.6);const started=f.advance(16);
  assert.equal(started.previewSection,true,source.name+': fallback/native section remains active after warm-up');
  assert.equal(started.fountainAgeMs,0,source.name+': first audible sample consumes pending entry exactly once');
  const seed=started.fountainSeed;
  assert.ok(seed>0,source.name+': a fountain was emitted');
  assert.ok(Math.abs(f.advance(100).fountainAgeMs-100)<.001,source.name+': pending entry starts a complete effect rather than an already expired effect');
  f.energy(0);assert.equal(f.advance(80).fountainAgeMs,-1,source.name+': brief silence hides the active fountain');
  f.energy(.6);const continued=f.advance(80);
  assert.ok(Math.abs(continued.fountainAgeMs-260)<.001,source.name+': audible recovery resumes the original remaining lifetime');
  assert.equal(continued.fountainSeed,seed,source.name+': a short silence does not replace the active fountain seed');
  assert.equal(f.advance(1800).fountainAgeMs,-1,source.name+': one fountain finishes while section continues');
  f.energy(0);f.advance(80);f.energy(.6);const resumed=f.advance(80);
  assert.equal(resumed.fountainAgeMs,-1,source.name+': later musical silence does not re-arm the consumed entry');
  assert.equal(resumed.fountainSeed,seed,source.name+': sustained kiai never emits a second fountain');
  f.dispose();

  const initial=await entryFixture(source,false);initial.energy(0);
  assert.equal(initial.frame().fountainAgeMs,-1,source.name+': initial preview analyser is quiet');
  initial.advance(700);initial.energy(.6);
  assert.equal(initial.advance(16).fountainAgeMs,0,source.name+': newly selected preview starts its one fountain even when preview begins inside a range');
  initial.dispose();

  const stall=await entryFixture(source);stall.advance(900);
  assert.equal(stall.advance(800,50).fountainAgeMs,0,source.name+': natural audio progress across entry survives App dt capped at 50ms');
  stall.dispose();

  const unlock=await entryFixture(source,false,'suspended');unlock.energy(0);
  assert.equal(unlock.clock.state,'suspended',source.name+': automatic resume request remains blocked before a browser gesture');
  const lockedTime=unlock.audio.previewTimeSec;
  for(let frame=0;frame<20;frame++)assert.equal(unlock.frame(50).fountainAgeMs,-1,source.name+': waiting for initial gesture draws no fountain');
  assert.equal(unlock.audio.previewTimeSec,lockedTime,source.name+': blocked audio clock remains frozen');
  unlock.clock.gestureUnlocked=true;unlock.audio.resume();
  assert.equal(unlock.clock.state,'running',source.name+': actual AudioEngine.resume unlocks the initial context');
  assert.equal(unlock.advance(700).fountainAgeMs,-1,source.name+': initial unlock still waits through analyser warm-up');
  unlock.energy(.6);const unlocked=unlock.advance(16);
  assert.equal(unlocked.fountainAgeMs,0,source.name+': initial gesture unlock preserves the one pending preview fountain');
  const unlockedSeed=unlocked.fountainSeed;unlock.advance(100);
  unlock.clock.state='suspended';assert.equal(unlock.frame().fountainAgeMs,-1,source.name+': later context suspension cancels active fountain');
  unlock.audio.resume();
  assert.equal(unlock.advance(50).fountainAgeMs,-1,source.name+': later context resume does not replay the original fountain');
  assert.equal(unlock.frame().fountainSeed,unlockedSeed,source.name+': only initial browser activation can retain the pending entry');
  unlock.dispose();
}
console.log('PASS real NFM/AudioEngine native, authored-preview and computed entry across silent FFT warm-up, initial preview, gesture unlock and clamped frame stalls');

// A pending entry is not a license to replay the effect after an explicit user
// interruption, and returning to the menu is not a fresh music-section entry.
for(const kind of ['pause','mute','seek','reduced-motion']){
  const f=await entryFixture(entrySources[0]);f.advance(960);f.energy(0);f.advance(40);
  if(kind==='pause'){f.audio.pausePreview();f.frame();f.audio.resumePreview();f.clock.currentTime+=.02;}
  if(kind==='mute'){f.app.settings.previewVolume=0;f.audio.setPreviewVolume(0);f.frame();f.app.settings.previewVolume=.4;f.audio.setPreviewVolume(.4);}
  if(kind==='seek'){f.audio.seekPreview(2);f.clock.currentTime+=.02;f.frame();}
  if(kind==='reduced-motion'){reduced=true;f.frame();reduced=false;}
  f.energy(.6);assert.equal(f.advance(16).fountainAgeMs,-1,kind+': explicit interruption cancels pending entry without a later spray');
  f.dispose();
}
const seekEntry=await entryFixture(entrySources[0]);seekEntry.advance(960);
seekEntry.audio.seekPreview(1.1);seekEntry.clock.currentTime+=.02;
assert.equal(seekEntry.frame().fountainAgeMs,-1,'actual seek close to kiai start cannot masquerade as natural entry');
seekEntry.audio.seekPreview(.96);seekEntry.clock.currentTime+=.02;seekEntry.frame();
assert.equal(seekEntry.advance(50).fountainAgeMs,0,'seeking before entry still permits the next natural crossing');
seekEntry.dispose();
const submenuEntry=await entryFixture(entrySources[0]);submenuEntry.advance(900);submenuEntry.screen('settings');
submenuEntry.clock.currentTime+=2;submenuEntry.music.update();submenuEntry.screen('menu');
assert.equal(submenuEntry.frame().fountainAgeMs,-1,'returning from a submenu inside kiai does not replay an already missed entry');
submenuEntry.dispose();
const loopEntry=await entryFixture(entrySources[1],false);const loopSeed=loopEntry.frame().fountainSeed;
loopEntry.advance(88900);assert.equal(loopEntry.audio.previewLoopCount,0);
assert.equal(loopEntry.advance(200,50).fountainAgeMs,0,'natural full-song loop entering the preview section emits once without a transport seek');
assert.equal(loopEntry.audio.previewLoopCount,1);assert.equal(loopEntry.frame().fountainSeed,loopSeed+1);
assert.ok(loopEntry.advance(100).fountainAgeMs>0,'subsequent frames after loop keep the same fountain');
assert.equal(loopEntry.frame().fountainSeed,loopSeed+1,'natural loop emits once, not once per loop-count observation');loopEntry.dispose();
console.log('PASS pending entry cancellation for pause, mute, seek and effect preferences; no late submenu replay');

// The player's hit-particle preference must never consume or cancel a menu
// entry, including while waiting for the analyser or the first audio gesture.
for(const source of entrySources){
  const f=await entryFixture(source);
  f.app.settings.particles=false;f.advance(960);f.energy(0);f.advance(40);
  f.advance(700);f.energy(.6);const started=f.advance(16);
  assert.equal(started.fountainAgeMs,0,source.name+': hit particles off retains pending menu entry');
  f.app.settings.particles=true;f.advance(100);f.app.settings.particles=false;
  const active=f.advance(100);
  assert.ok(Math.abs(active.fountainAgeMs-200)<.001,source.name+': changing hit particles does not cancel the active fountain');
  assert.equal(active.fountainSeed,started.fountainSeed,source.name+': hit-particle toggles do not retrigger');
  assert.equal(f.advance(1800).fountainAgeMs,-1,source.name+': fountain still expires once with hit particles off');
  f.dispose();
  const locked=await entryFixture(source,false,'suspended');
  locked.app.settings.particles=false;locked.energy(0);locked.frame();
  locked.clock.gestureUnlocked=true;locked.audio.resume();locked.advance(700);locked.energy(.6);
  assert.equal(locked.advance(16).fountainAgeMs,0,source.name+': hit particles off retains initial browser-unlock entry');
  locked.dispose();
}
console.log('PASS hit-particle preference is independent of native/preview/computed menu fountains, pending entry, unlock and lifetime');

const packages = new Map([
  ['original',packageChart({kiai:[{t:10000,end:20000}]})],
  ['generated',packageChart({meta:{previewTime:12000,previewSource:'generated'}})],
  ['failed',packageChart({kiai:[{t:1000,end:8000}]})],
]);
const imageLoads=[];let decodeFailure=false,selectedAnalysis=0;
const archiveAudio={previewActive:true,previewDurationSec:90,cancelPreviewLoad(){},stopAmbient(){},
  async previewMusic(){return !decodeFailure;},previewHighlightMs(){selectedAnalysis++;return 42000;}};
const archiveApp={settings:{previewVolume:.4},audio:archiveAudio,store:{getChartBytes:async id=>packages.get(id)}};
const archiveMusic=new MenuMusic(archiveApp);archiveMusic.enabled=true;
archiveMusic.loadBackground=()=>new Promise(resolve=>imageLoads.push(resolve));
await archiveMusic.select({id:'original',title:'Original'},true);
assert.deepEqual(archiveMusic.highlightRanges,[{t:10000,end:20000}]);assert.equal(selectedAnalysis,0);
await archiveMusic.select({id:'generated',title:'Generated'},true);
assert.deepEqual(archiveMusic.highlightRanges,[{t:42000,end:72000}]);assert.equal(selectedAnalysis,1);
const currentImage={id:'current'};imageLoads[1](currentImage);await Promise.resolve();
imageLoads[0]({id:'stale'});await Promise.resolve();assert.equal(archiveMusic.background,currentImage,'late previous artwork cannot overwrite current song');
const currentArchive=archiveApp.previewChart,currentRanges=archiveMusic.highlightRanges;
decodeFailure=true;await archiveMusic.select({id:'failed',title:'Failed'},true);
imageLoads[2]({id:'failed'});await Promise.resolve();
assert.equal(archiveMusic.entry.id,'generated');assert.equal(archiveMusic.highlightRanges,currentRanges,'failed decode preserves current kiai');
assert.equal(archiveMusic.background,currentImage,'failed decode preserves current artwork');
assert.equal(archiveApp.previewChart,currentArchive,'failed decode preserves currently playing archive');
assert.equal(selectedAnalysis,1,'failed decode never analyzes the previous buffer as a new song');
decodeFailure=false;
let oldFetch;archiveApp.store.getChartBytes=id=>id==='stale-fetch'?new Promise(resolve=>{oldFetch=resolve;}):Promise.resolve(packages.get(id));
const staleSelection=archiveMusic.select({id:'stale-fetch',title:'Stale'},true);
await archiveMusic.select({id:'original',title:'Original'},true);
oldFetch(packages.get('generated'));await staleSelection;
assert.equal(archiveMusic.entry.id,'original');assert.deepEqual(archiveMusic.highlightRanges,[{t:10000,end:20000}],'superseded fetch cannot replace actual kiai');
assert.equal(archiveApp.previewChart.id,'original');
console.log('PASS original kiai precedence, authored/legacy/generated preview handling, 30-second audio-derived fallback, real decode commit and stale/failed song isolation');

// Keep the resting frame used by the render assertions truly quiet.
energy=0;expectQuiet('quiet render fixture');energy=.6;

const out = path.resolve('test-results/menu-effects'); fs.mkdirSync(out, { recursive: true });
const edgeOut=path.resolve('test-results/edge-smoke');fs.mkdirSync(edgeOut,{recursive:true});
globalThis.document={createElement:tag=>tag==='canvas'?createCanvas(1,1):{style:{}}};
function render(w, h, value, name) {
  const canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d1218'; ctx.fillRect(0, 0, w, h);
  const angular=[];
  for(const method of ['moveTo','lineTo','closePath']){const original=ctx[method].bind(ctx);ctx[method]=(...args)=>{angular.push(method);return original(...args);};}
  drawMenuBeatEdges(ctx, w, h, value);
  assert.equal(angular.length,0,'edge renderer contains no angular path or triangle geometry');
  assert.deepEqual(Array.from(ctx.getImageData(w / 2 | 0, h / 2 | 0, 1, 1).data), [13,18,24,255], 'beat effects never cover screen centre');
  assert.equal(ctx.globalAlpha, 1); assert.equal(ctx.globalCompositeOperation, 'source-over');
  if (name) fs.writeFileSync(path.join(out, name + '.png'), canvas.toBuffer('image/png'));
  return canvas;
}
for (const [w,h] of [[1280,720],[780,360],[360,780]]) {
  const left = render(w,h,{...first,leftImpact:1,rightImpact:0,previewSection:false},`${w}x${h}-left`);
  const right = render(w,h,{...first,leftImpact:0,rightImpact:1,previewSection:false},`${w}x${h}-right`);
  const leftCtx = left.getContext('2d'), rightCtx = right.getContext('2d');
  assert.ok(leftCtx.getImageData(1,h*.5|0,1,1).data[0] > leftCtx.getImageData(w-2,h*.5|0,1,1).data[0], 'left impact is visually left');
  assert.ok(rightCtx.getImageData(w-2,h*.5|0,1,1).data[0] > rightCtx.getImageData(1,h*.5|0,1,1).data[0], 'right impact is visually right');
  const kiai=render(w,h,{...section,leftImpact:1,rightImpact:0,sectionBurst:0,previewSection:true},`${w}x${h}-preview`);
  const normalRow=leftCtx.getImageData(0,h*.5|0,w,1).data,kiaiCtx=kiai.getContext('2d'),kiaiRow=kiaiCtx.getImageData(0,h*.5|0,w,1).data;
  const normalWidth=Math.min(72,w*.07),kiaiWidth=Math.min(116,w*.11);
  for(const [row,name] of [[normalRow,'normal'],[kiaiRow,'kiai']]){
    for(let x=1;x<w/2;x++)assert.ok(row[x*4]<=row[(x-1)*4]+1,`${w}px ${name}: brightness decreases from edge to centre`);
    for(let x=Math.ceil(w/2);x<w;x++)assert.deepEqual(Array.from(row.slice(x*4,x*4+4)),[13,18,24,255],`${w}px ${name}: inactive half remains unchanged`);
  }
  assert.ok(normalRow[Math.ceil(normalWidth)*4]-13<=7,'normal light outside the edge core stays below 3% white');
  assert.ok(normalRow[Math.round(w*.25)*4]>13,'normal beats also have a subtle screen wash');
  assert.ok(normalRow[Math.round(Math.min(52,w*.05))*4]>20,'wider edge has visible energy beyond the old narrow band');
  const widerX=Math.ceil(normalWidth)+2,outsideKiai=Math.ceil(kiaiWidth)+3;
  assert.ok(kiaiRow[widerX*4]>normalRow[widerX*4]+1,'kiai narrow gradient extends slightly beyond normal band');
  assert.ok(kiaiRow[widerX*4]>kiaiRow[outsideKiai*4]+1,'kiai has a distinct narrow core before the half-screen accent');
  const faintX=Math.round(w*.25),faint=kiaiRow[faintX*4]-13;
  assert.ok(faint>normalRow[faintX*4]-13&&faint<=10,'kiai wash is stronger than normal but stays restrained');
  assert.deepEqual(Array.from(leftCtx.getImageData(0,h*.2|0,w,1).data),Array.from(normalRow),'horizontal normal gradient has no pointed vertical profile');
  assert.deepEqual(Array.from(kiaiCtx.getImageData(0,h*.8|0,w,1).data),Array.from(kiaiRow),'horizontal kiai gradient has no pointed vertical profile');
  const kiaiRight=render(w,h,{...section,leftImpact:0,rightImpact:1,sectionBurst:0,previewSection:true});
  const rightRow=kiaiRight.getContext('2d').getImageData(0,h*.5|0,w,1).data;
  for(let x=0;x<w/2;x++)assert.deepEqual(Array.from(rightRow.slice(x*4,x*4+4)),[13,18,24,255],'right kiai gradient does not cross centre');
  fs.writeFileSync(path.join(edgeOut,`normal-gradient-${w}x${h}.png`),left.toBuffer('image/png'));
  fs.writeFileSync(path.join(edgeOut,`kiai-gradient-${w}x${h}.png`),kiai.toBuffer('image/png'));
  const quiet = render(w,h,visual);
  assert.deepEqual(Array.from(quiet.getContext('2d').getImageData(1,h*.5|0,1,1).data),[13,18,24,255],'quiet visual draws no white edge');
  const reducedFrame=render(w,h,{...section,leftImpact:1,rightImpact:1,reducedMotion:true});
  assert.deepEqual(Array.from(reducedFrame.getContext('2d').getImageData(1,h*.5|0,1,1).data),[13,18,24,255],'reduced motion suppresses even stale nonzero impulses');
}
for (const [w,h] of [[1280,720],[360,780]]) {
  const canvas = createCanvas(w,h),ctx = canvas.getContext('2d');
  const app = { w,h,ctx,settings,account:{user:null},serverOnline:false,platform:'desktop',version:'0.2.4',
    menuMusic:{drawBackground(ctx,width,height){ctx.fillStyle='#0d1218';ctx.fillRect(0,0,width,height);}},uiSound(){},gotoScreen(){} };
  app.ui = new UI(app);
  const screen = new MenuScreen(app);screen.enter();screen.t0=-10000;
  screen.visual={...section,sectionBurst:0,fountainAgeMs:350,fountainSeed:42};
  app.ui.beginFrame({x:-1,y:-1,down:false,downX:0,downY:0,moved:false});screen.draw(ctx);app.ui.endFrame();
  fs.writeFileSync(path.join(out,`menu-preview-${w}x${h}.png`),canvas.toBuffer('image/png'));
}

// Exercise the real MenuScreen.update -> MenuMusic.visualizer -> draw chain.
// Both frames are audible and share the SAME playback position, so ordinary
// orbiting or moving text cannot fake a passing spectrum/beat regression.
const rhythmOut = path.resolve('test-results/rhythm-fix'); fs.mkdirSync(rhythmOut,{recursive:true});
const regression=[];
const changedPixels=(a,b)=>{let count=0;for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3])count++;return count;};
for(const scenario of [
  {name:'normal',particles:true,reduced:false},
  {name:'particles-off',particles:false,reduced:false},
  {name:'reduced-motion',particles:true,reduced:true},
]){
  reduced=scenario.reduced;let strong=false;
  const w=1280,h=720,canvas=createCanvas(w,h),ctx=canvas.getContext('2d');
  const testAudio={previewTimeSec:2,previewActive:true,ctx:{state:'running'},samplePreviewSpectrum(){return {
    bands:new Float32Array(17).fill(strong?.75:.08),bass:strong?.5:.02,energy:strong?.6:.08,
  };}};
  const app={w,h,ctx,settings:{particles:scenario.particles,previewVolume:.4},audio:testAudio,
    account:{user:null},serverOnline:false,platform:'desktop',version:'0.2.4',uiSound(){},gotoScreen(){}};
  app.ui=new UI(app);app.menuMusic=new MenuMusic(app);
  app.menuMusic.timing=[{t:0,bpm:120}];app.menuMusic.highlightRanges=[{t:2000,end:32000}];
  const screen=new MenuScreen(app);screen.enter();screen.t0=-10000;
  const snapshots=[];
  for(const label of ['quiet-beat','strong-beat']){
    strong=label==='strong-beat';screen.update(16,2000);
    app.ui.beginFrame({x:-1,y:-1,down:false,downX:0,downY:0,moved:false});screen.draw(ctx);app.ui.endFrame();
    snapshots.push({
      icon:ctx.getImageData(690,140,500,450).data,
      bars:ctx.getImageData(890,325,185,115).data,
      pulse:screen.visual.pulse,
      band:screen.visual.bands[0],
    });
    fs.writeFileSync(path.join(rhythmOut,`${scenario.name}-${label}.png`),canvas.toBuffer('image/png'));
  }
  const iconChanged=changedPixels(snapshots[0].icon,snapshots[1].icon);
  const barsChanged=changedPixels(snapshots[0].bars,snapshots[1].bars);
  screen.update(0,2000);
  app.ui.beginFrame({x:-1,y:-1,down:false,downX:0,downY:0,moved:false});screen.draw(ctx);app.ui.endFrame();
  const controlChanged=changedPixels(snapshots[1].icon,ctx.getImageData(690,140,500,450).data);
  assert.equal(controlChanged,0,`${scenario.name}: unchanged audio input and clock render an identical icon`);
  assert.ok(snapshots[1].pulse>snapshots[0].pulse && snapshots[1].band>snapshots[0].band,`${scenario.name}: actual update keeps stronger musical input`);
  assert.ok(iconChanged>100,`${scenario.name}: real main icon pixels respond to the stronger audible beat`);
  assert.ok(barsChanged>100,`${scenario.name}: actual spectrum bar pixels change without audio-clock movement`);
  if(scenario.reduced){assert.equal(screen.visual.reducedMotion,true);assert.equal(screen.visual.leftImpact,0);assert.equal(screen.visual.rightImpact,0);}
  else assert.ok(screen.visual.leftImpact>0,`${scenario.name}: side beat remains active`);
  if(scenario.reduced)assert.equal(screen.visual.fountainAgeMs,-1);
  else assert.ok(screen.visual.fountainAgeMs>=0,`${scenario.name}: menu fountain remains active independently of hit particles`);
  regression.push({scenario:scenario.name,iconChanged,barsChanged,controlChanged,beforePulse:snapshots[0].pulse,afterPulse:snapshots[1].pulse,beforeBand:snapshots[0].band,afterBand:snapshots[1].band});
}
reduced=false;
fs.writeFileSync(path.join(rhythmOut,'menu-pixel-regression.json'),JSON.stringify({renderer:'Native Canvas with actual MenuScreen.update/draw and MenuMusic; simulated audible spectral input at fixed playback time',regression},null,2));
console.log('PASS real MenuScreen update/draw pixel changes for normal, particles off and reduced motion; audio-clock position fixed in both frames');
console.log('PASS two-beat normal cadence, alternating kiai sides, icon-only offbeat transients, narrow gradient pixels, faint active-half accent and retired angular geometry');
