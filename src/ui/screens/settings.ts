import { Screen } from '../app.ts';
import { THEME, text, fillPanel, paragraph, pageHeader, drawScrollbar } from '../theme.ts';
import { tr } from '../i18n.ts';
import { readNFSK } from '../../core/nfm.ts';
import { findCI } from '../../core/zip.ts';
import type { SkinEntry } from '../../core/store.ts';
import { selectSkinForKeys } from '../../core/osk.ts';
import { TapCalibration } from '../latency-calibration.ts';
import { PlayfieldRenderer } from '../../engine/render.ts';
import { PlaySession } from '../../engine/play.ts';
import { DEFAULT_MODS, PLAYFIELD_SCALE_MIN, PLAYFIELD_SCALE_MAX, type NFChart } from '../../core/types.ts';
import { getDefaultSkin } from '../../core/default-skin.ts';

type Tab = 'general' | 'gameplay' | 'audio' | 'video' | 'input' | 'skin' | 'about';
const TABS: Tab[] = ['general', 'gameplay', 'audio', 'video', 'input', 'skin', 'about'];
export class SettingsScreen extends Screen {
  readonly name = 'settings';
  private tab: Tab = 'general';
  private captureBind: { keys: number; col: number } | null = null;
  private keyMode = 4;
  private calib: TapCalibration | null = null;
  private calibrationApplied = false;
  private skins: SkinEntry[] = [];
  private scroll = 0;
  private maxScroll = 0;
  private snapshot = '';
  private tapRect: { x: number; y: number; w: number; h: number } | null = null;
  private viewport = { x: 0, y: 0, w: 0, h: 0 };
  private preview: { renderer: PlayfieldRenderer; session: PlaySession } | null = null;
  private previewToken = 0;
  private active = false;
  private drag: { x: number; y: number; scroll: number; moved: boolean } | null = null;
  async enter() { this.active = true; this.snapshot = JSON.stringify(this.app.settings); await this.loadSkins(); if (this.active) void this.loadPreview(); }
  async loadSkins() { this.skins = await this.app.store.listSkins(); }
  private changeTab(tab: Tab) {
    if (tab === this.tab) return;
    const change = () => { this.calib?.cancel(); this.syncCalibrationDucking(); this.captureBind = null; this.scroll = 0; this.tab = tab; };
    if (this.app.animateViewChange) this.app.animateViewChange(change); else change();
    this.app.uiSound();
  }
  keyDown(code: string, e: KeyboardEvent) {
    if (this.captureBind) {
      if (code === 'Escape') { this.captureBind = null; return; }
      if (e?.repeat || ['Tab', 'MetaLeft', 'MetaRight'].includes(code)) return;
      const { keys, col } = this.captureBind, binds = this.app.settings.keybinds[String(keys)], existing = binds.indexOf(code);
      if (existing >= 0) binds[existing] = binds[col];
      binds[col] = code; this.captureBind = null; this.app.saveSettings(); this.app.uiSound(); return;
    }
    if (this.calib && ['starting', 'running'].includes(this.calib.state)) {
      if (code === 'Escape') { this.calib.cancel(); this.syncCalibrationDucking(); this.app.toast('Calibration cancelled; offsets unchanged.'); }
      if (code === 'Space') { e?.preventDefault(); if (!e?.repeat) this.calib.tap(); } return;
    }
    if (code === 'Escape') this.app.gotoScreen('menu');
    if (code === 'Tab') { e?.preventDefault(); this.changeTab(TABS[(TABS.indexOf(this.tab) + (e?.shiftKey ? 6 : 1)) % 7]); }
  }
  pointerDown(x: number, y: number) {
    const r = this.tapRect, v = this.viewport;
    this.drag = this.app.isTouch && x >= v.x && x <= v.x + v.w && y >= v.y && y <= v.y + v.h
      ? { x, y, scroll: this.scroll, moved: false } : null;
    if (r && x >= r.x && x <= r.x + r.w && y >= Math.max(v.y, r.y) && y <= Math.min(v.y + v.h, r.y + r.h)) this.calib?.tap();
  }
  pointerMove(x: number, y: number) {
    const drag = this.drag; if (!drag) return;
    if (Math.abs(y - drag.y) > 8 && Math.abs(y - drag.y) > Math.abs(x - drag.x) * 1.2) drag.moved = true;
    if (!drag.moved) return;
    this.scroll = Math.max(0, Math.min(this.maxScroll, drag.scroll + drag.y - y));
    this.app.ui.p.moved = true; this.app.ui.cancelPointer();
  }
  pointerUp() { if (this.drag?.moved) { this.app.ui.p.moved = true; this.app.ui.cancelPointer(); } this.drag = null; }
  resize() { this.drag = null; this.tapRect = null; }
  wheel(dy: number) { this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + dy * .6)); }
  leave() { this.active = false; this.drag = null; this.previewToken++; this.calib?.cancel(); this.syncCalibrationDucking(); this.app.saveSettings(); }
  update() { if (document.hidden && this.calib?.state === 'running') this.calib.cancel(); this.calib?.update(); this.syncCalibrationDucking(); }
  private syncCalibrationDucking() { this.app.audio?.setPreviewDucking?.(this.calib && ['starting', 'running'].includes(this.calib.state) ? .08 : 1); }
  private startCalib() { this.calib?.cancel(); this.calibrationApplied = false; this.calib = new TapCalibration(this.app.audio.ensure()); void this.calib.start(this.app.settings.sfxVolume); this.syncCalibrationDucking(); }
  private async loadPreview() {
    const token = ++this.previewToken;
    try {
      const bytes = this.app.settings.skinId ? await this.app.store.getSkinBytes(this.app.settings.skinId) : null;
      if (!this.active || token !== this.previewToken) return;
      const parsed = bytes ? readNFSK(bytes) : getDefaultSkin(), skin = selectSkinForKeys(parsed.skin, this.keyMode);
      const assets = (path: string) => parsed ? findCI(parsed.files, path) : undefined;
      const chart: NFChart = { format: 'neonfall-chart', version: 1, keys: this.keyMode, od: 8, offset: 0,
        meta: { title: '', artist: '', creator: '', version: '', audio: '', audioLeadIn: 0, previewTime: 0, lengthMs: 10000 }, timing: [{ t: 0, bpm: 120 }], sv: [], breaks: [],
        notes: Array.from({ length: this.keyMode * 3 }, (_, i) => ({ col: i % this.keyMode, t: 1900 + Math.floor(i / this.keyMode) * 380 + i % this.keyMode * 70, ...(i === 2 ? { end: 2750 } : {}) })) };
      const session = new PlaySession(chart, {} as any, { skin, getAsset: assets }, { ...DEFAULT_MODS }, this.app.settings, { songTimeMs: () => 1700 + this.app.settings.audioOffset } as any);
      const renderer = new PlayfieldRenderer(skin, assets, this.app.settings, { ...DEFAULT_MODS });
      await Promise.all([...(skin?.columns ?? []).flatMap(c => [c.keyImg, c.keyImgD, c.noteImg, c.noteImgH, c.bodyImg, c.noteImgT]), ...Object.values(skin?.stage ?? {})].map(p => renderer.images.load(p)));
        await renderer.prepareSkinArt();
        if (this.active && token === this.previewToken) this.preview = { renderer, session };
    } catch { if (token === this.previewToken) this.preview = null; }
  }
  draw(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app, ui = this.app.ui, s = this.app.settings;
    this.tapRect = null;
    if (ui.button('back', 24, 22, 96, 44, '← BACK')) this.app.gotoScreen('menu');
    pageHeader(ctx, 'SETTINGS', 'Your space. Your settings.', w);
    // A wide phone is still short: all seven side tabs need 458px of height.
    const side = w >= 920 && h >= 520, tabRows = w < 560 ? 2 : 1;
    const px = side ? 230 : 24, py = side ? 106 : 106 + tabRows * 46, pw = w - px - 24, ph = h - py - 44;
    if (side) {
      fillPanel(ctx, 24, 106, 184, h - 150, { r: 16, fill: '#121b22' });
      TABS.forEach((tab, i) => { if (ui.chip('tab-' + tab, 36, 122 + i * 48, 160, 38, tab.toUpperCase(), this.tab === tab).clicked) this.changeTab(tab); });
    } else {
      const cols = tabRows === 2 ? 4 : 7, tw = (w - 48) / cols;
      TABS.forEach((tab, i) => { if (ui.chip('tab-' + tab, 24 + i % cols * tw, 104 + Math.floor(i / cols) * 46, tw - 6, 36, tab.toUpperCase(), this.tab === tab).clicked) this.changeTab(tab); });
    }
    fillPanel(ctx, px, py, pw, ph, { r: 16, fill: '#141e26' });
    this.viewport = { x: px, y: py, w: pw, h: ph }; this.scroll = Math.min(this.scroll, this.maxScroll);
    ctx.save(); ctx.beginPath(); ctx.rect(px + 1, py + 1, pw - 2, ph - 2); ctx.clip(); ui.setClip(px, py, pw, ph);
    const pad = pw < 500 ? 20 : 32, x = px + pad, inner = pw - pad * 2;
    let y = py + 26 - this.scroll;
    const header = (label: string) => { text(ctx, label, x, y + 8, { size: 18, weight: 600 }); y += 40; };
    const note = (label: string) => { y += paragraph(ctx, label, x, y + 2, inner, { size: 12, color: THEME.dim, weight: 400 }) + 16; };
    const slider = (label: string, value: number, min: number, max: number, step: number, format: (v: number) => string, id: string, set: (v: number) => void) => {
      text(ctx, label, x, y + 10, { size: 13, baseline: 'middle' }); text(ctx, format(value), x + inner, y + 10, { size: 13, color: THEME.accent, align: 'right', baseline: 'middle' });
      const next = ui.slider('s-' + id, x + 2, y + 27, inner - 4, 22, value, min, max, step); if (Math.abs(next - value) > .00001) set(next); y += 70;
    };
    const toggle = (label: string, value: boolean, id: string, set: (v: boolean) => void) => {
      text(ctx, label, x, y + 16, { size: 13, baseline: 'middle', maxWidth: inner - 92 });
      if (ui.chip('t-' + id, x + inner - 82, y, 82, 32, value ? 'ON' : 'OFF', value).clicked) { set(!value); this.app.uiSound(); } y += 54;
    };
    const choices = (label: string, values: number[], current: number, id: string, format: (v: number) => string, set: (v: number) => void) => {
      text(ctx, label, x, y + 8, { size: 13 }); y += 24; const cw = Math.min(110, (inner + 8) / values.length);
      values.forEach((v, i) => { if (ui.chip(id + '-' + v, x + i * cw, y, cw - 8, 34, format(v), current === v).clicked) { set(v); this.app.uiSound(); } }); y += 58;
    };
    const percent = (v: number) => Math.round(v * 100) + '%';
    switch (this.tab) {
      case 'general':
        header('Appearance & language'); text(ctx, 'Language', x, y + 10, { size: 14 }); y += 28;
        for (const [i, lang] of (['zh-CN', 'en'] as const).entries()) {
          if (ui.chip('language-' + lang, x + i * (inner / 2), y, inner / 2 - 8, 48, lang === 'zh-CN' ? '简体中文' : 'English', s.language === lang).clicked) { s.language = lang; this.app.saveSettings(); }
        }
        y += 76; note('Switch languages instantly.'); header('Visual feedback'); toggle('Particles', s.particles, 'particles', v => s.particles = v); toggle('Touch lane hints', s.touchHint, 'touchHint', v => s.touchHint = v); break;
      case 'gameplay':
        header('Scroll & playfield'); slider('Scroll speed', s.scrollSpeed, .4, 2, .05, v => '×' + v.toFixed(2), 'scroll', v => s.scrollSpeed = v);
        slider('Playfield scale', s.playfieldScale, PLAYFIELD_SCALE_MIN, PLAYFIELD_SCALE_MAX, .01, percent, 'scale', v => s.playfieldScale = v); note('Adjust from 50% to 200%. Tilted lanes stay within the screen, with a fixed hit line.');
        header('Judgment'); note('Good hits restore health. Breaks let you recover.'); note('PERFECT ±16 ms · GREAT ±40 ms · GOOD ±73 ms · OK ±103 ms · BAD ±127 ms (OD 8)'); break;
      case 'audio': {
        header('Volumes'); slider('Music', s.musicVolume, 0, 1, .02, percent, 'music', v => s.musicVolume = v); slider('Hit sounds', s.sfxVolume, 0, 1, .02, percent, 'sfx', v => s.sfxVolume = v); slider('Preview', s.previewVolume, 0, 1, .02, percent, 'preview', v => s.previewVolume = v);
        header('Timing & calibration'); slider('Audio offset', s.audioOffset, -250, 250, 1, v => Math.round(v) + ' ms', 'aoff', v => { s.audioOffset = v; s.audioOffsetAuto = false; });
        slider('Visual offset', s.visualOffset, -120, 120, 1, v => Math.round(v) + ' ms', 'voff', v => s.visualOffset = v); slider('Input offset', s.inputOffset, -120, 120, 1, v => Math.round(v) + ' ms', 'ioff', v => s.inputOffset = v);
        toggle('Automatic latency compensation', !!s.audioOffsetAuto, 'auto-offset', v => { s.audioOffsetAuto = v; if (v) s.audioOffset = Math.round(this.app.audio.baseLatencyMs); });
        text(ctx, tr('Device output latency') + '  ' + this.app.audio.baseLatencyMs.toFixed(1) + ' ms', x, y, { size: 12, color: THEME.dim }); y += 34;
        header('Tap calibration'); note('Follow the sound: 4 warm-up beats, then 20 taps.'); note('Press SPACE or tap the pad. Save when the result feels right.');
        const running = !!this.calib && ['starting', 'running'].includes(this.calib.state);
        if (ui.button('calib', x, y, Math.min(230, inner), 42, running ? 'CANCEL CALIBRATION' : 'START / RETRY', { accent: !running })) { if (running) { this.calib?.cancel(); this.syncCalibrationDucking(); } else this.startCalib(); } y += 58;
        if (running) {
          this.tapRect = { x, y, w: inner, h: 60 }; ui.button('calib-tap', x, y, inner, 60, 'TAP / SPACE', { accent: true }); y += 86;
          note(this.calib!.state === 'starting' ? 'Enabling audio…' : tr('Beat {beat}/24 · taps {taps}', { beat: this.calib!.progress, taps: this.calib!.samples.size }));
        } else if (this.calib?.state === 'done') {
          const result = this.calib.result(s.inputOffset);
          note(result.ok ? tr('Suggested offset: {offset} ms · spread {spread} ms · {count} taps', { offset: result.audioOffset, spread: result.spreadMs.toFixed(1), count: result.accepted }) : result.reason);
          if (result.ok && ui.button('calib-apply', x, y, Math.min(230, inner), 42, this.calibrationApplied ? 'APPLIED' : 'SAVE & APPLY', { accent: true, disabled: this.calibrationApplied })) { s.audioOffset = result.audioOffset; s.audioOffsetAuto = false; this.calibrationApplied = true; this.app.saveSettings(); this.app.toast('Global audio offset saved. Input and visual offsets unchanged.'); } y += 58;
        } else if (this.calib?.state === 'error') note(this.calib.error);
        break;
      }
      case 'video':
        header('Background'); toggle('Storyboard', s.sbEnabled, 'sb', v => s.sbEnabled = v); choices('Storyboard quality', [.5, .75, 1], s.sbQuality, 'sbq', v => v === 1 ? 'HIGH' : v === .75 ? 'MED' : 'LOW', v => s.sbQuality = v);
        slider('Storyboard brightness', s.storyboardBrightness, 0, 1, .02, percent, 'sb-brightness', v => s.storyboardBrightness = v);
        toggle('Video background', s.videoBg, 'video', v => s.videoBg = v); slider('Background dim', s.bgDim, 0, .9, .02, percent, 'bgdim', v => s.bgDim = v);
        header('Performance'); choices('Resolution scale', [.5, .75, 1, 1.5, 2], s.resScale, 'rs', v => v + '×', v => { s.resScale = v; this.app.resize(); }); choices('FPS cap', [0, 60, 120, 240], s.fpsCap, 'fps', v => v ? String(v) : 'UNCAPPED', v => s.fpsCap = v); break;
      case 'input': {
        header('Key bindings'); note('Choose a mode, then click a key to rebind it.'); choices('KEYS', [4, 5, 6, 7, 8], this.keyMode, 'kb', v => v + 'K', v => { this.keyMode = v; this.captureBind = null; });
        const binds = s.keybinds[String(this.keyMode)], kw = (inner + 6) / this.keyMode;
        binds.forEach((code, col) => { const on = this.captureBind?.col === col && this.captureBind.keys === this.keyMode; if (ui.chip('bind-' + this.keyMode + '-' + col, x + col * kw, y, kw - 6, 56, on ? '…' : code === 'Space' ? '⎵' : code.replace(/^(Key|Digit|Numpad)/, ''), on).clicked) this.captureBind = { keys: this.keyMode, col }; }); y += 86;
        note(this.captureBind ? 'Press a key · ESC to cancel' : 'Duplicate keys swap positions. ESC stays reserved for pause.'); header('Touch controls'); note('Tap the lower half of each lane.'); break;
      }
      case 'skin': {
        header('Your note skin'); const previewH = 220; fillPanel(ctx, x, y, inner, previewH, { r: 12, fill: '#090f15' });
        if (this.preview) { ctx.save(); ctx.beginPath(); ctx.rect(x + 1, y + 1, inner - 2, previewH - 2); ctx.clip(); ctx.translate(x, y); this.preview.renderer.draw(ctx, this.preview.session, inner, previewH, performance.now()); ctx.restore(); }
        text(ctx, 'Live preview', x + 12, y + 20, { size: 10, color: THEME.dim }); y += previewH + 26;
        choices('KEYS', [4, 5, 6, 7, 8], this.keyMode, 'preview-keys', v => v + 'K', v => { this.keyMode = v; void this.loadPreview(); });
        if (s.skinId && this.preview && !this.preview.session.skin) note('No matching layout; this key mode uses the default skin.');
        slider('Playfield scale', s.playfieldScale, PLAYFIELD_SCALE_MIN, PLAYFIELD_SCALE_MAX, .01, percent, 'skin-scale', v => s.playfieldScale = v);
        for (const sk of [{ id: '', name: tr('DEFAULT SKIN') + ' · RM White Blue Bar 4–6K' }, ...this.skins]) {
          const selected = s.skinId === sk.id;
          if (ui.chip('skin-' + (sk.id || 'default'), x, y, inner - (sk.id ? 70 : 0), 56, sk.name, selected).clicked) { s.skinId = sk.id; void this.loadPreview(); }
          if (sk.id && ui.button('skin-del-' + sk.id, x + inner - 62, y + 12, 54, 32, 'DELETE', { small: true, danger: true })) {
            void (async () => { await this.app.store.deleteSkin(sk.id); if (s.skinId === sk.id) { s.skinId = ''; void this.loadPreview(); } this.app.saveSettings(); await this.loadSkins(); this.app.toast('skin deleted'); })();
          } y += 68;
        }
        y += 12; if (ui.button('skin-import', x, y, Math.min(inner, 230), 42, 'IMPORT', { accent: true })) this.app.gotoScreen('import'); y += 66; note('Import an .osk, .msp or .nfsk skin to make it yours.'); break;
      }
      case 'about':
        header('NEONFALL / RHYTHM GAME'); note('Music, at your fingertips.');
        for (const [label, value] of [['Version', this.app.version], ['Platform', this.app.platform.toUpperCase()], ['Modes', '4K / 5K / 6K / 7K / 8K'], ['Formats', '.osz · .mcz · .nfm / .osk · .msp · .nfsk']]) { text(ctx, label, x, y + 12, { size: 13, color: THEME.dim }); text(ctx, value, x + inner, y + 12, { size: 13, align: 'right', maxWidth: inner * .7 }); y += 52; } break;
    }
    this.maxScroll = Math.max(0, y + this.scroll + 12 - py - ph);
    ctx.restore(); ui.clearClip(); drawScrollbar(ctx, px + pw - 8, py + 12, ph - 24, ph + this.maxScroll, ph, this.scroll);
    text(ctx, 'Changes saved automatically', w - 26, h - 18, { size: 10, color: THEME.dim, align: 'right' });
    const snapshot = JSON.stringify(s); if (snapshot !== this.snapshot) { this.snapshot = snapshot; this.app.saveSettings(); }
  }
}
