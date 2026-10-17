// NEONFALL Electron main — custom neonfall:// protocol, chart/skin fs bridge.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
// isolate automated test runs (and avoid clashing with a running instance)
if (process.env.NF_USER_DATA) {
  app.setPath('userData', process.env.NF_USER_DATA);
}
// Desktop menu radio must work on first launch without a user-gesture gate.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// In the packaged build the payload lives in resources/app (i.e. __dirname itself);
// in dev it lives one level above electron/.
const APP_PAYLOAD = fs.existsSync(path.join(__dirname, 'dist'))
  ? __dirname
  : ROOT;
const DIST = path.join(APP_PAYLOAD, 'dist');
const SEED_DIR = fs.existsSync(path.join(APP_PAYLOAD, 'seed-charts'))
  ? path.join(APP_PAYLOAD, 'seed-charts')
  : path.join(ROOT, '..', 'samples-converted');

protocol.registerSchemesAsPrivileged([
  { scheme: 'neonfall', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow = null;

function chartsDir() {
  return path.join(app.getPath('userData'), 'charts');
}
function skinsDir() {
  return path.join(app.getPath('userData'), 'skins');
}
function ensureDirs() {
  for (const d of [chartsDir(), skinsDir()]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// seed bundled demo charts + skins on first run (or when the dir is empty)
function seedAssets() {
  ensureDirs();
  const seed = SEED_DIR;
  if (!fs.existsSync(seed)) return;
  try {
    require('./bundled-assets.cjs').refreshBundledAssets(seed, chartsDir(), skinsDir());
  } catch (error) {
    // Keep an existing library usable if a sample cannot be refreshed (e.g. locked file).
    console.warn('Bundled sample refresh:', error.message);
  }
  const cdir = chartsDir();
  if (fs.readdirSync(cdir).filter((f) => f.endsWith('.nfm')).length === 0) {
    for (const f of fs.readdirSync(seed)) {
      if (f.endsWith('.nfm')) {
        fs.copyFileSync(path.join(seed, f), path.join(cdir, f));
      }
    }
  }
  const sdir = skinsDir();
  if (fs.readdirSync(sdir).filter((f) => f.endsWith('.nfsk')).length === 0) {
    for (const f of fs.readdirSync(seed)) {
      if (f.endsWith('.nfsk')) {
        fs.copyFileSync(path.join(seed, f), path.join(sdir, f));
      }
    }
  }
}

function registerIpc() {
  const listDir = (dir, ext) =>
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => {
        const id = f.slice(0, -ext.length);
        const st = fs.statSync(path.join(dir, f));
        return { id, name: f, size: st.size, mtime: st.mtimeMs };
      });
  const readFile = (dir, id, ext) => {
    const p = path.join(dir, id + ext);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p).toString('base64');
  };
  const writeFile = (dir, id, b64, ext) => {
    fs.writeFileSync(path.join(dir, id + ext), Buffer.from(b64, 'base64'));
  };

  ipcMain.handle('nf-list-charts', () => listDir(chartsDir(), '.nfm'));
  ipcMain.handle('nf-read-chart', (_e, id) => readFile(chartsDir(), id, '.nfm'));
  ipcMain.handle('nf-read-bundled-chart', (_e, name) => {
    // This bridge exposes only shipped chart files, never arbitrary paths.
    if (typeof name !== 'string' || !name.endsWith('.nfm') || /[\\/:]/.test(name) || path.basename(name) !== name) return null;
    const file = path.join(SEED_DIR, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file).toString('base64');
  });
  ipcMain.handle('nf-write-chart', (_e, id, _name, b64) => writeFile(chartsDir(), id, b64, '.nfm'));
  ipcMain.handle('nf-delete-chart', (_e, id) => {
    const p = path.join(chartsDir(), id + '.nfm');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  ipcMain.handle('nf-list-skins', () => listDir(skinsDir(), '.nfsk'));
  ipcMain.handle('nf-read-skin', (_e, id) => readFile(skinsDir(), id, '.nfsk'));
  ipcMain.handle('nf-write-skin', (_e, id, _name, b64) => writeFile(skinsDir(), id, b64, '.nfsk'));
  ipcMain.handle('nf-delete-skin', (_e, id) => {
    const p = path.join(skinsDir(), id + '.nfsk');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  ipcMain.handle('nf-pick-files', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Import charts & skins',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'NEONFALL importable', extensions: ['osz', 'mcz', 'osk', 'msp', 'nfm', 'nfsk'] }],
    });
    if (r.canceled || !r.filePaths?.length) return [];
    return r.filePaths.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p).toString('base64') }));
  });
  ipcMain.handle('nf-app-path', () => app.getPath('userData'));
  ipcMain.on('nf-quit', () => app.quit());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#05070f',
    title: 'NEONFALL',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep gameplay timing stable when unfocused
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadURL('neonfall://index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerProtocol() {
  protocol.handle('neonfall', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel || rel === '/') rel = 'index.html';
    let full = path.normalize(path.join(DIST, rel));
    if (!full.startsWith(DIST)) full = path.join(DIST, 'index.html');
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) full = path.join(DIST, 'index.html');
    return net.fetch(pathToFileURL(full).toString());
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    ensureDirs();
    seedAssets();
    registerIpc();
    registerProtocol();
    createWindow();

    if (process.env.NF_VISUAL_TEST || process.env.NF_DIAG) {
      const runnerCandidates = [
        path.join(APP_PAYLOAD, 'tools', 'visual-test-runner.cjs'),
        path.join(ROOT, 'tools', 'visual-test-runner.cjs'),
        path.join(ROOT, '..', 'tools', 'visual-test-runner.cjs'),
      ];
      const diagCandidates = [
        path.join(APP_PAYLOAD, 'tools', 'quick-diag.cjs'),
        path.join(ROOT, 'tools', 'quick-diag.cjs'),
        path.join(ROOT, '..', 'tools', 'quick-diag.cjs'),
      ];
      const paths = process.env.NF_DIAG ? diagCandidates : runnerCandidates;
      const scriptPath = paths.find((p) => fs.existsSync(p));
      if (scriptPath) {
        const runner = require(scriptPath);
        runner.run(mainWindow, app).catch((e) => {
          console.error('[visual-test] failed', e);
          app.exit(2);
        });
      }
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

void pathToFileURL;
