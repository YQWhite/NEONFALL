import assert from 'node:assert/strict';
import http from 'node:http';
import { ServerApi } from '../src/api/client.ts';

const defer = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const payload = new Uint8Array([80, 75, 3, 4, 17, 25, 33]);
const calls = new Map(), gates = new Map();
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const id = decodeURIComponent(path.slice('/api/charts/'.length));
  calls.set(id, (calls.get(id) || 0) + 1);
  if (gates.has(id)) await gates.get(id).promise;
  if (id === 'retry-network' && calls.get(id) === 1) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Try again' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(payload);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function fixture() {
  const stored = new Map(), writes = [], reads = [];
  let failWrite = false, failRead = false, writeGate = null;
  const cache = {
    async getChartBytes(id) {
      reads.push(id);
      if (failRead) throw new Error('Temporary read failure');
      return stored.get(id) ?? null;
    },
    async putChart(bytes, name) {
      writes.push(name);
      if (writeGate) { writeGate.started.resolve(); await writeGate.release.promise; }
      if (failWrite) throw new Error('Storage quota');
      stored.set(name.slice(0, -4), bytes);
    },
    async deleteChart(id) { stored.delete(id); },
  };
  return {
    api: new ServerApi(base, cache), cache, stored, writes, reads,
    set failWrite(value) { failWrite = value; },
    set failRead(value) { failRead = value; },
    set writeGate(value) { writeGate = value; },
  };
}

