// Run from the deployed project: node tools/skin-tests.mjs
// Transpile source in memory; no generated files or source changes.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const sha1Url = dataUrl(transpile(readFileSync(path.join(root, 'src/core/sha1.ts'), 'utf8')));
const zipCode = transpile(readFileSync(path.join(root, 'src/core/zip.ts'), 'utf8'))
  .replace(/from ['"]fflate['"]/g, `from ${JSON.stringify(pathToFileURL(require.resolve('fflate')).href)}`)
  .replace(/from ['"]\.\/sha1\.ts['"]/g, `from ${JSON.stringify(sha1Url)}`);
const zipUrl = dataUrl(zipCode);
const oskCode = transpile(readFileSync(path.join(root, 'src/core/osk.ts'), 'utf8'))
  .replace(/from ['"]\.\/zip\.ts['"]/g, `from ${JSON.stringify(zipUrl)}`);
const { parseOSK, parseIniSections, selectSkinForKeys } = await import(dataUrl(oskCode));
const { findBaseCI } = await import(zipUrl);
const bytes = new Uint8Array([1, 2, 3]);
const fixture = (ini, paths = []) => new Map([['skin.ini', new TextEncoder().encode(ini)], ...paths.map((p) => [p, bytes])]);
let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`PASS ${name}`); };
test('repeated Mania blocks retained independently and selected by key count', () => {
  const { skin } = parseOSK(fixture('[Mania]\nKeys:4\nColumnStart:0\nNoteImage0:four\n[Mania]\nKeys:7\nNoteImage0:seven', ['four.png', 'seven.png']));
  assert.equal(parseIniSections('[Mania]\nKeys:4\n[Mania]\nKeys:7').filter((s) => s.name === 'Mania').length, 2);
  assert.equal(selectSkinForKeys(skin, 4).columns[0].noteImg, 'four.png');
  assert.equal(selectSkinForKeys(skin, 4).columnStart, 0);
  assert.equal(selectSkinForKeys(skin, 7).columns[0].noteImg, 'seven.png');
  assert.equal(selectSkinForKeys(skin, 7).columnStart, undefined);
  assert.equal(selectSkinForKeys(skin, 6), null);
  assert.doesNotThrow(() => JSON.stringify(skin));
});
test('same key count replacement does not leak fields', () => {
  const { skin } = parseOSK(fixture('[Mania]\nKeys:4\nColumnStart:123\n[Mania]\nKeys:4'));
  assert.equal(selectSkinForKeys(skin, 4).columnStart, undefined);
});
test('NoteImage is never reclassified as receptor; numeric basename zero works', () => {
  const { skin } = parseOSK(fixture('[Mania]\nKeys:4\nNoteImage0:note\nKeyImage1:0\nKeyImage2D:pressed', ['note.png', '0.png', 'pressed.png']));
  assert.equal(skin.columns[0].noteImg, 'note.png');
  assert.equal(skin.columns[0].keyImg, undefined);
  assert.equal(skin.columns[1].keyImg, '0.png');
  assert.equal(skin.columns[2].keyImgD, 'pressed.png');
});
test('explicit H/L/T have independent paths; no hardcoded body-as-head', () => {
  const { skin } = parseOSK(fixture('[Mania]\nKeys:4\nNoteImage0:tap\nNoteImage0H:head\nNoteImage0L:body\nNoteImage0T:tail', ['tap.png', 'head.png', 'body.png', 'tail.png', 'Mania/_LNB.png']));
  assert.deepEqual([skin.columns[0].noteImg, skin.columns[0].noteImgH, skin.columns[0].bodyImg, skin.columns[0].noteImgT], ['tap.png', 'head.png', 'body.png', 'tail.png']);
});
test('Remilia-like custom paths and density fallback resolve', () => {
  const { skin, assets } = parseOSK(fixture('[Mania]\nKeys:4\nKeyImage0:Mania\\Receptors\\Key\nKeyImage0D:Mania\\Receptors\\KeyD\nNoteImage0:Mania\\Note1\nNoteImage0H:Mania\\NoteL1\nNoteImage0L:Mania\\_LNB\nNoteImage0T:Mania\\_LNC', ['Mania/Receptors/Key@2x.png', 'Mania/Receptors/KeyD.png', 'Mania/Note1.png', 'Mania/NoteL1.png', 'Mania/_LNB.png', 'Mania/_LNC.png']));
  assert.equal(skin.columns[0].keyImg, 'Mania/Receptors/Key@2x.png');
  assert.equal(skin.assetDensity[skin.columns[0].keyImg], 2);
  assert.equal(skin.columns[0].noteImgT, 'Mania/_LNC.png');
  assert.equal(Object.keys(assets).length, 6);
});
test('1x/2x choice is deterministic, slash/case/extension independent', () => {
  const files = new Map([['Folder/KEY@2x.PNG', bytes], ['Folder/Key.png', bytes]]);
  assert.equal(findBaseCI(files, 'folder\\key').density, 1);
  assert.equal(findBaseCI(files, 'folder/key', { prefer2x: true }).density, 2);
  assert.equal(findBaseCI(files, 'folder/key@2x.png').density, 2);
  assert.equal(findBaseCI(new Map([['key@2x.png', bytes]]), 'key.png').density, 2);
});
test('explicit judgments and proper 200 fallback; audio/image isolation', () => {
  const { skin } = parseOSK(fixture('[Mania]\nKeys:4\nHit300g:custom-perfect\nHit200:custom-good\nNoteImage0:same', ['custom-perfect.png', 'custom-good@2x.png', 'same.ogg', 'normal-hitnormal.png', 'normal-hitnormal.ogg']));
  assert.equal(skin.judgments.perfect, 'custom-perfect.png');
  assert.equal(skin.judgments.good, 'custom-good@2x.png');
  assert.equal(skin.columns[0].noteImg, undefined);
  assert.equal(skin.hitsounds.normal.hit, 'normal-hitnormal.ogg');
  const fallback = parseOSK(fixture('[Mania]\nKeys:4', ['hit100.png'])).skin;
  assert.equal(fallback.judgments.good, undefined);
});
test('zero coordinates and explicit flags survive parsing', () => {
  const { skin } = parseOSK(fixture('[Mania]\nKeys:4\nColumnStart:0\nHitPosition:0\nJudgementLine:0\nKeysUnderNotes:1\nNoteBodyStyle:1\nColumnSpacing:0,2,0'));
  assert.equal(skin.columnStart, 0);
  assert.equal(skin.hitPosition, 0);
  assert.equal(skin.judgementLine, false);
  assert.equal(skin.keyUnderNotes, true);
  assert.equal(skin.noteBodyStyle, 1);
  assert.deepEqual(skin.columnSpacing, [0, 2, 0]);
});
test('column Colour is one-based, RGBA-preserving, clamped and variant-local', () => {
  const { skin } = parseOSK(fixture('[Mania]\nKeys:4\nColour0:255,0,0\nColour1:0,0,0,0\nColour2:10,20,30\nColour3:300,-2,42,128\nColour4:broken\n[Mania]\nKeys:7'));
  assert.deepEqual(skin.columns.map(c => c.background), [[0,0,0,0], [10,20,30,255], [255,0,42,128], undefined]);
  assert.equal(selectSkinForKeys(skin, 7).columns[0].background, undefined);
});
const renderCode = transpile(readFileSync(path.join(root, 'src/engine/render.ts'), 'utf8'))
  .replace(/from ['"]\.\.\/core\/types\.ts['"]/g, `from ${JSON.stringify(dataUrl(transpile(readFileSync(path.join(root, 'src/core/types.ts'), 'utf8'))))}`)
  .replace(/from ['"]\.\.\/ui\/skin-art\.ts['"]/g, `from ${JSON.stringify(dataUrl(transpile(readFileSync(path.join(root, 'src/ui/skin-art.ts'), 'utf8'))))}`)
  .replace(/from ['"]\.\/msp-art\.ts['"]/g, `from ${JSON.stringify(dataUrl(transpile(readFileSync(path.join(root, 'src/engine/msp-art.ts'), 'utf8'))))}`)
  .replace(/from ['"]\.\.\/core\/zip\.ts['"]/g, `from ${JSON.stringify(zipUrl)}`)
  .replace(/from ['"]\.\.\/ui\/i18n\.ts['"]/g, `from ${JSON.stringify(dataUrl(transpile(readFileSync(path.join(root, 'src/ui/i18n.ts'), 'utf8'))))}`);
const { PlayfieldRenderer } = await import(dataUrl(renderCode));
const { DEFAULT_SETTINGS, DEFAULT_MODS } = await import(dataUrl(transpile(readFileSync(path.join(root, 'src/core/types.ts'), 'utf8'))));
const makeRenderer = (skin) => new PlayfieldRenderer(skin, () => undefined, {...DEFAULT_SETTINGS}, {...DEFAULT_MODS});
const context = () => {
  const calls = [];
  const target = { globalAlpha: 1, calls };
  return new Proxy(target, { get(obj, prop) {
    if (prop in obj) return obj[prop];
    return (...args) => { calls.push({ method: prop, args, fill: obj.fillStyle, alpha: obj.globalAlpha }); };
  }});
};
const fieldSession = { keys: 4, laneStart: () => 124, hitY: () => 402 };
const drawStage = (skin, images = []) => {
  const renderer = makeRenderer(skin);
  for (const method of ['drawNotes', 'drawReceptors', 'drawHitline', 'drawParticles', 'drawPopups']) renderer[method] = () => {};
  for (const [key, img] of images) renderer.images.images.set(key, img);
  const ctx = context();
  renderer.drawField(ctx, fieldSession, 1000);
  return ctx.calls;
};
test('custom stage has no default field, coloured lanes or dividers; explicit alpha survives', () => {
  const skin = parseOSK(fixture('[Mania]\nKeys:4')).skin;
  assert.equal(drawStage(skin).filter(c => ['fillRect','stroke'].includes(c.method)).length, 0);
  skin.columns[1].background = [10,20,30,0];
  const fills = drawStage(skin).filter(c => c.method === 'fillRect');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].fill, 'rgba(10,20,30,0)');
  const defaultFills = drawStage(null).filter(c => c.method === 'fillRect');
  assert.equal(defaultFills.length, 1);
  assert.equal(defaultFills[0].fill, '#10151e');
});
test('stage hint spans the field once and centres on the actual HitPosition', () => {
  const skin = parseOSK(fixture('[Mania]\nKeys:4\nHitPosition:402\nStageHint:ring', ['ring.png'])).skin;
  const image = { width: 528, height: 40 };
  const draws = drawStage(skin, [['ring.png', image]]).filter(c => c.method === 'drawImage');
  assert.equal(draws.length, 1);
  assert.deepEqual(draws[0].args, [image, 124, 392, 264, 20]);
});
test('different key sizes/densities stay bottom-anchored; pressed artwork never scales', () => {
  for (const density of [1,2]) for (const hitY of [320,402,464]) for (const pressed of [false,true]) {
    const skin = parseOSK(fixture('[Mania]\nKeys:4\nKeyImage0:up\nKeyImage0D:down', ['up.png','down.png'])).skin;
    const renderer = makeRenderer(skin);
    const up = { width:66*density, height:160*density }, down = { width:66*density, height:180*density };
    renderer.images.images.set('up.png', up); renderer.images.images.set('down.png', down);
    const ctx = context();
    renderer.drawReceptors(ctx, { keys:1, colFlash:[0], input:{isDown:()=>pressed} }, 124, [66], hitY, 1000);
    const draws = ctx.calls.filter(c => c.method === 'drawImage');
    assert.deepEqual(draws[0].args, [pressed ? down : up, 124, pressed ? 300 : 320, 66, pressed ? 180 : 160]);
    assert.equal(ctx.calls.filter(c => c.method === 'scale').length, 0);
  }
});
test('tap/head anchors stay fixed; tail flips about its timestamp and body joins cap centres', () => {
  const skin = parseOSK(fixture('[Mania]\nKeys:4\nNoteImage0:tap\nNoteImage0H:head\nNoteImage0L:body\nNoteImage0T:tail', ['tap.png','head.png','body.png','tail.png'])).skin;
  const renderer = makeRenderer(skin);
  for (const [key,height] of [['tap',16], ['head',20], ['body',4], ['tail',10]]) renderer.images.images.set(key+'.png', {width:66,height});
  const ctx = context();
  renderer.drawTap(ctx, {}, 0, 157, 66, 402, 18, 0);
  renderer.drawHold(ctx, {}, 0, 157, 66, 200, 402, 0);
  const draws = ctx.calls.filter(c => c.method === 'drawImage');
  assert.deepEqual(draws.map(c => [c.args[0].height, c.args[2], c.args[4]]), [[16,386,16],[4,195,197],[10,0,10],[20,382,20]]);
  assert.deepEqual(ctx.calls.filter(c => c.method === 'translate').map(c => c.args), [[124,200]]);
  assert.deepEqual(ctx.calls.filter(c => c.method === 'scale').map(c => c.args), [[1,-1]]);
});
test('tail flip respects version, global/T/column overrides and layout isolation', () => {
  for (const [general, mania, expected] of [
    ['', '', true], ['Version:latest', '', true], ['Version:2.5', '', true],
    ['Version:2.4', '', false], ['Version:2.4', 'NoteFlipWhenUpsideDown0T:1', false],
    ['Version:latest', 'NoteFlipWhenUpsideDown:0', false],
    ['Version:latest', 'NoteFlipWhenUpsideDownT:0', false],
    ['Version:latest', 'NoteFlipWhenUpsideDown:0\nNoteFlipWhenUpsideDown0T:1', true],
  ]) {
    const skin = parseOSK(fixture(`[General]\n${general}\n[Mania]\nKeys:4\n${mania}\n[Mania]\nKeys:7`)).skin;
    assert.equal(skin.columns[0].tailFlip, expected);
    assert.equal(selectSkinForKeys(skin,7).columns[0].tailFlip, !general.includes('2.4'));
  }
});
// Track actual transformed sprite corners, not just drawImage argument signs.
const spriteContext = () => {
  let transform = [1,1,0,0]; const stack = []; const sprites = [];
  return { sprites, globalAlpha:1,
    save(){ stack.push([...transform]); }, restore(){ transform = stack.pop(); },
    translate(x,y){ transform[2] += x*transform[0]; transform[3] += y*transform[1]; },
    scale(x,y){ transform[0] *= x; transform[1] *= y; },
    drawImage(img,x,y,w,h){ const [sx,sy,tx,ty] = transform; sprites.push({img,left:x*sx+tx,right:(x+w)*sx+tx,sourceTop:y*sy+ty,sourceBottom:(y+h)*sy+ty}); },
  };
};
test('asymmetric tail source rows reverse vertically only; bottom anchor survives density and opt-out', () => {
  for (const density of [1,2]) for (const flip of [undefined,true,false]) for (const width of [33,66,99]) {
    const renderer = makeRenderer({columns:[{noteImgH:'H',bodyImg:'L',noteImgT:'T',tailFlip:flip}]});
    for (const [p,h] of [['H',20],['L',4],['T',10]]) renderer.images.images.set(p,{width:66*density,height:h*density});
    const ctx = spriteContext(); renderer.drawHold(ctx,{},0,157,width,200,402,0);
    const [body,tail,head] = ctx.sprites; const th = width*10/66, hh = width*20/66;
    assert.equal(tail.left,157-width/2); assert.equal(tail.right,157+width/2);
    assert.equal(Math.max(tail.sourceTop,tail.sourceBottom),200);
    assert.equal(tail.sourceTop,flip === false ? 200-th : 200);
    assert.equal(tail.sourceBottom,flip === false ? 200 : 200-th);
    assert.equal(body.sourceTop,200-th/2); assert.equal(body.sourceBottom,402-hh/2);
    assert.equal(head.sourceBottom,402);
  }
});
test('missing T falls back to H; zero/short holds preserve real tail time and no negative body', () => {
  const renderer = makeRenderer({columns:[{noteImgH:'H',bodyImg:'L'}]});
  renderer.images.images.set('H',{width:66,height:20}); renderer.images.images.set('L',{width:66,height:4});
  for (const top of [400,402]) {
    const ctx=spriteContext(); renderer.drawHold(ctx,{},0,157,66,top,402,0);
    const tail=ctx.sprites.find(s=>s.img.height===20);
    assert.equal(tail.sourceTop,top); assert.equal(tail.sourceBottom,top-20);
  }
  const ctx=spriteContext(); renderer.drawHold(ctx,{},0,157,66,403,402,0); assert.equal(ctx.sprites.length,0);
});
test('drawNotes never shifts short or held tails by an artificial fourteen pixels', () => {
  for (const held of [false,true]) for (const now of [0,9,10,11]) {
    const renderer=makeRenderer(null), calls=[]; renderer.drawHold=(...args)=>calls.push(args);
    const sess={keys:1,notes:[{t:0,end:10,col:0}],drawTime:()=>now,timeMap:{svBeatAt:t=>t/1000,msAtSvBeat:b=>b*1000},colFlash:[0],isJudged:()=>held,isHeld:()=>held};
    renderer.drawNotes(context(),sess,124,[66],402,1000);
    assert.equal(calls.length,1);
    assert.equal(calls[0][5],402-(10-now)/1000*renderer.beatHeight());
    assert.equal(calls[0][6],held ? 402 : 402+now/1000*renderer.beatHeight());
  }
});
// Decode the supplied PNG's alpha without a browser/image viewer or new dependency.
// Restrict to the fixture's non-interlaced RGBA8 PNG; reject silently changed formats.
const pngAlpha = (png) => {
  assert.equal(png.subarray(1,4).toString(),'PNG');
  const w=png.readUInt32BE(16), h=png.readUInt32BE(20);
  assert.deepEqual([...png.subarray(24,29)],[8,6,0,0,0]);
  const chunks=[]; for(let p=8;p<png.length;){const n=png.readUInt32BE(p); if(png.toString('ascii',p+4,p+8)==='IDAT')chunks.push(png.subarray(p+8,p+8+n)); p+=n+12;}
  const raw=inflateSync(Buffer.concat(chunks)), stride=w*4, rows=[];
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0,p=0;y<h;y++) { const filter=raw[p++], row=Buffer.alloc(stride), prev=rows[y-1];
    assert.ok(filter>=0&&filter<=4);
    for(let x=0;x<stride;x++){const a=x>=4?row[x-4]:0,b=prev?.[x]??0,c=x>=4?(prev?.[x-4]??0):0; row[x]=(raw[p++]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;}
    rows.push(row);
  }
  return {width:w,height:h,alpha:(x,y)=>rows[y][x*4+3]};
};
const realArchive = readdirSync(path.resolve(root,'..')).find(p=>/Remilia.*\.osk$/i.test(p));
if(realArchive) test('real Remilia H/L/T: decoded asymmetric tail joins body, flips taper upward and keeps end anchor', () => {
  const files = new Map(Object.entries(require('fflate').unzipSync(readFileSync(path.resolve(root,'..',realArchive)))));
  const {skin,assets}=parseOSK(files); const renderer=makeRenderer(skin), c=skin.columns[0];
  assert.equal(c.tailFlip,true); assert.match(c.noteImgH,/NoteL1/); assert.match(c.bodyImg,/_LNB/); assert.match(c.noteImgT,/_LNC/);
  for(const p of [c.noteImgH,c.bodyImg,c.noteImgT])renderer.images.images.set(p,pngAlpha(Buffer.from(assets[p])));
  const ctx=spriteContext(); renderer.drawHold(ctx,{},0,157,66,200,402,0);
  const [body,tail]=ctx.sprites;
  assert.equal(tail.img.width,128); assert.equal(tail.img.height,128);
  const rowCount=y=>Array.from({length:128},(_,x)=>tail.img.alpha(x,y)).filter(a=>a>0).length;
  assert.equal(rowCount(0),105); assert.equal(rowCount(127),0); assert.ok(rowCount(96)<rowCount(64));
  assert.equal(tail.sourceTop,200); assert.equal(tail.sourceBottom,134);
  assert.equal(body.sourceTop,167); // overlap beneath the cap, not a full-width overhang at y=200
  // Wide opaque source start attaches toward the body; transparent/tapered source end faces the future.
  assert.ok(tail.sourceBottom<tail.sourceTop); assert.ok(body.sourceBottom>tail.sourceTop);
});
else console.log('SKIP real Remilia pixel regression: source OSK not available');
console.log(`${count} skin regression tests passed.`);
