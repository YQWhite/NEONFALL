import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, Image } from '@napi-rs/canvas';
import { DEFAULT_MENU_EDGE_COLOR, menuEdgeColorFromPixels, extractMenuEdgeColor, mixMenuEdgeColors } from '../src/ui/menu-palette.ts';
import { MenuMusic } from '../src/ui/menu-music.ts';
import { drawMenuBeatEdges } from '../src/ui/screens/menu.ts';
import { buildNFM } from '../src/core/nfm.ts';

let checks = 0, samples = 0;
function ok(value, label) { checks++; assert.ok(value, label); }
function eq(a, b, label) { checks++; assert.deepEqual(a, b, label); }
const out = path.resolve('test-results/v0210/palette'); fs.mkdirSync(out, { recursive: true });
globalThis.document = { createElement(tag) { assert.equal(tag, 'canvas'); samples++; return createCanvas(1, 1); } };
globalThis.window = { matchMedia: () => ({ matches: false }) };
const pixels = (...groups) => Uint8ClampedArray.from(groups.flatMap(([rgba, count]) => Array.from({ length: count }, () => rgba).flat()));
for (const rgba of [[0,0,0,255], [255,255,255,255], [128,128,128,255], [20,0,0,255], [255,20,0,0]]) {
  eq(menuEdgeColorFromPixels(pixels([rgba, 10])), DEFAULT_MENU_EDGE_COLOR, 'neutral/dark/transparent fallback');
}
eq(menuEdgeColorFromPixels([]), DEFAULT_MENU_EDGE_COLOR, 'empty pixels fallback');
const red = menuEdgeColorFromPixels(pixels([[230,45,50,255],100], [[20,20,20,255],1000], [[255,255,255,255],1000]));
const blue = menuEdgeColorFromPixels(pixels([[30,70,230,255],100]));
const green = menuEdgeColorFromPixels(pixels([[40,220,90,255],100]));
ok(red[0] > red[1] * 1.8 && red[0] > red[2] * 1.8, 'bright art hue survives shadows and white');
ok(blue[2] > blue[0] * 1.8, 'blue hue retained');
ok(green[1] > green[0] * 1.8, 'green hue retained');
for (const color of [red, blue, green]) {
  ok(color.every(v => Number.isInteger(v) && v >= 0 && v <= 255), 'bounded finite RGB');
  ok(Math.max(...color) > 220 && Math.min(...color) > 100, 'glow colour is visible and softly lit');
}
const dominant = menuEdgeColorFromPixels(pixels([[230,40,45,255],60], [[20,180,230,255],40]));
ok(dominant[0] > dominant[2], 'complementary colours choose dominant hue rather than cancel to grey');
const noisy = menuEdgeColorFromPixels(pixels([[220,35,25,255],40], [[230,20,30,255],40], [[25,50,230,255],50]));
ok(noisy[0] > noisy[2], 'neighbouring red hue buckets count as a coherent family');
eq(mixMenuEdgeColors(red, blue, 0), red, 'transition start');
eq(mixMenuEdgeColors(red, blue, 1), blue, 'transition end');
eq(mixMenuEdgeColors(red, blue, -.2), red, 'transition bounded start');
eq(mixMenuEdgeColors(red, blue, 2), blue, 'transition bounded end');

async function art(color) {
  const canvas = createCanvas(480, 270), ctx = canvas.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const shade = ctx.createLinearGradient(0,0,480,270); shade.addColorStop(0,'rgba(0,0,0,.7)'); shade.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle = shade; ctx.fillRect(0,0,480,270);
  const image = new Image(); image.src = canvas.toBuffer('image/png'); await image.decode(); return image;
}
const [redArt, blueArt, greenArt] = await Promise.all(['#e62d32','#1e46e6','#28dc5a'].map(art));
const extracted = [redArt, blueArt, greenArt].map(image => extractMenuEdgeColor(image, 16/9));
ok(extracted[0][0] > extracted[0][2] * 1.6, 'real image sampling identifies red');
ok(extracted[1][2] > extracted[1][0] * 1.6, 'real image sampling identifies blue');
eq(extractMenuEdgeColor(null), DEFAULT_MENU_EDGE_COLOR, 'missing background fallback');
const realDocument = globalThis.document;
globalThis.document = { createElement() { return { getContext() { throw new Error('tainted'); } }; } };
eq(extractMenuEdgeColor(redArt), DEFAULT_MENU_EDGE_COLOR, 'canvas failure cannot stop music');
globalThis.document = realDocument;

const audio = { previewActive:true, previewTimeSec:0, previewDurationSec:20, ctx:{state:'running'},
  samplePreviewSpectrum:()=>({bands:new Float32Array(17),energy:.6,bass:.2}), cancelPreviewLoad(){},stopAmbient(){},
  async previewMusic(){return true;}, };
