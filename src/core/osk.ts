// osu! skin (.osk) parser -> NFSkin model + assets.
import type { NFSkin, NFSkinColumn } from './types.ts';
import type { ByteMap } from './zip.ts';
import { findCI, findBaseCI, bytesToStr, clamp, normPath } from './zip.ts';

export interface IniFile { [section: string]: { [key: string]: string }; }
export interface IniSection { name: string; values: Record<string, string>; }

/** Preserve repeated sections: each Mania block describes an independent key layout. */
export function parseIniSections(text: string): IniSection[] {
  const sections: IniSection[] = [];
  let cur: IniSection = { name: 'General', values: {} };
  sections.push(cur);
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(;|\/\/|#)/.test(line)) continue;
    const section = /^\[([^\]]+)\]\s*(?:\/\/.*|;.*)?$/.exec(line);
    if (section) {
      cur = { name: section[1].trim(), values: {} };
      sections.push(cur);
      continue;
    }
    const kv = /^([^:=]+)[:=](.*)$/.exec(line);
    if (kv) cur.values[kv[1].trim()] = kv[2].trim();
  }
  return sections;
}

/** Compatibility view; repeated sections replace rather than mix independent layouts. */
export function parseIni(text: string): IniFile {
  const out: IniFile = {};
  for (const section of parseIniSections(text)) out[section.name] = { ...section.values };
  return out;
}

/** Never apply a 4K column layout accidentally to a 7K chart. */
export function selectSkinForKeys(skin: NFSkin | null | undefined, keys: number): NFSkin | null {
  if (!skin) return null;
  return skin.variants?.[String(keys)] ?? (skin.keys === keys ? skin : null);
}

const value = (obj: Record<string, string>, key: string): string | undefined => {
  const found = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : obj[found];
};
const numberValue = (s: string | undefined, fallback: number): number => {
  if (s === undefined || !s.trim()) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};
const numbers = (s: string | undefined): number[] => s === undefined ? [] : s.split(',').map((v) => numberValue(v, NaN));
const backgroundColor = (s: string | undefined): [number, number, number, number] | undefined => {
  const rgba = numbers(s);
  if (rgba.length < 3 || rgba.slice(0, 3).some((n) => !Number.isFinite(n))) return undefined;
  return [clamp(rgba[0], 0, 255), clamp(rgba[1], 0, 255), clamp(rgba[2], 0, 255),
    Number.isFinite(rgba[3]) ? clamp(rgba[3], 0, 255) : 255];
};

