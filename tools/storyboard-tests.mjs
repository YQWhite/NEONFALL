import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseStoryboard, parseOsb, parseOsuChart, animFramePath } from '../src/core/osz.ts';
import { evaluateStoryboardObject as ev, storyboardSpan as span, storyboardFrame, StoryboardPlayer } from '../src/core/storyboard.ts';
import { importChartArchive } from '../src/core/import.ts';
import { readNFM } from '../src/core/nfm.ts';
import { zipFromMap, strToBytes } from '../src/core/zip.ts';
import { storyboardEase } from '../src/core/storyboard-easing.ts';
for(let id=0;id<=34;id++){assert.equal(storyboardEase(id,0),0);assert.equal(storyboardEase(id,1),1);assert.ok(Number.isFinite(storyboardEase(id,.37)));}
assert.equal(storyboardEase(0,.5),.5);assert.equal(storyboardEase(3,.5),.25);assert.equal(storyboardEase(4,.5),.75);
const parse = (...lines) => parseStoryboard(lines)[0];
let o = parse('Sprite,3,1,"folder/a,b.png",320,240','_F,0,-100,100,1','_S,0,0,,0.25','_M,0,0,100,0,0,100,100','_R,0,0,,1.5707963267948966');
assert.equal(o.path,'folder/a,b.png'); assert.equal(o.cmds[0].t2,100); assert.equal(ev(o,50).sx,.25); assert.equal(ev(o,50).x,50); assert.equal(ev(o,-101).visible,false); assert.equal(ev(o,101).visible,false);
// Constant MX shorthand places scripted notes in their own lanes. Older
// conversions silently omitted these commands and collapsed all notes to 320.
for (const x of [190,254,318,382]) {
 const note=parse('Sprite,Overlay,Centre,"note.png",320,240',` MX,0,1000,2000,${x}`,' MY,0,1000,2000,-10,430',' S,0,1000,,0.25');
 assert.equal(note.cmds[0].k,'MX'); assert.deepEqual(note.cmds[0].a,[x,x]);
 for (const t of [1000,1250,1500,2000]) assert.equal(ev(note,t).x,x);
 assert.equal(ev(note,1500).y,210);
}
o=parse('Sprite,Foreground,Centre,"a.png",0,0',' L,1000,3','  F,0,100,300,0,1');
// The loop period is its last end minus its first start (ppy/osu
// StoryboardCommandGroup.Duration), not its last relative timestamp.
assert.deepEqual(span(o.cmds),{min:1100,max:1700});
for(const t of [1200,1400,1600])assert.equal(ev(o,t).alpha,.5);
assert.equal(ev(o,1099).visible,false);assert.equal(ev(o,1300).alpha,0);assert.equal(ev(o,1700).alpha,1);assert.equal(ev(o,1701).visible,false);
o=parse('Sprite,Foreground,Centre,"a.png",0,0',' F,0,0,2000,1',' L,1000,3','  MX,0,100,200,0,100','  MY,0,200,300,0,50');
for(const t of [1350,1550,1350]){assert.equal(ev(o,t).x,50);assert.equal(ev(o,t).y,50);}
assert.equal(ev(o,1800).x,100);assert.equal(ev(o,1800).y,50);
o=parse('Sprite,Foreground,Centre,"a.png",0,0',' T,HitSound,1000,2000','  F,0,0,100,1',' F,0,3000,4000,0.5');
assert.equal(o.cmds[0].k,'T');assert.equal(o.cmds[0].loops.length,1);assert.equal(ev(o,50).visible,false);assert.equal(ev(o,3500).alpha,.5);
o=parse('Sprite,Foreground,Centre,"a.png",0,0',' F,0,0,100,0,1,0.5,1');assert.equal(o.cmds.length,3);assert.equal(ev(o,150).alpha,.75);
o=parse('Animation,Foreground,Centre,"anim2.png",0,0,3,100,LoopOnce',' F,0,1000,3000,1');assert.equal(animFramePath(o.path,1),'anim21.png');assert.equal(storyboardFrame(o,1000),0);assert.equal(storyboardFrame(o,1500),2);o.loopType=0;assert.equal(storyboardFrame(o,1400),1);
o=parse('Sprite,Foreground,Centre,"a.png",0,0',' F,0,0,1000,1',' P,0,100,200,A',' P,0,300,,H');assert.equal(ev(o,150).additive,true);assert.equal(ev(o,250).additive,false);assert.equal(ev(o,500).flipH,true);
// Legacy initial properties apply before the first command; finite parameters
// must also clear an earlier persistent parameter when their interval ends.
assert.equal(ev(o,0).flipH,true);assert.equal(ev(o,200).additive,false);
for(const [parameter,key] of [['A','additive'],['H','flipH'],['V','flipV']]){
 const object=parse('Sprite,Foreground,Centre,"a.png",0,0',' F,0,0,1000,1',` P,0,100,,${parameter}`,` P,0,300,400,${parameter}`);
 for(const t of [0,200,350])assert.equal(ev(object,t)[key],true);
 for(const t of [400,500])assert.equal(ev(object,t)[key],false);
}
// Uniform and vector scale are independent properties, multiplied at draw time.
o=parse('Sprite,Foreground,Centre,"a.png",0,0',' F,0,0,1000,1',' S,0,0,1000,1,3',' V,0,0,1000,2,3,4,5');
assert.equal(ev(o,500).sx,6);assert.equal(ev(o,500).sy,8);
o=parse('Sprite,Foreground,Centre,"a.png",0,0',' F,0,0,1000,0,6.22');
assert.ok(Math.abs(ev(o,500).alpha-.11)<1e-12,'legacy opacity wraps rather than clamps above one');
assert.equal(parseOsb('[Variables]\n$p="a,b.png"\n[Events]\nSprite,Foreground,Centre,$p,0,0\n F,0,0,100,1')[0].path,'a,b.png');
// Preserve declaration order, layer gating, radians and seek without a DOM or static canvas.
const objects=parseStoryboard(['Sprite,Overlay,Centre,"overlay",0,0',' F,0,0,1000,1','Sprite,Foreground,Centre,"one",0,0',' F,0,0,1000,1',' R,0,0,,1.5','Sprite,Foreground,Centre,"two",0,0',' F,0,0,1000,1','Sprite,Fail,Centre,"fail",0,0',' F,0,0,1000,1']);
const player=new StoryboardPlayer(objects,()=>undefined), calls=[];for(const st of player.objects)st.img={img:st.obj.path,w:10,h:10};
const ctx={save(){},restore(){},translate(){},scale(){},rotate(r){calls.push(['r',r]);},drawImage(img){calls.push(img);}};
player.draw(ctx,500,false);assert.deepEqual(calls.filter(x=>typeof x==='string'),['one','two','overlay']);assert.ok(calls.some(x=>Array.isArray(x)&&x[1]===1.5));calls.length=0;player.draw(ctx,1500,true);assert.equal(calls.length,0);player.draw(ctx,500,true);assert.deepEqual(calls.filter(x=>typeof x==='string'),['fail','one','two','overlay']);
calls.length=0;player.draw(ctx,500,false,'background');assert.deepEqual(calls.filter(x=>typeof x==='string'),['one','two']);
calls.length=0;player.draw(ctx,500,true,'overlay');assert.deepEqual(calls.filter(x=>typeof x==='string'),['overlay']);
// Preparation must wait for decoding before playback, share sprite decodes, and
// include upcoming animation frames without loading distant scene resources.
const originalImage=globalThis.Image,decoding=[],requests=[];
try{
 globalThis.Image=class {naturalWidth=8;naturalHeight=4;set src(value){this.url=value;decoding.push(this);}};
 const preload=new StoryboardPlayer(parseStoryboard([
  'Sprite,Background,Centre,"shared.png",0,0',' F,0,0,1000,1',
  'Sprite,Foreground,Centre,"shared.png",0,0',' F,0,0,1000,1',
  'Animation,Foreground,Centre,"anim.png",0,0,3,100,LoopOnce',' F,0,100,1000,1',
  'Sprite,Foreground,Centre,"later.png",0,0',' F,0,9000,10000,1',
 ]),path=>{requests.push(path);return new Uint8Array([137,80,78,71]);});
 let ready=false;
 const preparing=preload.prepare(0,500).then(()=>{ready=true;});
 await Promise.resolve();assert.equal(ready,false,'prepare returned before image decode');
 assert.deepEqual(requests.sort(),['anim0.png','anim1.png','anim2.png','shared.png']);
 assert.equal(decoding.length,4,'shared resources must decode once');
 for(const img of decoding)img.onload();
 await preparing;assert.equal(ready,true);
 assert.equal(preload.objects[0].img.w,8);assert.equal(preload.objects[0].img,preload.objects[1].img);
 await preload.prepare(0,500);assert.equal(decoding.length,4,'prepared assets should remain cached');
}finally{if(originalImage===undefined)delete globalThis.Image;else globalThis.Image=originalImage;}
// Shared OSB must be independently rewritten for every difficulty; all animation frames copied.
const chart=v=>`osu file format v14\n[General]\nMode:3\nAudioFilename:a.ogg\n[Metadata]\nTitle:X\nVersion:${v}\n[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,1000,1,0`;
const archive=zipFromMap({'a.osu':strToBytes(chart('A')),'b.osu':strToBytes(chart('B')),'a.ogg':new Uint8Array([1]),'x.osb':strToBytes('[Events]\nAnimation,Foreground,Centre,"Other\\anim2.png",0,0,2,100,LoopForever\n F,0,0,2000,1\nSprite,Foreground,Centre,"Loose.PNG",0,0\n F,0,0,2000,1'),'Other/anim20.png':new Uint8Array([2]),'Other/anim21.png':new Uint8Array([3]),'loose.png':new Uint8Array([4])});
for(const c of importChartArchive('test.osz',archive)){const n=readNFM(c.nfm);for(const ob of n.chart.storyboard.objects){if(ob.type==='anim'){for(let i=0;i<2;i++)assert.ok(n.files.get(animFramePath(ob.path,i)));}else assert.ok(n.files.get(ob.path));}}
const root=new URL('../../',import.meta.url), real=fs.readdirSync(root).find(f=>f.endsWith('.osz')&&f.includes('Mopemope'));
assert.ok(real,'real Mopemope fixture required');
for(const c of importChartArchive(real,fs.readFileSync(new URL(real,root)))){
 const n=readNFM(c.nfm);assert.equal(c.chart.notes[0].t,2379);if(!n.chart.storyboard){console.log('REAL',c.version,'no storyboard (source has none)');continue;}let missing=0,commands=0;
 for(const ob of n.chart.storyboard.objects){if(!n.files.get(ob.path))missing++;commands+=ob.cmds.length;for(const t of [0,2379,45579,73554,98979]){const s=ev(ob,t);assert.ok([s.x,s.y,s.sx,s.sy,s.rot,s.alpha].every(Number.isFinite));}}
 assert.equal(missing,0); console.log('REAL',c.version,n.chart.storyboard.objects.length,'objects',commands,'commands',missing,'missing');
}
console.log('PASS storyboard parser / loop periods / trigger isolation / lifetime / shorthand / animation / parameters / scale / opacity / preload / layer passes / radians / seek / real OSZ');