const app = {w:1280,h:720,settings:{musicVolume:.4},audio};
const music = new MenuMusic(app); music.timing = [{t:0,bpm:120}];
music.changeBackground(redArt, 0);
eq(music.visualizer(16,0).edgeColor, DEFAULT_MENU_EDGE_COLOR, 'colour starts with previous background');
eq(music.visualizer(16,1000).edgeColor, extracted[0], 'colour reaches sampled art after background fade');
music.changeBackground(blueArt,1000);
eq(music.visualizer(16,1000).edgeColor, extracted[0], 'new track starts without colour jump');
eq(music.visualizer(16,1500).edgeColor, mixMenuEdgeColors(extracted[0],extracted[1],.5), 'colour uses same midpoint as background');
const partial = music.visualizer(16,1420).edgeColor;
music.changeBackground(greenArt,1420);
eq(music.visualizer(16,1420).edgeColor, partial, 'rapid skip snapshots currently visible mixed colour');
eq(music.visualizer(16,2420).edgeColor, extracted[2], 'rapid skip finishes on latest image');
const sampleCount=samples;
for(let i=0;i<1000;i++) music.visualizer(16,2500+i*16);
eq(samples,sampleCount,'no canvas sampling or allocation on subsequent visual frames');
music.changeBackground(greenArt,3000);eq(samples,sampleCount,'same image does not resample');
music.changeBackground(null,3000);
eq(music.visualizer(16,3000).edgeColor, extracted[2], 'missing artwork fades from prior hue');
eq(music.visualizer(16,4000).edgeColor, DEFAULT_MENU_EDGE_COLOR, 'missing artwork ends at theme fallback');

const chart = {format:'neonfall-chart',version:1,keys:4,od:8,offset:0,timing:[{t:0,bpm:120}],sv:[],breaks:[],notes:[],meta:{audio:'audio.mp3',previewTime:0,lengthMs:20000}};
const archive=buildNFM(chart,{'audio.mp3':new Uint8Array([1])});
const raceApp={...app,store:{getChartBytes:async()=>archive}}, race=new MenuMusic(raceApp), loads=[];
race.enabled=true;race.loadBackground=()=>new Promise(resolve=>loads.push(resolve));
await race.select({id:'old',title:'Old'});await race.select({id:'new',title:'New'});
loads[1](blueArt);await Promise.resolve();
eq(race.edgeColorTo,extracted[1],'new song owns the palette');
loads[0](redArt);await Promise.resolve();
eq(race.edgeColorTo,extracted[1],'late old artwork cannot recolour current song');
const beforeFailed=race.edgeColorTo;
audio.previewMusic=async()=>false;await race.select({id:'failed',title:'Failed'});loads[2](greenArt);await Promise.resolve();
eq(race.edgeColorTo,beforeFailed,'failed replacement retains current song palette');

const visual={bands:new Float32Array(17),pulse:1,energy:.6,position:0,leftImpact:1,rightImpact:1,sectionBurst:0,previewSection:false};
function render(color,kiai=false,reducedMotion=false){
  const canvas=createCanvas(780,360),ctx=canvas.getContext('2d');ctx.fillStyle='#0d1218';ctx.fillRect(0,0,780,360);
  drawMenuBeatEdges(ctx,780,360,{...visual,edgeColor:color,previewSection:kiai,reducedMotion});
  eq(ctx.globalAlpha,1,'edge draw restores alpha');eq(ctx.globalCompositeOperation,'source-over','edge draw restores compositing');
  return canvas;
}
const normal=render(red),kiai=render(red,true),quiet=render(red,true,true);
const pixel=(canvas,x)=>Array.from(canvas.getContext('2d').getImageData(x,180,1,1).data);
ok(pixel(normal,5)[0]-13 > (pixel(normal,5)[1]-18)*1.6,'edge gradient is tinted from artwork');
ok(pixel(normal,100)[0] > 13,'subtle half-screen wash shares the palette');
ok(pixel(kiai,100)[0] > pixel(normal,100)[0],'kiai wash remains stronger');
eq(pixel(quiet,5),[13,18,24,255],'reduced motion suppresses coloured flashes');
eq(pixel(kiai,390),[13,18,24,255],'colour does not extend effects across centre');
for (const [name,color] of [['red',red],['blue',blue],['green',green]]) {
  fs.writeFileSync(path.join(out,`${name}-normal.png`),render(color).toBuffer('image/png'));
  fs.writeFileSync(path.join(out,`${name}-kiai.png`),render(color,true).toBuffer('image/png'));
}
console.log(`PASS ${checks} menu palette checks: representative hue, actual canvas sampling, graceful fallback, fade interruption, no per-frame readback, stale decode isolation, tinted normal/kiai effects and reduced motion`);
