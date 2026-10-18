import { tr } from './i18n.ts';

export interface ServerNoticeData {
  address: string;
  serverVersion: string;
  localVersion: string;
  announcement: { title: string; body: string } | null;
}

export function serverVersionMismatch(remote: string, local: string): boolean {
  return !!remote && remote.replace(/^v/i, '') !== local.replace(/^v/i, '');
}

/** Public server text is rendered literally, never as HTML. */
export function showServerNotice(data: ServerNoticeData, onClose: () => void): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const overlay = document.createElement('div');
  overlay.className = 'nf-server-notice';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:11000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(7,12,17,.78);font-family:system-ui,sans-serif;color:#e9f0ed;';
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', tr('Server announcement'));
  const panel = document.createElement('section');
  panel.style.cssText = 'width:540px;max-width:100%;max-height:calc(100dvh - 32px);overflow:auto;overscroll-behavior:contain;touch-action:pan-y;box-sizing:border-box;background:#18232b;border:1px solid #40554b;border-radius:18px;padding:24px;box-shadow:0 18px 80px #0008;';
  const tag = document.createElement('div'); tag.textContent = tr('Server announcement');
  tag.style.cssText = 'font-size:11px;color:#a6cbb5;letter-spacing:1px;margin-bottom:12px;';
  const title = document.createElement('h2'); title.textContent = data.announcement?.title || tr('Welcome to NEONFALL');
  title.style.cssText = 'font-size:22px;line-height:1.3;margin:0 0 16px;overflow-wrap:anywhere;';
  const body = document.createElement('p'); body.textContent = data.announcement?.body || tr('The server has no announcement. Enjoy the music.');
  body.style.cssText = 'font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 20px;color:#c3d0c8;';
  const address = document.createElement('p'); address.textContent = data.address;
  address.style.cssText = 'font-size:11px;color:#849b90;overflow-wrap:anywhere;margin:8px 0;';
  const versions = document.createElement('p');
  versions.textContent = tr('Server {server} · Client {client}', { server: data.serverVersion || tr('Unknown version'), client: data.localVersion });
  versions.style.cssText = 'font-size:12px;color:#a5b7b0;margin:8px 0;';
  panel.append(tag, title, body, address, versions);
  if (serverVersionMismatch(data.serverVersion, data.localVersion)) {
    const warning = document.createElement('p');
    warning.textContent = tr('Versions differ. You remain connected; features supported by this server are available.');
    warning.style.cssText = 'font-size:12px;line-height:1.6;color:#e0c493;background:#302d25;border-radius:8px;padding:12px;margin:16px 0;';
    panel.appendChild(warning);
  }
  const button = document.createElement('button'); button.type = 'button'; button.textContent = tr('CONTINUE');
  button.style.cssText = 'display:block;width:100%;min-height:42px;margin-top:20px;border:0;border-radius:10px;background:#c9ded4;color:#15251e;font:600 14px system-ui;cursor:pointer;';
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; overlay.remove();
    if (previous?.isConnected) previous.focus();
    onClose();
  };
  button.addEventListener('click', close);
  overlay.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.code === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') { event.preventDefault(); button.focus(); }
  });
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'wheel', 'keyup']) {
    overlay.addEventListener(name, event => event.stopPropagation());
  }
  panel.appendChild(button); overlay.appendChild(panel); document.body.appendChild(overlay); button.focus({ preventScroll: true });
  return close;
}
