// Quick diagnostic runner — focused probes (preview pipeline / note visibility), then exits.
'use strict';
// GUI launches can detach the inherited console. Persist diagnostics regardless.
for (const stream of [process.stdout, process.stderr]) stream.on('error', err => {
  if (err.code !== 'EPIPE') throw err;
});
const diagnosticLog = (...args) => {
  const fs = require('fs'), path = require('path');
  const text = args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  fs.appendFileSync(path.join(require('electron').app.getPath('userData'), 'diagnostic.log'), text + '\n');
  console.log(text);
};

async function run(win, app) {
  if (process.env.NF_DIAG_MODE === 'menu') return require('./menu-runtime-test.cjs').run(win, app);
  if (process.env.NF_DIAG_MODE === 'subscreens') return require('./subscreen-runtime-test.cjs').run(win, app);
  if (process.env.NF_DIAG_MODE === 'storyboard') return require('./storyboard-runtime-test.cjs').run(win, app);
  if (process.env.NF_DIAG_MODE === 'storyboard-visual') return require('./storyboard-visual-test.cjs').run(win, app);
  if (process.env.NF_DIAG_MODE === 'holds') return require('./hold-runtime-test.cjs').run(win, app);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => {
    console.error('[diag] timeout');
    app.exit(3);
  }, 60000);
  try {
    await sleep(1800);
    await js(`window.__NF.testMode = true`);
    if (process.env.NF_DIAG_MODE === 'game') {
      // gameplay note visibility probe (dense chart, sampled when notes are mid-field)
      await js(`(async () => {
        const charts = await window.__NF.store.listCharts();
        const c = charts.find(c => (c.version || '').includes('Suic!de')) || charts.find(c => (c.version || '').includes('evil')) || charts[0];
        window.__NF.mods.auto = true;
        const skins = await window.__NF.store.listSkins();
        if (skins.length) window.__NF.settings.skinId = skins[0].id;
        window.__NF.gotoScreen('play', { entry: c });
      })()`);
      // wait until chart time is in a dense section (first notes ~2.4s in Mopemope)
      await js(`new Promise(res => {
        const iv = setInterval(() => {
          const s = window.__NF.screen;
          if (s && s.sess && s.sess.chartTime() >= 5000) { clearInterval(iv); res(); }
          else if (!s || !s.sess) { clearInterval(iv); res(); }
        }, 300);
      })`);
      await sleep(600);
      const out = await js(`(() => {
        const s = window.__NF.screen;
        if (!s || !s.renderer || !s.sess) return { missing: true };
        const c = window.__NF.canvas;
        const ctx = c.getContext('2d');
        const { ox, oy, scale } = s.renderer.fieldOrigin(window.__NF.w, window.__NF.h);
        const widths = s.renderer.laneWidths(s.sess);
        const totalW = widths.reduce((a, b) => a + b, 0);
        const x0 = s.sess.laneStart();
        const hitY = s.sess.hitY();
        const dp = window.__NF.dpr * (window.__NF.settings.resScale || 1);
        const fx = Math.round((ox + x0 * scale) * dp);
        const fw = Math.round(totalW * scale * dp);
        const band = (y0, h) => {
          const fy = Math.round((oy + y0 * scale) * dp);
          const fh = Math.round(h * scale * dp);
          const d = ctx.getImageData(fx, fy, Math.min(fw, c.width - fx), Math.min(fh, c.height - fy)).data;
          let bright = 0, colored = 0, total = 0;
          for (let i = 0; i < d.length; i += 16) {
            total++;
            if (d[i] + d[i+1] + d[i+2] > 500) bright++;
            if (d[i] + d[i+1] + d[i+2] > 120) colored++;
          }
          return { bright: +(bright / Math.max(1, total)).toFixed(3), colored: +(colored / Math.max(1, total)).toFixed(3) };
        };
        const tm = s.sess.timeMap;
        const t = s.sess.drawTime();
        const unjudged = s.sess.notes.filter((x) => !s.sess.isJudged(x.idx));
        const dump = unjudged.slice(0, 8).map((n) => ({
          t: Math.round(n.t),
          col: n.col,
          sv: +tm.svBeatAt(n.t).toFixed(3),
          yHead: Math.round(hitY - (tm.svBeatAt(n.t) - tm.svBeatAt(t)) * s.renderer.beatHeight()),
        }));
        return {
          missing: false,
          phase: s.sess.phase,
          t: Math.round(t),
          svNow: +tm.svBeatAt(t).toFixed(2),
          bh: s.renderer.beatHeight(),
          unjudged: unjudged.length,
          dump,
          upperBand: band(hitY - 430, 110),
          midBand: band(hitY - 260, 140),
          lowerBand: band(hitY - 120, 110),
        };
      })()`);
      diagnosticLog('[diag-game]', JSON.stringify(out));
      const skin = await js(`(() => {
        const s = window.__NF.screen;
        const r = s.renderer, sess = s.sess;
        const layout = r.skin;
        return {
          skin: layout?.name,
          loaded: layout?.columns.map(c => [c.noteImg, c.noteImgH, c.bodyImg, c.noteImgT].map(p => !!r.images.get(p))),
          pixelsPerSecond: (sess.timeMap.svBeatAt(6000) - sess.timeMap.svBeatAt(5000)) * r.beatHeight(),
          firstNote: sess.notes[0].t,
          laneStart: sess.laneStart(),
          laneCenter: sess.laneStart() + sess.laneWidths().reduce((a,b) => a+b, 0) / 2
        };
      })()`);
      diagnosticLog('[diag-skin-scroll]', JSON.stringify(skin));
      const fs = require('fs'), path = require('path');
      const dir = path.join(app.getPath('userData'), 'diagnostics');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'gameplay.png'), (await win.webContents.capturePage()).toPNG());
      if (out.missing || out.phase !== 'playing' || out.bh !== 275 || !skin.loaded?.every(c => c.every(Boolean)) || skin.pixelsPerSecond < 500 || skin.laneCenter !== 256) throw new Error('skin/scroll runtime regression');
      app.exit(0);
      return;
    }
    // default: preview pipeline probe
    await js(`window.__NF.gotoScreen('select')`);
    await sleep(600);
    const result = await js(`(async () => {
      const out = {};
      const s = window.__NF.screen;
      for (let i = 0; i < 20 && s.view.length === 0; i++) await new Promise(r => setTimeout(r, 400));
      const entry = s.view[0];
      out.viewLen = s.view.length;
      if (!entry) return out;
      out.entry = entry.id;
      out.ctxBefore = window.__NF.audio.ctx ? window.__NF.audio.ctx.state : 'none';
      try {
        const bytes = await window.__NF.store.getChartBytes(entry.id);
        out.bytesLen = bytes ? bytes.length : 0;
        const arc = window.__NF_TEST.readNFM(bytes);
        const audio = arc.files.get(arc.chart.meta.audio);
        out.audioLen = audio ? audio.length : 0;
        out.previewTime = arc.chart.meta.previewTime;
        await window.__NF.audio.previewMusic(audio, entry.id, arc.chart.meta.previewTime >= 0 ? arc.chart.meta.previewTime : 0, 0.3);
        await new Promise(r => setTimeout(r, 400));
        out.active = window.__NF.audio.previewActive;
        out.info = window.__NF.audio.previewInfo;
        out.ctxAfter = window.__NF.audio.ctx ? window.__NF.audio.ctx.state : 'none';
      } catch (e) {
        out.error = String((e && (e.stack || e.message)) || e);
      }
      return out;
    })()`);
    console.log('[diag]', JSON.stringify(result));
    app.exit(0);
  } catch (e) {
    console.error('[diag] FAILED:', e);
    app.exit(2);
  }
}

module.exports = { run };
