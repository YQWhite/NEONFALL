// App: canvas bootstrap, screen manager, animated neon background, platform wiring.
import type { Mods, UserInfo } from '../core/types.ts';
import { DEFAULT_MODS } from '../core/types.ts';
import { deepClone } from '../core/zip.ts';
import { Store, bridge, isDesktop, isAndroid, type ChartEntry, type LocalProfile } from '../core/store.ts';
import { AudioEngine } from '../engine/audio.ts';
import { MenuMusic } from './menu-music.ts';
import { ApiError, ServerApi } from '../api/client.ts';
import { UI, type PointerState } from './widgets.ts';
import { THEME, gradientRect, text, fillPanel } from './theme.ts';
import { setLanguage } from './i18n.ts';
import { DisplayMode } from './display-mode.ts';
import { scoreSync } from '../api/score-sync.ts';
import { ScreenTransition } from './screen-transition.ts';

export interface ScreenParams {
  [k: string]: any;
}

export abstract class Screen {
  app: App;
  params: ScreenParams = {};
  constructor(app: App) {
    this.app = app;
  }
  abstract readonly name: string;
  enter(p: ScreenParams = {}) {
    this.params = p;
  }
  leave() {}
  update(dt: number, now: number) {}
  abstract draw(ctx: CanvasRenderingContext2D): void;
  keyDown(code: string, e: KeyboardEvent) {}
  pointerMove(x: number, y: number) {}
  pointerDown(x: number, y: number) {}
  pointerUp(x: number, y: number) {}
  wheel(dy: number) {}
  resize() {}
}

export interface AccountState {
  server: boolean;
  user: UserInfo | LocalProfile | null;
}

export class App {
  canvas: HTMLCanvasElement;
  bgCanvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  bgCtx: CanvasRenderingContext2D;
  stage: HTMLElement;
  w = 1280;
  h = 720;
  dpr = 1;

  audio = new AudioEngine();
  menuMusic = new MenuMusic(this);
  store = new Store();
  server = new ServerApi('');
  ui: UI;
  screen: Screen | null = null;
  mods: Mods = deepClone(DEFAULT_MODS);
  account: AccountState = { server: false, user: null };
  library: ChartEntry[] = [];
  serverOnline = false;
  toastMsg = '';
  toastT0 = 0;
  version = '0.2.7';
  time = 0;
  testMode = false;
  platform: 'web' | 'desktop' | 'android' = 'web';
  previewChart: { id: string; archive: import('../core/nfm.ts').NFMArchive } | null = null;

  private lastT = 0;
  private bgParticles: { x: number; y: number; v: number; r: number; a: number; hue: number }[] = [];
  private raf = 0;
  private listenersBound = false;
  private pointer: PointerState = { x: 0, y: 0, down: false, downX: 0, downY: 0, moved: false };
  private touchSeen = false;
  private disposeQueue: (() => void)[] = [];
  private displayMode: DisplayMode | null = null;
  private viewTransition = new ScreenTransition();
  private drawing = false;
  private hasDrawn = false;
  private pendingViewChanges: (() => void)[] = [];

  constructor() {
    setLanguage(this.store.settings.language);
    this.stage = document.getElementById('stage')!;
    this.canvas = document.createElement('canvas');
    this.bgCanvas = document.createElement('canvas');
    this.stage.appendChild(this.bgCanvas);
    this.stage.appendChild(this.canvas);
    // main canvas is translucent so the animated neon background shows through
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.bgCtx = this.bgCanvas.getContext('2d', { alpha: false })!;
    this.ui = new UI(this);
    if (bridge()) this.platform = 'desktop';
    else if (isAndroid) this.platform = 'android';
    try { this.server = new ServerApi(this.store.settings.serverUrl || '', this.store); }
    catch { this.store.settings.serverUrl = ''; this.server = new ServerApi('', this.store); }
    this.server.setToken(this.store.getToken());
    if (this.platform === 'web') this.displayMode = new DisplayMode(message => this.toast(message));
  }

  get isTouch(): boolean {
    return this.platform === 'android' || this.touchSeen;
  }

  get centralLibrary(): boolean {
    return !!this.settings.serverUrl || (this.platform === 'web' && typeof location !== 'undefined' && /^https?:$/.test(location.protocol));
  }

