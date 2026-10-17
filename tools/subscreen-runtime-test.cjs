'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
async function run(win,app){
 const dir=path.join(app.getPath('userData'),'diagnostics');fs.mkdirSync(dir,{recursive:true});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const log=(name,data)=>fs.appendFileSync(path.join(dir,'results.log'),name+' '+JSON.stringify(data)+'\n');
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');fs.writeFileSync(path.join(dir,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 const wait=code=>js(`(async()=>{const end=performance.now()+25000;while(!(${code})){if(performance.now()>end)throw Error('timeout '+${JSON.stringify(code)});await new Promise(r=>setTimeout(r,50))}})()`);
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);log('renderer-error',e.message)}});
 const deadline=setTimeout(()=>app.exit(3),150000);
 try{
 await wait('window.__NF?.screen');await wait('(await window.__NF.store.listCharts()).length');await js('window.__NF.testMode=true');
 for(const [w,h] of [[1280,760],[800,600],[640,400]]){
  win.setContentSize(w,h);await js('new Promise(r=>setTimeout(r,150))');
  await js("window.__NF.gotoScreen('settings')");
  for(const tab of ['gameplay','audio','video','input','skin','about']){await js(`window.__NF.screen.tab='${tab}';window.__NF.screen.scroll=0`);await shot(`${w}-settings-${tab}`)}
  await js("window.__NF.gotoScreen('import')");await shot(`${w}-import`);
  await js("window.__NF.gotoScreen('account')");await shot(`${w}-account`);
  await js(`(async()=>{const a=window.__NF;window.__subEntry=(await a.store.listCharts())[0];a.mods.auto=true;a.gotoScreen('play',{entry:window.__subEntry})})()`);
  await wait("window.__NF.screen.sess?.phase==='playing'");await js('window.__NF.screen.sess.pause()');await shot(`${w}-pause`);
  await js(`(()=>{const a=window.__NF;const result=a.screen.sess.buildResult();result.counts={perfect:120,great:8,good:1,ok:0,bad:0,miss:0,holdTicks:4};a.gotoScreen('result',{result,entry:window.__subEntry,rating:123})})()`);await shot(`${w}-result`);
 }
 win.setContentSize(1280,760);await js("window.__NF.gotoScreen('settings');window.__NF.screen.tab='audio';window.__NF.screen.startCalib()");await wait("window.__NF.screen.calib?.state==='running'");await shot('calibration-running');
 const before=await js('window.__NF.settings.audioOffset');await js('window.__NF.screen.calib.cancel()');assert.equal(await js('window.__NF.settings.audioOffset'),before);
 await js('window.__NF.screen.startCalib()');await wait("window.__NF.screen.calib?.state==='running'");
 await js(`(async()=>{const c=window.__NF.screen.calib;for(let i=4;i<c.beats.length;i++){await new Promise(r=>setTimeout(r,Math.max(0,(c.beats[i]+0.07-c.now)*1000)));c.tap()}})()`);
 await wait("window.__NF.screen.calib.state==='done'");
 const measured=await js('window.__NF.screen.calib.result(window.__NF.settings.inputOffset)');log('measured',measured);assert.equal(measured.ok,true);assert.ok(Math.abs(measured.delayMs-70)<20);assert.equal(await js('window.__NF.settings.audioOffset'),before);
 await shot('calibration-result');
 // Click actual explicit save button after scrolling it into view.
 await js('window.__NF.screen.scroll=250');await shot('calibration-save-visible');
 const save=await js(`(()=>{const a=window.__NF;const original=a.ui.button.bind(a.ui);let box=null;a.ui.button=(...args)=>{if(args[0]==='calib-apply')box={x:args[1]+args[3]/2,y:args[2]+args[4]/2};return original(...args)};a.draw();a.ui.button=original;return box})()`);
 assert.ok(save&&save.y>126&&save.y<726);win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(save.x),y:Math.round(save.y),button:'left',clickCount:1});await js('new Promise(r=>setTimeout(r,80))');win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(save.x),y:Math.round(save.y),button:'left',clickCount:1});await wait('window.__NF.screen.calibrationApplied');assert.equal(await js('window.__NF.settings.audioOffset'),measured.audioOffset);assert.equal(await js('window.__NF.settings.audioOffsetAuto'),false);
 await js('window.__NF.screen.startCalib()');await wait("window.__NF.screen.calib.state==='running'");await js("window.__subCalib=window.__NF.screen.calib;window.__NF.gotoScreen('menu')");assert.equal(await js('window.__subCalib.state'),'cancelled');assert.equal(await js('window.__subCalib.sources.length'),0);
 assert.deepEqual(errors,[]);log('PASS','all settings tabs / three sizes / import account pause result / calibration cancel retry timed taps explicit save leave cleanup / renderer errors zero');clearTimeout(deadline);app.exit(0);
 }catch(e){log('FAIL',e.stack||String(e));clearTimeout(deadline);app.exit(2)}
}
module.exports={run};
