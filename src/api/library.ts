import type { ChartEntry } from '../core/store.ts';
import type { App } from '../ui/app.ts';

/** Every platform merges the server catalogue with downloads and local imports. */
export async function listPlaybackCharts(app: App): Promise<ChartEntry[]> {
  const local = await app.store.listCharts();
  if (!app.centralLibrary || !app.serverOnline) return local;
  const api = app.server;
  try {
    const remote = await api.listCharts();
    if (app.server !== api || app.settings.serverDisconnected) return local;
    const localIds = new Set(local.map(entry => entry.contentHash || entry.id));
    const ids = new Set(remote.map(entry => entry.id));
    return [...remote.map(entry => ({ ...entry, downloaded: localIds.has(entry.id) })), ...local.filter(entry => !ids.has(entry.contentHash || entry.id))];
  } catch (error) {
    if (app.server !== api || app.settings.serverDisconnected) return local;
    app.serverOnline = false;
    if (local.length) return local;
    throw error;
  }
}
