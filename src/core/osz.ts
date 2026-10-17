// osu! (.osu / .osb) parser — mania charts, timing points, storyboards.
import type { NFChart, SBObject, SBCmd } from './types.ts';
import { clamp } from './zip.ts';

export interface OsuSections {
  [key: string]: string[];
}

export function parseSections(text: string): OsuSections {
  const lines = text.split(/\r?\n/);
  const out: OsuSections = {};
  let cur = '';
  for (const line of lines) {
    const m = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (m) {
      cur = m[1];
      out[cur] = [];
      continue;
    }
    if (cur && line.trim() !== '') (out[cur] ??= []).push(line);
  }
  return out;
}

function fieldOf(sec: string[] | undefined, name: string): string {
  if (!sec) return '';
  const prefix = name + ':';
  for (const line of sec) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return '';
}

// ---------------- storyboard text parser ----------------

const LAYER_ID: Record<string, number> = {
  Background: 0, Fail: 1, Pass: 2, Foreground: 3, Overlay: 4,
};

const ORIGIN_ID: Record<string, number> = {
  TopLeft: 0, Centre: 1, CentreLeft: 2, TopRight: 3, BottomCentre: 4,
  TopCentre: 5, Custom: 6, CentreRight: 7, BottomLeft: 8, BottomRight: 9,
};

