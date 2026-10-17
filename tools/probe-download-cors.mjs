// Read-only diagnostic for a public NEONFALL endpoint. Never sends credentials.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ServerApi, normalizeServerUrl } from '../src/api/client.ts';
const base = normalizeServerUrl(process.argv[2] || '');
if (!base) throw new Error('Usage: node --experimental-transform-types tools/probe-download-cors.mjs https://server.example');
const fetchNetwork = globalThis.fetch, responses = [];
const list = await (await fetchNetwork(base + '/api/charts')).json();
if (!Array.isArray(list) || !list.length) throw new Error('No public charts to probe');
const entry = process.argv[3] ? list.find(item => item.id === process.argv[3]) : [...list].sort((a, b) => a.size - b.size)[0];
if (!entry) throw new Error('Requested chart is not in the public catalogue');
const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
const report = { server: base, chart: entry.id, chartBytes: entry.size, catalogCount: list.length, testedAt: new Date().toISOString(), probes: responses, boundary: 'Actual public HTTP/TLS responses with browser CORS checks emulated; no GUI and no authenticated requests or remote changes.' };
try {
  for (const origin of ['neonfall://index.html', 'https://localhost']) {
    const bare = await fetchNetwork(base + '/api/charts/' + entry.id, { method: 'HEAD', headers: { Origin: origin } });
    responses.push({ kind: 'old-bare-url', origin, status: bare.status, allowOrigin: bare.headers.get('access-control-allow-origin'), vary: bare.headers.get('vary') });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
    globalThis.fetch = async (url, options = {}) => {
      const headers = new Headers(options.headers); headers.set('Origin', origin);
      const response = await fetchNetwork(url, { ...options, headers });
      const allowOrigin = response.headers.get('access-control-allow-origin');
      responses.push({ kind: 'current-client', origin, status: response.status, allowOrigin, vary: response.headers.get('vary'), cacheKey: new URL(url).search });
      if (!['*', origin].includes(allowOrigin)) throw new TypeError('Browser would reject response due to missing/mismatched CORS');
      return response;
    };
    const bytes = await new ServerApi(base).downloadChart(entry.id), sha1 = createHash('sha1').update(bytes).digest('hex');
    if (sha1 !== entry.id) throw new Error('Downloaded bytes do not match content hash');
    Object.assign(responses.at(-1), { receivedBytes: bytes.length, sha1, integrity: true });
  }
  const directory = path.resolve('test-results/transport-avatar'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'public-download-probe.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.fetch = fetchNetwork;
  if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor); else delete globalThis.location;
}
