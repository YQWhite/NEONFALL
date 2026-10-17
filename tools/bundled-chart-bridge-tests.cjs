'use strict';

// Evaluate the real desktop bridge in a VM. No Electron process or user-data
// access is involved; every filesystem operation uses a small in-memory fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
const win = path.win32;
const fixtureName = 'もぺもぺ [-_Suic!de.-.].nfm';
const chartBytes = Buffer.from('bundled chart fixture');

function desktopHandlers(packaged) {
  const mainDir = packaged ? 'C:\\fixture\\release\\resources\\app' : 'C:\\fixture\\neonfall\\electron';
  const seedDir = packaged ? win.join(mainDir, 'seed-charts') : 'C:\\fixture\\samples-converted';
  const files = new Map([[win.join(seedDir, fixtureName), chartBytes]]);
  const dirs = new Set([seedDir, win.join(seedDir, 'directory.nfm')]);
  if (packaged) dirs.add(win.join(mainDir, 'dist'));
  const reads = [];
  const handlers = new Map();
  const mockFs = {
    existsSync: name => files.has(name) || dirs.has(name),
    statSync: name => ({ isFile: () => files.has(name), isDirectory: () => dirs.has(name) }),
    readFileSync(name) {
      assert.ok(files.has(name), 'only the fixture bundle may be read');
      reads.push(name);
      return files.get(name);
    },
  };
  const mockElectron = {
    app: { commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    protocol: { registerSchemesAsPrivileged() {} },
  };
  vm.runInNewContext(mainSource + '\nregisterIpc();', {
    __dirname: mainDir,
    process: { env: {} },
    Buffer,
    require(name) {
      if (name === 'electron') return mockElectron;
      if (name === 'fs') return mockFs;
      if (name === 'path') return win;
      if (name === 'url') return require('node:url');
      assert.fail('unexpected module: ' + name);
    },
  }, { filename: 'electron/main.cjs' });
  return { read: handlers.get('nf-read-bundled-chart'), reads, seedDir };
}

for (const packaged of [false, true]) {
  const { read, reads, seedDir } = desktopHandlers(packaged);
  assert.equal(typeof read, 'function', 'main must register the bundled-chart handler');
  assert.equal(read({}, fixtureName), chartBytes.toString('base64'));
  assert.deepEqual(reads, [win.join(seedDir, fixtureName)]);
  for (const name of [
    undefined, null, 123, {}, '', '../outside.nfm', '..\\outside.nfm',
    'C:\\outside.nfm', '/outside.nfm', '\\outside.nfm', 'C:outside.nfm',
    'chart.nfm:other.nfm', 'nested/chart.nfm', 'nested\\chart.nfm',
    'skin.nfsk', 'main.cjs', 'chart.nfm.exe', 'missing.nfm', 'directory.nfm',
  ]) {
    assert.equal(read({}, name), null, 'invalid, missing or directory bundle must return null: ' + String(name));
  }
  assert.equal(reads.length, 1, 'rejected names must not read any files');
}

let exposed;
const invokes = [];
vm.runInNewContext(preloadSource, {
  require(name) {
    assert.equal(name, 'electron');
    return {
      contextBridge: {
        exposeInMainWorld(name, api) {
          assert.equal(name, 'neonfallBridge');
          exposed = api;
        },
      },
      ipcRenderer: { invoke: (...args) => { invokes.push(args); return Promise.resolve('bundle data'); } },
    };
  },
}, { filename: 'electron/preload.cjs' });
assert.equal(typeof exposed.readBundledChart, 'function');
exposed.readBundledChart(fixtureName).then(result => {
  assert.equal(result, 'bundle data');
  assert.deepEqual(invokes, [['nf-read-bundled-chart', fixtureName]]);
  console.log('PASS bundled chart bridge: dev/package paths, preload IPC, valid bundle, traversal/type/extension/missing/directory rejection');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
