'use strict';
// Server counterpart of src/core/scoring.ts; tools/server-v029-tests.cjs compares
// both implementations. Old, unbounded scores keep their original rules.
const GRADES = ['perfect', 'great', 'good', 'ok', 'bad', 'miss'];
const weights = [320, 300, 200, 100, 50, 0];
function scoreFromCounts(counts, judgments, mods = []) {
  const weighted = GRADES.reduce((sum, key, i) => sum + counts[key] * weights[i], 0);
  return judgments > 0 ? Math.round(1000000 * Math.max(0, Math.min(1, weighted / (320 * judgments))) * (mods.some(mod => /^notail$/i.test(mod)) ? .9 : 1)) : 0;
}
function accuracyFromCounts(counts) {
  const total = GRADES.reduce((sum, key) => sum + counts[key], 0);
  return total ? (305 * counts.perfect + 300 * counts.great + 200 * counts.good + 100 * counts.ok + 50 * counts.bad) / (305 * total) : 1;
}
function gradeFromAccuracy(acc, passed = true) { return !passed ? 'F' : acc >= 1 ? 'SS' : acc > .95 ? 'S' : acc > .9 ? 'A' : acc > .8 ? 'B' : acc > .7 ? 'C' : 'D'; }
module.exports = { scoreFromCounts, accuracyFromCounts, gradeFromAccuracy };
