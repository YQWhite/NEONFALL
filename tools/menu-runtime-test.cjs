'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
async function run(win, app) {
  const dir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  const js = code => win.webContents.executeJavaScript(code, true);
  const log = (name, data) => fs.appendFileSync(path.join(dir, 'results.log'), name + ' ' + JSON.stringify(data) + '\n');
  const shot = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const wait = code => js(`(async () => { const end = performance.now()+20000; while (!(${code})) { if(performance.now()>end) throw new Error('condition timeout: '+${JSON.stringify(code)}); await new Promise(r=>setTimeout(r,80)); } })()`);
  win.webContents.on('console-message', event => {
    if (event.level === 'error') log('renderer-error', event.message);
  });
  const timeout = setTimeout(() => app.exit(3), 120000);
  try {
    await wait('window.__NF?.audio.previewActive && !window.__NF.menuMusic.loading');
    await js('window.__NF.testMode=true');
    const startup = await js(`({screen:window.__NF.screen.name, entry:window.__NF.menuMusic.entry?.id, loop:window.__NF.audio.previewInfo, state:window.__NF.audio.ctx.state, t:window.__NF.audio.previewTimeSec})`);
    log('startup', startup); assert.equal(startup.screen, 'menu'); assert.equal(startup.loop.loopStart, 0); assert.equal(startup.state, 'running');
    await shot('01-menu');
    await js("window.__NF.gotoScreen('select')");
    await wait('window.__NF.screen.view?.length && !window.__NF.screen.previewTimer && !window.__NF.menuMusic.loading');
    const select = await js(`({id:window.__NF.menuMusic.entry.id, selected:window.__NF.screen.view[window.__NF.screen.sel].id,t:window.__NF.audio.previewTimeSec,active:window.__NF.audio.previewActive})`);
    log('initial-select', select); assert.equal(select.id, startup.entry); assert.equal(select.selected, startup.entry); assert.equal(select.active, true); assert.ok(select.t >= startup.t);
    await shot('02-select');
    const paused = await js(`(() => { window.__NF.audio.pausePreview(); return window.__NF.audio.previewTimeSec; })()`);
    await js('new Promise(r=>setTimeout(r,200))');
    assert.equal(await js('window.__NF.audio.previewTimeSec'), paused);
    await js('window.__NF.audio.seekPreview(12);window.__NF.audio.resumePreview()');
    assert.ok(await js('window.__NF.audio.previewTimeSec >= 12'));
    await js(`window.__NF.screen.setSel((window.__NF.screen.sel+1)%window.__NF.screen.view.length)`);
    await wait('!window.__NF.screen.previewTimer && !window.__NF.menuMusic.loading');
    const switched = await js(`({id:window.__NF.menuMusic.entry.id,selected:window.__NF.screen.view[window.__NF.screen.sel].id,active:window.__NF.audio.previewActive})`);
    log('switched', switched); assert.equal(switched.id, switched.selected); assert.equal(switched.active, true);
    await js("window.__NF.gotoScreen('menu')");
    assert.equal(await js('window.__NF.menuMusic.entry.id'), switched.id);
    await win.setContentSize(800, 600); await js('new Promise(r=>setTimeout(r,200))'); await shot('03-menu-800');
    await js("window.__NF.gotoScreen('select')"); await wait('window.__NF.screen.view?.length'); await js('new Promise(r=>setTimeout(r,400))'); await shot('04-select-800');
    await win.setContentSize(640, 400); await js('new Promise(r=>setTimeout(r,200))'); await shot('05-select-640');
    await win.setContentSize(1280, 760);
    await js(`(async()=>{const a=window.__NF;const c=(await a.store.listCharts()).find(c=>(c.version||'').includes('Suic!de'));a.mods.auto=true;a.settings.skinId='';a.gotoScreen('play',{entry:c});})()`);
    assert.equal(await js('window.__NF.audio.previewActive'), false);
    await wait("window.__NF.screen.sess?.phase==='playing' && window.__NF.screen.sess.chartTime()>6000"); const defaultState = await js(`({skin:window.__NF.screen.renderer.skin?.name ?? null, hitY:window.__NF.screen.sess.hitY()})`); log('default-gameplay', defaultState); assert.equal(defaultState.skin, null); await shot('06-default-gameplay');
    await js(`(async()=>{const a=window.__NF;const skins=await a.store.listSkins();a.settings.skinId=skins[0]?.id;const c=(await a.store.listCharts()).find(c=>(c.version||'').includes('Suic!de'));a.gotoScreen('play',{entry:c});})()`);
    await wait("window.__NF.screen.sess?.phase==='playing' && window.__NF.screen.sess.chartTime()>6000"); const customState = await js(`({skin:window.__NF.screen.renderer.skin?.name ?? null,hitY:window.__NF.screen.sess.hitY(),laneStart:window.__NF.screen.sess.laneStart()})`); log('custom-gameplay',customState); assert.ok(customState.skin); await shot('07-custom-gameplay');
    log('PASS', 'startup radio / initial select / continuity / pause seek resume / switch / sizes / gameplay preview isolation');
    clearTimeout(timeout); app.exit(0);
  } catch (e) { log('FAIL', e.stack || String(e)); clearTimeout(timeout); app.exit(2); }
}
module.exports = { run };
