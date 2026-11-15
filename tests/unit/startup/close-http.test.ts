import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { closeHttpServer } from '../../../src/startup/close-http.js';
describe('HTTP shutdown joins live ingress requests', () => {
  it('keeps the drain pending until an accepted request finishes', async () => {
    let finish!: () => void; let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const server = createServer((_request, response) => { finish = () => response.end('accepted'); started(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const received = new Promise<void>((resolve, reject) => {
      get(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { agent: false }, (response) => {
        response.resume(); response.on('end', resolve);
      }).on('error', reject);
    });
    try {
      await entered; let closed = false;
      const draining = closeHttpServer(server).then(() => { closed = true; });
      await new Promise<void>((resolve) => setImmediate(resolve)); expect(closed).toBe(false);
      finish(); await received; await draining; expect(closed).toBe(true);
    } finally { server.closeAllConnections(); server.close(); }
  });
});
