// Malody (.mc) chart parser.
import type { NFChart } from './types.ts';
import { clamp } from './zip.ts';

interface McBeat {
  [0]: number;
  [1]: number;
  [2]: number;
}

export function parseMc(text: string, keysOverride?: number): NFChart {
  const j = JSON.parse(text);
  const meta = j.meta || {};
  const song = meta.song || {};
  const mode = meta.mode ?? 0;
  if (mode !== 0) throw new Error('Not a Malody key chart (mode: ' + mode + ')');
  const keys = clamp(meta.mode_ext?.column ?? keysOverride ?? 4, 1, 18);
  const timeRaw: { beat: McBeat; bpm: number; delay: number }[] = j.time || [];
  const notesRaw: {
    beat: McBeat; column?: number; endbeat?: McBeat; vol?: number;
    sound?: string; type?: number; offset?: number;
  }[] = j.note || [];
  const subRaw: { beat: McBeat; val?: number; v?: number }[] = j.sub || [];

  const beatPos = (b: McBeat): number => (b[2] > 0 ? b[0] + b[1] / b[2] : b[0]);

  // Integrate BPM changes once. Section delay is NOT an absolute section time.
  const secs = timeRaw
    .map((s) => ({ pos: beatPos(s.beat), bpm: Number.isFinite(s.bpm) && s.bpm > 0 ? s.bpm : 120, t: 0 }))
    .sort((a, b) => a.pos - b.pos);
  if (secs.length === 0) secs.push({ pos: 0, bpm: 120, t: 0 });
  secs[0].t = secs[0].pos * 60000 / secs[0].bpm;
  for (let i = 1; i < secs.length; i++) {
    const prev = secs[i - 1];
    secs[i].t = prev.t + (secs[i].pos - prev.pos) * 60000 / prev.bpm;
  }

  const beatTime = (pos: number): number => {
    if (pos <= secs[0].pos) return secs[0].t + ((pos - secs[0].pos) * 60000) / secs[0].bpm;
    let lo = 0, hi = secs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (secs[mid].pos <= pos) lo = mid;
      else hi = mid - 1;
    }
    const s = secs[lo];
    return s.t + ((pos - s.pos) * 60000) / s.bpm;
  };

  // MC sound cue types: 0 effect, 1 song, 2 keysound (rconv Malody
  // format reference). Only the song cue defines the backing audio/time origin.
  // A positive cue offset delays the AUDIO start relative to the beat grid.
  // Notes use the audio-file clock: audioTime = beatTime - beatTime(cue.beat)
  // - cue.offset. This is not an audio seek position (the previous +offset
  // moved every note late by twice the offset). Do not add legacy delay again.
  const songCue = notesRaw.find((n) => n.type === 1 && typeof n.sound === 'string' && n.sound.length > 0);
  const legacyDelay = timeRaw.length ? [...timeRaw].sort((a, b) => beatPos(a.beat) - beatPos(b.beat))[0].delay : 0;
  const offset = songCue
    ? -(Number.isFinite(songCue.offset) ? songCue.offset! : 0) - beatTime(beatPos(songCue.beat))
    : -(Number.isFinite(legacyDelay) ? legacyDelay : 0);
  const timeAt = (pos: number): number => beatTime(pos) + offset;

  const notes: NFChart['notes'] = [];
  for (const n of notesRaw) {
    // Song/effect cues are never playable, even if an exporter includes column:0.
    // A keysound attached to a real key (type 2) is still a playable note.
    if (n.type === 0 || n.type === 1 || !Number.isInteger(n.column) || n.column! < 0 || n.column! >= keys) continue;
    const t = timeAt(beatPos(n.beat));
    let end: number | undefined;
    if (n.endbeat) {
      const e = timeAt(beatPos(n.endbeat));
      if (e > t) end = e;
    }
    notes.push({ t, col: clamp(Math.round(n.column ?? 0), 0, keys - 1), end, vol: n.vol });
  }
  notes.sort((a, b) => a.t - b.t);

  const timing = secs.map((s) => ({ t: s.t + offset, bpm: s.bpm }));
  const sv: { t: number; sv: number }[] = [];
  for (const s of subRaw) {
    const val = s.val ?? s.v;
    if (val === undefined) continue;
    sv.push({ t: timeAt(beatPos(s.beat)), sv: clamp(val, 0.01, 10) });
  }
  sv.sort((a, b) => a.t - b.t);
  // drop SV points before the first timing section (same rule as osu)
  if (timing.length) {
    const firstT = timing[0].t;
    while (sv.length && sv[0].t < firstT) sv.shift();
  }

  const title = song.titleorg || song.title || 'Unknown';
  const artist = song.artistorg || song.artist || 'Unknown';
  const bgFile = meta.background || meta.cover || undefined;
  const audioFile = songCue?.sound || song.file || 'audio.mp3';

  let lengthMs = 0;
  for (const n of notes) lengthMs = Math.max(lengthMs, n.end ?? n.t);

  // The MC schema uses meta.preview in audio-file milliseconds (rconv's
  // MetaData.preview and its real parsing fixture); zero is a valid author cue.
  const authoredPreview = Number.isFinite(meta.preview) && meta.preview >= 0;
  const previewTime = authoredPreview ? meta.preview : (() => {
    // default preview: 40% into the song, clamp within chart
    if (lengthMs <= 0) return -1;
    const at = lengthMs * 0.4;
    let best = -1;
    for (const n of notes) {
      if (n.t >= at) {
        best = n.t;
        break;
      }
    }
    return best >= 0 ? Math.max(0, best - 1500) : -1;
  })();

  return {
    format: 'neonfall-chart',
    version: 1,
    meta: {
      title,
      artist,
      creator: meta.creator || 'Unknown',
      version: meta.version || 'Normal',
      source: song.source ?? undefined,
      audio: 'assets/' + audioFile,
      audioLeadIn: 0,
      previewTime,
      previewSource: authoredPreview ? 'authored' : 'generated',
      bg: bgFile ? 'assets/' + bgFile : undefined,
      lengthMs,
    },
    keys,
    od: 8,
    hp: 7,
    offset,
    timing,
    sv,
    breaks: [],
    notes,
  };
}
