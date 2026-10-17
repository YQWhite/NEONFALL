import assert from 'node:assert/strict';
import { evaluateCalibration, median, TapCalibration } from '../src/ui/latency-calibration.ts';
assert.equal(median([4, 1, 3, 2]), 2.5);
const samples = Array.from({length: 18}, (_, i) => 80 + (i % 3 - 1) * 3);
const result = evaluateCalibration([...samples, -180, 210], 15);
assert.equal(result.ok, true); assert.equal(result.audioOffset, 65); assert.equal(result.rejected, 2);
// Actual engine sign: songTime - audioOffset - inputOffset. An 80 ms tap must resolve to 0.
assert.equal(80 - result.audioOffset - 15, 0);
assert.equal(evaluateCalibration(samples.map(v => -v), -15).audioOffset, -65);
assert.equal(evaluateCalibration([1, 2, NaN, Infinity], 0).ok, false);
assert.equal(evaluateCalibration(Array(20).fill(280), 0).ok, false);
assert.equal(evaluateCalibration(Array.from({length:20}, (_,i)=>i%2 ? -90 : 90), 0).ok, false);
const nodes=[];
const ctx={ currentTime: 10, state:'running',sampleRate:48000,destination:{},
 async resume(){},
 createGain(){const n={gain:{value:0},connect(){},disconnect(){this.disconnected=true}};nodes.push(n);return n},
 createBuffer(_channels,length){return {getChannelData(){return new Float32Array(length)}}},
 createBufferSource(){const n={connect(){},start(at){this.at=at},stop(){this.stopped=true},disconnect(){this.disconnected=true}};nodes.push(n);return n}
};
const c=new TapCalibration(ctx); await c.start(.5);
assert.equal(c.state,'running');assert.equal(c.beats.length,24);
assert.ok(nodes.slice(1).every((s,i)=>s.at===10.75+i*.5));
ctx.currentTime=c.beats[0]+.08;c.tap();assert.equal(c.samples.size,0,'warmup ignored');
for(let i=4;i<24;i++){ctx.currentTime=c.beats[i]+.08;c.tap();c.tap()}
assert.equal(c.samples.size,20,'duplicates ignored');
ctx.currentTime=c.beats[23]+.31;c.update();assert.equal(c.state,'done');assert.equal(c.result(0).audioOffset,80);
assert.ok(nodes.every(n=>n.disconnected));assert.ok(nodes.slice(1).every(n=>n.stopped));
await c.start(.5); c.cancel();assert.equal(c.state,'cancelled');assert.ok(nodes.every(n=>n.disconnected));
await c.start(.5); ctx.state='suspended';c.update();assert.equal(c.state,'error');assert.ok(nodes.every(n=>n.disconnected));
// Cancelling an unresolved resume must never leave late scheduled audio behind.
let resume; const delayed={...ctx,state:'suspended',resume(){return new Promise(r=>resume=r)}};
const race=new TapCalibration(delayed); const pending=race.start(.4);race.cancel();delayed.state='running';resume();await pending;assert.equal(race.state,'cancelled');assert.equal(race.beats.length,0);
console.log('calibration-tests: robust statistics, clock sign, scheduling, warmup, duplicates, cleanup, interruption and cancellation race PASS');
