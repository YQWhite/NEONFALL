import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const output = path.resolve('test-results/avatar-crop-fix/mobile');
fs.mkdirSync(output, { recursive: true });
for (const filename of ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/segoeui.ttf']) {
  if (fs.existsSync(filename)) GlobalFonts.registerFromPath(filename, filename.includes('msyh') ? 'Microsoft YaHei' : 'Segoe UI');
}
globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.document = {
  documentElement: {}, activeElement: null, body: { appendChild() {} },
  createElement(tag) {
    if (tag === 'canvas') return createCanvas(1, 1);
    return { style: {}, value: '', type: 'text', addEventListener() {}, remove() {}, setAttribute() {},
      focus() { document.activeElement = this; }, blur() { document.activeElement = null; } };
  },
};
const { UI } = await import('../src/ui/widgets.ts');
const { MenuMusic } = await import('../src/ui/menu-music.ts');
const { DEFAULT_SETTINGS, DEFAULT_MODS } = await import('../src/core/types.ts');
const { setLanguage } = await import('../src/ui/i18n.ts');
const classes = {};
for (const [name, exported] of [['menu', 'MenuScreen'], ['select', 'SelectScreen'], ['settings', 'SettingsScreen'], ['account', 'AccountScreen'], ['import', 'ImportScreen']]) {
  classes[name] = (await import(`../src/ui/screens/${name}.ts`))[exported];
}
const entries = Array.from({ length: 20 }, (_, i) => ({ id: `test-${i}`, title: `Song ${Math.floor(i / 3)}`, artist: 'Artist', creator: 'Mapper', version: `${i % 3} Difficulty`,
  keys: 4, stars: 2 + i % 3, notes: 600, lengthMs: 150000, size: 2000, addedAt: 20 - i, name: `test-${i}.nfm` }));
