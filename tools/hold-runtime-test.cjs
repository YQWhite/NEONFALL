'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
async function run(win,app){
 const dir=path.join(app.getPath('userData'),'diagnostics');fs.mkdirSync(dir,{recursive:true});
 const js=code=>win.webContents.executeJavaScript(code,true), log=(k,v)=>fs.appendFileSync(path.join(dir,'hold-results.log'),k+' '+JSON.stringify(v)+'\n');
 const wait=code=>js(`(async()=>{const end=performance.now()+25000;while(!(${code})){if(performance.now()>end)throw Error('timeout '+${JSON.stringify(code)});await new Promise(r=>setTimeout(r,50));}})()`);
 const timer=setTimeout(()=>app.exit(3),60000);
 try{
 await wait('window.__NF?.store');
 await js(`(async()=>{const a=window.__NF;a.testMode=true;a.mods.auto=true;a.settings.sbEnabled=false;const skins=await a.store.listSkins();a.settings.skinId=skins[0]?.id;const charts=await a.store.listCharts();a.gotoScreen('play',{entry:charts.find(c=>c.version.includes('Hard Lv.19'))||charts[0]});})()`);
 await wait("window.__NF.screen.sess?.phase==='playing' && window.__NF.screen.renderer.skin");
 const result=await js(`(()=>{const screen=window.__NF.screen,real=screen.sess;const C=real.constructor;let now=0,down=false;
 const audio={songTimeMs:()=>now,playSynth(){},pauseMusic(){},stopMusic(){},stopPreview(){},playMusic(){}};
 const chart={...real.chart,storyboard:undefined,skin:undefined,notes:[{t:1000,col:0,end:2000}],meta:{...real.chart.meta,bg:undefined,video:undefined,lengthMs:5000}};
 const test=new C(chart,{}, {skin:null,getAsset:()=>undefined},{...real.mods,auto:false,noFail:true},{...real.settings,inputOffset:0,particles:false},audio);test.phase='playing';test.input.isDown=()=>down;
 now=1000;down=true;test.press(0,now);now=2000;test.update(16,performance.now());const beforeRelease={held:test.isHeld(0),ticks:test.counts.holdTicks,combo:test.combo};down=false;test.release(0,2000);const success={counts:{...test.counts},combo:test.combo,accuracy:test.accuracy(),popup:test.popups.at(-1).label};
 const tail=real.skin.columns[0].noteImgT;const img=screen.renderer.images.get(tail);if(!img)throw Error('tail not decoded');
 const hold=real.notes.find(n=>n.end>n.t);real.audio.seekMusic((hold.t+Math.min(200,(hold.end-hold.t)/3)+real.settings.audioOffset)/1000);
 return {beforeRelease,success,skin:real.skin.name,tail,tailSize:[img.width,img.height],hold:{t:hold.t,end:hold.end},columns:real.skin.columns};})()`);
 log('runtime',result);assert.equal(result.beforeRelease.held,true);assert.equal(result.beforeRelease.ticks,19);assert.equal(result.success.combo,21);assert.equal(result.success.accuracy,1);assert.equal(result.success.popup,'TAIL PERFECT');
 await js('new Promise(r=>setTimeout(r,80))');fs.writeFileSync(path.join(dir,'custom-hold.png'),(await win.webContents.capturePage()).toPNG());
 log('PASS','real custom tail decoded / chart-clock body judgments / release judgment / screenshot');clearTimeout(timer);app.exit(0);
 }catch(e){log('FAIL',e.stack||String(e));clearTimeout(timer);app.exit(2);}
}
module.exports={run};
