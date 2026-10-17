// Malody V .msp: ZIP containing info.json and protobuf info.asm / info.asm2.
// Decode data only. Lua modules are never executed by the importer or renderer.
import type { NFSkin, NFSkinColumn } from './types.ts';
import type { MSPSprite, MSPAnimation, MSPPresentation } from './msp-types.ts';
import { bytesToStr, findCI, normPath, clamp } from './zip.ts';

type Message = Map<number, Array<number | Uint8Array>>;

/** Bounded protobuf wire reader; unknown fields can be safely skipped. */
function decode(data: Uint8Array): Message {
  const fields: Message = new Map();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0, count = 0;
  const varint = () => {
    let value = 0, multiplier = 1;
    for (let i = 0; i < 10; i++) {
      if (at >= data.length) throw new Error('Truncated MSP layout');
      const byte = data[at++];
      value += (byte & 127) * multiplier;
      if (!(byte & 128)) return value;
      multiplier *= 128;
    }
    throw new Error('Invalid MSP varint');
  };
  while (at < data.length) {
    if (++count > 50000) throw new Error('MSP layout has too many fields');
    const tag = varint(), field = Math.floor(tag / 8), wire = tag % 8;
    if (!field || field > 536870911) throw new Error('Invalid MSP field');
    let value: number | Uint8Array;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const size = varint();
      if (!Number.isSafeInteger(size) || size < 0 || size > data.length - at) throw new Error('Truncated MSP field');
      value = data.subarray(at, at + size); at += size;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > data.length) throw new Error('Truncated MSP number');
      value = wire === 1 ? view.getFloat64(at, true) : view.getFloat32(at, true); at += size;
    } else throw new Error('Unsupported MSP wire type');
    const list = fields.get(field) ?? []; list.push(value); fields.set(field, list);
  }
  return fields;
}

const number = (m: Message, field: number, fallback = 0): number => {
  const value = m.get(field)?.[0];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};
const string = (m: Message, field: number): string => {
  const value = m.get(field)?.[0]; return value instanceof Uint8Array ? bytesToStr(value) : '';
};
const children = (m: Message, field: number): Message[] => (m.get(field) ?? [])
  .filter((v): v is Uint8Array => v instanceof Uint8Array).map(decode);
const child = (m: Message, field: number): Message => children(m, field)[0] ?? new Map();
const moduleName = (m: Message) => string(child(m, 3), 3);

