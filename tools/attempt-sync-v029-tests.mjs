// Isolated real HTTP, synthetic chart and accounts; never reads the player server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { ServerApi } from '../src/api/client.ts';
import { ScoreSync, scoreSync } from '../src/api/score-sync.ts';
import { Store } from '../src/core/store.ts';
import { buildNFM } from '../src/core/nfm.ts';
import { accuracyFromCounts, scoreFromCounts } from '../src/core/scoring.ts';
import { PlayScreen } from '../src/ui/screens/play.ts';

const memory = new Map();
globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k,v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) };
const output = path.resolve('test-results/v029'); fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(output, 'attempt-server-'));
Object.assign(process.env, { NF_DATA_DIR: data, NF_SEED_DIR: path.join(data, 'no-seed'), HOST: '127.0.0.1', PORT: '0', NF_UPLOADS: 'authenticated' });
const { server } = createRequire(import.meta.url)('../server/server.js');
if (!server.listening) await once(server, 'listening');
let sync;
try {
  const base = `http://127.0.0.1:${server.address().port}`, api = new ServerApi(base), store = new Store();
  await api.ping();
  const auth = await api.register('attempt_test', 'Attempt player', 'isolated-password', 'attempt@example.invalid');
  store.setToken(auth.token); store.settings.serverUrl = base;
  const app = { server: api, store, settings: store.settings, centralLibrary: true, serverOnline: true,
    account: { server: true, user: auth.user }, screen: { name: 'play' }, toast() {} };
  sync = scoreSync(app);
  const chart = { format: 'neonfall-chart', version: 1, keys: 4, od: 8, stars: 5, offset: 0,
    meta: { title: 'Attempt fixture', artist: 'Test', creator: 'Test', version: '4K', audio: 'a.wav', audioLeadIn: 0, previewTime: 0, lengthMs: 10000 },
    timing: [{t:0,bpm:120}], sv:[], breaks:[], notes:Array.from({length:10},(_,i)=>({t:1000+i*500,col:i%4})) };
  const entry = await api.uploadChart(buildNFM(chart, {'a.wav':new Uint8Array(32)}), 'attempts.nfm');
  function result(playId, perfect, great, passed = true, mods = []) {
    const counts = {perfect,great,good:0,ok:0,bad:0,miss:0,holdTicks:0};
    return {chartId:entry.id,keys:4,scoreVersion:2,playId,score:scoreFromCounts(counts,10,mods),acc:accuracyFromCounts(counts),maxCombo:perfect+great,
      counts,stars:5,pp:0,grade:passed?'SS':'F',mods,passed,playedAt:Date.now(),title:'Attempt fixture',version:'4K',durationMs:10000,
      ...(!passed?{failedAtMs:4500}:{})};
  }
  const best=result('attempt-best-0001',10,0), worse=result('attempt-worse-0002',0,10), failure=result('attempt-failed-0003',5,0,false);
  sync.submit(best); sync.submit(worse); sync.submit(failure);
  assert.equal(sync.pendingCount,3,'all new attempts, including a non-PB clear and failure, remain queued during gameplay');
  sync.stop(); sync=new ScoreSync(app);
  assert.equal(sync.pendingCount,3,'failed attempt survives queue restoration');
  app.screen={name:'result'}; await sync.sync();
  assert.equal(sync.pendingCount,0);
  let stats=await api.chartStats(entry.id,4);
  assert.equal(stats.attempts,3); assert.equal(stats.passes,2); assert.equal(stats.passRate,2/3);
  assert.equal(stats.failureSamples,1); assert.equal(stats.failureBins.reduce((a,b)=>a+b,0),1);
  assert.equal((await api.scores(entry.id,4))[0].score,1_000_000,'lower attempt cannot replace high score');
  const rating=app.account.user.rating;
  sync.submit(failure); await sync.sync();
  stats=await api.chartStats(entry.id,4);
  assert.equal(stats.attempts,3,'retrying acknowledged attempt is idempotent');
  assert.equal(app.account.user.rating,rating,'failure/retry cannot inflate rating');

  const noTail=result('attempt-notail-0004',10,0,true,['NoTail']);
  const ping=api.ping.bind(api); api.scoreVersion=0; api.ratingVersion=3;
  api.ping=async()=>true;
  sync.submit(noTail); await sync.sync();
  assert.equal(sync.status(noTail).state,'update-required'); assert.equal(sync.pendingCount,1);
  assert.equal(app.serverOnline,true); assert.equal(store.getToken(),auth.token,'compatibility gate keeps the existing connection');
  api.ping=ping; await ping(); await sync.sync();
  assert.equal(sync.pendingCount,0); assert.equal((await api.chartStats(entry.id,4)).attempts,4);

  // Failure screen records once before a retry/quit, while retaining its UI.
  app.screen={name:'play'};
  const screen=new PlayScreen(app); let built=0;
  const screenFailure=result('attempt-ui-fail-0005',3,0,false);
  screen.sess={phase:'failed',update(){},buildResult(){built++;return screenFailure;}};
  screen.update(16,1); screen.update(16,2);
  assert.equal(built,1,'failure UI records once, not on every frame');
  assert.equal(screen.sess.phase,'failed','failure statistics do not force an early result transition');
  const stored=JSON.parse(memory.get('nf.score-sync.v1'));
  assert.ok(stored.pending.some(item=>item.result.playId===screenFailure.playId));
  console.log('PASS all-attempt durable sync, failures, replay idempotence, old-server queue/connection compatibility and failure-screen capture');
} finally {
  sync?.stop(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
}
