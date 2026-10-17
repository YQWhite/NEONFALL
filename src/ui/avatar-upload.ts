import { tr } from './i18n.ts';

/** Square selection in source pixels, independent of the preview's CSS size. */
export class AvatarCrop {
  zoom = 1;
  cx: number;
  cy: number;
  constructor(readonly width: number, readonly height: number) {
    if (!(width > 0 && height > 0)) throw new Error('Invalid image dimensions.');
    this.cx = width / 2; this.cy = height / 2;
  }
  get size() { return Math.min(this.width, this.height) / this.zoom; }
  setZoom(value: number) { this.zoom = Math.max(1, Math.min(4, value)); this.clamp(); }
  drag(dx: number, dy: number, previewSize: number) {
    if (!(previewSize > 0) || !Number.isFinite(previewSize)) return;
    this.cx -= dx * this.size / previewSize;
    this.cy -= dy * this.size / previewSize;
    this.clamp();
  }
  private clamp() {
    const half = this.size / 2;
    this.cx = Math.max(half, Math.min(this.width - half, this.cx));
    this.cy = Math.max(half, Math.min(this.height - half, this.cy));
  }
  get rect() { return { x: this.cx - this.size / 2, y: this.cy - this.size / 2, size: this.size }; }
}

/** Only explicit confirmation returns pixels to upload. Cancel/abort never uploads. */
export async function cropAvatar(file: File, signal?: AbortSignal): Promise<Uint8Array | null> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('Avatar image must be smaller than 10 MB.');
  const url = URL.createObjectURL(file), picture = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      picture.onload = () => resolve();
      picture.onerror = () => reject(new Error('Could not read this image.'));
      picture.src = url;
    });
    if (signal?.aborted) return null;
    const width = picture.naturalWidth, height = picture.naturalHeight;
    if (!width || !height || width * height > 40_000_000) throw new Error('Avatar image dimensions are too large.');
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const crop = new AvatarCrop(width, height);
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:12000;background:rgba(7,12,17,.86);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;font-family:system-ui,sans-serif;color:#e9f0ed;';
      overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', tr('Crop avatar'));
      const panel = document.createElement('div');
      panel.className = 'nf-avatar-crop-panel';
      panel.style.cssText = 'position:relative;width:360px;max-width:100%;max-height:100%;overflow:auto;touch-action:pan-y;overscroll-behavior:contain;background:#18232b;border:1px solid #40554b;border-radius:20px;padding:22px;box-sizing:border-box;box-shadow:0 18px 80px #0008;';
      const responsive = document.createElement('style');
      responsive.textContent = '@media(max-height:520px) and (min-width:520px){.nf-avatar-crop-panel{width:680px!important;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:20px;padding:16px!important}.nf-avatar-crop-panel>canvas{grid-column:1;grid-row:1/5;width:min(100%,calc(100dvh - 80px))!important;align-self:center;justify-self:center}.nf-avatar-crop-panel>h2{grid-column:2;grid-row:1}.nf-avatar-crop-panel>p{grid-column:2;grid-row:2}.nf-avatar-crop-panel>label{grid-column:2;grid-row:3}.nf-avatar-crop-panel>div{grid-column:2;grid-row:4}}';
      overlay.appendChild(responsive);
      const heading = document.createElement('h2'); heading.textContent = tr('Crop avatar'); heading.style.cssText = 'font-size:20px;margin:0 0 8px;';
      const help = document.createElement('p'); help.textContent = tr('Drag the image and zoom to choose a square crop.'); help.style.cssText = 'font-size:13px;line-height:1.5;color:#a5b7b0;margin:0 0 16px;';
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 320;
      // This canvas is a normal-flow dialog control, never a fullscreen stage
      // layer. Keep CSS dimensions square so drag deltas match source pixels.
      canvas.style.cssText = 'display:block;position:relative;inset:auto;width:min(100%,max(120px,calc(100dvh - 250px)));height:auto;max-width:100%;min-width:0;aspect-ratio:1;margin:0 auto;touch-action:none;cursor:grab;background:#0c1218;border-radius:8px;';
      canvas.setAttribute('aria-label', tr('Square avatar preview'));
      const context = canvas.getContext('2d')!;
      const paint = () => {
        const r = crop.rect; context.clearRect(0, 0, 320, 320);
        context.drawImage(picture, r.x, r.y, r.size, r.size, 0, 0, 320, 320);
        context.strokeStyle = '#ffffff45'; context.lineWidth = 1;
        for (const fraction of [1 / 3, 2 / 3]) {
          context.beginPath(); context.moveTo(fraction * 320, 0); context.lineTo(fraction * 320, 320); context.stroke();
          context.beginPath(); context.moveTo(0, fraction * 320); context.lineTo(320, fraction * 320); context.stroke();
        }
      };
      const zoomLabel = document.createElement('label'); zoomLabel.textContent = tr('Zoom'); zoomLabel.style.cssText = 'display:block;margin:16px 0;font-size:13px;';
      const zoom = document.createElement('input'); zoom.type = 'range'; zoom.min = '1'; zoom.max = '4'; zoom.step = '.01'; zoom.value = '1'; zoom.style.cssText = 'display:block;width:100%;margin-top:10px;accent-color:#bed8c9;';
      zoom.setAttribute('aria-label', tr('Zoom'));
      zoom.addEventListener('input', () => { crop.setZoom(Number(zoom.value)); paint(); }); zoomLabel.appendChild(zoom);
      const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:12px;';
      const cancel = document.createElement('button'), confirm = document.createElement('button');
      cancel.textContent = tr('CANCEL'); confirm.textContent = tr('Crop and upload');
      for (const button of [cancel, confirm]) { button.type = 'button'; button.style.cssText = 'flex:1;padding:12px 8px;border:1px solid #52645c;border-radius:10px;background:#25352f;color:#e9f0ed;font-size:14px;cursor:pointer;'; actions.appendChild(button); }
      confirm.style.background = '#c9ded4'; confirm.style.color = '#17271f';
      panel.append(heading, help, canvas, zoomLabel, actions); overlay.appendChild(panel);
      const previousFocus = document.activeElement as HTMLElement | null;
      let finished = false;
      let drag: { id: number; x: number; y: number } | null = null;
      const endDrag = () => {
        const id = drag?.id; drag = null; canvas.style.cursor = 'grab';
        if (id !== undefined) { try { canvas.releasePointerCapture(id); } catch { /* Capture may already be lost. */ } }
      };
      const finish = (value: Uint8Array | null, error?: Error) => {
        if (finished) return; finished = true;
        endDrag();
        signal?.removeEventListener('abort', abort); overlay.remove(); previousFocus?.focus();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(null);
      cancel.addEventListener('click', abort);
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        try {
          const output = document.createElement('canvas'); output.width = output.height = 256;
          const r = crop.rect, out = output.getContext('2d')!;
          out.imageSmoothingEnabled = true; out.imageSmoothingQuality = 'high';
          out.drawImage(picture, r.x, r.y, r.size, r.size, 0, 0, 256, 256);
          const blob = await new Promise<Blob>((done, fail) => output.toBlob(value => value ? done(value) : fail(new Error('Could not prepare the avatar.')), 'image/png'));
          if (blob.size > 512 * 1024) throw new Error('Could not prepare the avatar.');
          finish(new Uint8Array(await blob.arrayBuffer()));
        } catch (error) { finish(null, error instanceof Error ? error : new Error('Could not prepare the avatar.')); }
      });
      canvas.addEventListener('pointerdown', event => {
        if (drag || (event.button !== undefined && event.button !== 0)) return;
        event.preventDefault(); drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; canvas.style.cursor = 'grabbing';
        try { canvas.setPointerCapture(event.pointerId); } catch { /* In-canvas dragging remains available. */ }
      });
      canvas.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        event.preventDefault();
        crop.drag(event.clientX - drag.x, event.clientY - drag.y, canvas.getBoundingClientRect().width);
        drag.x = event.clientX; drag.y = event.clientY; paint();
      });
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) canvas.addEventListener(name, event => { if (drag?.id === event.pointerId) endDrag(); });
      canvas.addEventListener('wheel', event => { event.preventDefault(); crop.setZoom(crop.zoom * Math.exp(-event.deltaY * .001)); zoom.value = String(crop.zoom); paint(); }, { passive: false });
      for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'click']) overlay.addEventListener(name, event => event.stopPropagation());
      overlay.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); finish(null); }
        if (event.key === 'Tab') {
          const focusable = [zoom, cancel, confirm].filter(el => !el.disabled), index = focusable.indexOf(document.activeElement as HTMLInputElement);
          event.preventDefault(); focusable[(index + (event.shiftKey ? focusable.length - 1 : 1)) % focusable.length].focus();
        }
      });
      signal?.addEventListener('abort', abort, { once: true });
      document.body.appendChild(overlay); paint(); zoom.focus();
    });
  } finally { URL.revokeObjectURL(url); }
}