let groups = 0;
function pass(message) { groups++; console.log('PASS ' + message); }
try {
  {
    const f = fixture();
    const values = await Promise.all(Array.from({ length: 8 }, () => f.api.downloadChart('preview', { persist: false })));
    values.forEach(value => assert.deepEqual(value, payload));
    assert.equal(calls.get('preview'), 1);
    assert.equal(f.writes.length, 0, 'preview must never encode/store the whole archive');
    const reads = f.reads.length;
    assert.strictEqual(await f.api.downloadChart('preview', { persist: false }), values[0]);
    assert.equal(f.reads.length, reads, 'warm preview uses bytes directly without disk work');
    assert.equal(f.api.downloads.size, 0);
    assert.equal(f.api.chartWrites.size, 0);
    pass('parallel previews share a transfer and warm previews do no persistence work');

    await Promise.all(Array.from({ length: 8 }, () => f.api.downloadChart('preview')));
    assert.equal(calls.get('preview'), 1, 'explicit download must reuse preview memory');
    assert.equal(f.writes.length, 1, 'preview cache hit must be persisted once');
    assert.deepEqual(f.stored.get('preview'), payload);
    await f.api.downloadChart('preview', { persist: true });
    assert.equal(f.writes.length, 1, 'a confirmed local copy is not rewritten');
    pass('default and explicit persist:true upgrade preview cache to one offline copy');

    await f.cache.deleteChart('preview');
    await f.api.downloadChart('preview', { persist: false });
    assert.equal(f.writes.length, 1, 'preview must respect local removal');
    await f.api.downloadChart('preview');
    assert.equal(f.writes.length, 2, 'deleting a local copy must not leave stale persistence flags');
    assert.equal(calls.get('preview'), 1);
    pass('a later explicit download restores a deleted local copy without another transfer');
  }

  for (const defaultFirst of [false, true]) {
    const f = fixture(), id = 'mixed-' + defaultFirst;
    const transfer = defer(); gates.set(id, transfer);
    const writeGate = { started: defer(), release: defer() }; f.writeGate = writeGate;
    let preview, download, downloadDone = false;
    if (defaultFirst) {
      download = f.api.downloadChart(id);
      preview = f.api.downloadChart(id, { persist: false });
    } else {
      preview = f.api.downloadChart(id, { persist: false });
      download = f.api.downloadChart(id);
    }
    const moreDownloads = Array.from({ length: 4 }, () => f.api.downloadChart(id));
    download.then(() => { downloadDone = true; });
    transfer.resolve();
    await writeGate.started.promise;
    assert.deepEqual(await preview, payload, 'preview must not wait for unrelated disk persistence');
    assert.equal(downloadDone, false, 'default request waits for its offline write');
    assert.equal(f.writes.length, 1);
    assert.equal(calls.get(id), 1);
    writeGate.release.resolve();
    await Promise.all([download, ...moreDownloads]);
    assert.deepEqual(f.stored.get(id), payload);
    assert.equal(f.api.chartWrites.size, 0);
    pass(`mixed preview/default requests share network and disk work (default first: ${defaultFirst})`);
  }

  {
    const f = fixture();
    f.stored.set('already-local', payload);
    assert.deepEqual(await f.api.downloadChart('already-local', { persist: false }), payload);
    await f.api.downloadChart('already-local');
    assert.equal(calls.has('already-local'), false);
    assert.equal(f.writes.length, 0);
    const fresh = new ServerApi(base, f.cache);
    await fresh.downloadChart('already-local');
    assert.equal(f.writes.length, 0);
    pass('existing offline files serve previews and gameplay without fetches or rewriting');
  }

  {
    const f = fixture(); f.failWrite = true;
    assert.deepEqual(await f.api.downloadChart('retry-storage'), payload, 'storage failure must preserve playback');
    assert.equal(f.writes.length, 1);
    assert.equal(f.api.chartWrites.size, 0, 'failed writes are not permanently cached');
    f.failWrite = false;
    await f.api.downloadChart('retry-storage');
    assert.equal(f.writes.length, 2);
    assert.equal(calls.get('retry-storage'), 1);
    assert.deepEqual(f.stored.get('retry-storage'), payload);
    pass('quota/filesystem failures remain nonfatal and the next request retries persistence');
  }

  {
    const f = fixture(); f.failRead = true;
    assert.deepEqual(await f.api.downloadChart('read-error', { persist: false }), payload);
    assert.equal(f.writes.length, 0);
    await f.api.downloadChart('read-error');
    assert.equal(f.writes.length, 1);
    assert.equal(calls.get('read-error'), 1);
    pass('local read errors fall back to network/memory without disabling explicit persistence');
  }

  {
    const f = fixture();
    await assert.rejects(f.api.downloadChart('retry-network', { persist: false }), /Try again/);
    assert.equal(f.api.downloads.size, 0);
    assert.equal(f.writes.length, 0);
    await f.api.downloadChart('retry-network');
    assert.equal(calls.get('retry-network'), 2);
    assert.equal(f.writes.length, 1);
    pass('failed network transfers are removed and can be retried with persistence');
  }

  {
    const api = new ServerApi(base);
    assert.deepEqual(await api.downloadChart('no-store', { persist: false }), payload);
    assert.deepEqual(await api.downloadChart('no-store'), payload);
    assert.equal(calls.get('no-store'), 1);
    pass('clients without a persistent store keep their existing memory-only behavior');
  }

  {
    // Exercise the byte budget without sending 100+ MB over the local socket.
    const f = fixture(), transfers = new Map();
    f.api.request = async path => {
      const id = path.slice('/api/charts/'.length);
      transfers.set(id, (transfers.get(id) || 0) + 1);
      return new Uint8Array((id === 'oversized' ? 65 : 24) * 1024 * 1024);
    };
    await f.api.downloadChart('a', { persist: false });
    await f.api.downloadChart('b', { persist: false });
    await f.api.downloadChart('a', { persist: false });
    await f.api.downloadChart('c', { persist: false });
    assert.deepEqual([...f.api.chartBytes.keys()], ['a', 'c'], 'recently used preview survives eviction');
    assert.equal(f.api.cacheSize, 48 * 1024 * 1024);
    await f.api.downloadChart('b', { persist: false });
    assert.equal(transfers.get('b'), 2);
    await f.api.downloadChart('oversized', { persist: false });
    await f.api.downloadChart('oversized', { persist: false });
    assert.equal(transfers.get('oversized'), 2, 'oversized archives must not remain in memory');
    assert.equal(f.api.chartBytes.has('oversized'), false);
    assert.ok(f.api.cacheSize <= 64 * 1024 * 1024);
    assert.equal(f.writes.length, 0);
    pass('preview LRU retains the 64 MiB byte bound, recent-use order and oversized exclusion');
  }

  {
    const f = fixture(); f.api.request = async () => new Uint8Array(0);
    for (let i = 0; i < 60; i++) await f.api.downloadChart('empty-' + i, { persist: false });
    assert.equal(f.api.chartBytes.size, 24, 'even zero-byte responses must have bounded bookkeeping');
    assert.equal(f.api.cacheSize, 0);
    assert.equal(f.api.downloads.size, 0);
    assert.equal(f.api.chartWrites.size, 0);
    pass('entry-count bound prevents empty/tiny preview responses from growing the LRU forever');
  }
} finally {
  for (const gate of gates.values()) gate.resolve();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(`PASS preview download persistence: ${groups} groups`);