const settings = structuredClone(DEFAULT_SETTINGS);
const app = {
  w: 780, h: 360, ctx: null, isTouch: true, platform: 'android', version: 'test', settings, mods: structuredClone(DEFAULT_MODS),
  account: { server: false, user: null }, serverOnline: false, centralLibrary: false,
  canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
  audio: { previewActive: false, previewTimeSec: 30, previewDurationSec: 150, ctx: { state: 'running' }, baseLatencyMs: 10, setPreviewDucking() {} },
  uiSound() {}, toast() {}, saveSettings() {}, gotoScreen(name) { this.destination = name; },
  server: { base: '', listCharts: async () => [], leaderboard: async () => [], myScores: async () => [] },
  store: { settings, getToken: () => '', listCharts: async () => entries, getChartBytes: async () => null, listSkins: async () => [], getBest: () => null, getBestScores: () => ({}) },
};
app.ui = new UI(app); app.menuMusic = new MenuMusic(app); app.menuMusic.entry = entries[0]; app.menuMusic.ensureStarted = async () => {}; app.menuMusic.select = async () => {};
const controls = [], files = [];
for (const method of ['button', 'chip', 'slider']) {
  const original = app.ui[method].bind(app.ui);
  app.ui[method] = (...args) => { controls.push({ id: args[0], x: args[1], y: args[2], w: args[3], h: args[4], clip: app.ui.clip ? { ...app.ui.clip } : null }); return original(...args); };
}
function draw(screen, filename = '', pointer = {}) {
  app.screen = screen; controls.length = 0;
  const canvas = createCanvas(app.w, app.h); app.ctx = canvas.getContext('2d');
  app.ctx.fillStyle = '#0d1218'; app.ctx.fillRect(0, 0, app.w, app.h);
  app.ui.beginFrame({ x: -1, y: -1, down: false, moved: false, downX: 0, downY: 0, ...pointer });
  screen.draw(app.ctx);
  if (['menu', 'select'].includes(screen.name)) app.menuMusic.draw(app.ctx);
  app.ui.endFrame();
  if (filename) { const file = `${app.w}x${app.h}-${filename}.png`; fs.writeFileSync(path.join(output, file), canvas.toBuffer('image/png')); files.push(file); }
}
function bounded(ids) {
  for (const id of ids) {
    const control = controls.find(c => c.id === id);
    assert.ok(control, `control exists: ${id}`);
    assert.ok(control.x >= 0 && control.y >= 0 && control.w > 0 && control.h > 0 && control.x + control.w <= app.w + .01 && control.y + control.h <= app.h + .01,
      `${app.w}x${app.h} ${id} is visible: ${JSON.stringify(control)}`);
  }
}
function disjoint(ids) {
  const selected = controls.filter(c => ids.includes(c.id));
  for (let i = 0; i < selected.length; ++i) for (let j = i + 1; j < selected.length; ++j) {
    const a = selected[i], b = selected[j];
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} overlaps ${b.id}`);
  }
}
function click(screen, id) {
  draw(screen); const target = controls.find(c => c.id === id); assert.ok(target);
  const p = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
  draw(screen, '', { ...p, down: true }); draw(screen, '', { ...p, down: false });
}
setLanguage('zh-CN');
for (const [w, h] of [[568, 320], [640, 360], [780, 360], [844, 390], [960, 400], [1280, 800]]) {
  app.w = w; app.h = h;
  const menu = new classes.menu(app); menu.enter(); menu.t0 = -10000;
  draw(menu, 'menu');
  const menuIds = ['menu-play', 'menu-rankings', 'menu-settings', 'menu-account', 'menu-import', 'music-toggle', 'music-next', 'music-profile'];
  bounded(menuIds); disjoint(menuIds);
  click(menu, 'menu-settings'); assert.equal(app.destination, 'settings');

  const select = new classes.select(app); select.entries = entries; select.schedulePreview = () => {}; select.applyFilter();
  select.infoTab = 'details';
  draw(select, 'select');
  const selectIds = ['back', 'import', 'refresh', 'sort-cycle', 'key-0', 'key-4', 'key-5', 'key-6', 'key-7', 'key-8', 'play', 'mods', 'export', 'delete', 'music-toggle', 'music-next'];
  bounded(selectIds); disjoint(selectIds);
  assert.ok(select.listArea().h >= 140, 'landscape list leaves usable vertical space');
  assert.ok(select.detailViewport.h >= 40, 'selected title/details remain visible above actions');
  const d = select.detailViewport;
  select.pointerDown(d.x + 20, d.y + d.h - 3); select.pointerMove(d.x + 20, d.y + 2); select.pointerUp(d.x + 20, d.y + 2);
  assert.ok(select.detailScroll > 0, 'details can be dragged on touch devices');
  assert.ok(app.ui.p.moved, 'detail drag cannot click play or another control');
  const a = select.listArea(); select.pointerDown(a.x + 20, a.y + a.h - 3); select.pointerMove(a.x + 20, a.y + 3); select.pointerUp(a.x + 20, a.y + 3);
  assert.ok(select.scroll > 0, 'song tree can be dragged');
  select.showMods = true; draw(select, 'mods'); bounded(['mod-auto', 'mod-constantSpeed', 'mod-speed', 'mods-close']);
  select.leave();

  const setting = new classes.settings(app);
  for (const tab of ['general', 'gameplay', 'audio', 'video', 'input', 'skin', 'about']) {
    setting.tab = tab; setting.scroll = 0; draw(setting, `settings-${tab}`);
    bounded(['back', ...['general', 'gameplay', 'audio', 'video', 'input', 'skin', 'about'].map(t => 'tab-' + t)]);
    assert.ok(setting.viewport.h >= 124);
  }
  setting.tab = 'audio'; draw(setting);
  const v = setting.viewport; setting.pointerDown(v.x + 15, v.y + v.h - 5); setting.pointerMove(v.x + 15, v.y + 5); setting.pointerUp();
  assert.ok(setting.scroll > 0, 'settings touch scroll remains usable');
  setting.resize(); assert.equal(setting.drag, null);

  const imp = new classes.import(app); imp.localCharts = entries; draw(imp, 'import');
  imp.pointerDown(40, h - 30); imp.pointerMove(40, 120); imp.pointerUp();
  assert.ok(imp.scroll > 0, 'import content and local library accessible via touch');
  assert.ok(app.ui.p.moved, 'import drag cancels file/download button click');
  draw(imp, 'import-scrolled');

  const account = new classes.account(app); draw(account, 'account');
  account.pointerDown(60, h - 30); account.pointerMove(60, 120); account.pointerUp(60, 120);
  assert.ok(account.maxScroll === 0 || account.scroll > 0, 'account form and connection are touch-scrollable when content exceeds viewport');
  draw(account, 'account-scrolled');
  account.leave();
}

// Rotation must regenerate the actual row hit targets, and keep selection visible.
app.w = 360; app.h = 780;
const rotated = new classes.select(app); rotated.entries = entries; rotated.schedulePreview = () => {}; rotated.applyFilter(); rotated.sel = 16; rotated.resize();
const portraitHeight = rotated.rows.find(r => !r.header).height;
rotated.listDrag = { y: 50, scroll: 0, moved: false };
app.w = 780; app.h = 360; rotated.resize(); draw(rotated, 'rotation-select');
assert.ok(rotated.rows.find(r => !r.header).height < portraitHeight);
assert.equal(rotated.listDrag, null);
const row = rotated.rows.find(r => !r.header && r.index === 16), area = rotated.listArea();
assert.ok(row.top >= rotated.scroll && row.top + row.height <= rotated.scroll + area.h);
rotated.leave();
fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({ dimensions: ['568x320', '640x360', '780x360', '844x390', '960x400', '1280x800'], files,
  checks: ['menu/player controls bounded and disjoint', 'touch controls work without global scale', 'compact select toolbar/actions', 'all settings tabs accessible', 'import/details touch scroll', 'rotation regenerates song tree and clears gesture'] }, null, 2));
console.log(`PASS ${files.length} actual-screen Native Canvas captures, landscape geometry, real UI clicks, touch scrolling and orientation resize`);
