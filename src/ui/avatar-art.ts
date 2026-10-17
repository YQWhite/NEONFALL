import type { App } from './app.ts';
import type { UserInfo } from '../core/types.ts';
import type { LocalProfile } from '../core/store.ts';
import { text } from './theme.ts';

type Profile = UserInfo | LocalProfile | null;
const avatars = new Map<string, HTMLImageElement | null>();
const MAX_AVATARS = 24;

function avatarUrl(app: App, user: Profile): string {
  const avatar = user && 'avatar' in user ? user.avatar : '';
  if (typeof avatar !== 'string' || !avatar.startsWith('/api/avatars/') || avatar.includes('\\')) return '';
  try {
    const base = app.server?.base || (typeof location !== 'undefined' ? location.origin : '');
    if (!/^https?:\/\//i.test(base)) return '';
    const root = new URL(base.endsWith('/') ? base : base + '/');
    // Keep an optional reverse-proxy prefix; only public server avatar paths are accepted.
    const url = new URL(avatar.slice(1), root);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname + 'api/avatars/')) return '';
    return url.href;
  } catch { return ''; }
}

/** Public avatar image, shared by the menu widget and account page. */
export function drawAvatar(ctx: CanvasRenderingContext2D, app: App, user: Profile, x: number, y: number, size: number) {
  const url = avatarUrl(app, user);
  if (url && !avatars.has(url) && typeof Image !== 'undefined') {
    if (avatars.size >= MAX_AVATARS) avatars.delete(avatars.keys().next().value!);
    avatars.set(url, null);
    const image = new Image();
    image.onload = () => { if (avatars.has(url)) avatars.set(url, image); };
    // No token, credentials parameter, or untrusted remote URL is attached to the public image.
    image.src = url;
  }
  const image = url ? avatars.get(url) : null;
  ctx.save();
  ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#293c36'; ctx.fillRect(x, y, size, size);
  if (image?.complete && image.naturalWidth > 0) {
    const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
    ctx.drawImage(image, x + (size - image.naturalWidth * scale) / 2, y + (size - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
  } else {
    const name = user?.nickname || user?.username || 'N';
    const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() || 'N';
    text(ctx, initial, x + size / 2, y + size / 2, { size: size * .42, weight: 600, baseline: 'middle', align: 'center', color: '#c9ded4', translate: false });
  }
  ctx.restore();
}
