// NEONFALL command-line converter: osz/mcz -> .nfm, osk/msp -> .nfsk.
// Usage: node tools/convert-cli.mjs <file...> [--out <dir>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { importChartArchive, importSkinArchive, detectKind } from '../src/core/import.ts';
import { readNFM, readNFSK } from '../src/core/nfm.ts';
import { computeStars, computePP } from '../src/core/rating.ts';

const args = process.argv.slice(2);
let outDir = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    outDir = args[++i];
  } else if (args[i] === '--stats') {
    // handled below
  } else {
    files.push(args[i]);
  }
}
const wantStats = args.includes('--stats');

if (files.length === 0) {
  console.log('usage: node tools/convert-cli.mjs <file.osz|file.mcz|file.osk|file.msp|file.nfm|file.nfsk> [--out <dir>] [--stats]');
  process.exit(0);
}

function fmtSize(b) {
  return (b / 1048576).toFixed(2) + ' MB';
}

for (const file of files) {
  const bytes = readFileSync(file);
  const name = path.basename(file);
  const kind = detectKind(name);
  console.log(`\n=== ${name} (${fmtSize(bytes.length)}) — ${kind || 'unknown'} ===`);
  const dir = outDir || path.dirname(file);
  mkdirSync(dir, { recursive: true });
  try {
    if (kind === 'osz' || kind === 'mcz') {
      const charts = await importChartArchive(name, bytes);
      for (const c of charts) {
        const safe = c.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const out = path.join(dir, `${safe}.nfm`);
        writeFileSync(out, c.nfm);
        const stars = c.stars;
        const pp95 = computePP(stars, 0.95, c.chart.meta.lengthMs);
        const pp99 = computePP(stars, 0.99, c.chart.meta.lengthMs);
        console.log(`  → ${path.basename(out)}  ${c.keys}K · ${c.notes} notes · ★${stars.toFixed(2)} · ${(c.chart.meta.lengthMs / 1000).toFixed(0)}s · pp(95%)${pp95.toFixed(1)} pp(99%)${pp99.toFixed(1)}${c.chart.storyboard ? ` · storyboard ×${c.chart.storyboard.objects.length}` : ''} · ${fmtSize(c.nfm.length)}`);
        if (wantStats) {
          const st = computeStars(c.chart);
          console.log(`      density ${st.density.toFixed(2)} n/s · avgChord ${st.avgChord.toFixed(2)} · jacks ${(st.jackRatio * 100).toFixed(1)}% · holds ${(st.holdRatio * 100).toFixed(1)}% · sv ${st.svComplexity.toFixed(2)} · bpm ${st.bpm}`);
        }
      }
    } else if (kind === 'osk' || kind === 'msp') {
      const s = await importSkinArchive(name, bytes);
      const safe = (s.name + '.nfsk').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
      const out = path.join(dir, safe);
      writeFileSync(out, s.nfsk);
      console.log(`  → ${path.basename(out)}  "${s.name}" by ${s.author || 'unknown'} · ${s.keys}K · ${fmtSize(s.nfsk.length)}`);
    } else if (kind === 'nfm') {
      const arc = await readNFM(bytes);
      const c = arc.chart;
      console.log(`  valid .nfm: ${c.meta.title} [${c.meta.version}] ${c.keys}K · ${c.notes.length} notes · ★${(c.stars || computeStars(c).stars).toFixed(2)}`);
    } else if (kind === 'nfsk') {
      const { skin } = readNFSK(bytes);
      console.log(`  valid .nfsk: "${skin.name}" by ${skin.author || 'unknown'} · ${skin.keys}K`);
    } else {
      console.log('  ✗ unsupported type — use .osz / .mcz / .osk / .msp / .nfm / .nfsk');
    }
  } catch (e) {
    console.log('  ✗ FAILED: ' + (e?.message || e));
  }
}
