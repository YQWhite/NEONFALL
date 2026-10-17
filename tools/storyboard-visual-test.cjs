'use strict';
// Exercise PlayScreen itself: a separate SB canvas misses playfield occlusion.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');

async function run(win, app) {
  const dir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  const js = code => win.webContents.executeJavaScript(code, true);
  const log = (name, data) => fs.appendFileSync(path.join(dir, 'storyboard-results.log'), name + ' ' + JSON.stringify(data) + '\n');
  const wait = code => js(`(async()=>{const end=performance.now()+30000;while(!(${code})){if(performance.now()>end)throw Error('timeout: '+${JSON.stringify(code)});await new Promise(r=>setTimeout(r,50));}})()`);
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  const timer = setTimeout(() => app.exit(3), 120000);
  try {
    await wait('window.__NF?.store');
    await js(`(async()=>{
      const a=window.__NF;a.testMode=true;a.mods.auto=true;a.mods.noFail=true;
      Object.assign(a.settings,{sbEnabled:true,sbQuality:1,bgDim:0,skinId:'',audioOffset:0,visualOffset:0,particles:false});
      const c=(await a.store.listCharts()).find(c=>(c.version||'').includes('Suic!de'));
      if(!c)throw Error('real Suic!de chart missing');a.gotoScreen('play',{entry:c});
    })()`);
    await wait("window.__NF.screen.sess?.phase==='playing' && window.__NF.screen.sess.sb?.objects.length>2000");
    const startup = await js(`(()=>{const p=window.__NF.screen.sess.sb;return {objects:p.objects.length,layers:p.objects.reduce((n,s)=>(n[s.obj.layer]=(n[s.obj.layer]||0)+1,n),{}),loaded:p.images.size};})()`);
    log('startup', startup);
    await js(`(async()=>{
      const screen=window.__NF.screen,s=screen.sess;
      screen.update=()=>{};s.audio.pauseMusic();s.popups=[];s.particles=[];s.combo=0;
      window.__realStoryboard=s.sb;
      await Promise.all([...new Set(s.sb.objects.map(o=>o.obj.path))].map(p=>s.sb.load(p)));
    })()`);
    for (const t of [2379, 45590, 46779, 73554, 98979]) {
      const frame = await js(`(async()=>{
        const a=window.__NF,s=a.screen.sess;s.audio.seekMusic(${t}/1000);s.sb.warm(${t});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        return {t:s.chartTime(),png:a.canvas.toDataURL('image/png').split(',')[1]};
      })()`);
      fs.writeFileSync(path.join(dir, `play-${t}.png`), Buffer.from(frame.png, 'base64'));
      log('frame', { t: frame.t });
    }
    const composition = await js(`(()=>{
      const a=window.__NF,screen=a.screen,s=screen.sess,C=s.sb.constructor;
      const white=document.createElement('canvas');white.width=white.height=80;
      white.getContext('2d').fillStyle='rgb(20,240,40)';white.getContext('2d').fillRect(0,0,80,80);
      const F={k:'F',ease:0,t1:0,t2:2000,a:[1,1]};
      const q=new C([{type:'sprite',layer:4,origin:1,path:'probe',x:320,y:240,cmds:[F]}],()=>undefined);
      q.objects[0].img={img:white,w:80,h:80};s.sb=q;s.audio.seekMusic(1);s.notes=[];
      const canvas=document.createElement('canvas');canvas.width=a.w;canvas.height=a.h;const ctx=canvas.getContext('2d');
      const sample=()=>{screen.draw(ctx);return Array.from(ctx.getImageData(Math.floor(a.w/2),Math.floor(a.h/2),1,1).data);};
      const overlay=sample();q.objects[0].obj.layer=3;const foreground=sample();
      // Tint must multiply RGB while leaving partially-transparent black black.
      const source=document.createElement('canvas');source.width=source.height=1;const z=source.getContext('2d');
      z.fillStyle='rgba(0,0,0,0.5)';z.fillRect(0,0,1,1);
      const tinted=Array.from(q.tinted(source,255,0,0).getContext('2d').getImageData(0,0,1,1).data);
      // Flips change texture direction without relocating a TopLeft anchor.
      q.objects[0].obj={type:'sprite',layer:4,origin:0,path:'probe',x:320,y:240,cmds:[F,{k:'P',ease:0,t1:0,t2:2000,a:[],parameter:'H'}]};
      const flipped=document.createElement('canvas');flipped.width=640;flipped.height=480;const f=flipped.getContext('2d');q.draw(f,1000,false);
      const flipRight=Array.from(f.getImageData(330,250,1,1).data),flipLeft=Array.from(f.getImageData(310,250,1,1).data);
      s.sb=window.__realStoryboard;
      return {overlay,foreground,tinted,flipRight,flipLeft};
    })()`);
    log('composition', composition);
    if (!process.env.NF_SB_BASELINE) {
      assert.deepEqual(composition.overlay, [20,240,40,255], 'Overlay must be visible above the real playfield');
      assert.notDeepEqual(composition.foreground, composition.overlay, 'Foreground belongs below the playfield');
      assert.deepEqual(composition.tinted.slice(0,3), [0,0,0], 'Tint must not colour translucent black pixels');
      assert.ok(Math.abs(composition.tinted[3]-128)<=1, 'Tint must preserve alpha');
      assert.deepEqual(composition.flipRight, [20,240,40,255], 'Flip must preserve the anchor bounds');
      assert.equal(composition.flipLeft[3], 0);
      assert.equal(errors.length, 0, 'renderer errors');
      log('PASS', 'real PlayScreen Overlay composition / alpha tint / flip anchor / real sample captures');
    } else log('BASELINE', 'captured unfixed composition; assertions intentionally deferred');
    clearTimeout(timer);app.exit(0);
  } catch (e) {
    log('FAIL', e.stack || String(e));clearTimeout(timer);app.exit(2);
  }
}
module.exports = { run };