/** CSV fields retain empty time cells and quoted commas in resource names. */
export function storyboardCSV(line: string): string[] {
  return (line.match(/(?:"[^"]*"|[^,])*(?:,|$)/g) ?? []).filter((v, i, a) => i < a.length - 1 || v !== '').map(v => v.replace(/,$/, '').trim().replace(/^"|"$/g, ''));
}
function parseCmd(kind: string, rest: string): SBCmd[] {
  const p = rest.split(',').map(s => s.trim());
  const n = (i: number, fallback = NaN) => p[i] === '' || p[i] === undefined ? fallback : Number(p[i]);
  if (kind === 'L') {
    const t = n(0), count = n(1);
    return Number.isFinite(t) && Number.isFinite(count) && count > 0 ? [{ k: 'L', ease: 0, t1: t, t2: t, a: [t, Math.floor(count)], loops: [] }] : [];
  }
  if (kind === 'T') return [{ k: 'T', ease: 0, t1: n(1, -Infinity), t2: n(2, Infinity), a: [], trigger: p[0], group: n(3, 0), loops: [] }];
  const ease = n(0), t1 = n(1), t2 = n(2, t1);
  if (![ease, t1, t2].every(Number.isFinite)) return [];
  if (kind === 'P') return ['A', 'H', 'V'].includes(p[3]) ? [{ k: 'P', ease, t1, t2, a: [], parameter: p[3] as 'A' | 'H' | 'V' }] : [];
  const width = ({ F: 1, M: 2, MX: 1, MY: 1, S: 1, V: 2, C: 3, R: 1 } as Record<string, number>)[kind];
  if (!width) return [];
  const values = p.slice(3).map(Number);
  if (values.length < width || values.length % width || !values.every(Number.isFinite)) return [];
  if (values.length === width) values.push(...values);
  const out: SBCmd[] = [], duration = t2 - t1;
  for (let i = 0; i < values.length / width - 1; i++) out.push({ k: kind as SBCmd['k'], ease, t1: t1 + i * duration, t2: t2 + i * duration, a: values.slice(i * width, (i + 2) * width) });
  return out;
}

/** Trigger children remain conditional; the player currently deliberately skips them. */
export function parseStoryboard(lines: string[]): SBObject[] {
  const objects: SBObject[] = [];
  let cur: SBObject | null = null;
  const stack: { indent: number; cmd: SBCmd }[] = [];
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('//')) continue;
    const m = /^(Sprite|Animation|4|6)\s*,(.+)$/.exec(line.trim());
    if (m) {
      const p = storyboardCSV(m[2]);
      cur = { type: m[1] === 'Animation' || m[1] === '6' ? 'anim' : 'sprite', layer: LAYER_ID[p[0]] ?? Number(p[0]), origin: ORIGIN_ID[p[1]] ?? Number(p[1]), path: p[2] || '', x: Number(p[3]) || 0, y: Number(p[4]) || 0, cmds: [] };
      if (!Number.isFinite(cur.layer)) cur.layer = 3;
      if (!Number.isFinite(cur.origin)) cur.origin = 0;
      if (cur.type === 'anim') { cur.frames = Math.max(1, Math.floor(Number(p[5]) || 1)); cur.frameDelay = Math.max(1, Number(p[6]) || 1000); cur.loopType = p[7] === 'LoopOnce' || p[7] === '1' ? 1 : 0; }
      objects.push(cur); stack.length = 0; continue;
    }
    const cm = /^([\s_]*)(MX|MY|F|M|S|V|C|R|P|L|T)\s*,(.+)$/.exec(line);
    if (!cm || !cur) { if (!/^[\s_]/.test(line)) cur = null; continue; }
    const indent = cm[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const commands = parseCmd(cm[2], cm[3]);
    const target = stack.length ? stack[stack.length - 1].cmd.loops! : cur.cmds;
    target.push(...commands);
    if (commands[0] && (cm[2] === 'L' || cm[2] === 'T')) stack.push({ indent, cmd: commands[0] });
  }
  return objects;
}

// ---------------- full .osu chart parser ----------------

export function parseOsuChart(text: string, keysOverride?: number): NFChart {
  const secs = parseSections(text);
  const general = secs['General'];
  const metaSec = secs['Metadata'];
  const diff = secs['Difficulty'];
  const mode = Number(fieldOf(general, 'Mode') || '0');
  if (mode !== 3) throw new Error('Not an osu!mania chart (Mode: ' + mode + ')');

  const keys = keysOverride ?? clamp(parseInt(fieldOf(diff, 'CircleSize')) || 4, 1, 18);
  const od = parseFloat(fieldOf(diff, 'OverallDifficulty'));
  const hp = parseFloat(fieldOf(diff, 'HPDrainRate'));
  const audioFile = fieldOf(general, 'AudioFilename') || 'audio.mp3';
  const audioLeadIn = parseFloat(fieldOf(general, 'AudioLeadIn')) || 0;
  const rawPreviewTime = parseFloat(fieldOf(general, 'PreviewTime'));
  const authoredPreview = Number.isFinite(rawPreviewTime) && rawPreviewTime >= 0;
  const previewTime = authoredPreview ? rawPreviewTime : -1;

  // ---- timing points ----
  const timing: { t: number; bpm: number }[] = [];
  const sv: { t: number; sv: number }[] = [];
  const sampleSetAt: { t: number; set: number }[] = [];
  const kiaiPoints: { t: number; enabled: boolean }[] = [];
  for (const line of secs['TimingPoints'] ?? []) {
    const p = line.split(',').map((s) => parseFloat(s.trim()));
    if (p.length < 2 || !Number.isFinite(p[0])) continue;
    const t = p[0];
    // osu timing-point effects bit 0 (mask 1) controls kiai for both red and
    // inherited green points. Beat length/SV never determines the kiai state.
    const effects = Number.isInteger(p[7]) && p[7] >= 0 ? p[7] : 0;
    kiaiPoints.push({ t, enabled: (effects & 1) !== 0 });
    if (!Number.isFinite(p[1])) continue;
    const beatLength = p[1];
    const set = Math.floor(p[3] ?? 0);
    sampleSetAt.push({ t, set });
    const uninherited = Number.isNaN(p[6]) || p[6] === undefined ? true : p[6] === 1;
    if (uninherited && beatLength > 0) {
      timing.push({ t, bpm: 60000 / beatLength });
      // Every red line resets inherited velocity. Stable sorting below retains
      // source order at equal timestamps, including green -> red and red -> green.
      sv.push({ t, sv: 1 });
    } else if (!uninherited && beatLength < 0) {
      sv.push({ t, sv: clamp(100 / -beatLength, 0.01, 10) });
    }
  }
  timing.sort((a, b) => a.t - b.t);
  sv.sort((a, b) => a.t - b.t);
  // osu ignores inherited (SV) points placed before the first uninherited point —
  // maps like Mopemope put a global SV 0.01 green line at -23ms, which must NOT
  // apply to the whole chart.
  if (timing.length) {
    const firstT = timing[0].t;
    while (sv.length && sv[0].t < firstT) sv.shift();
  }
  sampleSetAt.sort((a, b) => a.t - b.t);
  const offset = timing.length ? timing[0].t : 0;

  const getSampleSet = (t: number): number => {
    let s = 1; // default normal
    for (const p of sampleSetAt) {
      if (p.t <= t) {
        if (p.set !== 0) s = p.set;
      } else break;
    }
    return s; // 1 normal, 2 soft, 3 drum -> store as 0/1/2
  };

  // ---- events: bg / video / breaks / storyboard ----
  let bg: string | undefined;
  let video: string | undefined;
  const breaks: { t: number; end: number }[] = [];
  const sbLines: string[] = [];
  let inSb = false;
  for (const line of secs['Events'] ?? []) {
    if (line.startsWith('//')) continue;
    if (/^\s*(Sprite|Animation|4|6)\s*,/.test(line)) {
      inSb = true;
      sbLines.push(line);
      continue;
    }
    if (/^[\s_]*[A-Z]{1,2}\s*,/.test(line)) {
      if (inSb) sbLines.push(line);
      continue;
    }
    if (inSb && line.trim() === '') continue;
    inSb = false;
    const p = line.split(',').map((s) => s.trim());
    const type = parseInt(p[0]);
    if (type === 0 && p.length >= 3 && !bg) {
      bg = p[2].replace(/^"|"$/g, '');
    } else if (type === 1 && p.length >= 3 && !video) {
      video = p[2].replace(/^"|"$/g, '');
    } else if (type === 2 && p.length >= 3) {
      breaks.push({ t: parseFloat(p[1]) || 0, end: parseFloat(p[2]) || 0 });
    }
  }

  // ---- hit objects ----
  const notes: NFChart['notes'] = [];
  for (const line of secs['HitObjects'] ?? []) {
    const p = line.split(',');
    if (p.length < 5) continue;
    const x = parseFloat(p[0]);
    const t = parseFloat(p[2]);
    const type = parseInt(p[3]);
    const hitSound = parseInt(p[4]);
    if (!Number.isFinite(t)) continue;
    const col = clamp(Math.floor(x * keys / 512), 0, keys - 1);
    let end: number | undefined;
    if (type & 128) {
      const endT = parseInt((p[5] || '').split(':')[0]);
      if (!isNaN(endT) && endT > t) end = endT;
    }
    const sound = hitSound & 7;
    const setRaw = getSampleSet(t);
    notes.push({ t, col, end, sound, sampleSet: setRaw - 1 >= 0 ? setRaw - 1 : 0 });
  }
  notes.sort((a, b) => a.t - b.t);

  const title = fieldOf(metaSec, 'TitleUnicode') || fieldOf(metaSec, 'Title') || 'Unknown';
  const artist = fieldOf(metaSec, 'ArtistUnicode') || fieldOf(metaSec, 'Artist') || 'Unknown';
  const creator = fieldOf(metaSec, 'Creator') || 'Unknown';
  const version = fieldOf(metaSec, 'Version') || 'Normal';

  let lengthMs = 0;
  for (const n of notes) lengthMs = Math.max(lengthMs, n.end ?? n.t);
  // Equal-time control points are applied in file order; the last state wins.
  // Keep intervals finite for JSON, using the last note/tail when no off point
  // exists. The menu clips these against the decoded audio's actual duration.
  kiaiPoints.sort((a, b) => a.t - b.t);
  const states: typeof kiaiPoints = [];
  for (const point of kiaiPoints) {
    if (states.length && states[states.length - 1].t === point.t) states[states.length - 1] = point;
    else states.push(point);
  }
  const kiai: NonNullable<NFChart['kiai']> = [];
  let kiaiStart: number | null = null;
  for (const point of states) {
    if (point.enabled && kiaiStart === null) kiaiStart = point.t;
    else if (!point.enabled && kiaiStart !== null) {
      if (point.t > kiaiStart) kiai.push({ t: kiaiStart, end: point.t });
      kiaiStart = null;
    }
  }
  if (kiaiStart !== null && lengthMs > kiaiStart) kiai.push({ t: kiaiStart, end: lengthMs });

  const chart: NFChart = {
    format: 'neonfall-chart',
    version: 1,
    meta: {
      title,
      titleOrg: fieldOf(metaSec, 'Title'),
      artist,
      artistOrg: fieldOf(metaSec, 'Artist'),
      creator,
      version,
      source: fieldOf(metaSec, 'Source') || undefined,
      tags: fieldOf(metaSec, 'Tags') || undefined,
      audio: 'assets/' + audioFile,
      audioLeadIn,
      previewTime,
      previewSource: authoredPreview ? 'authored' : 'generated',
      bg: bg ? 'assets/' + bg : undefined,
      video: video ? 'assets/' + video : undefined,
      lengthMs,
    },
    keys,
    od: isNaN(od) ? 8 : od,
    hp: isNaN(hp) ? 7 : hp,
    offset,
    timing,
    sv,
    breaks,
    notes,
    ...(kiai.length ? { kiai } : {}),
  };
  if (sbLines.length > 0) {
    const objects = parseStoryboard(sbLines);
    if (objects.length > 0) chart.storyboard = { objects };
  }
  return chart;
}

/** Parse a .osb file (storyboard only). */
export function parseOsb(text: string): SBObject[] {
  const secs = parseSections(text);
  const variables = new Map<string, string>();
  for (const line of secs['Variables'] ?? []) { const i = line.indexOf('='); if (i > 0) variables.set(line.slice(0, i).trim(), line.slice(i + 1)); }
  const entries = [...variables].sort((a, b) => b[0].length - a[0].length);
  return parseStoryboard((secs['Events'] ?? []).map(line => { for (const [key, value] of entries) line = line.split(key).join(value); return line; }));
}

/** Compute frame path for an osu Animation object at a given frame index. */
export function animFramePath(path: string, frame: number): string {
  path = path.replace(/\\/g, '/');
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? path.slice(0, dot) + frame + path.slice(dot) : path + frame;
}
