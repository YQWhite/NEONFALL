'use strict';
// Real Chromium/WebAudio regression, isolated from player data and browser profiles.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { zipSync, strToU8 } = require('fflate');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.env.NF_BROWSER_OUTPUT || path.join(root, 'test-results/rhythm-fix'));
fs.mkdirSync(out, { recursive: true });
const mode = process.env.NF_RHYTHM_BEFORE ? 'before' : 'after';
const stage = fs.mkdtempSync(path.join(out, 'browser-'));
const browser = process.env.NF_BROWSER_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
Object.assign(process.env, { HOST: '127.0.0.1', PORT: '0', NF_DATA_DIR: path.join(stage, 'data'), NF_SEED_DIR: path.resolve(root, '../samples-converted'), NF_DIST_DIR: path.join(root, 'dist') });
const { server } = require('../server/server.js');

// Exercise the real NFM -> readNFM -> select -> decodeAudioData -> analyser
// path. These small PCM fixtures only live in this isolated browser's memory.
function entryFixture(name, { computed = false, authored = false, natural = false, stall = false } = {}) {
  const sampleRate = 8000, seconds = 40, frames = sampleRate * seconds;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  const start = computed ? 10000 : 2000, preview = natural ? 0 : computed || authored ? start : 2500;
  const soundAt = (natural ? start : preview) + 650;
  for (let i = 0; i < frames; i++) {
    const ms = i / sampleRate * 1000;
    // The inferred case has its only strong high-frequency section at the end,
    // so the strongest thirty-second window is the final 10s..40s span.
    const audible = computed ? ms >= soundAt : ms < start - 50 || ms >= soundAt;
    wav.writeInt16LE(audible ? Math.round(Math.sin(i * 2 * Math.PI * (computed ? 1800 : 440) / sampleRate) * .3 * 32767) : 0, 44 + i * 2);
  }
  const chart = { format: 'neonfall-chart', version: 1, keys: 4, od: 8, offset: 0,
    timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [], notes: [],
    meta: { title: name, artist: 'Isolated browser fixture', creator: 'Regression', version: 'Diagnostic', audio: 'probe.wav',
      audioLeadIn: 0, previewTime: preview, previewSource: computed ? 'generated' : 'authored', lengthMs: seconds * 1000 } };
  if (!computed && !authored) chart.kiai = [{ t: start, end: 32000 }];
  const bytes = zipSync({ 'chart.nf': strToU8(JSON.stringify(chart)), 'probe.wav': wav }, { level: 9 });
  return { name, computed, authored, natural, stall, expectedStart: start, preview, soundAt,
    entry: { id: 'entry-probe-' + name, name: name + '.nfm', title: name, artist: chart.meta.artist, creator: 'Regression',
      version: 'Diagnostic', keys: 4, stars: 1, notes: 0, lengthMs: seconds * 1000, size: bytes.length, addedAt: 0 },
    data: Buffer.from(bytes).toString('base64') };
}

