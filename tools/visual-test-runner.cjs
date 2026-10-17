// Visual test runner (Electron) — drives the app, captures screenshots of every screen.
'use strict';
const fs = require('fs');
const path = require('path');

async function run(win, app) {
  const outDir = path.join(__dirname, '..', 'test-shots');
  fs.mkdirSync(outDir, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
      console.log('[shot]', name);
    } catch (e) {
      console.error('[shot] failed', name, e.message);
    }
  };
  // watchdog: never hang the CI for more than 300s
  const watchdog = setTimeout(() => {
    console.error('[visual-test] watchdog timeout');
    app.exit(3);
  }, 300000);

  try {
    // seed converted charts into the desktop library
    const chartsDir = path.join(app.getPath('userData'), 'charts');
    const seed = path.join(__dirname, '..', '..', 'samples-converted');
    if (fs.existsSync(seed)) {
      for (const f of fs.readdirSync(seed)) {
        if (f.endsWith('.nfm')) {
          fs.copyFileSync(path.join(seed, f), path.join(chartsDir, f));
        }
      }
      console.log('[seed] charts copied');
    }

    await sleep(1800);
    // test mode: keep running even if the window is occluded/minimized
    await js(`window.__NF.testMode = true`);
    await shot('01-menu');

    await js(`window.__NF.gotoScreen('select')`);
    await sleep(1500);
    await shot('02-select');

    await js(`window.__NF.gotoScreen('settings')`);
    await sleep(500);
    await shot('03-settings');

    await js(`window.__NF.gotoScreen('account')`);
    await sleep(500);
    await shot('04-account');

    await js(`window.__NF.gotoScreen('import')`);
    await sleep(500);
    await shot('05-import');

    // preview behavior: select via setSel → preview loops from preview point to song end
    const previewInfo = await js(`(async () => {
      window.__NF.gotoScreen('select');
      await new Promise(r => setTimeout(r, 400));
      const s = window.__NF.screen;
      for (let i = 0; i < 20 && s.view.length === 0; i++) await new Promise(r => setTimeout(r, 500));
      const viewLen = s.view.length;
      s.setSel(0);
      await new Promise(r => setTimeout(r, 2200));
      const info = window.__NF.audio.previewInfo;
      return { active: window.__NF.audio.previewActive, info, viewLen };
    })()`);
    console.log('[preview]', JSON.stringify(previewInfo));

    // gameplay with the storyboard chart, autoplay on
    const info = await js(`(async () => {
      const charts = await window.__NF.store.listCharts();
      let c = charts.find(c => (c.version || '').includes('Suic!de')) || charts.find(c => (c.version || '').includes('evil')) || charts[0];
      window.__NF.mods.auto = true;
      window.__NF.gotoScreen('play', { entry: c });
      return { title: c.title, version: c.version, keys: c.keys, notes: c.notes };
    })()`);
    console.log('[play]', JSON.stringify(info));
    // no countdown: playing + music running within 2.5s of entering
    await sleep(2500);
    const startState = await js(`(() => {
      const s = window.__NF.screen;
      return { phase: s && s.sess ? s.sess.phase : 'none', music: s && s.sess ? s.sess.musicStarted : false, previewStillOn: window.__NF.audio.previewActive, t: s && s.sess ? Math.round(s.sess.chartTime()) : -1 };
    })()`);
    console.log('[start]', JSON.stringify(startState));
    await shot('06-gameplay-start');
    await sleep(7000);
    // note visibility: bright note pixels in the UPPER and LOWER lane regions
    const noteCheck = await js(`(() => {
      const s = window.__NF.screen;
      if (!s || !s.renderer || !s.sess) return { missing: true };
      const c = window.__NF.canvas;
      const ctx = c.getContext('2d');
      const { ox, oy, scale } = s.renderer.fieldOrigin(window.__NF.w, window.__NF.h);
      const widths = s.renderer.laneWidths(s.sess);
      const totalW = widths.reduce((a, b) => a + b, 0);
      const x0 = s.sess.skin ? s.sess.skin.columnStart ?? (512 - totalW) / 2 : (512 - totalW) / 2;
      const hitY = s.sess.hitY();
      const dp = window.__NF.dpr * (window.__NF.settings.resScale||1);
      const fx = Math.round((ox + x0 * scale) * dp);
      const fw = Math.round(totalW * scale * dp);
      const band = (y0, h) => {
        const fy = Math.round((oy + y0 * scale) * dp);
        const fh = Math.round(h * scale * dp);
        const d = ctx.getImageData(fx, fy, Math.min(fw, c.width - fx), Math.min(fh, c.height - fy)).data;
        let bright = 0, total = 0;
        for (let i = 0; i < d.length; i += 16) {
          total++;
          if (d[i] + d[i+1] + d[i+2] > 500) bright++;
        }
        return +(bright / Math.max(1, total)).toFixed(3);
      };
      return {
        missing: false,
        upperBand: band(hitY - 430, 110),  // far above the hitline
        lowerBand: band(hitY - 250, 200),  // approaching the hitline
        hitlineY: Math.round(oy + hitY * scale),
      };
    })()`);
    console.log('[notes]', JSON.stringify(noteCheck));
    await shot('07-gameplay-mid');

    // storyboard verification: at ~73.5s the Suic!de SB shows white X1 sprites
    await js(`new Promise(res => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const s = window.__NF.screen;
        if (!s || !s.sess) { clearInterval(iv); res(false); return; }
        if (s.sess.chartTime() >= 73000 || Date.now() - t0 > 90000) { clearInterval(iv); res(true); }
      }, 400);
    })`);
    // FPS measurement over 3s during the storyboard-heavy section
    const fps = await js(`new Promise(res => {
      let frames = 0; const t0 = performance.now();
      const loop = () => { frames++; if (performance.now() - t0 < 3000) requestAnimationFrame(loop); else res(Math.round(frames / 3)); };
      requestAnimationFrame(loop);
    })`);
    console.log('[fps]', fps, 'during storyboard section');
    const sbStats = await js(`(() => {
      const s = window.__NF.screen;
      if (!s || !s.sbCanvas) return { missing: true };
      const ctx = s.sbCanvas.getContext('2d');
      const d = ctx.getImageData(0, 0, s.sbCanvas.width, s.sbCanvas.height).data;
      let bright = 0, total = 0, colored = 0;
      for (let i = 0; i < d.length; i += 40) {
        total++;
        if (d[i] + d[i+1] + d[i+2] > 240) bright++;
        if (Math.abs(d[i] - d[i+1]) > 25 || Math.abs(d[i+1] - d[i+2]) > 25) colored++;
      }
      return { missing: false, brightRatio: +(bright / total).toFixed(3), coloredRatio: +(colored / total).toFixed(3), sprites: s.sess.sb ? s.sess.sb.objects.length : 0 };
    })()`);
    console.log('[sb]', JSON.stringify(sbStats));
    await shot('08b-storyboard');

    // pause menu
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(700);
    await shot('10-pause');
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });

    // wait for result screen
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const name = await js(`window.__NF.screen ? window.__NF.screen.name : null`);
      if (name === 'result') break;
    }
    await sleep(800);
    await shot('09-result');

    console.log('[visual-test] done');
    app.exit(0);
  } catch (e) {
    console.error('[visual-test] FAILED:', e);
    try {
      await shot('99-error');
    } catch {}
    app.exit(2);
  }
}

module.exports = { run };
