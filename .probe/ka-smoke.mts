// Probe 0: can we import the client + what is Qdrant's server-side keep-alive?
import { createConnection } from 'node:net';

// --- raw socket: send one request, then measure idle time until server FIN ---
await new Promise<void>((resolve) => {
  const sock = createConnection({ host: '127.0.0.1', port: 6333 }, () => {
    sock.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
  });
  const t0 = Date.now();
  let gotHeaders = false;
  let chunkTimes: number[] = [];
  sock.on('data', (b) => {
    if (!gotHeaders) {
      gotHeaders = true;
      console.log(`[ka] response headers after ${Date.now() - t0}ms; now idling to measure server FIN...`);
    }
    chunkTimes.push(Date.now() - t0);
  });
  sock.on('end', () => {
    console.log(`[ka] server FIN (end) at ${Date.now() - t0}ms after connect`);
    resolve();
  });
  sock.on('close', () => {
    if (!gotHeaders) console.log(`[ka] server closed before responding at ${Date.now() - t0}ms`);
    resolve();
  });
  sock.on('error', (e) => { console.log('[ka] socket error', e.message); resolve(); });
  // hard cap so we never hang: 20s
  setTimeout(() => { console.log(`[ka] NO FIN within 20s — server keep-alive > 20s (idle socket still open). data chunks at ms=${JSON.stringify(chunkTimes)}`); sock.destroy(); resolve(); }, 20000);
});

// --- smoke: import client construction exactly like production ---
const { QdrantClient } = await import('@qdrant/js-client-rest');
const c = new QdrantClient({ host: '127.0.0.1', port: 6333, https: false });
const cols = await c.getCollections();
console.log('[qclient] collections:', cols.collections.map((x) => x.name).join(', '));
console.log('[qclient] import OK');
