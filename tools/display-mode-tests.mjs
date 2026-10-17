import assert from 'node:assert/strict';

const handlers = new Map();
const documentHandlers = new Map();
const notices = [];
let entered = 0, exited = 0;
const button = { style: {}, hidden: false, attributes: {}, addEventListener(name, fn) { handlers.set(name, fn); }, setAttribute(k, v) { this.attributes[k] = v; } };
globalThis.document = {
  fullscreenElement: null,
  documentElement: { async requestFullscreen() { entered++; document.fullscreenElement = this; } },
  async exitFullscreen() { exited++; document.fullscreenElement = null; },
  createElement() { return button; }, body: { appendChild() {} }, addEventListener(name, fn) { documentHandlers.set(name, fn); },
};
globalThis.window = { innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: false }), screen: {} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Desktop', maxTouchPoints: 0 } });
const { DisplayMode } = await import('../src/ui/display-mode.ts');
(await import('../src/ui/i18n.ts')).setLanguage('en');
const display = new DisplayMode(message => notices.push(message));
assert.equal(entered, 0, 'windowed play starts without a rejected non-gesture fullscreen request');
await display.toggle();
assert.equal(entered, 1);
assert.equal(button.attributes['aria-pressed'], 'true');
await display.toggle();
assert.equal(exited, 1);
assert.equal(button.attributes['aria-pressed'], 'false');
document.documentElement.requestFullscreen = async () => { throw new Error('browser denied'); };
await display.toggle();
assert.equal(notices.length, 1, 'denied fullscreen gives a usable windowed fallback');
display.setScreen('play'); assert.equal(button.hidden, true, 'display control never overlays a touch lane');
display.setScreen('select'); assert.equal(button.hidden, true, 'library action buttons remain unobstructed');
display.setScreen('menu'); assert.equal(button.hidden, false);
let stopped = 0;
handlers.get('pointerdown')({ stopPropagation() { stopped++; } });
assert.equal(stopped, 1, 'fullscreen gesture does not click through into the canvas');

// Mobile portrait: fullscreen must be requested in the original gesture before
// waiting for anything; the landscape lock only follows successful fullscreen.
const order = [];
let locks = 0, unlocks = 0;
window.innerWidth = 360; window.innerHeight = 780;
window.matchMedia = () => ({ matches: true });
navigator.maxTouchPoints = 5;
window.screen.orientation = {
  async lock(mode) { assert.equal(mode, 'landscape'); assert.ok(document.fullscreenElement); order.push('lock'); locks++; },
  unlock() { unlocks++; },
};
let resolveEntry;
document.documentElement.requestFullscreen = function () {
  order.push('request'); entered++;
  return new Promise(resolve => { resolveEntry = () => { document.fullscreenElement = this; documentHandlers.get('fullscreenchange')(); resolve(); }; });
};
const entry = display.toggle();
assert.deepEqual(order, ['request'], 'fullscreen request remains synchronous inside the user gesture');
assert.equal(button.disabled, true);
const duplicate = display.toggle();
assert.equal(entered, 2, 'double taps do not start a second fullscreen request');
resolveEntry(); await entry; await duplicate;
assert.deepEqual(order, ['request', 'lock']); assert.equal(locks, 1); assert.equal(button.disabled, false);
await display.toggle();
assert.equal(unlocks, 1, 'the orientation lock owned by this control is released on exit');

document.documentElement.requestFullscreen = async function () { document.fullscreenElement = this; documentHandlers.get('fullscreenchange')(); };
await display.toggle();
document.fullscreenElement = null; documentHandlers.get('fullscreenchange')();
assert.equal(unlocks, 2, 'browser/back-button exits release the owned lock');

// The browser may leave fullscreen while lock() is unresolved.
let resolveLock;
window.screen.orientation.lock = () => new Promise(resolve => { resolveLock = resolve; });
const racing = display.toggle(); await Promise.resolve();
document.fullscreenElement = null; documentHandlers.get('fullscreenchange')();
resolveLock(); await racing;
assert.equal(unlocks, 3, 'a late lock cannot keep the windowed page locked');
assert.equal(button.attributes['aria-pressed'], 'false');

// Unsupported lock is an honest rotate instruction, not a false landscape claim.
delete window.screen.orientation.lock;
const prior = notices.length;
await display.toggle();
assert.equal(notices.length, prior + 1);
assert.match(notices.at(-1), /Rotate your device/);
await display.toggle();
window.screen.orientation.lock = async () => { throw new Error('not supported'); };
await display.toggle();
assert.equal(notices.length, prior + 2, 'denied landscape lock shows the rotate fallback');
await display.toggle();

// A touch-capable desktop with no coarse pointer keeps the desktop behavior.
window.innerWidth = 1280; window.innerHeight = 800;
window.matchMedia = () => ({ matches: false });
window.screen.orientation.lock = async () => { throw new Error('desktop must not lock'); };
await display.toggle();
assert.equal(notices.length, prior + 2, 'ordinary desktop fullscreen does not attempt an orientation lock');
await display.toggle();
console.log('PASS fullscreen entry/exit, mobile landscape ordering, duplicate taps, external-exit race, orientation fallback and gesture isolation');
