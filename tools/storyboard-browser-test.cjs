'use strict';
// Run the real PlayScreen checks in installed Chrome, with an isolated profile.
// Useful when the local Electron runtime cannot pass Windows installation ACL checks.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.NF_BROWSER_OUTPUT || path.join(root, 'test-results', 'storyboard-browser'));
const chrome = process.env.NF_BROWSER_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fixtureDir = path.resolve(root, '..', 'samples-converted');
const fixture = fs.readdirSync(fixtureDir).find(name => name.includes('Suic!de') && name.endsWith('.nfm'));
if (!fixture) throw new Error('Mopemope Suic!de fixture missing');
fs.mkdirSync(output, { recursive: true });
const profile = path.join(output, `chrome-profile-${Date.now()}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/fixture.nfm') {
      res.setHeader('Content-Type', 'application/octet-stream');
      fs.createReadStream(path.join(fixtureDir, fixture)).pipe(res);
    } else if (pathname === '/' || pathname === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      fs.createReadStream(path.join(root, 'dist', 'index.html')).pipe(res);
    } else {
      // An HTML response lets the app detect that this isn't its chart server.
      res.setHeader('Content-Type', 'text/html');
      res.end('');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browserLog = fs.openSync(path.join(output, 'browser-stderr.log'), 'a');
  const child = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1280,800', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', browserLog] });
  fs.closeSync(browserLog);
  let launchError;
  child.on('error', error => { launchError = error; });
  let ws;
  const pending = new Map();
  let nextId = 1;
  let result = 2;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 45000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(portFile)) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Chrome exited during startup: ${child.exitCode}`);
      if (Date.now() > deadline) throw new Error('Chrome did not expose DevTools');
      await sleep(100);
    }
    const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(target => target.type === 'page');
    if (!page) throw new Error('Chrome page target missing');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    const contents = new EventEmitter();
    const events = new EventEmitter();
    const exceptions = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method) events.emit(message.method, message.params);
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails);
        contents.emit('console-message', {}, 3, JSON.stringify(message.params.exceptionDetails));
      } else if (message.method === 'Runtime.consoleAPICalled') {
        const info = message.params;
        if (info.type === 'error') contents.emit('console-message', {}, 3, info.args.map(arg => arg.value || arg.description).join(' '));
      }
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    contents.executeJavaScript = async expression => {
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result?.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Page navigation timed out')), 30000);
      events.once('Page.loadEventFired', () => { clearTimeout(timer); resolve(); });
    });
    await send('Page.navigate', { url });
    await loaded;
    await contents.executeJavaScript(`(async()=>{const deadline=Date.now()+30000;while(!window.__NF?.store){if(Date.now()>deadline)throw Error('App startup timeout: '+document.body.innerText);await new Promise(r=>setTimeout(r,50));}})()`);
    await contents.executeJavaScript(`(async()=>{const bytes=new Uint8Array(await (await fetch('/fixture.nfm')).arrayBuffer());await window.__NF.store.putChart(bytes,${JSON.stringify(fixture)});})()`);
    await require('./storyboard-visual-test.cjs').run({ webContents: contents }, {
      getPath: () => output,
      exit: code => { result = code; },
    });
    fs.writeFileSync(path.join(output, 'renderer-exceptions.json'), JSON.stringify(exceptions, null, 2));
    if (exceptions.length) result = 2;
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { await send('Browser.close'); } catch { /* target closes during response */ }
      ws.close();
    }
    for (const request of pending.values()) request.reject(new Error('Browser test closed'));
    pending.clear();
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(`Storyboard browser verification exit ${result}: ${output}`);
  process.exitCode = result;
}

main().catch(error => { console.error(error); process.exitCode = 2; });
