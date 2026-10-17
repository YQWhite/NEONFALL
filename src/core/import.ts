// Import pipeline: .osz/.mcz -> .nfm, .osk -> .nfsk.
import type { NFChart, NFSkin, SBObject } from './types.ts';
import { unzipToMap, findCI, strToBytes, bytesToStr, normPath, extOf } from './zip.ts';
import { parseOsuChart, parseOsb, animFramePath } from './osz.ts';
import { parseMc } from './mcz.ts';
import { parseOSK } from './osk.ts';
import { parseMSP } from './msp.ts';
import { buildNFM, buildNFSK, chartLengthMs } from './nfm.ts';
import { computeStars } from './rating.ts';

export interface ImportedChart {
  name: string; // suggested file name
  version: string;
  keys: number;
  notes: number;
  stars: number;
  chart: NFChart;
  nfm: Uint8Array;
}

export interface ImportedSkin {
  name: string;
  author: string;
  keys: number;
  skin: NFSkin;
  nfsk: Uint8Array;
}

export type ArchiveKind = 'osz' | 'mcz' | 'osk' | 'msp' | 'nfm' | 'nfsk' | null;

export function detectKind(name: string): ArchiveKind {
  const ext = extOf(name);
  if (ext === 'osz') return 'osz';
  if (ext === 'mcz') return 'mcz';
  if (ext === 'osk') return 'osk';
  if (ext === 'msp') return 'msp';
  if (ext === 'nfm') return 'nfm';
  if (ext === 'nfsk') return 'nfsk';
  return null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_OK = /\.(mp4|webm|m4v|mov)$/i;

/** convert an osz/mcz archive into .nfm packages (one per difficulty). */
export function importChartArchive(name: string, bytes: Uint8Array): ImportedChart[] {
  const files = unzipToMap(bytes);
  const ext = extOf(name);
  const hasOsu = [...files.keys()].some((k) => k.toLowerCase().endsWith('.osu'));
  const hasMc = [...files.keys()].some((k) => k.toLowerCase().endsWith('.mc'));

  if (ext === 'osz' || (hasOsu && !hasMc)) {
    return importOsz(files, name);
  }
  if (ext === 'mcz' || hasMc) {
    return importMcz(files, name);
  }
  throw new Error('No osu!mania (.osu) or Malody (.mc) charts found in archive');
}

function collectAssets(
  files: Map<string, Uint8Array>,
  chart: NFChart,
): Record<string, Uint8Array> {
  const assets: Record<string, Uint8Array> = {};
  const addAsset = (srcPath: string | undefined, destPath: string): boolean => {
    if (!srcPath) return false;
    const data = findCI(files, srcPath);
    if (!data) return false;
    assets[destPath] = data;
    return true;
  };
  // audio
  if (!addAsset(chart.meta.audio.replace(/^assets\//, ''), chart.meta.audio)) {
    // fallback: first audio file in archive
    const any = [...files.keys()].find((k) => /\.(mp3|ogg|wav|flac|m4a)$/i.test(k));
    if (!any) throw new Error('Chart has no audio file');
    chart.meta.audio = 'assets/' + normPath(any).split('/').pop()!;
    addAsset(normPath(any), chart.meta.audio);
  }
  // background
  if (chart.meta.bg) {
    if (!addAsset(chart.meta.bg.replace(/^assets\//, ''), chart.meta.bg)) {
      const any = [...files.keys()].find((k) => IMAGE_EXT.test(k) && !k.toLowerCase().startsWith('sb/'));
      if (any) {
        chart.meta.bg = 'assets/' + normPath(any).split('/').pop()!;
        addAsset(normPath(any), chart.meta.bg);
      } else chart.meta.bg = undefined;
    }
  }
  // video (only browser-decodable containers)
  if (chart.meta.video) {
    const vPath = chart.meta.video.replace(/^assets\//, '');
    if (VIDEO_OK.test(vPath)) {
      addAsset(vPath, chart.meta.video);
    } else {
      chart.meta.video = undefined; // browsers can't decode flv/avi; drop gracefully
    }
  }
  // storyboard images: copy SB/ folder + any referenced loose files
  if (chart.storyboard) {
    for (const [k, v] of files) {
      const kl = normPath(k);
      if (/^sb\//i.test(kl) && IMAGE_EXT.test(kl)) {
        assets['sb/' + kl.replace(/^sb\//i, '')] = v;
      }
    }
    const rewritePath = (p: string): string => {
      const norm = normPath(p);
      const dest = 'sb/' + norm;
      if (assets[dest]) return dest;
      const src = findCI(files, norm);
      if (src) {
        assets[dest] = src;
        return dest;
      }
      return norm; // keep as-is; renderer will skip if missing
    };
    const fixObj = (o: SBObject) => {
      if (o.type === 'anim') {
        // An animation's base file need not exist; copy each referenced frame,
        // including loose files and folders other than SB/.
        const source = normPath(o.path);
        for (let i = 0; i < (o.frames ?? 1); i++) {
          const frame = animFramePath(source, i), data = findCI(files, frame);
          if (data) assets['sb/' + frame] = data;
        }
        o.path = 'sb/' + source;
      } else o.path = rewritePath(o.path);
    };
    for (const o of chart.storyboard.objects) fixObj(o);
  }
  // embedded beatmap skin (skin.ini at archive root)
  if (findCI(files, 'skin.ini')) {
    const { skin, assets: skinAssets } = parseOSK(files);
    chart.skin = { files: {}, data: skin };
    for (const [k, v] of Object.entries(skinAssets)) {
      const dest = 'skin/' + normPath(k);
      assets[dest] = v;
      chart.skin.files[normPath(k)] = dest;
    }
    // rewrite skin asset paths to their new locations inside the nfm package
    const prefix = (p?: string): string | undefined => (p ? 'skin/' + normPath(p) : undefined);
    for (const c of skin.columns) {
      c.keyImg = prefix(c.keyImg);
      c.keyImgD = prefix(c.keyImgD);
      c.noteImg = prefix(c.noteImg);
      c.noteImgH = prefix(c.noteImgH);
      c.noteImgT = prefix(c.noteImgT);
      c.bodyImg = prefix(c.bodyImg);
      c.bodyBegin = prefix(c.bodyBegin);
      c.bodyEnd = prefix(c.bodyEnd);
    }
    if (skin.stage) {
      skin.stage.left = prefix(skin.stage.left);
      skin.stage.right = prefix(skin.stage.right);
      skin.stage.bottom = prefix(skin.stage.bottom);
      skin.stage.light = prefix(skin.stage.light);
      skin.stage.hint = prefix(skin.stage.hint);
      skin.stage.warning = prefix(skin.stage.warning);
    }
    if (skin.judgments) {
      for (const k of Object.keys(skin.judgments) as (keyof typeof skin.judgments)[]) {
        (skin.judgments as any)[k] = prefix((skin.judgments as any)[k]);
      }
    }
    if (skin.hitsounds) {
      for (const set of ['normal', 'soft', 'drum'] as const) {
        const s = skin.hitsounds[set];
        if (!s) continue;
        for (const k of Object.keys(s) as (keyof typeof s)[]) (s as any)[k] = prefix((s as any)[k]);
      }
    }
    if (skin.misc) {
      for (const k of Object.keys(skin.misc) as (keyof typeof skin.misc)[]) {
        (skin.misc as any)[k] = prefix((skin.misc as any)[k]);
      }
    }
    if (skin.fonts) {
      skin.fonts.combo = prefix(skin.fonts.combo);
      skin.fonts.score = prefix(skin.fonts.score);
      skin.fonts.name = prefix(skin.fonts.name);
    }
    for (const group of [skin.hud, skin.grades]) {
      if (group) for (const key of Object.keys(group)) (group as any)[key] = prefix((group as any)[key]);
    }
  }
  // Rewrite variant layouts too (the root layout was rewritten above).
  const embedded = chart.skin?.data;
  if (embedded?.variants) {
    const rewrite = (value: any): any => {
      if (typeof value === 'string') return assets['skin/' + normPath(value)] ? 'skin/' + normPath(value) : value;
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
      return value;
    };
    embedded.variants = rewrite(embedded.variants);
  }
  return assets;
}

function finalizeChart(chart: NFChart, sourceType: 'osz' | 'mcz', original: string): NFChart {
  chart.stars = computeStars(chart).stars;
  chart.source = { type: sourceType, original };
  chart.meta.lengthMs = chartLengthMs(chart);
  if (!Number.isFinite(chart.meta.previewTime) || chart.meta.previewTime < 0) {
    const at = chart.meta.lengthMs * 0.4;
    let best = -1;
    for (const n of chart.notes) {
      if (n.t >= at) {
        best = n.t;
        break;
      }
    }
    chart.meta.previewTime = best > 0 ? Math.max(0, best - 1500) : 0;
    chart.meta.previewSource = 'generated';
  }
  return chart;
}

function importOsz(files: Map<string, Uint8Array>, archiveName: string): ImportedChart[] {
  const out: ImportedChart[] = [];
  const osuFiles = [...files.keys()]
    .filter((k) => k.toLowerCase().endsWith('.osu') && !k.toLowerCase().includes('storyboard'))
    .sort();
  if (osuFiles.length === 0) throw new Error('No .osu files in archive');
  // optional separate storyboard file
  let osbObjects: SBObject[] | undefined;
  const osbFile = [...files.keys()].find((k) => k.toLowerCase().endsWith('.osb'));
  if (osbFile) {
    try {
      osbObjects = parseOsb(bytesToStr(findCI(files, osbFile)!));
    } catch {
      osbObjects = undefined;
    }
  }

  for (const osuPath of osuFiles) {
    const text = bytesToStr(findCI(files, osuPath)!);
    // Mixed-mode beatmap sets are common; skip non-mania difficulties only.
    if (!/^\s*Mode\s*:\s*3\s*$/m.test(text)) continue;
    const chart = parseOsuChart(text);
    if (osbObjects && osbObjects.length) {
      // collectAssets rewrites paths in place: never share .osb object instances
      // between difficulties or later charts acquire sb/sb/... missing paths.
      const ownObjects = structuredClone(osbObjects);
      chart.storyboard = chart.storyboard
        ? { objects: [...chart.storyboard.objects, ...ownObjects] }
        : { objects: ownObjects };
    }
    const assets = collectAssets(files, chart);
    finalizeChart(chart, 'osz', archiveName);
    out.push({
      name: `${chart.meta.title} [${chart.meta.version}]`,
      version: chart.meta.version,
      keys: chart.keys,
      notes: chart.notes.length,
      stars: chart.stars!,
      chart,
      nfm: buildNFM(chart, assets),
    });
  }
  return out;
}

function importMcz(files: Map<string, Uint8Array>, archiveName: string): ImportedChart[] {
  const out: ImportedChart[] = [];
  const mcFiles = [...files.keys()].filter((k) => k.toLowerCase().endsWith('.mc')).sort();
  if (mcFiles.length === 0) throw new Error('No .mc files in archive');
  for (const mcPath of mcFiles) {
    const text = bytesToStr(findCI(files, mcPath)!);
    const chart = parseMc(text);
    if (chart.keys < 1 || chart.keys > 18) continue;
    const assets = collectAssets(files, chart);
    finalizeChart(chart, 'mcz', archiveName);
    out.push({
      name: `${chart.meta.title} [${chart.meta.version}]`,
      version: chart.meta.version,
      keys: chart.keys,
      notes: chart.notes.length,
      stars: chart.stars!,
      chart,
      nfm: buildNFM(chart, assets),
    });
  }
  return out;
}

/** Convert an osu! or Malody skin archive into a .nfsk package. */
export function importSkinArchive(name: string, bytes: Uint8Array): ImportedSkin {
  const files = unzipToMap(bytes);
  const { skin, assets } = extOf(name) === 'msp' ? parseMSP(files) : parseOSK(files);
  return {
    name: skin.name,
    author: skin.author || '',
    keys: skin.keys,
    skin,
    nfsk: buildNFSK(skin, assets),
  };
}

export function bytesToJson(b: Uint8Array): string {
  return bytesToStr(b);
}

export { strToBytes };