export function parseMSP(source: Map<string, Uint8Array>): { skin: NFSkin; assets: Record<string, Uint8Array> } {
  // Some exporters wrap the package in one directory. Preserve paths relative to
  // the manifest so case-insensitive references work without arbitrary traversal.
  const infoPath = [...source.keys()].find(p => /(^|\/)info\.json$/i.test(normPath(p)));
  if (!infoPath) throw new Error('Invalid MSP skin: missing info.json');
  const base = normPath(infoPath).slice(0, -'info.json'.length);
  const files = new Map([...source].filter(([p]) => normPath(p).startsWith(base)).map(([p, v]) => [normPath(p).slice(base.length), v]));
  let info: Record<string, unknown>;
  try { info = JSON.parse(bytesToStr(findCI(files, 'info.json')!)); } catch { throw new Error('Invalid MSP metadata'); }
  if (!info || typeof info !== 'object' || (info.mode !== undefined && info.mode !== 0)) throw new Error('MSP skin must use Malody Key mode');
  // info.asm is the active layout; asm2 may be an editor backup with stale assets.
  const raw = findCI(files, 'info.asm') ?? findCI(files, 'info.asm2');
  if (!raw?.length || raw.length > 8 * 1024 * 1024) throw new Error('Invalid MSP skin: missing or oversized layout');
  const root = decode(raw), meta = child(root, 1), modules = children(root, 3);
  const name = typeof info.title === 'string' ? info.title : string(meta, 1) || 'Malody skin';
  const author = typeof info.creator === 'string' ? info.creator : string(meta, 3);
  const assets: Record<string, Uint8Array> = Object.create(null);
  const use = (path: string): string | undefined => {
    const normalized = normPath(path);
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || !/\.(png|jpe?g|webp|gif|ogg|wav|mp3)$/i.test(normalized)) return undefined;
    const found = [...files.keys()].find(p => p.toLowerCase() === normalized.toLowerCase());
    if (!found) return undefined;
    assets[found] = files.get(found)!; return found;
  };
  const named = (name: string) => modules.find(m => moduleName(m).toLowerCase() === name.toLowerCase());
  const sprite = (m?: Message) => m ? child(m, 7) : new Map<number, Array<number | Uint8Array>>();
  const image = (m?: Message) => use(string(sprite(m), 1));
  const spriteData = (m?: Message): MSPSprite | undefined => {
    const path = image(m); if (!path) return undefined;
    const s = sprite(m);
    return { image: path, flipX: !!number(s, 8), additive: !!number(s, 19) };
  };
  const animation = (m?: Message): MSPAnimation | undefined => {
    if (!m) return undefined;
    const s = sprite(m), path = image(m); if (!path) return undefined;
    const count = clamp(number(s, 3, 1), 1, 120), first = number(s, 12, 1), prefix = string(s, 11);
    const frames: string[] = [];
    for (let i = 0; i < count; i++) {
      const frame = prefix ? use(`${prefix}${first + i}.png`) : path;
      if (frame) frames.push(frame);
    }
    return { frames: frames.length ? frames : [path], fps: clamp(number(s, 4, 30), 1, 120), additive: !!number(s, 19) };
  };
  // This author's Lua positions and animates these modules at runtime. Translate
  // its known gameplay presentation into bounded native data; never run Lua.
  const rmProfile = /RM White Blue Bar/i.test(name) && !!named('trackbg1') && !!named('catbg4') &&
    /function\s+Bongocat\s*\(/.test(bytesToStr(findCI(files, string(meta, 23)) ?? new Uint8Array()));
  const notes = modules.filter(m => number(m, 1) === 1 && [6, 7].includes(number(m, 2)));
  if (!notes.length) throw new Error('MSP layout has no supported Key note modules');
  const matches = (m: Message, column: number) => children(m, 4).every(condition => {
    const kind = number(condition, 1), op = number(condition, 2);
    // Key column (1-based) and scene-scale filters are part of Malody's module
    // format. Other feature filters do not change the exported sprite mapping.
    if (kind !== 1 && kind !== 9) return true;
    const actual = kind === 1 ? column + 1 : 1;
    const expected = kind === 1 ? number(condition, 3) : number(condition, 4);
    if (op === 2) return actual > expected;
    if (op === 3) return actual <= expected;
    if (op === 1) return actual !== expected;
    return actual === expected;
  });
  const layouts = new Set<number>();
  for (const m of modules) {
    const count = /^key(?:bg)?(\d{1,2})$/i.exec(moduleName(m));
    if (count && +count[1] >= 1 && +count[1] <= 18) layouts.add(+count[1]);
  }
  if (!layouts.size) {
    const declared = Number(info.key);
    if (Number.isInteger(declared) && declared > 0 && declared <= 18) layouts.add(declared);
    else { const range = /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*K/i.exec(`${name} ${info.desc ?? ''}`);
      if (range) for (let i = Math.max(1, +range[1]); i <= Math.min(18, +range[2]); i++) layouts.add(i);
      if (!layouts.size) layouts.add(4);
    }
  }
  const judge = modules.find(m => number(m, 1) === 7 && /judge/i.test(moduleName(m))) ?? modules.find(m => number(m, 1) === 7);
  const judgments = judge ? children(child(judge, 9), 1).map(m => use(string(m, 1))) : [];
  const angle = clamp(number(child(meta, 7), 2, 40), 0, 70);
  const variants: Record<string, NFSkin> = {};
  for (const keys of [...layouts].sort((a, b) => a - b)) {
    const keyModule = named(`key${keys}`), keyImage = image(keyModule), keySprite = sprite(keyModule);
    const columns: NFSkinColumn[] = [];
    for (let col = 0; col < keys; col++) {
      const findNote = (type: number) => notes.find(m => number(m, 2) === type && matches(m, col));
      const tap = findNote(7) ?? notes.find(m => number(m, 2) === 7);
      const hold = findNote(6) ?? notes.find(m => number(m, 2) === 6);
      const taps = tap ? children(child(tap, 11), 1) : [], holds = hold ? children(child(hold, 11), 1) : [];
      const pressed = named(`keyd${keys}${col + 1}`);
      columns.push({ width: 480 / keys, noteImg: use(string(taps[0] ?? new Map(), 1)),
        noteImgH: use(string(holds[0] ?? new Map(), 1)), bodyImg: use(string(holds[1] ?? new Map(), 1)),
        noteImgT: use(string(holds[2] ?? new Map(), 1)), tailFlip: false,
        noteScaleY: clamp(number(taps[0] ?? new Map(), 7, 1), .2, 2),
        holdHeadScaleY: clamp(number(holds[0] ?? new Map(), 7, 1), .2, 2),
        holdTailScaleY: clamp(number(holds[2] ?? new Map(), 7, 1), .2, 2),
        keyImg: keyImage, keyCrop: [col / keys, 0, 1 / keys, 1],
        keyFlip: !!number(keySprite, 8), keyImgD: image(pressed), keyPressedFlip: !!number(sprite(pressed), 8),
        tint: [80, 206, 247], background: [14, 20, 28, 235] });
    }
    const presentation: MSPPresentation = {
      profile: rmProfile ? 'rm-white-blue' : undefined, depth: angle > 0 ? .55 : 1,
      trackLeft: spriteData(named('trackbg1')), trackLight: spriteData(named('tracklight1')),
      trackBottom: spriteData(named('trackbottom1')), keyBackground: spriteData(named(`keybg${keys}`)),
      laneLine: spriteData(named('trackline1')), press: spriteData(named('press1')),
      hit: animation(named('hit1')), holdHit: animation(named('hit3')),
    };
    const effect = named('perfecteffect'), effectFrame = effect ? children(child(effect, 9), 1)[0] : undefined;
    const effectImage = effectFrame ? use(string(effectFrame, 1)) : undefined;
    if (effectImage) presentation.perfectEffect = { image: effectImage, additive: !!number(effectFrame!, 19) };
    if (rmProfile) {
      const background = image(named(`catbg${keys}`));
      const presses = Array.from({ length: keys }, (_, col) => image(named(keys === 5
        ? ['catp61', 'catp62', 'catp53', 'catp65', 'catp66'][col] : `catp${keys}${col + 1}`)) ?? '');
      const poses = Array.from({ length: 16 }, (_, i) => image(named(`cat${i + 1}`)) ?? '');
      if (background) presentation.cat = { background, presses, poses };
    }
    const topWidths = [760, 732, 704, 674, 646, 616, 588, 558, 528, 498, 468, 438, 408, 376, 346, 314, 282, 250, 218, 184, 150];
    const topWidth = rmProfile && angle >= 30 && angle <= 50 ? topWidths[Math.round(angle) - 30] / 1680
      : angle > 0 ? clamp(Math.cos(angle * Math.PI / 180) ** 4, .12, .85) : 1;
    const layout: NFSkin = { format: 'neonfall-skin', version: 1, name, author, keys, columnWidth: 480 / keys,
      hitPosition: 414, columns, judgementLine: !presentation.keyBackground, keyUnderNotes: true, noteBodyStyle: 0,
      perspective: { angle, topWidth }, msp: presentation,
      stage: { light: image(named('press1')) }, hud: { healthFill: image(named('hpbar')) },
      judgments: { perfect: judgments[0], great: judgments[1] ?? judgments[0], good: judgments[2],
        ok: judgments[2], bad: judgments[2], miss: judgments[3] },
      source: { type: 'msp', scripted: !!string(meta, 23) },
    };
    variants[String(keys)] = layout;
  }
  const first = variants[Object.keys(variants)[0]];
  if (!first.columns.some(c => c.noteImg)) throw new Error('MSP note images are missing');
  return { skin: { ...first, variants }, assets };
}
