import { tr } from './i18n.ts';

/** Fullscreen must be requested directly from a user gesture. Windowed play is always available. */
export class DisplayMode {
  private button: HTMLButtonElement;
  private visible = true;
  private pending = false;
  private generation = 0;
  private ownedOrientation: { unlock?: () => void } | null = null;

  constructor(private notify: (message: string) => void) {
    this.button = document.createElement('button');
    this.button.id = 'display-mode';
    this.button.type = 'button';
    this.button.style.cssText = 'position:fixed;right:max(18px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:20;border:1px solid #53675f;border-radius:9px;padding:9px 14px;background:#17241fee;color:#d7e8df;font:12px "Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;touch-action:manipulation';
    // Keep this DOM control out of the canvas pointer/keyboard state machine.
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown']) this.button.addEventListener(name, e => e.stopPropagation());
    this.button.addEventListener('click', () => { void this.toggle(); });
    document.addEventListener('fullscreenchange', () => this.fullscreenChanged());
    document.addEventListener('webkitfullscreenchange', () => this.fullscreenChanged());
    document.body.appendChild(this.button);
    this.refresh();
  }

  private get fullscreen(): boolean {
    return !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
  }

  private get mobile(): boolean {
    const nav = typeof navigator === 'undefined' ? null : navigator;
    const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(any-pointer: coarse)').matches;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent || '') || !!(nav?.maxTouchPoints && coarse);
  }

  private releaseOrientation() {
    const orientation = this.ownedOrientation;
    this.ownedOrientation = null;
    try { orientation?.unlock?.(); } catch { /* Some browsers revoke the lock during fullscreen exit. */ }
  }

  private fullscreenChanged() {
    if (!this.fullscreen) {
      ++this.generation;
      this.releaseOrientation();
    }
    this.refresh();
  }

  private rotateHint() {
    if (typeof window !== 'undefined' && window.innerHeight > window.innerWidth) {
      this.notify(tr('Rotate your device to landscape for the best layout.'));
    }
  }

  setScreen(name: string) {
    this.visible = name === 'menu';
    this.refresh();
  }

  refresh() {
    this.button.hidden = !this.visible;
    this.button.textContent = tr(this.fullscreen ? 'WINDOWED' : this.mobile ? 'LANDSCAPE FULLSCREEN' : 'FULLSCREEN');
    this.button.title = tr(this.mobile ? 'Enter landscape fullscreen on mobile' : 'Play in a window or enter fullscreen');
    this.button.disabled = this.pending;
    this.button.setAttribute('aria-pressed', String(this.fullscreen));
  }

  async toggle() {
    if (this.pending) return;
    this.pending = true;
    const generation = ++this.generation;
    this.refresh();
    try {
      if (this.fullscreen) {
        const exit = document.exitFullscreen || (document as any).webkitExitFullscreen;
        if (!exit) throw new Error('unsupported');
        await exit.call(document);
        if (!this.fullscreen) this.releaseOrientation();
      } else {
        const root = document.documentElement;
        const request = root.requestFullscreen || (root as any).webkitRequestFullscreen;
        if (!request) throw new Error('unsupported');
        // Call directly in the click stack; waiting for orientation first loses
        // the browser's transient user activation and rejects fullscreen.
        await request.call(root);
        if (generation !== this.generation || !this.fullscreen) return;
        if (this.mobile) {
          const orientation = window.screen?.orientation as ScreenOrientation & { lock?: (mode: string) => Promise<void> };
          if (typeof orientation?.lock === 'function') {
            try {
              await orientation.lock('landscape');
              if (generation === this.generation && this.fullscreen) this.ownedOrientation = orientation;
              else { try { orientation.unlock?.(); } catch {} }
            } catch { if (generation === this.generation && this.fullscreen) this.rotateHint(); }
          } else this.rotateHint();
        }
      }
    } catch {
      this.notify(tr('Fullscreen unavailable. You can keep playing in this window.'));
      if (this.mobile) this.rotateHint();
    } finally {
      this.pending = false;
      this.refresh();
    }
  }
}
