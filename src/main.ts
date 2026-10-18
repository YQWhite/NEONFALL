// NEONFALL entry point.
import { App } from './ui/app.ts';
import { MenuScreen } from './ui/screens/menu.ts';
import { SelectScreen } from './ui/screens/select.ts';
import { SettingsScreen } from './ui/screens/settings.ts';
import { AccountScreen } from './ui/screens/account.ts';
import { ImportScreen } from './ui/screens/import.ts';
import { PlayScreen } from './ui/screens/play.ts';
import { ResultScreen } from './ui/screens/result.ts';
import { RankingsScreen } from './ui/screens/rankings.ts';
import { readNFM } from './core/nfm.ts';
import { tr } from './ui/i18n.ts';
import { scoreSync } from './api/score-sync.ts';
import { installAndroidExamples } from './core/android-bundled.ts';

declare global {
  interface Window {
    __NF?: App;
    __NF_TEST?: { readNFM: typeof readNFM };
  }
}

async function boot() {
  const app = new App();
  app.registerScreen('menu', (a) => new MenuScreen(a));
  app.registerScreen('select', (a) => new SelectScreen(a));
  app.registerScreen('settings', (a) => new SettingsScreen(a));
  app.registerScreen('account', (a) => new AccountScreen(a));
  app.registerScreen('import', (a) => new ImportScreen(a));
  app.registerScreen('play', (a) => new PlayScreen(a));
  app.registerScreen('result', (a) => new ResultScreen(a));
  app.registerScreen('rankings', (a) => new RankingsScreen(a));

  // platform wiring
  if (app.platform === 'android') {
    try { await installAndroidExamples(app.store); }
    catch { app.toast(tr('Example songs could not be installed. You can import your own songs.')); }
  }
  if (!app.settings.serverDisconnected && (app.centralLibrary || app.settings.serverUrl)) {
    try {
      await app.pingServer();
    } catch {
      app.serverOnline = false;
    }
  }
  if (app.serverOnline) await app.refreshAccount();
  else app.account = { server: false, user: app.store.getProfile() };
  app.audio.applySettings(app.settings);
  app.start();
  scoreSync(app).start();

  // Android back button behaves like ESC (pause gameplay / back out of menus)
  try {
    const capApp = await import('@capacitor/app');
    capApp.App.addListener('backButton', () => {
      const screen = app.screen;
      if (screen && screen.name === 'play') {
        screen.keyDown('Escape', new KeyboardEvent('keydown', { code: 'Escape' }));
      } else if (screen && screen.name !== 'menu') {
        app.gotoScreen('menu');
      } else {
        capApp.App.minimizeApp();
      }
    });
  } catch {
    /* plugin not present (web/desktop) */
  }

  // expose for the visual test harness
  window.__NF = app;
  window.__NF_TEST = { readNFM };

  const bootEl = document.getElementById('boot');
  if (bootEl) bootEl.remove();
}

boot().catch((err) => {
  console.error('NEONFALL boot failed', err);
  const el = document.getElementById('boot');
  if (el) {
    el.innerHTML = `<div class="logo" style="color:#d49396;font-size:18px;letter-spacing:2px">${tr('BOOT ERROR')}: ${String(
      (err as Error)?.message || err,
    ).replace(/</g, '&lt;')}</div>`;
  }
});
