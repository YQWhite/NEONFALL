// Storyboards use audio-relative milliseconds, radians and 640x480 coordinates.
import type { SBObject, SBCmd } from './types.ts';
import { clamp, guessMime, normPath } from './zip.ts';
import { storyboardEase as easeVal } from './storyboard-easing.ts';
import { animFramePath } from './osz.ts';
export interface SBImage { img: HTMLImageElement | HTMLCanvasElement; w: number; h: number; }
export interface SBEval { x: number; y: number; alpha: number; sx: number; sy: number; rot: number; r: number; g: number; b: number; visible: boolean; additive: boolean; flipH: boolean; flipV: boolean; }
export type SBPass = 'all' | 'background' | 'overlay';
/** NFM prefixes the original beatmap paths with assets/ or sb/. */
export function storyboardUsesBackground(objects: SBObject[], background: string): boolean {
  const originalPath = (path: string) => normPath(path).replace(/^(assets|sb)\//i, '').toLowerCase();
  return objects.some(obj => obj.type === 'sprite' && originalPath(obj.path) === originalPath(background));
}
export function storyboardSpan(cmds: SBCmd[]): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const c of cmds) {
    if (c.k === 'T') continue;
    if (c.k === 'L') {
      const s = storyboardSpan(c.loops ?? []), count = Math.floor(c.a[1]);
      if (count > 0 && Number.isFinite(s.min)) { min = Math.min(min, c.a[0] + s.min); max = Math.max(max, c.a[0] + s.min + Math.max(0, s.max - s.min) * count); }
    } else { min = Math.min(min, c.t1); max = Math.max(max, c.t1, c.t2); }
  }
  return { min, max };
}
interface TimedCommand { cmd: SBCmd; start: number; end: number; }
function collect(cmds: SBCmd[], t: number, shift: number, out: TimedCommand[]) {
  for (const c of cmds) {
    if (c.k === 'T') continue; // Conditional commands must never leak onto the absolute timeline.
    if (c.k !== 'L') { out.push({ cmd: c, start: shift + c.t1, end: shift + c.t2 }); continue; }
    const body = c.loops ?? [], span = storyboardSpan(body), count = Math.floor(c.a[1]);
    if (count <= 0 || !Number.isFinite(span.min)) continue;
    const duration = Math.max(0, span.max - span.min), start = shift + c.a[0];
    const iteration = duration > 0 ? clamp(Math.floor((t - start - span.min) / duration), 0, count - 1) : 0;
    // Latest completed iteration supplies values until current iteration changes them.
    if (iteration > 0) collect(body, t, start + (iteration - 1) * duration, out);
    collect(body, t, start + iteration * duration, out);
  }
}
export function evaluateStoryboardObject(obj: SBObject, t: number, span = storyboardSpan(obj.cmds)): SBEval {
  const o: SBEval & { scale: number } = { x: obj.x, y: obj.y, alpha: 1, sx: 1, sy: 1, scale: 1, rot: 0, r: 255, g: 255, b: 255, visible: t >= span.min && t <= span.max, additive: !!obj.additive, flipH: false, flipV: false };
  if (!o.visible) return o;
  const commands: TimedCommand[] = []; collect(obj.cmds, t, 0, commands); commands.sort((a,b) => a.start-b.start);
  const set = new Set<string>();
  for (const { cmd: c, start, end } of commands) {
    if (c.k === 'P') {
      const key = c.parameter === 'A' ? 'additive' : c.parameter === 'H' ? 'flipH' : c.parameter === 'V' ? 'flipV' : undefined;
      // A first instantaneous parameter supplies the initial value too (osu
      // legacy). A later finite command must be able to reset that parameter.
      if (key && (t >= start || !set.has(key))) {
        o[key] = end === start || (t >= start && t < end);
        set.add(key);
      }
      continue;
    }
    const p = end > start ? easeVal(c.ease, clamp((t-start)/(end-start),0,1)) : t < start ? 0 : 1;
    const apply = (key: 'x'|'y'|'alpha'|'sx'|'sy'|'scale'|'rot'|'r'|'g'|'b', a: number, b: number) => { if (t >= start || !set.has(key)) { o[key] = a+(b-a)*p; set.add(key); } };
    switch (c.k) {
      case 'F': apply('alpha',c.a[0],c.a[1]); break;
      case 'MX': apply('x',c.a[0],c.a[1]); break;
      case 'MY': apply('y',c.a[0],c.a[1]); break;
      case 'M': apply('x',c.a[0],c.a[2]); apply('y',c.a[1],c.a[3]); break;
      case 'S': apply('scale',c.a[0],c.a[1]); break;
      case 'V': apply('sx',c.a[0],c.a[2]); apply('sy',c.a[1],c.a[3]); break;
      case 'R': apply('rot',c.a[0],c.a[1]); break;
      case 'C': apply('r',c.a[0],c.a[3]); apply('g',c.a[1],c.a[4]); apply('b',c.a[2],c.a[5]); break;
    }
  }
  o.sx *= o.scale; o.sy *= o.scale;
  if (o.alpha > 1) o.alpha %= 1; // Legacy flicker effects depend on wrapping.
  o.visible = o.visible && o.alpha > 0; return o;
}
export function storyboardFrame(obj: SBObject, t: number): number {
  const frames = Math.max(1,obj.frames ?? 1), delay = Math.max(1,obj.frameDelay ?? 1000), start = storyboardSpan(obj.cmds).min;
  const frame = Math.max(0,Math.floor((t-(Number.isFinite(start)?start:0))/delay));
  return obj.loopType === 1 ? Math.min(frames-1,frame) : frame%frames;
}
interface SBObjectState { obj: SBObject; img?: SBImage; span: { min: number; max: number }; }
export class StoryboardPlayer {
  objects: SBObjectState[];
  readonly startTime: number;
  readonly endTime: number;
  private images = new Map<string, SBImage>();
  private pending = new Map<string, Promise<SBImage | undefined>>();
  private missing = new Set<string>();
  private tints = new WeakMap<SBImage['img'], { pixels: ImageData; cache: Map<string, HTMLCanvasElement> }>();
  private additiveLayers = new Set<number>();
  private getAsset: (path: string) => Uint8Array | undefined;
  constructor(objects: SBObject[], getAsset: (path: string) => Uint8Array | undefined) {
    this.getAsset=getAsset;this.objects=objects.map(obj=>({obj,span:storyboardSpan(obj.cmds)}));
    this.startTime=this.objects.reduce((t,st)=>Math.min(t,st.span.min),Infinity);
    this.endTime=this.objects.reduce((t,st)=>Math.max(t,st.span.max),-Infinity);
    const hasAdditive=(cmds:SBCmd[]):boolean=>cmds.some(c=>c.parameter==='A'||(c.loops?hasAdditive(c.loops):false));
    for(const obj of objects)if(obj.additive||hasAdditive(obj.cmds))this.additiveLayers.add(obj.layer);
  }
  needsBackdrop(pass:SBPass):boolean {
    return [...this.additiveLayers].some(layer=>pass==='all'||(pass==='overlay'?layer===4:layer<4));
  }
  load(path: string): Promise<SBImage | undefined> {
    const cached=this.images.get(path); if(cached) return Promise.resolve(cached);
    if(this.missing.has(path)) return Promise.resolve(undefined);
    const pending=this.pending.get(path); if(pending) return pending;
    const data=this.getAsset(path); if(!data){this.missing.add(path);return Promise.resolve(undefined);}
    const promise=new Promise<SBImage | undefined>(resolve=>{
      const url=URL.createObjectURL(new Blob([data as BlobPart],{type:guessMime(data)})), img=new Image();
      const finish=(sb?:SBImage)=>{URL.revokeObjectURL(url);if(sb)this.images.set(path,sb);else this.missing.add(path);resolve(sb);};
      img.onload=()=>finish({img,w:img.naturalWidth||1,h:img.naturalHeight||1});img.onerror=()=>finish();img.src=url;
    });
    this.pending.set(path,promise);void promise.then(()=>this.pending.delete(path));return promise;
  }
  warm(t: number, windowMs=8000) {
    for(const st of this.objects){
      if(t>st.span.max||t+windowMs<st.span.min)continue;
      if(st.obj.type==='anim'){
        const idx=storyboardFrame(st.obj,Math.max(t,st.span.min)), frames=st.obj.frames??1;
        const count=Math.min(frames, Math.ceil(windowMs/Math.max(1,st.obj.frameDelay??1000))+1);
        for(let i=0;i<count;i++) {
          const next=st.obj.loopType===1?Math.min(frames-1,idx+i):(idx+i)%frames;
          void this.load(animFramePath(st.obj.path,next));
        }
      }else if(!st.img)void this.load(st.obj.path).then(img=>{st.img=img;});
    }
  }
  /** Loading must finish before the music starts, including upcoming animation frames. */
  async prepare(t: number, windowMs=8000) {
    this.warm(t,windowMs);
    await Promise.all(this.pending.values());
  }
  private tinted(img: HTMLImageElement | HTMLCanvasElement,r:number,g:number,b:number):HTMLCanvasElement{
    r=clamp(Math.round(r),0,255);g=clamp(Math.round(g),0,255);b=clamp(Math.round(b),0,255);
    let holder=this.tints.get(img);
    if(!holder){
      const source=document.createElement('canvas');source.width=(img as HTMLImageElement).naturalWidth||img.width;source.height=(img as HTMLImageElement).naturalHeight||img.height;
      const ctx=source.getContext('2d')!;ctx.drawImage(img,0,0);
      holder={pixels:ctx.getImageData(0,0,source.width,source.height),cache:new Map()};this.tints.set(img,holder);
    }
    const key=`${r},${g},${b}`;const cached=holder.cache.get(key);if(cached)return cached;
    const c=document.createElement('canvas');c.width=holder.pixels.width;c.height=holder.pixels.height;
    const ctx=c.getContext('2d')!, tinted=ctx.createImageData(c.width,c.height), source=holder.pixels.data;
    // Canvas multiply+destination-in contaminates translucent pixels with the
    // fill colour. Multiply unpremultiplied RGB directly, retaining source alpha.
    for(let i=0;i<source.length;i+=4){tinted.data[i]=source[i]*r/255;tinted.data[i+1]=source[i+1]*g/255;tinted.data[i+2]=source[i+2]*b/255;tinted.data[i+3]=source[i+3];}
    ctx.putImageData(tinted,0,0);
    if(holder.cache.size>=8)holder.cache.delete(holder.cache.keys().next().value!);
    holder.cache.set(key,c);return c;
  }
  /** Caller supplies 640x480 transform. No whole-layer cache: it broke order, visibility and seek. */
  draw(ctx:CanvasRenderingContext2D,t:number,showFail:boolean,pass:SBPass='all',brightness=1){
    const light=Number.isFinite(brightness)?clamp(brightness,0,1):1;
    for(let layer=pass==='overlay'?4:0;layer<(pass==='background'?4:5);layer++){
      if((layer===1&&!showFail)||(layer===2&&showFail))continue;
      for(const st of this.objects){
        if(st.obj.layer!==layer||t<st.span.min||t>st.span.max)continue;
        const o=evaluateStoryboardObject(st.obj,t,st.span);if(!o.visible)continue;
        if(st.obj.type==='anim'){const path=animFramePath(st.obj.path,storyboardFrame(st.obj,t));st.img=this.images.get(path);if(!st.img)void this.load(path);}
        else if(!st.img){st.img=this.images.get(st.obj.path);if(!st.img)void this.load(st.obj.path);}
        const img=st.img;if(!img)continue;const {w,h}=img;
        const origins:[number,number][]=[[0,0],[-w/2,-h/2],[0,-h/2],[-w,0],[-w/2,-h],[-w/2,0],[0,0],[-w,-h/2],[0,-h],[-w,-h]];
        let [ox,oy]=origins[st.obj.origin]??origins[0];ctx.save();if(o.additive)ctx.globalCompositeOperation='lighter';ctx.globalAlpha=clamp(o.alpha,0,1);
        const sx=o.sx*(o.flipH?-1:1),sy=o.sy*(o.flipV?-1:1);
        if(sx<0)ox=-w-ox;if(sy<0)oy=-h-oy;
        ctx.translate(o.x,o.y);ctx.rotate(o.rot);ctx.scale(sx,sy);
        ctx.drawImage(light===1&&o.r===255&&o.g===255&&o.b===255?img.img:this.tinted(img.img,o.r*light,o.g*light,o.b*light),ox,oy);ctx.restore();
      }
    }
  }
}