async function main() {
  if (!server.listening) await once(server, 'listening');
  const profile = path.join(stage, 'profile');
  const log = fs.openSync(path.join(out, `browser-${mode}-stderr.log`), 'w');
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1280,800', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', log] });
  fs.closeSync(log);
  let launchError, ws, nextId = 0;
  child.on('error', error => { launchError = error; });
  const pending = new Map(), exceptions = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  try {
    const portFile = path.join(profile, 'DevToolsActivePort'), deadline = Date.now() + 25000;
    while (!fs.existsSync(portFile)) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw Error('Browser exited: ' + child.exitCode);
      if (Date.now() > deadline) throw Error('Browser did not expose DevTools');
      await sleep(100);
    }
    const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = pending.get(message.id); if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(Error(JSON.stringify(message.error))); else request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    });
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await evaluate(`(async()=>{const deadline=Date.now()+25000;while(!window.__NF?.audio.previewActive){if(Date.now()>deadline)throw Error('Preview startup timeout');await new Promise(r=>setTimeout(r,80));}__NF.audio.resume();__NF.audio.seekPreview(30);})()`);
    const report = { mode, browser: path.basename(browser), samples: {}, exceptions };
    const capture = async name => {
      report.samples[name] = await evaluate(`(async()=>{
        const app=__NF, records=[], hashes=new Set();
        const until=performance.now()+1600;
        while(performance.now()<until){
          await new Promise(r=>setTimeout(r,40));
          const s=app.audio.samplePreviewSpectrum(),v=app.screen.visual;
          const x=Math.floor(app.w*.61),y=Math.floor(app.h*.28),w=Math.floor(app.w*.30),h=Math.floor(app.h*.57);
          const px=app.ctx.getImageData(x,y,w,h).data;let hash=2166136261;
          for(let i=0;i<px.length;i+=16)hash=Math.imul(hash^px[i],16777619);hashes.add(hash);
          records.push({energy:s.energy,pulse:v.pulse,band:Math.max(...v.bands),edge:Math.max(v.leftImpact,v.rightImpact),burst:v.sectionBurst});
        }
        const range=k=>({min:Math.min(...records.map(v=>v[k])),max:Math.max(...records.map(v=>v[k]))});
        return {state:app.audio.ctx.state,particles:app.settings.particles,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
          energy:range('energy'),pulse:range('pulse'),band:range('band'),edge:range('edge'),burst:range('burst'),differentIconFrames:hashes.size,samples:records.length};
      })()`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, `browser-${mode}-${name}.png`), Buffer.from(screenshot.data, 'base64'));
    };
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await evaluate('__NF.settings.particles=true');
    await capture('normal');
    await evaluate('__NF.settings.particles=false');
    await capture('particles-off');
    await evaluate('__NF.settings.particles=true');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await capture('reduced');
    if (mode === 'after') {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      // A diagnostic marker over real decoded music makes the short entry
      // effect observable without waiting for an arbitrary song's climax.
      report.kiaiEntry = await evaluate(`(async()=>{
        const app=__NF,m=app.menuMusic;app.settings.particles=true;
        const now=app.audio.previewTimeSec*1000,start=now+550;
        m.highlightRanges=[{t:start,end:start+5000}];m.lastHighlightStart=null;m.fountainStartedAt=-1;
        const records=[];
        while(app.audio.previewTimeSec*1000<start+450){
          await new Promise(r=>setTimeout(r,20));const v=app.screen.visual;
          records.push({time:app.audio.previewTimeSec*1000,age:v.fountainAgeMs,seed:v.fountainSeed,left:v.leftImpact,right:v.rightImpact,kiai:v.previewSection});
        }
        window.__NF_ENTRY_PROBE={start,seed:m.fountainSeed};
        return {markerSource:'diagnostic interval over real decoded music',start,records};
      })()`);
      let screenshot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, 'browser-kiai-entry-smoke.png'), Buffer.from(screenshot.data, 'base64'));
      report.kiaiSustained = await evaluate(`(async()=>{
        const app=__NF,p=window.__NF_ENTRY_PROBE,records=[];
        while(app.audio.previewTimeSec*1000<p.start+2400){await new Promise(r=>setTimeout(r,25));const v=app.screen.visual;
          records.push({age:v.fountainAgeMs,seed:v.fountainSeed,left:v.leftImpact,right:v.rightImpact,kiai:v.previewSection});}
        return {seedAtEntry:p.seed,records,finalAge:app.screen.visual.fountainAgeMs};
      })()`);
      screenshot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, 'browser-kiai-sustained.png'), Buffer.from(screenshot.data, 'base64'));
      assert.ok(report.kiaiEntry.records.some(record => record.age >= 0 && record.age < 100), 'natural kiai entry starts fountain');
      assert.equal(report.kiaiSustained.finalAge, -1, 'fountain finishes while kiai continues');
      assert.ok(report.kiaiSustained.records.every(record => record.seed === report.kiaiSustained.seedAtEntry), 'no repeated spray inside kiai');
      assert.ok(report.kiaiSustained.records.filter(record => record.kiai).every(record => record.left === 0 || record.right === 0), 'kiai flashes only one side at a time');
      assert.ok(report.kiaiSustained.records.some(record => record.left > .2) && report.kiaiSustained.records.some(record => record.right > .2), 'real kiai alternates sides');
    }
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    report.entryPackages = {};
    for (const fixture of [entryFixture('native-preview-interior'), entryFixture('authored-preview', { authored: true }),
      entryFixture('computed-preview', { computed: true }), entryFixture('native-natural', { natural: true }),
      entryFixture('native-frame-stall', { natural: true, stall: true })]) {
      const probe = await evaluate(`(async()=>{
        const fixture=${JSON.stringify(fixture)},app=__NF,m=app.menuMusic,a=app.audio;
        const oldRead=app.store.getChartBytes,oldParticles=app.settings.particles;
        const bytes=Uint8Array.from(atob(fixture.data),c=>c.charCodeAt(0));
        app.store.getChartBytes=async function(id){return id===fixture.entry.id?bytes:oldRead.call(this,id);};
        app.settings.particles=true;
        try {
          await m.select(fixture.entry);
          if(m.error)throw Error(m.error);
          // Select has resolved, but source.start is scheduled 20ms ahead.
          // Observe that first real zero-energy frame synchronously so this
          // regression cannot accidentally wait until the analyser is ready.
          const immediateSample=a.samplePreviewSpectrum(),immediate=m.visualizer(0);
          app.screen.visual=immediate;
          const ranges=m.highlightRanges.map(r=>({...r})),revision=a.previewTimelineRevision;
          const records=[{time:a.previewTimeSec*1000,energy:immediateSample.energy,age:immediate.fountainAgeMs,seed:immediate.fountainSeed,kiai:immediate.previewSection}];
          let screenshot=null,stallApplied=false;
          const end=fixture.soundAt+2300,deadline=performance.now()+10000;
          while(a.previewTimeSec*1000<end){
            if(performance.now()>deadline)throw Error('Fixture playback stalled: '+fixture.name);
            if(fixture.stall&&!stallApplied&&a.previewTimeSec*1000>1800){
              // Block a real RAF while WebAudio keeps advancing; App caps its
              // next dt at50ms, which must not turn this into a manual seek.
              const until=performance.now()+1000;while(performance.now()<until){}
              stallApplied=true;
            }
            await new Promise(r=>setTimeout(r,20));
            const v=app.screen.visual,s=a.samplePreviewSpectrum();
            records.push({time:a.previewTimeSec*1000,energy:s.energy,age:v.fountainAgeMs,seed:v.fountainSeed,kiai:v.previewSection});
            if(!screenshot&&v.fountainAgeMs>=300&&v.fountainAgeMs<600)screenshot=app.canvas.toDataURL('image/png');
          }
          return {ranges,analyzedStart:fixture.computed?a.previewHighlightMs():null,revisionBefore:revision,revisionAfter:a.previewTimelineRevision,
            initial:records[0],stallApplied,records,screenshot,final:records.at(-1)};
        } finally {app.store.getChartBytes=oldRead;app.settings.particles=oldParticles;}
      })()`);
      if (probe.screenshot) {
        fs.writeFileSync(path.join(out, `browser-${mode}-${fixture.name}-smoke.png`), Buffer.from(probe.screenshot.split(',')[1], 'base64'));
      }
      probe.capturedSmoke = !!probe.screenshot; delete probe.screenshot;
      report.entryPackages[fixture.name] = probe;
      // Persist partial evidence even when a new entry-path assertion fails.
      fs.writeFileSync(path.join(out, `browser-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
      if (mode === 'after') {
        assert.equal(probe.initial.energy, 0, fixture.name + ': first scheduled-source sample must be real silence');
        assert.equal(probe.ranges[0].t, fixture.expectedStart, fixture.name + ': actual chart/analysis establishes expected interval');
        if (fixture.computed) assert.equal(probe.analyzedStart, fixture.expectedStart, 'computed fixture uses real decoded PCM highlight');
        const emitted = probe.records.filter(record => record.age >= 0);
        assert.ok(emitted.length > 4, fixture.name + ': pending entry must survive silent analyser/boundary');
        assert.ok(probe.capturedSmoke, fixture.name + ': rendered smoke is captured after delayed audio onset');
        if (!fixture.stall) assert.ok(probe.records.some(record => record.time > fixture.expectedStart + 500 && record.energy === 0), fixture.name + ': silence lasts beyond old 500ms gate');
        assert.equal(new Set(emitted.map(record => record.seed)).size, 1, fixture.name + ': exactly one emission');
        assert.equal(probe.final.seed, emitted[0].seed, fixture.name + ': no repeat after fountain has ended');
        assert.equal(probe.final.age, -1, fixture.name + ': lifetime completes while the kiai continues');
        assert.equal(probe.revisionBefore, probe.revisionAfter, fixture.name + ': natural playback does not change transport revision');
        if (fixture.stall) assert.ok(probe.stallApplied, 'real RAF stall scenario executed');
      }
    }
    // True stereo anti-phase is audible on separate channels; a mono analyzer can cancel it.
    report.synthetic = await evaluate(`(async()=>{
      const a=__NF.audio,c=a.ctx,result={};
      const sample=()=>{const s=a.samplePreviewSpectrum();return {energy:s.energy,band:Math.max(...s.bands)};};
      for(const kind of ['antiphase','right-only','mono','silence']){
        const b=c.createBuffer(kind==='mono'?1:2,c.sampleRate*3,c.sampleRate),l=b.getChannelData(0),r=b.numberOfChannels>1?b.getChannelData(1):null;
        for(let i=0;i<l.length;i++){const v=kind==='silence'?0:Math.sin(i*2*Math.PI*220/c.sampleRate)*.3;l[i]=kind==='right-only'?0:v;if(r)r[i]=kind==='antiphase'?-v:v;}
        a.stopPreview();a.previewBuffer=b;a.previewLoopStart=0;a.previewVolume=.35;a.startPreviewAt(0);
        await new Promise(r=>setTimeout(r,350));result[kind]=sample();
        if(kind==='mono'){
          a.setPreviewVolume(0);result.muted=sample();a.setPreviewVolume(.35);
          a.pausePreview();result.paused=sample();a.resumePreview();await new Promise(r=>setTimeout(r,350));result.resumed=sample();
        }
      }
      return result;
    })()`);
    fs.writeFileSync(path.join(out, `browser-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
    if (mode === 'after') {
      for (const [name, sample] of Object.entries(report.samples)) {
        assert.equal(sample.state, 'running', name);
        assert.ok(sample.energy.max > .02 && sample.band.max > .05 && sample.pulse.max > .05, name + ': music feedback missing');
        assert.ok(sample.differentIconFrames > 3, name + ': frozen icon');
      }
      assert.equal(report.samples.reduced.edge.max, 0);
      assert.equal(report.samples.reduced.burst.max, 0);
      assert.equal(report.samples['particles-off'].burst.max, 0);
      for (const name of ['antiphase', 'right-only', 'mono', 'resumed']) {
        assert.ok(report.synthetic[name].energy > .1 && report.synthetic[name].band > .1, name + ': analyzer must detect audible channels');
      }
      for (const name of ['silence', 'muted', 'paused']) assert.deepEqual(report.synthetic[name], { energy: 0, band: 0 }, name);
      assert.equal(exceptions.length, 0);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (ws?.readyState === WebSocket.OPEN) {
      try { await send('Browser.close'); } catch {}
      ws.close();
    }
    for (const request of pending.values()) request.reject(Error('Test closed'));
    pending.clear();
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
