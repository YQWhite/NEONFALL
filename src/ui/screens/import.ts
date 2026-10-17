// Import screen — convert osz/mcz/osk into .nfm/.nfsk and install into the library.
import { Screen } from '../app.ts';
import { THEME, text, fillPanel, paragraph, pageHeader, drawScrollbar } from '../theme.ts';
import { tr } from '../i18n.ts';
import { importChartArchive, importSkinArchive, detectKind } from '../../core/import.ts';
import { readNFM } from '../../core/nfm.ts';
import type { ChartEntry } from '../../core/store.ts';
import { fmtTime } from '../../core/zip.ts';

interface Job {
  name: string;
  status: 'working' | 'done' | 'error';
  detail: string;
}

export class ImportScreen extends Screen {
  readonly name = 'import';
  private jobs: Job[] = [];
  private fileInput: HTMLInputElement | null = null;
  private localCharts: ChartEntry[] = [];
  private serverCharts: ChartEntry[] = [];
  private busy = false;
  private scroll = 0;
  private maxScroll = 0;
  private touchDrag: { y: number; scroll: number; moved: boolean } | null = null;
  private dragging = false;
  private dragHandler = (e: DragEvent) => { e.preventDefault(); this.dragging = true; };
  private dropHandler = (e: DragEvent) => { e.preventDefault(); this.dragging = false; void this.handleFiles(Array.from(e.dataTransfer?.files ?? [])); };
  private dragLeave = () => { this.dragging = false; };
  wheel(dy: number) { this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + dy * .6)); }
  resize() { this.touchDrag = null; }
  pointerDown(_x: number, y: number) {
    this.touchDrag = this.app.isTouch && y >= 106 && y <= this.app.h - 20 ? { y, scroll: this.scroll, moved: false } : null;
  }
  pointerMove(_x: number, y: number) {
    const drag = this.touchDrag; if (!drag) return;
    if (Math.abs(y - drag.y) > 8) drag.moved = true;
    if (drag.moved) {
      this.scroll = Math.max(0, Math.min(this.maxScroll, drag.scroll + drag.y - y));
      this.app.ui.p.moved = true; this.app.ui.cancelPointer();
    }
  }
  pointerUp() {
    if (this.touchDrag?.moved) { this.app.ui.p.moved = true; this.app.ui.cancelPointer(); }
    this.touchDrag = null;
  }

  async enter() {
    window.addEventListener('dragover', this.dragHandler);
    window.addEventListener('drop', this.dropHandler);
    window.addEventListener('dragleave', this.dragLeave);
    this.localCharts = await this.app.store.listCharts();
    if (this.app.serverOnline) {
      try {
        this.serverCharts = await this.app.server.listCharts();
      } catch {
        this.serverCharts = [];
      }
    }
  }

  leave() {
    this.touchDrag = null;
    window.removeEventListener('dragover', this.dragHandler);
    window.removeEventListener('drop', this.dropHandler);
    window.removeEventListener('dragleave', this.dragLeave);
    if (this.fileInput) {
      this.fileInput.remove();
      this.fileInput = null;
    }
  }

  keyDown(code: string) {
    if (code === 'Escape') this.app.gotoScreen('menu');
  }

  private pickFiles() {
    if (this.fileInput) this.fileInput.remove();
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = '.osz,.mcz,.osk,.msp,.nfm,.nfsk';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    this.fileInput = inp;
    inp.onchange = () => {
      const files = Array.from(inp.files || []);
      this.handleFiles(files);
      inp.remove();
      this.fileInput = null;
    };
    inp.click();
  }

  async handleFiles(files: File[]) {
    if (this.busy || !files.length) return;
    this.busy = true;
    this.jobs = [];
    for (const f of files) {
      const job: Job = { name: f.name, status: 'working', detail: 'reading…' };
      this.jobs.unshift(job);
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const kind = detectKind(f.name);
        if (kind === 'nfm') {
          await this.installNfm(bytes, f.name, job);
        } else if (kind === 'nfsk') {
          const { id } = await this.app.store.putSkin(bytes, f.name.replace(/\.nfsk$/i, ''));
          job.status = 'done';
          job.detail = tr('Installed: {name}', { name: f.name });
          this.app.toast('skin installed');
        } else if (kind === 'osz' || kind === 'mcz') {
          const charts = await importChartArchive(f.name, bytes);
          let installed = 0;
          for (const c of charts) {
            await this.app.store.putChart(c.nfm, c.name);
            installed++;
          }
          job.status = 'done';
          job.detail = tr('Converted {count} charts', { count: installed });
          this.app.toast(tr('{count} charts imported', { count: installed }));
        } else if (kind === 'osk' || kind === 'msp') {
          const s = await importSkinArchive(f.name, bytes);
          await this.app.store.putSkin(s.nfsk, s.name);
          job.status = 'done';
          job.detail = tr('Installed: {name}', { name: s.name });
          this.app.toast('skin converted & installed');
        } else {
          throw new Error('unsupported file type (use .osz / .mcz / .osk / .msp / .nfm / .nfsk)');
        }
      } catch (e: any) {
        job.status = 'error';
        job.detail = e?.message || 'conversion failed';
      }
    }
    this.busy = false;
    this.localCharts = await this.app.store.listCharts();
    if (this.app.serverOnline) this.serverCharts = await this.app.server.listCharts().catch(() => []);
  }

  private async installNfm(bytes: Uint8Array, name: string, job: Job) {
    try {
      const arc = await readNFM(bytes); // validate
      const c = arc.chart;
      job.detail = tr('Importing…');
      await this.app.store.putChart(bytes, name);
      job.status = 'done';
      job.detail = tr('Installed: {name}', { name: c.meta.title + ' [' + c.meta.version + ']' });
    } catch (e: any) {
      throw new Error(tr('invalid .nfm: {error}', { error: tr(e?.message || 'failed') }));
    }
  }

  private async downloadServerChart(e: ChartEntry) {
    try {
      const bytes = await this.app.server.downloadChart(e.id);
      await this.app.store.putChart(bytes, e.name);
      this.localCharts = await this.app.store.listCharts();
      this.app.toast('cached locally');
    } catch (err: any) {
      this.app.toast(tr('download failed: {error}', { error: tr(String(err?.message || 'failed')) }));
    }
  }

  private async uploadLocalChart(entry: ChartEntry) {
    if (this.busy) return;
    this.busy = true;
    try {
      const bytes = await this.app.store.getChartBytes(entry.id);
      if (!bytes) throw new Error('chart bytes missing');
      await this.app.server.uploadChart(bytes, entry.name);
      this.serverCharts = await this.app.server.listCharts();
      this.app.toast('Uploaded to the central library.');
    } catch (error: any) { this.app.toast(tr('upload failed: {error}', { error: tr(error?.message || 'failed') })); }
    finally { this.busy = false; }
  }

  draw(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.app, ui = this.app.ui;
    this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll));
    if (ui.button('back', 24, 22, 96, 44, '← BACK')) this.app.gotoScreen('menu');
    pageHeader(ctx, 'IMPORT', 'Bring your music.', w);
    const viewY = 106, viewH = h - 126, pad = 24, gap = 18, split = w >= 700, colW = split ? (w - pad * 2 - gap) * .48 : w - 48;
    ctx.save(); ctx.beginPath(); ctx.rect(pad, viewY, w - 48, viewH); ctx.clip(); ui.setClip(pad, viewY, w - 48, viewH);
    const top = viewY - this.scroll;
    fillPanel(ctx, pad, top, colW, 246, { r: 18, fill: this.dragging ? '#293f34' : '#1b2b27', line: this.dragging ? THEME.accent : '#3b5148' });
    text(ctx, '+', pad + 28, top + 58, { size: 42, color: THEME.accent, weight: 300 });
    text(ctx, 'DROP BEATMAPS & SKINS HERE', pad + 28, top + 102, { size: 15, maxWidth: colW - 56 });
    paragraph(ctx, 'Charts & skins, ready in a moment.', pad + 28, top + 130, colW - 56, { size: 12, color: THEME.dim });
    text(ctx, '.osz  .mcz  .osk  .msp  .nfm  .nfsk', pad + 28, top + 166, { size: 11, color: THEME.accent2 });
    text(ctx, 'Import locally. Sign in to upload to the server.', pad + 28, top + 177, { size: 9, color: THEME.dim, maxWidth: colW - 56 });
    if (ui.button('pick', pad + 28, top + 188, colW - 56, 40, this.busy ? 'Importing…' : 'CHOOSE FILES…', { accent: true, disabled: this.busy })) this.pickFiles();
    const qx = split ? pad + colW + gap : pad, qy = split ? top : top + 264, qw = split ? w - qx - pad : colW;
    const qh = Math.max(246, 72 + this.jobs.length * 62);
    fillPanel(ctx, qx, qy, qw, qh, { r: 18 });
    text(ctx, 'CONVERSION QUEUE', qx + 24, qy + 34, { size: 12, color: THEME.accent });
    if (!this.jobs.length) paragraph(ctx, 'Your files will appear here.', qx + 24, qy + 100, qw - 48, { size: 13, color: THEME.dim });
    this.jobs.forEach((job, i) => {
      const jy = qy + 72 + i * 62, color = job.status === 'error' ? THEME.red : job.status === 'done' ? THEME.green : THEME.gold;
      text(ctx, job.status === 'done' ? '✓' : job.status === 'error' ? '!' : '…', qx + 24, jy, { size: 16, color });
      text(ctx, job.name, qx + 50, jy, { size: 12, maxWidth: qw - 74, translate: false });
      text(ctx, job.detail, qx + 50, jy + 22, { size: 11, color: job.status === 'error' ? color : THEME.dim, maxWidth: qw - 74 });
    });
    let y = Math.max(top + 246, qy + qh) + 18;
    const library = (title: string, charts: ChartEntry[], downloadable = false) => {
      const lh = Math.max(150, 76 + charts.length * 54);
      fillPanel(ctx, pad, y, w - 48, lh, { r: 18 });
      text(ctx, title, pad + 24, y + 30, { size: 12, color: THEME.accent });
      text(ctx, tr('{count} charts on this device', { count: charts.length }), w - pad - 24, y + 30, { size: 11, color: THEME.dim, align: 'right' });
      if (!charts.length) paragraph(ctx, 'No charts yet. Import your first song above.', pad + 24, y + 82, w - 96, { size: 13, color: THEME.dim });
      charts.forEach((entry, i) => {
        const ry = y + 66 + i * 54;
        text(ctx, entry.title, pad + 24, ry + 10, { size: 13, maxWidth: w - 260, translate: false });
        text(ctx, entry.version + ' · ' + entry.artist, pad + 24, ry + 30, { size: 10, color: THEME.dim, maxWidth: w - 260, translate: false });
        if (downloadable) { if (ui.button('dl-' + entry.id, w - pad - 104, ry, 80, 32, 'CACHE', { small: true })) void this.downloadServerChart(entry); }
        else if (this.app.serverOnline && this.app.account.server) {
          const uploaded = this.serverCharts.some(chart => chart.id === entry.id);
          if (ui.button('upload-' + entry.id, w - pad - 104, ry, 80, 32, uploaded ? 'UPLOADED' : 'UPLOAD', { small: true, disabled: this.busy || uploaded || !this.app.server.uploadsEnabled })) void this.uploadLocalChart(entry);
        } else text(ctx, `${entry.keys}K · ${(entry.stars || 0).toFixed(2)} ★ · ${fmtTime(entry.lengthMs)}`, w - pad - 24, ry + 16, { size: 11, color: THEME.accent2, align: 'right' });
      });
      y += lh + 18;
    };
    library('LOCAL LIBRARY', this.localCharts);
    if (this.app.serverOnline) library('SERVER LIBRARY', this.serverCharts, true);
    this.maxScroll = Math.max(0, y + this.scroll - viewY - viewH);
    ctx.restore(); ui.clearClip();
    drawScrollbar(ctx, w - 13, viewY + 10, viewH - 20, viewH + this.maxScroll, viewH, this.scroll);
  }
}