export function parseOSK(files: ByteMap): { skin: NFSkin; assets: Record<string, Uint8Array> } {
  const iniRaw = findCI(files, 'skin.ini');
  const sections = parseIniSections(iniRaw ? bytesToStr(iniRaw) : '');
  const general: Record<string, string> = {};
  for (const section of sections) if (section.name.toLowerCase() === 'general') Object.assign(general, section.values);
  let skinName = value(general, 'Name') || 'Untitled skin';
  let author = value(general, 'Author') || '';
  const skininfo = findCI(files, 'skininfo.json');
  if (skininfo) {
    try {
      const info = JSON.parse(bytesToStr(skininfo));
      skinName = info.Name || skinName;
      author = info.Creator || author;
    } catch { /* optional metadata */ }
  }
  // Tail images are upside-down head artwork in osu 2.5+, including explicit T.
  // Keep old-version opt-out explicit; old NFSK without this field uses modern default.
  const version = value(general, 'Version');
  const modernTail = version === undefined || version.toLowerCase() === 'latest' || numberValue(version, 1) >= 2.5;
  const assets: Record<string, Uint8Array> = {};
  const density: Record<string, number> = {};
  const use = (path: string | undefined, audio = false): string | undefined => {
    if (!path) return undefined;
    const found = findBaseCI(files, path, { extensions: audio ? ['ogg', 'wav', 'mp3'] : ['png', 'jpg', 'jpeg', 'webp', 'gif'] });
    if (!found) return undefined;
    const key = normPath(found.path);
    assets[key] = found.data;
    density[key] = found.density;
    return key;
  };
  const fontInDir = (dir: string): string | undefined => {
    const prefix = normPath(dir).toLowerCase().replace(/\/$/, '') + '/';
    const entry = [...files].filter(([k]) => normPath(k).toLowerCase().startsWith(prefix) && /\.(ttf|otf)$/i.test(k))
      .sort(([a], [b]) => a.localeCompare(b))[0];
    if (!entry) return undefined;
    const key = normPath(entry[0]);
    assets[key] = entry[1];
    return key;
  };
  const fonts = { combo: fontInDir('Fonts/combo'), score: fontInDir('Fonts/score'), name: fontInDir('Fonts/name') };
  const ss = (set: string) => ({ hit: use(`${set}-hitnormal`, true), whistle: use(`${set}-hitwhistle`, true), finish: use(`${set}-hitfinish`, true), clap: use(`${set}-hitclap`, true) });
  const hitsounds = { normal: ss('normal'), soft: ss('soft'), drum: ss('drum') };
  const hud = { healthBackground: use('scorebar-bg'), healthFill: use('scorebar-colour') ?? use('scorebar-colour-0'), healthMarker: use('scorebar-marker') };
  const grades: NFSkin['grades'] = { SS: use('ranking-X'), S: use('ranking-S'), A: use('ranking-A'), B: use('ranking-B'), C: use('ranking-C'), D: use('ranking-D') };
  const misc = {
    combobreak: use('combobreak', true), comboburst: use('comboburst-mania') ?? use('comboburst'),
    count1: use('count1s', true), count2: use('count2s', true), count3: use('count3s', true), go: use('gos', true), ready: use('readys', true),
  };
  const maniaSections = sections.filter((section) => section.name.toLowerCase() === 'mania');
  const layouts = maniaSections.length ? maniaSections : [{ name: 'Mania', values: {} }];
  const variants: Record<string, NFSkin> = {};
  let first: NFSkin | undefined;
  for (const section of layouts) {
    const mania = section.values;
    const get = (key: string) => value(mania, key);
    const keys = clamp(Math.trunc(numberValue(get('Keys'), 4)), 1, 18);
    const widths = numbers(get('ColumnWidth'));
    const columnWidth = widths.find((w) => Number.isFinite(w) && w > 0) ?? 66;
    const specialStyle = numberValue(get('SpecialStyle'), 0);
    // osu's default assets are key TYPES, not one file per physical column.
    // Alternate the two normal types symmetrically, with type S for the special middle key.
    const keyType = (i: number): string => {
      if (keys % 2 === 1 && i === Math.floor(keys / 2)) return specialStyle === 0 ? 'S' : '1';
      const sideIndex = i < keys / 2 ? i : keys - 1 - i;
      return sideIndex % 2 === 0 ? '1' : '2';
    };
    const columns: NFSkinColumn[] = [];
    for (let i = 0; i < keys; i++) {
      const type = keyType(i);
      const keyImg = use(get(`KeyImage${i}`)) ?? use(`mania-key${type}`);
      const keyImgD = use(get(`KeyImage${i}D`)) ?? use(`mania-key${type}D`) ?? keyImg;
      const noteImg = use(get(`NoteImage${i}`)) ?? use(`mania-note${type}`);
      const noteImgH = use(get(`NoteImage${i}H`)) ?? use(`mania-note${type}H`) ?? noteImg;
      const bodyImg = use(get(`NoteImage${i}L`)) ?? use(`mania-note${type}L`);
      const noteImgT = use(get(`NoteImage${i}T`)) ?? use(`mania-note${type}T`);
      columns.push({
        keyImg, keyImgD, noteImg, noteImgH, bodyImg, noteImgT,
        tailFlip: modernTail && numberValue(get(`NoteFlipWhenUpsideDown${i}T`) ?? get('NoteFlipWhenUpsideDownT') ?? get('NoteFlipWhenUpsideDown'), 1) !== 0,
        // Colour1 is the first column (not Colour0). Preserve explicit transparent black.
        background: backgroundColor(get(`Colour${i + 1}`)),
        // Compatibility aliases: never use the body texture as a head cap.
        bodyBegin: noteImgH, bodyEnd: noteImgT,
        width: Number.isFinite(widths[i]) && widths[i] > 0 ? widths[i] : columnWidth,
      });
    }
    const judgmentAnimations: NonNullable<NFSkin['judgmentAnimations']> = {};
    const judgment = (grade: keyof NonNullable<NFSkin['judgments']>, name: string, fallback: string): string | undefined => {
      for (const candidate of [get(name), `mania-${fallback}`, fallback]) {
        if (!candidate) continue;
        // osu!mania hit bursts prefer numbered frames over the static image.
        // Skins often deliberately use a transparent static placeholder and
        // put the actual 200/100/50/MISS artwork in their sole "-0" frame.
        const base = candidate.replace(/\.(png|jpe?g|webp|gif)$/i, '').replace(/@2x$/i, '');
        const frames: string[] = [];
        for (let i = 0; i < 240; i++) {
          const frame = use(`${base}-${i}`);
          if (!frame) break;
          frames.push(frame);
        }
        if (frames.length) {
          // The mania hit bursts loop at 60 FPS, independent of the General
          // AnimationFramerate used by other osu skin elements.
          judgmentAnimations[grade] = { frames, fps: 60 };
          return frames[0];
        }
        const image = use(candidate);
        if (image) return image;
      }
      return undefined;
    };
    const layout: NFSkin = {
      format: 'neonfall-skin', version: 1, name: skinName, author, keys,
      columnStart: get('ColumnStart') === undefined ? undefined : numberValue(get('ColumnStart'), 0),
      columnWidth, hitPosition: numberValue(get('HitPosition'), 464), specialStyle,
      keyUnderNotes: numberValue(get('KeysUnderNotes'), 0) !== 0,
      judgementLine: numberValue(get('JudgementLine'), 1) !== 0,
      noteBodyStyle: numberValue(get('NoteBodyStyle'), 0),
      columnSpacing: numbers(get('ColumnSpacing')).map((n) => Number.isFinite(n) ? n : 0),
      columnLineWidth: numbers(get('ColumnLineWidth')).map((n) => Number.isFinite(n) ? n : 0),
      columns,
      stage: {
        left: use(get('StageLeft') ?? 'mania-stage-left'), right: use(get('StageRight') ?? 'mania-stage-right'),
        bottom: use(get('StageBottom') ?? 'mania-stage-bottom'), light: use(get('StageLight') ?? 'mania-stage-light'),
        hint: use(get('StageHint') ?? 'mania-stage-hint'), warning: use('mania-warningarrow'),
      },
      judgments: {
        perfect: judgment('perfect', 'Hit300g', 'hit300g'), great: judgment('great', 'Hit300', 'hit300'),
        good: judgment('good', 'Hit200', 'hit200'), ok: judgment('ok', 'Hit100', 'hit100'),
        bad: judgment('bad', 'Hit50', 'hit50'), miss: judgment('miss', 'Hit0', 'hit0'),
      },
      judgmentAnimations,
      hitsounds, misc, fonts, hud, grades, assetDensity: density,
    };
    first ??= layout;
    // Repeated blocks for the SAME key count: last complete block wins, no attribute leakage.
    variants[String(keys)] = layout;
  }
  const selected = variants[String(first!.keys)];
  // Root is a separate object to keep variants acyclic and JSON serializable.
  const skin: NFSkin = { ...selected, variants };
  return { skin, assets };
}
