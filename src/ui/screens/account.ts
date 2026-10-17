// Account screen — server login/register, offline local profile, leaderboard, email-verify (reserved).
import { Screen } from '../app.ts';
import { THEME, text, fillPanel, paragraph, pageHeader, drawScrollbar } from '../theme.ts';
import { tr } from '../i18n.ts';
import { TextField } from '../widgets.ts';
import type { UserInfo, PlayResult } from '../../core/types.ts';
import { ServerApi } from '../../api/client.ts';
import { scoreSync } from '../../api/score-sync.ts';
import { cropAvatar } from '../avatar-upload.ts';
import { drawAvatar } from '../avatar-art.ts';
import { modsLabel } from '../mod-labels.ts';

export class AccountScreen extends Screen {
  readonly name = 'account';
  private mode: 'login' | 'register' = 'login';
  private username = new TextField('text', { maxLength: 16 });
  private nickname = new TextField('text', { maxLength: 24 });
  private password = new TextField('password', { maxLength: 64 });
  private email = new TextField('email', { maxLength: 96 });
  private serverUrl = new TextField('text', { maxLength: 200 });
  private verifyCode = new TextField('text', { maxLength: 6 });
  private busy = '';
  private leaderboard: { username: string; nickname: string; rating: number; bestPp: number }[] = [];
  private myPlays: PlayResult[] = [];
  private error = '';
  private scroll = 0;
  private maxScroll = 0;
  private active = false;
  private avatarInput: HTMLInputElement | null = null;
  private avatarCrop: AbortController | null = null;
  private drag: { x: number; y: number; scroll: number; moved: boolean } | null = null;
  private suppressTap = false;
  private fields: { field: TextField; x: number; y: number; w: number; disabled: boolean }[] = [];
  wheel(dy: number) { this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + dy * .5)); }
  resize() { this.drag = null; this.fields = []; }
  pointerDown(x: number, y: number) {
    this.suppressTap = false;
    this.drag = y >= 106 && y <= this.app.h - 20 ? { x, y, scroll: this.scroll, moved: false } : null;
  }
  pointerMove(x: number, y: number) {
    const drag = this.drag; if (!drag) return;
    if (Math.hypot(x - drag.x, y - drag.y) > 7) drag.moved = true;
    if (!drag.moved) return;
    this.scroll = Math.max(0, Math.min(this.maxScroll, drag.scroll + drag.y - y));
    this.suppressTap = true; this.app.ui.p.moved = true; this.app.ui.cancelPointer();
    for (const { field } of this.fields) if (field.focused) field.blur();
  }
  pointerUp(x: number, y: number) {
    const drag = this.drag; this.drag = null;
    if (drag?.moved) { this.suppressTap = true; this.app.ui.p.moved = true; this.app.ui.cancelPointer(); return; }
    if (this.app.isTouch && y >= 106 && y <= this.app.h - 20) {
      const hit = this.fields.find(item => !item.disabled && x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + 42);
      hit?.field.focus();
    }
  }

  enter() {
    this.active = true;
    this.drag = null; this.suppressTap = false;
    for (const f of [this.username, this.nickname, this.password, this.email, this.serverUrl, this.verifyCode]) if (!f.el.isConnected) document.body.appendChild(f.el);
    this.serverUrl.value = this.app.settings.serverUrl || (this.app.serverOnline && typeof location !== 'undefined' ? location.origin : '');
    this.username.value = this.app.settings.lastUsername || '';
    this.busy = '';
    this.error = '';
    this.loadLeaderboard();
    this.loadMyPlays();
  }

  leave() {
    this.active = false;
    this.drag = null;
    this.avatarCrop?.abort(); this.avatarCrop = null;
    this.avatarInput?.remove(); this.avatarInput = null;
    for (const f of [this.username, this.nickname, this.password, this.email, this.serverUrl, this.verifyCode]) f.destroy();
  }

  chooseAvatar() {
    if (!this.active || this.busy || !this.app.account.server || !this.app.serverOnline) return;
    this.avatarInput?.remove();
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
    input.style.display = 'none'; this.avatarInput = input;
    input.addEventListener('change', () => {
      const file = input.files?.[0]; input.remove(); this.avatarInput = null;
      if (file) void this.uploadAvatar(file);
    }, { once: true });
    document.body.appendChild(input); input.click();
  }

  async uploadAvatar(file: File) {
    if (!this.active || this.busy || !this.app.account.server || !this.app.serverOnline || !this.app.account.user) return;
    const api = this.app.server, token = this.app.store.getToken(), username = this.app.account.user.username;
    const controller = new AbortController(); this.avatarCrop = controller;
    const sameAccount = () => this.active && this.avatarCrop === controller && !controller.signal.aborted && this.app.server === api && this.app.store.getToken() === token && this.app.account.server && this.app.account.user?.username === username;
    this.busy = 'Cropping avatar…'; this.error = '';
    try {
      const bytes = await cropAvatar(file, controller.signal);
      if (!bytes || !sameAccount()) return;
      this.busy = 'Uploading avatar…';
      const user = await api.uploadAvatar(bytes, 'image/png', controller.signal);
      if (!sameAccount()) return;
      this.app.account.user = user; scoreSync(this.app).remember(user);
      this.app.toast('Avatar updated.');
    } catch (error: any) {
      if (sameAccount()) { this.error = error?.message || 'Avatar upload failed.'; this.app.toast(tr(this.error)); }
    } finally { if (this.avatarCrop === controller) { this.avatarCrop = null; this.busy = ''; } }
  }

  async loadLeaderboard() {
    try {
      if (this.app.serverOnline) {
        this.leaderboard = await this.app.server.leaderboard();
      } else this.leaderboard = [];
    } catch {
      this.leaderboard = [];
    }
  }

  async loadMyPlays() {
    try {
      if (this.app.account.server && this.app.serverOnline) {
        this.myPlays = await this.app.server.myScores();
      } else {
        const best = this.app.store.getBestScores();
        this.myPlays = Object.values(best).sort((a, b) => b.playedAt - a.playedAt).slice(0, 20);
      }
    } catch {
      this.myPlays = [];
    }
  }

  keyDown(code: string) {
    if (code === 'Escape') this.app.gotoScreen('menu');
  }

  private changeMode(mode: 'login' | 'register') {
    if (mode === this.mode) return;
    const change = () => { this.mode = mode; this.error = ''; };
    if (this.app.animateViewChange) this.app.animateViewChange(change); else change();
  }

  async doLogin() {
    if (this.busy) return;
    this.busy = 'signing in…';
    this.error = '';
    try {
      const u = this.username.value.trim();
      const p = this.password.value;
      if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) throw new Error('username: 3-16 chars, letters/digits/underscore only');
      const res = await this.app.server.login(u, p);
      this.app.store.setToken(res.token);
      this.app.settings.lastUsername = u;
      this.app.saveSettings();
      scoreSync(this.app).signedIn(res.user);
      this.password.value = '';
      this.app.toast(tr('welcome back, {name}', { name: res.user.nickname || res.user.username }));
      await this.loadLeaderboard();
      await this.loadMyPlays();
    } catch (e: any) {
      this.error = e?.message || 'login failed';
    }
    this.busy = '';
  }

  async doRegister() {
    if (this.busy) return;
    this.busy = 'creating account…';
    this.error = '';
    try {
      const u = this.username.value.trim();
      const n = this.nickname.value.trim();
      const p = this.password.value;
      const em = this.email.value.trim();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) throw new Error('username: 3-16 chars, letters/digits/underscore only');
      if (!n) throw new Error('nickname required');
      if (p.length < 8) throw new Error('password: at least 8 characters');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw new Error('invalid email address');
      const res = await this.app.server.register(u, n, p, em);
      this.app.store.setToken(res.token);
      this.app.settings.lastUsername = u;
      this.app.saveSettings();
      scoreSync(this.app).signedIn(res.user);
      this.password.value = '';
      this.app.toast(tr('account created — welcome to NEONFALL, {name}', { name: n }));
      await this.loadLeaderboard();
      await this.loadMyPlays();
    } catch (e: any) {
      this.error = e?.message || 'registration failed';
    }
    this.busy = '';
  }

  async doLocalRegister() {
    this.error = '';
    try {
      const u = this.username.value.trim();
      const n = this.nickname.value.trim();
      const em = this.email.value.trim();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) throw new Error('username: 3-16 chars, letters/digits/underscore only');
      if (!n) throw new Error('nickname required');
      if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw new Error('invalid email address');
      this.app.store.createLocalProfile(u, n, em);
      this.app.account = { server: false, user: this.app.store.getProfile() };
      this.app.toast('offline profile created');
      await this.loadMyPlays();
    } catch (e: any) {
      this.error = e?.message || 'failed';
    }
  }

  async doLogout() {
    this.avatarCrop?.abort(); this.avatarCrop = null; this.busy = '';
    void this.app.server.logout().catch(() => {});
    this.app.store.setToken('');
    this.app.server.setToken('');
    this.app.account = { server: false, user: this.app.store.getProfile() };
    await this.loadMyPlays();
    this.app.toast('signed out');
  }

  async tryVerify() {
    if (this.busy) return;
    this.busy = 'Sending verification email…';
    try {
      const r = await this.app.server.requestVerification();
      this.app.toast(r.note || 'verification email requested');
    } catch (e: any) {
      this.app.toast(tr('verify: {error}', { error: tr(e?.message || 'failed') }));
    } finally { this.busy = ''; }
  }

  async confirmVerify() {
    if (this.busy) return;
    this.busy = 'Verifying email…';
    try {
      const code = this.verifyCode.value.trim();
      if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit verification code.');
      await this.app.server.verifyEmail(code);
      await this.app.refreshAccount();
      scoreSync(this.app).restoreCachedAccount();
      void scoreSync(this.app).sync();
      this.verifyCode.value = '';
      this.app.toast('Email verified.');
    } catch (e: any) { this.app.toast(tr('verify: {error}', { error: tr(e?.message || 'failed') })); }
    finally { this.busy = ''; }
  }

  async connectServer() {
    if (this.busy) return;
    this.busy = 'connecting…';
    this.error = '';
    try {
      const candidate = new ServerApi(this.serverUrl.value.trim(), this.app.store);
      const ok = await candidate.ping();
      const url = candidate.base || location.origin;
      if (!ok) throw new Error(tr('no NEONFALL server at {url}', { url }));
      // Commit only after the candidate responds; failed connections preserve the current server and account.
      if (candidate.base !== this.app.server.base) this.app.store.setToken('');
      this.app.server = candidate;
      this.app.settings.serverUrl = candidate.base;
      this.serverUrl.value = candidate.base;
      this.app.saveSettings();
      this.app.serverOnline = true;
      await this.app.refreshAccount();
      scoreSync(this.app).restoreCachedAccount();
      void scoreSync(this.app).sync();
      await Promise.all([this.loadLeaderboard(), this.loadMyPlays()]);
      this.app.toast(tr('connected to {url}', { url }));
    } catch (e: any) {
      this.error = e?.message || 'connection failed';
    }
    this.busy = '';
  }

  private fieldRow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    label: string,
    field: TextField,
    disabled = false,
  ) {
    this.fields.push({ field, x, y, w, disabled });
    field.el.disabled = disabled;
    if (disabled && field.focused) field.blur();
    fillPanel(ctx, x, y, w, 42, { r: 10, fill: disabled ? '#1c2328' : 'rgba(23,30,38,0.9)', line: field.focused ? 'rgba(147,174,160,0.6)' : THEME.panelLine });
    text(ctx, (field.el.type === 'password' ? '•'.repeat(field.value.length) : field.value) || field.el.placeholder || '', x + 16, y + 21, {
      size: 14, maxWidth: w - 32, translate: false,
      color: disabled ? '#748079' : field.value ? THEME.text : 'rgba(135,147,159,0.6)',
      baseline: 'middle',
    });
    if (!disabled && !this.app.isTouch && !this.suppressTap && this.app.ui.hover('f-' + label, x, y, w, 42) && this.app.ui.p.down) field.focus();
    if (field.focused) {
      const r = this.app.canvas.getBoundingClientRect();
      field.el.style.left = r.left + x + 14 + 'px';
      field.el.style.top = r.top + y + 12 + 'px';
      field.el.style.width = w - 28 + 'px';
      field.el.style.height = '28px';
    }
    field.el.setAttribute('aria-label', tr(label.toUpperCase()));
    text(ctx, label.toUpperCase(), x, y - 12, { size: 11, color: THEME.dim, weight: 700, baseline: 'middle' });
  }

  draw(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app, ui = this.app.ui, acc = this.app.account, user = acc.user;
    this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll));
    this.fields = [];
    if (this.suppressTap) { ui.p.moved = true; ui.cancelPointer(); }
    if (ui.button('back', 24, 22, 96, 44, '← BACK')) this.app.gotoScreen('menu');
    pageHeader(ctx, 'ACCOUNT', 'Keep your best moments.', w);
    const side = w >= 960, px = 24, pw = side ? Math.min(620, w * .56) : w - 48, viewY = 106, viewH = h - 126;
    ctx.save(); ctx.beginPath(); ctx.rect(24, viewY, w - 48, viewH); ctx.clip(); ui.setClip(24, viewY, w - 48, viewH);
    let y = viewY - this.scroll;
    const formX = px + 28, formW = pw - 56;
    if (user) {
      const needsVerification = acc.server && !user.emailVerified && this.app.server.emailVerification;
      const profileH = needsVerification ? 435 : 315;
      fillPanel(ctx, px, y, pw, profileH, { r: 18, fill: '#1c2d27', line: '#3c5348' });
      text(ctx, 'Player profile', formX, y + 30, { size: 11, color: THEME.accent2 });
      drawAvatar(ctx, this.app, user, formX, y + 48, 42);
      text(ctx, user.nickname || user.username, formX + 54, y + 77, { size: 25, maxWidth: formW - 184, translate: false });
      const pending = scoreSync(this.app).pendingCount;
      const state = acc.server ? this.app.serverOnline ? pending ? tr('Syncing {count} scores', { count: pending }) : tr('Automatic sync enabled') : tr('Offline · scores will sync automatically') : tr('OFFLINE PROFILE');
      text(ctx, '@' + user.username + ' · ' + state, formX, y + 102, { size: 12, color: THEME.dim, maxWidth: formW });
      text(ctx, 'RATING', formX, y + 146, { size: 10, color: THEME.dim });
      text(ctx, (user.rating || 0).toFixed(1), formX, y + 188, { size: 36, color: THEME.accent });
      text(ctx, 'BEST', formX + formW * .55, y + 146, { size: 10, color: THEME.dim });
      text(ctx, (user.bestPp || 0).toFixed(1) + ' pp', formX + formW * .55, y + 188, { size: 28, color: THEME.gold });
      if (ui.button('logout', px + pw - 134, y + 32, 106, 34, acc.server ? 'LOG OUT' : 'REMOVE PROFILE', { small: true })) {
        if (acc.server) void this.doLogout(); else { localStorage.removeItem('nf.profile.v1'); this.app.account = { server: false, user: null }; }
      }
      text(ctx, acc.server ? user.email + ' · ' + tr(user.emailVerified ? '✓ VERIFIED' : 'UNVERIFIED') : 'Local profiles store scores & rating on this device', formX, y + 222, { size: 11, color: THEME.dim, maxWidth: formW });
      if (acc.server) {
        if (ui.button('avatar-upload', formX, y + 244, Math.min(170, formW), 36, this.busy || 'CHANGE AVATAR', { small: true, disabled: !!this.busy || !this.app.serverOnline || !this.app.server.avatarsEnabled })) this.chooseAvatar();
        if (!this.app.server.avatarsEnabled && this.app.serverOnline) text(ctx, 'Update server to enable avatars.', formX, y + 300, { size: 10, color: THEME.dim, maxWidth: formW });
      } else text(ctx, 'Sign in to upload your avatar.', formX, y + 268, { size: 12, color: THEME.dim, maxWidth: formW });
      if (needsVerification) {
        const codeW = Math.min(180, formW * .44);
        this.fieldRow(ctx, formX, y + 338, codeW, 'verification code', this.verifyCode);
        if (ui.button('verify-send', formX + codeW + 12, y + 338, formW - codeW - 12, 42, 'SEND CODE', { small: true, disabled: !!this.busy })) void this.tryVerify();
        if (ui.button('verify-confirm', formX, y + 390, formW, 32, 'VERIFY EMAIL', { small: true, disabled: !!this.busy })) void this.confirmVerify();
      }
      y += profileH + 18;
    }
    if (!user || (!acc.server && this.app.serverOnline)) {
      const online = this.app.serverOnline, register = online && this.mode === 'register';
      const formH = online ? (register ? 490 : 342) : 416;
      fillPanel(ctx, px, y, pw, formH, { r: 18 });
      if (online) {
        if (ui.chip('mode-login', formX, y + 20, 116, 36, 'SIGN IN', !register).clicked) this.changeMode('login');
        if (ui.chip('mode-register', formX + 128, y + 20, 116, 36, 'REGISTER', register).clicked) this.changeMode('register');
      } else text(ctx, 'CREATE LOCAL PROFILE', formX, y + 36, { size: 17, color: THEME.accent });
      let fy = y + 88;
      this.fieldRow(ctx, formX, fy, formW, 'username (english id)', this.username); fy += 74;
      if (register || !online) { this.fieldRow(ctx, formX, fy, formW, 'nickname', this.nickname); fy += 74; }
      if (online) { this.fieldRow(ctx, formX, fy, formW, 'password', this.password); fy += 74; }
      if (register || !online) { this.fieldRow(ctx, formX, fy, formW, online ? 'email' : 'email (optional)', this.email); fy += 74; }
      if (this.error) text(ctx, this.error, formX, fy - 12, { size: 11, color: THEME.red, maxWidth: formW });
      if (ui.button(online ? 'do-auth' : 'local-create', formX, fy + 8, formW, 44, this.busy || (online ? register ? 'CREATE ACCOUNT' : 'SIGN IN' : 'CREATE LOCAL PROFILE'), { accent: true, disabled: !!this.busy })) {
        if (!online) void this.doLocalRegister(); else if (register) void this.doRegister(); else void this.doLogin();
      }
      y += formH + 18;
    }
    {
      fillPanel(ctx, px, y, pw, 174, { r: 18 }); text(ctx, 'CONNECT A SERVER', formX, y + 32, { size: 13, color: THEME.accent });
      const narrow = formW < 400;
      this.fieldRow(ctx, formX, y + 70, narrow ? formW : formW - 130, 'server url (http://host:port)', this.serverUrl, this.app.serverOnline);
      if (ui.button('connect', narrow ? formX : formX + formW - 116, narrow ? y + 122 : y + 70, narrow ? formW : 116, narrow ? 32 : 42, this.app.serverOnline ? 'CONNECTED' : 'CONNECT', { accent: !this.app.serverOnline, disabled: !!this.busy || this.app.serverOnline })) void this.connectServer();
      if (!narrow && (this.error || this.busy)) text(ctx, this.error || this.busy, formX, y + 144, { size: 11, color: this.error ? THEME.red : THEME.dim, maxWidth: formW });
      y += 192;
    }
    if (this.myPlays.length || user) {
      const rows = this.myPlays.slice(0, 12), ph = Math.max(130, 62 + rows.length * 58);
      fillPanel(ctx, px, y, pw, ph, { r: 18 }); text(ctx, 'MY PLAYS', formX, y + 32, { size: 12, color: THEME.accent });
      if (!rows.length) text(ctx, 'no plays yet', formX, y + 90, { size: 13, color: THEME.dim });
      rows.forEach((play, i) => {
        const ry = y + 68 + i * 58;
        text(ctx, play.title, formX, ry, { size: 13, maxWidth: formW - 120, translate: false });
        text(ctx, [modsLabel(play.mods), play.version].filter(Boolean).join(' · '), formX, ry + 21, { size: 10, color: THEME.dim, maxWidth: formW - 120, translate: false });
        text(ctx, play.grade + ' · ' + (play.acc * 100).toFixed(2) + '%', formX + formW, ry, { size: 13, align: 'right', color: THEME.accent });
        text(ctx, play.pp.toFixed(1) + ' pp', formX + formW, ry + 21, { size: 10, align: 'right', color: THEME.dim });
      }); y += ph + 18;
    }
    if (side) {
      const lx = px + pw + 18, lw = w - lx - 24, ly = viewY;
      fillPanel(ctx, lx, ly, lw, Math.min(viewH, 510), { r: 18 }); text(ctx, 'TOP RATING', lx + 24, ly + 34, { size: 13, color: THEME.gold });
      if (!this.leaderboard.length) paragraph(ctx, this.app.serverOnline ? 'no players yet' : 'connect a server for global rankings', lx + 24, ly + 100, lw - 48, { size: 13, color: THEME.dim });
      this.leaderboard.slice(0, Math.max(0, Math.floor((Math.min(viewH, 510) - 70) / 44))).forEach((player, i) => {
        const ry = ly + 80 + i * 44;
        text(ctx, String(i + 1).padStart(2, '0'), lx + 24, ry, { size: 12, color: i < 3 ? THEME.gold : THEME.dim });
        text(ctx, player.nickname || player.username, lx + 58, ry, { size: 13, maxWidth: lw - 152, translate: false });
        text(ctx, player.rating.toFixed(0), lx + lw - 24, ry, { size: 13, align: 'right', color: THEME.accent });
      });
    }
    this.maxScroll = Math.max(0, y + this.scroll - viewY - viewH);
    ctx.restore(); ui.clearClip(); drawScrollbar(ctx, pw + px - 8, viewY + 12, viewH - 24, viewH + this.maxScroll, viewH, this.scroll);
  }
}
