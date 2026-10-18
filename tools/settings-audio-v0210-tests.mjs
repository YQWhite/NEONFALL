import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas, Image, GlobalFonts } from '@napi-rs/canvas';
import { resolveObjectURL } from 'node:buffer';
import { AudioEngine } from '../src/engine/audio.ts';
import { DEFAULT_SETTINGS, DEFAULT_MODS } from '../src/core/types.ts';
import { Store } from '../src/core/store.ts';
import { App } from '../src/ui/app.ts';
import { SettingsScreen } from '../src/ui/screens/settings.ts';
import { PlayScreen } from '../src/ui/screens/play.ts';
import { UI } from '../src/ui/widgets.ts';
import { setLanguage } from '../src/ui/i18n.ts';
import { TapCalibration } from '../src/ui/latency-calibration.ts';

const out = new URL('../test-results/v0210/', import.meta.url); fs.mkdirSync(out, { recursive: true });
for (const font of ['C:/Windows/Fonts/msyh.ttc','C:/Windows/Fonts/segoeui.ttf']) if(fs.existsSync(font)) GlobalFonts.registerFromPath(font);
const saved = new Map();
globalThis.localStorage = { getItem: key=>saved.get(key)??null, setItem: (key,value)=>saved.set(key,value) };
globalThis.document={documentElement:{},hidden:false,createElement:()=>createCanvas(1,1)};
globalThis.Image=class extends Image {set src(value){ const blob=resolveObjectURL(value); if(blob)blob.arrayBuffer().then(bytes=>{super.src=Buffer.from(bytes)});else super.src=value;} };
const nodes=[];
const param=()=>({value:1,cancelScheduledValues(){},setValueAtTime(v){this.value=v;},linearRampToValueAtTime(v){this.value=v;}});
class Context {
  state='running';currentTime=5;sampleRate=8000;destination={};
  async resume() {}
  createGain(){const n={gain:param(),connect(to){this.to=to;},disconnect(){}};nodes.push(n);return n;}
  createBufferSource(){return {connect(to){this.to=to;},start(){},stop(){},disconnect(){}};}
  createBuffer(_channels,length){return {duration:length/8000,getChannelData:()=>new Float32Array(length)};}
}
globalThis.window={AudioContext:Context,addEventListener(){},removeEventListener(){}};
for(const [old,expected] of [[{musicVolume:.4,previewVolume:.1},.4],[{previewVolume:.2},.2],[{musicVolume:0,previewVolume:.8},0],[{},.9]]){
 saved.set('nf.settings.v1',JSON.stringify(old));const store=new Store();assert.equal(store.settings.musicVolume,expected);assert.equal(store.settings.previewVolume,undefined);store.saveSettings();assert.equal(JSON.parse(saved.get('nf.settings.v1')).previewVolume,undefined);
}
saved.clear();
const audio=new AudioEngine(); const settings={...DEFAULT_SETTINGS,musicVolume:.4,sfxVolume:.3};
audio.applySettings(settings); assert.equal(audio.ctx,null,'saving settings must not create an AudioContext');
audio.ensure(); assert.equal(audio.musicGain.gain.value,.4);assert.equal(audio.sfxGain.gain.value,.3);
audio.decode=async()=>({duration:120});await audio.previewMusic(new Uint8Array(),'fixture',0,settings.musicVolume);
const previewSource=audio.previewSrc;assert.equal(audio.previewGain.gain.value,.4);
audio.setPreviewDucking(.08);settings.musicVolume=.6;audio.applySettings(settings);
assert.equal(audio.musicGain.gain.value,.6);assert.equal(audio.previewGain.gain.value,.048);assert.equal(audio.previewSrc,previewSource);
settings.sfxVolume=0;audio.applySettings(settings);App.prototype.uiSound.call({audio});
assert.equal(nodes.at(-1).to,audio.sfxGain,'UI click shares effects bus');assert.equal(audio.sfxGain.gain.value,0);
settings.musicVolume=0;audio.applySettings(settings);assert.equal(audio.previewGain.gain.value,0);assert.equal(audio.musicGain.gain.value,0);
let finishDecode; audio.decode=()=>new Promise(resolve=>{finishDecode=resolve;});
const loading=audio.previewMusic(new Uint8Array(),'slow',0,.8);
settings.musicVolume=.2;audio.applySettings(settings);finishDecode({duration:100});await loading;
assert.equal(audio.previewVolume,.2,'latest volume survives slow audio decode');
assert.equal(audio.previewGain.gain.value,.2*.08,'new preview preserves current volume and duck');
const calibration=new TapCalibration(audio.ctx,audio.sfxGain);await calibration.start(1);
assert.equal(nodes.at(-1).to,audio.sfxGain,'calibration shares live effects bus');
assert.equal(audio.sfxGain.gain.value,0,'muted effects keep calibration silent');calibration.cancel();
const directCalibration=new TapCalibration(audio.ctx);await directCalibration.start(0);
assert.equal(nodes.at(-1).gain.value,0,'standalone calibration also respects zero volume');directCalibration.cancel();

