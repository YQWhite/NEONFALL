'use strict';
// Actual packaged CSS + AccountScreen.uploadAvatar, using an isolated browser
// profile and a local in-memory upload stub. No account or remote writes.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'test-results/avatar-crop-fix');
fs.mkdirSync(out, { recursive: true });
const mode = process.env.NF_AVATAR_BEFORE ? 'before' : 'after';
const html = fs.readFileSync(mode === 'before' ? path.join(out, 'before.html') : path.join(root, 'dist/index.html'));
const stage = fs.mkdtempSync(path.join(out, 'browser-'));
const browser = process.env.NF_BROWSER_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html);
  } else {
    response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"error":"isolated fixture"}');
  }
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Reserve a safe high port: random Chromium CDP ports can land on fetch's
  // restricted-port list (for example 6566).
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const debugPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const profile = path.join(stage, 'profile');
  const log = fs.openSync(path.join(out, `browser-${mode}-stderr.log`), 'w');
  const child = spawn(browser, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--window-size=1280,800', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--mute-audio', 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', log] });
  fs.closeSync(log);
  let launchError, ws, nextId = 0;
  child.on('error', error => { launchError = error; });
  const pending = new Map(), exceptions = [];
  const report = { mode, browser: path.basename(browser), htmlBytes: html.length, samples: [], exceptions };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 25000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const open = () => evaluate(`(async()=>{
    __NF.serverOnline=true;
    window.__AVATAR.pending=__NF.screen.uploadAvatar(__AVATAR.file);
    const deadline=performance.now()+5000;
    while(!document.querySelector('[role="dialog"]')){if(performance.now()>deadline)throw Error('crop dialog missing '+JSON.stringify({screen:__NF.screen?.name,active:__NF.screen?.active,busy:__NF.screen?.busy,error:__NF.screen?.error,online:__NF.serverOnline,signedIn:__NF.account.server,fileSize:__AVATAR.file?.size}));await new Promise(r=>setTimeout(r,20));}
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  })()`);
  const geometry = () => evaluate(`(()=>{
    const d=document.querySelector('[role="dialog"]'),p=d.querySelector('.nf-avatar-crop-panel'),c=d.querySelector('canvas'),z=d.querySelector('input'),buttons=[...d.querySelectorAll('button')];
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const clickable=e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e;};
    return {viewport:{width:innerWidth,height:innerHeight},panel:rect(p),preview:rect(c),zoom:rect(z),buttons:buttons.map(e=>({...rect(e),clickable:clickable(e),text:e.textContent})),position:getComputedStyle(c).position,
      panelScrollWidth:p.scrollWidth,panelClientWidth:p.clientWidth,panelScrollHeight:p.scrollHeight,panelClientHeight:p.clientHeight};
  })()`);
  const snapshot = name => send('Page.captureScreenshot', { format: 'png' }).then(value => fs.writeFileSync(path.join(out, `browser-${mode}-${name}.png`), Buffer.from(value.data, 'base64')));
  const pixels = () => evaluate(`(()=>{const c=document.querySelector('[role="dialog"] canvas');return [...c.getContext('2d').getImageData(160,160,1,1).data];})()`);
  try {
    const deadline = Date.now() + 25000;
    let targets;
    while (!targets) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw Error('Browser exited: ' + child.exitCode);
      if (Date.now() > deadline) throw Error('Browser did not expose DevTools');
      try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); } catch { await sleep(100); }
    }
    ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = pending.get(message.id); if (!request) return; pending.delete(message.id);
        if (message.error) request.reject(Error(JSON.stringify(message.error))); else request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    });
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await evaluate(`(async()=>{
      const deadline=performance.now()+15000;while(!window.__NF){if(performance.now()>deadline)throw Error('App boot timeout');await new Promise(r=>setTimeout(r,30));}
      const app=__NF, user={username:'fixture',nickname:'裁切测试',email:'',emailVerified:true,createdAt:0,rating:25,bestPp:120};
      window.__AVATAR={uploads:[],leaks:{pointerDown:0,pointerMove:0,pointerUp:0,wheel:0}};
      app.serverOnline=true; app.account={server:true,user};
      app.server={base:'https://example.invalid',avatarsEnabled:true,ping:async()=>true,leaderboard:async()=>[],myScores:async()=>[],
        uploadAvatar:async(bytes,mime)=>{__AVATAR.uploads.push({bytes:[...bytes],mime});return {...user};}};
      app.store.getToken=()=>''; app.gotoScreen('account');
      await new Promise(r=>setTimeout(r,400));
      for(const name of Object.keys(__AVATAR.leaks)){const original=app.screen[name].bind(app.screen);app.screen[name]=(...args)=>{__AVATAR.leaks[name]++;return original(...args);};}
      const c=document.createElement('canvas');c.width=4096;c.height=2048;const ctx=c.getContext('2d');
      // Continuous coordinates let us verify both axes and the final crop.
      const image=ctx.createImageData(4096,2048);
      for(let y=0;y<2048;y++)for(let x=0;x<4096;x++){const p=(y*4096+x)*4;image.data[p]=Math.round(x*255/4095);image.data[p+1]=Math.round(y*255/2047);image.data[p+2]=80;image.data[p+3]=255;}
      ctx.putImageData(image,0,0);const blob=await new Promise(r=>c.toBlob(r,'image/png'));__AVATAR.file=new File([blob],'large-avatar.png',{type:'image/png'});
    })()`);
    report.appVersion = await evaluate('__NF.version');
    for (const [width, height, touch] of [[1280, 800, false], [640, 400, false], [360, 780, true], [780, 360, true]]) {
      const name = `${width}x${height}-${touch ? 'touch' : 'mouse'}`;
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
      await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 1 });
      await open();
      const item = { name, geometry: await geometry() }; report.samples.push(item);
      const g = item.geometry, c = g.preview, p = g.panel;
      item.boundedSquare = Math.abs(c.width - c.height) < 1 && c.x >= p.x && c.y >= p.y && c.right <= p.right + 1 && c.bottom <= p.bottom + 1 && c.right <= width && c.bottom <= height;
      item.actionsReachable = g.buttons.every(b => b.clickable && b.x >= 0 && b.y >= 0 && b.right <= width && b.bottom <= height);
      await snapshot(name);
      if (mode === 'before') {
        await evaluate(`document.querySelector('[role="dialog"] button').click();__AVATAR.pending`);
        continue;
      }
      assert.ok(item.boundedSquare, `${name}: preview must stay square and inside panel/viewport`);
      assert.ok(item.actionsReachable, `${name}: both actions must be visible and hittable`);
      assert.ok(g.panelScrollWidth <= g.panelClientWidth + 1, `${name}: no horizontal overflow`);
      item.initialPixel = await pixels();
      // Operate the real range input, then pointer-capture drag outside preview.
      await click(g.zoom.x + g.zoom.width * .55, g.zoom.y + g.zoom.height / 2);
      item.zoom = await evaluate(`Number(document.querySelector('[role="dialog"] input').value)`);
      assert.ok(item.zoom > 2 && item.zoom < 4, `${name}: native slider changes zoom`);
      const start = { x: c.x + c.width * .8, y: c.y + c.height * .8 };
      const end = { x: Math.max(1, c.x - c.width * .1), y: Math.max(1, c.y - c.height * .1) };
      if (touch) {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
        for (let i = 1; i <= 8; i++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * i / 8, y: start.y + (end.y - start.y) * i / 8, id: 1 }] });
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 8; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (end.x - start.x) * i / 8, y: start.y + (end.y - start.y) * i / 8, button: 'left', buttons: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
      }
      item.draggedPixel = await pixels();
      assert.ok(item.draggedPixel[0] > item.initialPixel[0] + 25, `${name}: horizontal drag changes selected image region`);
      assert.ok(item.draggedPixel[1] > item.initialPixel[1] + 25, `${name}: vertical drag changes selected image region`);
      await snapshot(name + '-dragged');
      const confirm = g.buttons.at(-1);
      await click(confirm.x + confirm.width / 2, confirm.y + confirm.height / 2);
      item.output = await evaluate(`(async()=>{
        await __AVATAR.pending;const entry=__AVATAR.uploads.at(-1);if(!entry)throw Error('No captured upload');
        const bytes=Uint8Array.from(entry.bytes),bitmap=await createImageBitmap(new Blob([bytes],{type:entry.mime}));
        const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);
        const result={width:bitmap.width,height:bitmap.height,mime:entry.mime,pixel:[...canvas.getContext('2d').getImageData(128,128,1,1).data],data:btoa(String.fromCharCode(...bytes)),dialogClosed:!document.querySelector('[role="dialog"]')};bitmap.close();return result;
      })()`);
      fs.writeFileSync(path.join(out, `browser-${mode}-${name}-avatar.png`), Buffer.from(item.output.data, 'base64')); delete item.output.data;
      assert.equal(item.output.width, 256); assert.equal(item.output.height, 256); assert.equal(item.output.mime, 'image/png'); assert.equal(item.output.dialogClosed, true);
      assert.ok(item.output.pixel.every((v, i) => Math.abs(v - item.draggedPixel[i]) < 3), `${name}: exported crop matches preview selection`);
      const count = await evaluate('__AVATAR.uploads.length');
      await open(); const cancel = (await geometry()).buttons[0];
      await click(cancel.x + cancel.width / 2, cancel.y + cancel.height / 2);
      await evaluate('__AVATAR.pending');
      item.cancelNoUpload = await evaluate(`__AVATAR.uploads.length===${count}&&!document.querySelector('[role="dialog"]')`);
      assert.equal(item.cancelNoUpload, true);
    }
    report.eventLeaks = await evaluate('__AVATAR.leaks');
    if (mode === 'after') {
      assert.deepEqual(report.eventLeaks, { pointerDown: 0, pointerMove: 0, pointerUp: 0, wheel: 0 }, 'dialog interactions must not reach account handlers');
      assert.equal(exceptions.length, 0, 'no runtime exceptions');
    }
    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    fs.writeFileSync(path.join(out, `browser-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
    if (ws?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch {} ws.close(); }
    for (const request of pending.values()) request.reject(Error('Test closed')); pending.clear();
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