  // ---------- boot ----------
  start() {
    this.resize();
    if (!this.listenersBound) {
      this.bindListeners();
      this.listenersBound = true;
    }
    for (let i = 0; i < 46; i++) {
      this.bgParticles.push({
        x: Math.random(),
        y: Math.random(),
        v: 0.008 + Math.random() * 0.03,
        r: 1 + Math.random() * 2.4,
        a: 0.15 + Math.random() * 0.4,
        hue: Math.random() < 0.6 ? 192 : Math.random() < 0.5 ? 312 : 46,
      });
    }
    this.lastT = performance.now();
    let lastDraw = 0;
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(50, t - this.lastT);
      this.lastT = t;
      this.time = t;
      this.update(dt, t);
      const cap = this.store.settings.fpsCap;
      if (!cap || t - lastDraw >= 1000 / cap - 1) {
        lastDraw = t;
        this.draw();
      }
    };
    this.raf = requestAnimationFrame(loop);
    this.gotoScreen('menu');
  }

  private autoOffsetDone = false;

  applyAutoAudioOffset() {
    if (this.autoOffsetDone) return;
    this.autoOffsetDone = true;
    const lat = this.audio.baseLatencyMs;
    if (this.store.settings.audioOffsetAuto && lat > 0 && this.store.settings.audioOffset === 0) {
      this.store.settings.audioOffset = Math.round(lat);
      this.store.saveSettings();
    }
  }

  private bindListeners() {
    const w = window;
    w.addEventListener('resize', () => this.resize());
    document.addEventListener('fullscreenchange', () => this.resize());
    w.addEventListener('pointermove', (e) => {
      const c = this.toLocal(e.clientX, e.clientY);
      this.pointer.x = c.x;
      this.pointer.y = c.y;
      this.screen?.pointerMove(c.x, c.y);
    });
    w.addEventListener('pointerdown', (e) => {
      this.audio.resume();
      this.applyAutoAudioOffset();
      this.touchSeen = e.pointerType === 'touch';
      const c = this.toLocal(e.clientX, e.clientY);
      this.pointer.x = c.x;
      this.pointer.y = c.y;
      this.pointer.down = true;
      this.pointer.downX = c.x;
      this.pointer.downY = c.y;
      this.pointer.moved = false;
      this.screen?.pointerDown(c.x, c.y);
    });
    w.addEventListener('pointerup', (e) => {
      const c = this.toLocal(e.clientX, e.clientY);
      this.pointer.x = c.x;
      this.pointer.y = c.y;
      this.pointer.down = false;
      this.screen?.pointerUp(c.x, c.y);
    });
    w.addEventListener('pointercancel', () => {
      this.pointer.down = false;
    });
    w.addEventListener('wheel', (e) => {
      this.screen?.wheel(e.deltaY);
    });
    w.addEventListener('keydown', (e) => {
      // let native inputs handle their keys
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      this.audio.resume();
      this.screen?.keyDown(e.code, e);
    });
    w.addEventListener('contextmenu', (e) => e.preventDefault());
    w.addEventListener('blur', () => {
      if (this.screen?.name === 'play' && !this.testMode) (this.screen as any).onHidden?.();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.screen?.name === 'play' && !this.testMode) {
        (this.screen as any).onHidden?.();
      }
    });
  }

  toLocal(cx: number, cy: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rs = this.store.settings.resScale || 1;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.max(1, Math.round(this.w * this.dpr * rs));
    this.canvas.height = Math.max(1, Math.round(this.h * this.dpr * rs));
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(this.dpr * rs, 0, 0, this.dpr * rs, 0, 0);
    this.bgCanvas.width = Math.round(this.w * 0.5);
    this.bgCanvas.height = Math.round(this.h * 0.5);
    this.bgCanvas.style.width = this.w + 'px';
    this.bgCanvas.style.height = this.h + 'px';
    this.screen?.resize();
  }

  // ---------- screens ----------
  private screenFactories: Record<string, (app: App) => Screen> = {};

  registerScreen(name: string, factory: (app: App) => Screen) {
    this.screenFactories[name] = factory;
  }

  gotoScreen(name: string, params: ScreenParams = {}) {
    const factory = this.screenFactories[name];
    if (!factory) {
      console.error('unknown screen', name);
      return;
    }
    this.animateViewChange(() => {
      this.screen?.leave();
      this.screen = factory(this);
      this.menuMusic.setScreen(name);
      this.screen.enter(params);
      this.screen.resize();
      this.displayMode?.setScreen(name);
    });
  }

  /** Also used by tabs and in-screen panels; logic changes without waiting for animation. */
  animateViewChange(change: () => void) {
    if (this.drawing) {
      // Immediate-mode buttons navigate during draw. Finish that frame before
      // taking its snapshot or disposing any screen/input resources.
      this.pendingViewChanges.push(change);
      this.ui.cancelPointer();
      return;
    }
    if (this.hasDrawn) {
      const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.viewTransition.capture(this.bgCanvas, this.canvas, this.w, this.h, performance.now(), reduced ? 100 : 280);
    }
    this.ui.cancelPointer();
    this.ui.clearClip();
    this.pointer.down = false;
    this.pointer.moved = true;
    change();
  }

  // ---------- helpers ----------
  uiSound() {
    this.audio.playSynth('ui', 0.3);
  }

  toast(msg: string) {
    this.toastMsg = msg;
    this.toastT0 = performance.now();
  }

  quitApp() {
    bridge()?.quit();
  }

  update(dt: number, now: number) {
    // background particles
    for (const p of this.bgParticles) {
      p.y -= p.v * (dt / 16);
      if (p.y < -0.02) {
        p.y = 1.02;
        p.x = Math.random();
      }
    }
    this.screen?.update(dt, now);
    this.menuMusic.update();
    // flush queued disposals (element cleanup)
    for (const fn of this.disposeQueue) fn();
    this.disposeQueue.length = 0;
  }

  queueDispose(fn: () => void) {
    this.disposeQueue.push(fn);
  }

  draw() {
    this.drawing = true;
    try {
      this.drawBackground();
      const ctx = this.ctx;
      // screens draw over the animated background (translucent canvas)
      ctx.clearRect(0, 0, this.w, this.h);
      this.ui.beginFrame(this.pointer);
      this.screen?.draw(ctx);
      if (this.screen?.name === 'menu' || this.screen?.name === 'select') this.menuMusic.draw(ctx);
      this.ui.endFrame();
      this.viewTransition.draw(ctx, this.w, this.h, performance.now());
      // toast
      if (this.toastMsg) {
        const age = performance.now() - this.toastT0;
        if (age < 2600) {
          const a = age < 200 ? age / 200 : age > 2200 ? 1 - (age - 2200) / 400 : 1;
          const w = Math.min(640, this.w - 80);
          fillPanel(ctx, (this.w - w) / 2, this.h - 94, w, 44, { r: 12, fill: 'rgba(20,31,37,.96)', alpha: a });
          text(ctx, this.toastMsg, this.w / 2, this.h - 72, {
            size: 14,
            align: 'center',
            baseline: 'middle',
            color: `rgba(223,243,255,${Math.max(0, a)})`,
            weight: 600,
            maxWidth: w - 28,
            glow: false,
            glowColor: 'rgba(63,214,255,0.8)',
          });
        }
      }
      this.hasDrawn = true;
    } finally {
      this.drawing = false;
      const pending = this.pendingViewChanges.splice(0);
      if (pending.length) this.animateViewChange(() => { for (const change of pending) change(); });
    }
  }

  private drawBackground() {
    const ctx = this.bgCtx;
    const w = this.bgCanvas.width;
    const h = this.bgCanvas.height;
    const t = this.time / 1000;
    if (this.screen?.name !== 'play') {
      ctx.fillStyle = '#0a0e16';
      ctx.fillRect(0, 0, w, h);
      const mist = ctx.createRadialGradient(w * 0.72, h * 0.42, 0, w * 0.72, h * 0.42, w * 0.75);
      mist.addColorStop(0, 'rgba(49,86,102,0.22)');
      mist.addColorStop(0.6, 'rgba(34,44,65,0.08)');
      mist.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = mist;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, w, h);
    // aurora gradient
    const g = ctx.createRadialGradient(w * 0.3, h * 0.15, 10, w * 0.3, h * 0.15, w * 0.7);
    g.addColorStop(0, 'rgba(20,60,110,0.35)');
    g.addColorStop(0.5, 'rgba(40,20,70,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const g2 = ctx.createRadialGradient(w * 0.8, h * 0.85, 10, w * 0.8, h * 0.85, w * 0.6);
    g2.addColorStop(0, 'rgba(120,20,110,0.22)');
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w, h);
    // grid
    const gs = 46;
    ctx.strokeStyle = 'rgba(63,214,255,0.045)';
    ctx.lineWidth = 1;
    const off = (t * 6) % gs;
    ctx.beginPath();
    for (let x = -off; x < w; x += gs) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = 0; y < h; y += gs) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    // particles
    for (const p of this.bgParticles) {
      ctx.fillStyle = `hsla(${p.hue},90%,65%,${p.a * (0.7 + 0.3 * Math.sin(t * 2 + p.x * 10))})`;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    // vignette
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  get settings() {
    return this.store.settings;
  }

  saveSettings() {
    setLanguage(this.settings.language);
    this.displayMode?.refresh();
    this.store.saveSettings();
    this.audio.applySettings(this.settings);
    this.audio.setPreviewVolume(this.settings.previewVolume);
  }

  async pingServer(): Promise<boolean> {
    this.serverOnline = await this.server.ping();
    return this.serverOnline;
  }

  /** load account from server token (web mode) */
  async refreshAccount(): Promise<void> {
    const token = this.store.getToken();
    if (!token) {
      this.server.setToken('');
      this.account = { server: false, user: this.store.getProfile() };
      return;
    }
    this.server.setToken(token);
    try {
      const user = await this.server.me();
      this.account = { server: true, user };
      scoreSync(this).remember(user);
    } catch (error) {
      // A temporary outage must not destroy a valid saved session.
      if (error instanceof ApiError && error.status === 401) {
        this.store.setToken('');
        this.server.setToken('');
      }
      this.account = { server: false, user: this.store.getProfile() };
    }
  }
}