const store=new Store();store.listSkins=async()=>[];store.getSkinBytes=async()=>null;
const app={w:1280,h:800,settings:store.settings,store,audio,mods:{...DEFAULT_MODS},version:'test',platform:'web',isTouch:true,uiSound(){},gotoScreen(){},toast(){},saveSettings(){store.saveSettings();audio.applySettings(this.settings);}};
app.ui=new UI(app);const controls=[];for(const name of ['button','slider','chip']){const original=app.ui[name].bind(app.ui);app.ui[name]=(...args)=>{controls.push({id:args[0],x:args[1],y:args[2],w:args[3],h:args[4],args});return original(...args);};}
const game=new PlayScreen(app);game.sess={phase:'paused',resume(){},retry(){}};
function frame(draw,p={}){controls.length=0;app.ui.beginFrame({x:-1,y:-1,down:false,moved:false,...p});draw();app.ui.endFrame();}
setLanguage('zh-CN');
for(const [w,h] of [[568,320],[780,360],[1280,800]]){
 app.w=w;app.h=h;const canvas=createCanvas(w,h);app.ctx=canvas.getContext('2d');const draw=()=>game.drawPause(app.ctx);
 frame(draw);const targets=controls.filter(c=>c.id.startsWith('pause-')||c.id.startsWith('p-'));
 assert.equal(targets.length,8);
 for(const c of targets)assert.ok(c.x>=0&&c.y>=0&&c.x+c.w<=w&&c.y+c.h<=h,c.id+' fits');
 for(let i=0;i<targets.length;i++)for(let j=i+1;j<targets.length;j++){const a=targets[i],b=targets[j];assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y,a.id+' does not overlap '+b.id);}
 for(const [id,key]of [['pause-bgdim','bgDim'],['pause-sb-brightness','storyboardBrightness'],['pause-music','musicVolume'],['pause-sfx','sfxVolume']])for(const v of [0,.5,1]){
   frame(draw);const c=controls.find(c=>c.id===id),p={x:c.x+c.w*v,y:c.y+c.h/2};frame(draw,{...p,down:true,downX:p.x,downY:p.y});frame(draw,p);assert.equal(app.settings[key],key==='bgDim'?1-v:v);assert.equal(new Store().settings[key],app.settings[key]);
 }
 fs.writeFileSync(new URL(`pause-${w}x${h}.png`,out),canvas.toBuffer('image/png'));
}
app.w=1280;app.h=800;app.ctx=createCanvas(app.w,app.h).getContext('2d');const screen=new SettingsScreen(app);await screen.enter();
for(const skin of ['', 'builtin:malody'])for(const keys of [4,5,6,7,8]){
 app.settings.skinId=skin;screen.keyMode=keys;await screen.loadPreview();const notes=screen.preview.session.notes;
 for(const hold of notes.filter(n=>n.end!==undefined))assert.ok(!notes.some(n=>n!==hold&&n.col===hold.col&&n.t>=hold.t&&n.t<=hold.end+120),'preview tap cannot overlap hold lane or caps');
}
screen.tab='audio';frame(()=>screen.draw(app.ctx));assert.ok(controls.some(c=>c.id==='s-music'));assert.ok(controls.some(c=>c.id==='s-sfx'));assert.ok(!controls.some(c=>c.id==='s-preview'));
screen.leave();audio.stopPreview();
console.log('PASS unified music/effects, legacy preferences, audio bus, pause controls at 3 sizes, persisted brightness/volume, and preview hold separation in 10 skin/mode combinations');
