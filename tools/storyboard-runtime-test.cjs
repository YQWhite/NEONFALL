'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
async function run(win,app){
 const dir=path.join(app.getPath('userData'),'diagnostics');fs.mkdirSync(dir,{recursive:true});
 const js=code=>win.webContents.executeJavaScript(code,true),log=(name,data)=>fs.appendFileSync(path.join(dir,'storyboard-results.log'),name+' '+JSON.stringify(data)+'\n');
 const wait=code=>js(`(async()=>{let end=performance.now()+30000;while(!(${code})){if(performance.now()>end)throw Error('timeout: '+${JSON.stringify(code)});await new Promise(r=>setTimeout(r,80));}})()`);
 const timer=setTimeout(()=>app.exit(3),120000);
 try{
  await wait('window.__NF?.store');await js(`(async()=>{const a=window.__NF; a.testMode=true;a.mods.auto=true;a.settings.sbEnabled=true;a.settings.bgDim=.25;const c=(await a.store.listCharts()).find(c=>(c.version||'').includes('Suic!de'));if(!c)throw Error('real Suic!de chart missing');a.gotoScreen('play',{entry:c});})()`);
  await wait("window.__NF.screen.sess?.phase==='playing' && window.__NF.screen.sess.sb?.objects.length>2000");
  const result=await js(`(async()=>{
   const s=window.__NF.screen.sess,p=s.sb;
   const canvas=document.createElement('canvas');canvas.width=854;canvas.height=480;canvas.style='position:fixed;inset:0;width:100vw;height:100vh;z-index:99999;background:#222';document.body.append(canvas);window.__sbProbeCanvas=canvas;const ctx=canvas.getContext('2d');
   const frames=[];for(const t of [2379,45590,73554,98979,45590]){
    p.warm(t);await Promise.all(p.objects.filter(o=>t>=o.span.min&&t<=o.span.max).map(o=>p.load(o.obj.path)));await new Promise(r=>setTimeout(r,20));
    ctx.clearRect(0,0,854,480);ctx.save();ctx.translate(107,0);let draws=0;const original=ctx.drawImage.bind(ctx);ctx.drawImage=(...a)=>{draws++;return original(...a);};const begin=performance.now();p.draw(ctx,t,false);const ms=performance.now()-begin;ctx.drawImage=original;ctx.restore();
    frames.push({t,draws,ms,loaded:p.images.size,pixel:Array.from(ctx.getImageData(427,240,1,1).data)});
   }
   const last=frames[1],again=frames[4];if(JSON.stringify(last.pixel)!==JSON.stringify(again.pixel))throw Error('seek changed deterministic pixel');
   // Real Canvas layer composition and radians on synthetic declarations using the real player class.
   const C=p.constructor,F={k:'F',ease:0,t1:0,t2:1000,a:[1,1]},objects=[{type:'sprite',layer:1,origin:0,path:'fail',x:0,y:0,cmds:[F]},{type:'sprite',layer:2,origin:0,path:'pass',x:0,y:0,cmds:[F]},{type:'sprite',layer:3,origin:0,path:'top',x:30,y:30,cmds:[F,{k:'R',ease:0,t1:0,t2:0,a:[Math.PI/2,Math.PI/2]}]}],q=new C(objects,()=>undefined);
   for(const st of q.objects){const c=document.createElement('canvas');c.width=20;c.height=10;const z=c.getContext('2d');z.fillStyle=st.obj.path==='fail'?'red':st.obj.path==='pass'?'lime':'blue';z.fillRect(0,0,20,10);st.img={img:c,w:20,h:10};}
   const c=document.createElement('canvas');c.width=64;c.height=64;const z=c.getContext('2d');q.draw(z,500,false);const pass=Array.from(z.getImageData(2,2,1,1).data),rotated=Array.from(z.getImageData(25,45,1,1).data);z.clearRect(0,0,64,64);q.draw(z,500,true);const fail=Array.from(z.getImageData(2,2,1,1).data);z.clearRect(0,0,64,64);q.draw(z,1500,true);const expired=Array.from(z.getImageData(2,2,1,1).data);
   return {objects:p.objects.length,frames,pass,fail,rotated,expired};
  })()`);
  log('runtime',result);assert.equal(result.objects,2765);assert.ok(result.frames.every(f=>f.draws>0&&f.loaded>0));assert.deepEqual(result.pass,[0,255,0,255]);assert.deepEqual(result.fail,[255,0,0,255]);assert.deepEqual(result.rotated,[0,0,255,255]);assert.equal(result.expired[3],0);
  fs.writeFileSync(path.join(dir,'storyboard-45590.png'),(await win.webContents.capturePage()).toPNG());
  log('PASS','real decoded resources / sampled real timeline / seek / layer gating / radians / lifetime');clearTimeout(timer);app.exit(0);
 }catch(e){log('FAIL',e.stack||String(e));clearTimeout(timer);app.exit(2);}
}
module.exports={run};
