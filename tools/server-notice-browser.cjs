'use strict';
// Actual current source modules and application CSS, without building a release,
// starting the app, accessing player storage, or connecting to a public server.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-results/v029');
fs.mkdirSync(out, { recursive: true });
const stage = fs.mkdtempSync(path.join(out, 'browser-notice-'));
const browser = process.env.NF_BROWSER_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const style = fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
const modules = new Map(['/src/ui/server-notice.ts', '/src/ui/i18n.ts'].map(url => [url,
  ts.transpileModule(fs.readFileSync(path.join(root, url.slice(1)), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText]));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head><body>
<div id="stage" style="display:grid;place-items:center;background:radial-gradient(ellipse at 60% 50%,#1f3e36,#080f15);"><button id="underlying">返回菜单</button></div>
<script type="module">
import {showServerNotice} from '/src/ui/server-notice.ts';
import {setLanguage} from '/src/ui/i18n.ts';
setLanguage('zh-CN');
window.__NOTICE={closed:0,leaks:{keydown:0,keyup:0,pointerdown:0,pointerup:0,wheel:0},injected:false};
for(const name of Object.keys(__NOTICE.leaks))window.addEventListener(name,()=>__NOTICE.leaks[name]++);
window.openNotice=()=>{
  document.querySelector('#underlying').focus();
  const lines=Array.from({length:30},(_,i)=>'公告 '+(i+1)+'：欢迎来到 NEONFALL。新版本支持百万分计分、长条判定与歌曲排行榜。');
  lines.splice(1,0,'<img src="/never.png" onerror="window.__NOTICE.injected=true"><script>alert(1)<\\/script>');
  window.closeNotice=showServerNotice({address:'https://fixture.example.invalid',serverVersion:'0.2.8',localVersion:'0.2.9',announcement:{title:'更新公告 · 浏览器测试',body:lines.join('\\n')}},()=>__NOTICE.closed++);
};
window.__READY=true;
</script></body></html>`;
const requests = [], server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
  if (modules.has(req.url)) { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(modules.get(req.url)); }
  res.writeHead(404); res.end();
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = path.join(stage, 'profile'), log = fs.openSync(path.join(out, 'browser-notice-stderr.log'), 'w');
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--mute-audio', 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', log] });
  fs.closeSync(log);
  let launchError, ws, nextId = 0;
  child.on('error', error => { launchError = error; });
  const pending = new Map(), exceptions = [], issues = [];
  const report = { generatedAt: new Date().toISOString(), source: ['src/ui/server-notice.ts', 'src/ui/i18n.ts', 'index.html CSS'],
    sourceSha256: Object.fromEntries(['src/ui/server-notice.ts', 'src/ui/i18n.ts', 'index.html'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    browser: path.basename(browser), samples: [], exceptions, issues, checks: 0 };
  const check = (condition, description) => { report.checks++; if (!condition) issues.push(description); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  };
  const snapshot = async name => { const result = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `browser-notice-${name}.png`), Buffer.from(result.data, 'base64')); };
  const geometry = () => evaluate(`(()=>{
    const o=document.querySelector('.nf-server-notice'),p=o.querySelector('section'),b=p.querySelector('button'),title=p.querySelector('h2');
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const r=b.getBoundingClientRect();
    return {viewport:[innerWidth,innerHeight],panel:rect(p),button:rect(b),title:rect(title),scrollTop:p.scrollTop,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,
      horizontalOverflow:p.scrollWidth>p.clientWidth+1,buttonReachable:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b,
      focusedButton:document.activeElement===b,bodyTouchAction:getComputedStyle(document.body).touchAction,panelTouchAction:getComputedStyle(p).touchAction};})()`);
  const key = async (key, code, modifiers = 0) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); };
  try {
    const file = path.join(profile, 'DevToolsActivePort'), deadline = Date.now() + 25000;
    while (!fs.existsSync(file)) { if (launchError) throw launchError; if (child.exitCode !== null) throw Error('Browser exited'); if (Date.now() > deadline) throw Error('Browser startup timed out'); await sleep(100); }
    const port = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0], targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { const request = pending.get(message.id); if (!request) return; pending.delete(message.id); if (message.error) request.reject(Error(JSON.stringify(message.error))); else request.resolve(message.result); }
      else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text); });
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await evaluate(`(async()=>{const until=performance.now()+5000;while(!window.__READY){if(performance.now()>until)throw Error('module ready timeout');await new Promise(r=>setTimeout(r,20));}})()`);
    for (const [width, height, touch] of [[1280, 800, false], [780, 360, true], [360, 780, true]]) {
      const name = `${width}x${height}-${touch ? 'touch' : 'mouse'}`;
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
      await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 1 });
      await evaluate('openNotice()'); await sleep(60);
      const sample = { name, initial: await geometry() }; report.samples.push(sample);
      const p = sample.initial.panel;
      check(p.x >= 0 && p.y >= 0 && p.right <= width + 1 && p.bottom <= height + 1, `${name}: modal bounded by viewport`);
      check(!sample.initial.horizontalOverflow, `${name}: no horizontal overflow`);
      check(sample.initial.scrollTop === 0, `${name}: opening a long announcement starts at its title`);
      check(sample.initial.focusedButton, `${name}: focus enters dialog`);
      const literal = await evaluate(`(()=>{const p=document.querySelector('.nf-server-notice');return {images:p.querySelectorAll('img,script').length,plain:p.textContent.includes('<img src='),injected:__NOTICE.injected,mismatch:p.textContent.includes('版本不同')||p.textContent.includes('版本不一致')};})()`);
      sample.literal = literal; check(literal.images === 0 && literal.plain && !literal.injected, `${name}: announcement is literal text`);
      check(literal.mismatch, `${name}: version mismatch remains visible as a compatibility notice`);
      await snapshot(name + '-open');
      await key('Tab', 'Tab'); check((await geometry()).focusedButton, `${name}: Tab stays in modal`);
      await key('Tab', 'Tab', 8); check((await geometry()).focusedButton, `${name}: Shift Tab stays in modal`);
      await evaluate(`document.querySelector('.nf-server-notice section').scrollTop=0`);
      const x = p.x + p.width * .5, startY = p.bottom - Math.min(50, p.height * .2), endY = p.y + Math.min(50, p.height * .2);
      if (touch) {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY, id: 1 }] });
        for (let i = 1; i <= 10; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY + (endY - startY) * i / 10, id: 1 }] }); await sleep(20); }
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y: (p.y + p.bottom) / 2, deltaX: 0, deltaY: 550 });
      await sleep(250); sample.afterGesture = await geometry();
      check(sample.afterGesture.scrollTop > 20, `${name}: real ${touch ? 'touch drag' : 'wheel'} scrolls the long announcement`);
      // Place the panel at its end after verifying native gestures, then check
      // actual hit-testing and click dispatch on the action in every viewport.
      await evaluate(`(()=>{const panel=document.querySelector('.nf-server-notice section');panel.scrollTop=panel.scrollHeight})()`);
      await sleep(60); sample.bottom = await geometry();
      check(sample.bottom.buttonReachable, `${name}: Continue is visible and hittable after scrolling`);
      await snapshot(name + '-bottom');
      const b = sample.bottom.button;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x + b.width / 2, y: b.y + b.height / 2, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x + b.width / 2, y: b.y + b.height / 2, button: 'left', clickCount: 1 });
      check(await evaluate(`!document.querySelector('.nf-server-notice')&&document.activeElement===document.querySelector('#underlying')`), `${name}: close restores prior focus`);
      await evaluate('openNotice()'); await key('Escape', 'Escape');
      check(await evaluate(`!document.querySelector('.nf-server-notice')`), `${name}: Escape closes modal`);
    }
    report.leaks = await evaluate('__NOTICE.leaks');
    // Closing with Escape removes the overlay before keyup, so the underlying
    // page may observe that release; modal keydown/pointer/wheel must not leak.
    check(['keydown', 'pointerdown', 'pointerup', 'wheel'].every(name => report.leaks[name] === 0), 'dialog events do not activate underlying menu');
    check(!requests.includes('/never.png'), 'injected-looking text makes no resource request');
    check(exceptions.length === 0, 'no browser runtime exceptions');
    report.ok = issues.length === 0;
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, issues, samples: report.samples.map(sample => ({ name: sample.name, scrollAfterGesture: sample.afterGesture.scrollTop, initialScrollTop: sample.initial.scrollTop })) }, null, 2));
    assert.equal(issues.length, 0, 'Browser modal requirements failed: ' + issues.join('; '));
  } finally {
    fs.writeFileSync(path.join(out, 'browser-notice.json'), JSON.stringify(report, null, 2) + '\n');
    if (ws?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch {} ws.close(); }
    for (const request of pending.values()) request.reject(Error('Test closed')); pending.clear();
    if (child.exitCode === null) child.kill();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.stack || error); server.close(); process.exitCode = 1; });
