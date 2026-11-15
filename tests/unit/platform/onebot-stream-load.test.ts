import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OneBotClient } from '../../../src/platform/onebot-client.js';
import { downloadOneBotFile } from '../../../src/platform/onebot-media-stream.js';

const clients: OneBotClient[] = []; const servers: WebSocketServer[] = [];
interface Request { action: string; echo: string; params: Record<string, unknown>; }
function reply(socket: WebSocket, echo: string, data: unknown) {
  socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }));
}
async function setup(onRequest: (socket: WebSocket, request: Request) => void, options: { requestTimeoutMs?: number; maxFramesPerSecond?: number } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(server);
  server.on('connection', socket => {
    socket.on('error', () => {});
    socket.on('message', data => {
      const request = JSON.parse(data.toString()) as Request;
      if (request.action === 'get_login_info') reply(socket, request.echo, { user_id: 42 });
      else onRequest(socket, request);
    });
  });
  await once(server, 'listening');
  const diagnostic = vi.fn();
  const client = new OneBotClient({ endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    accessToken: 'test-only', accountId: '42', mediaEnabled: true, onMessage: () => {}, onDiagnostic: diagnostic,
    limits: { maxReconnectAttempts: 0, requestTimeoutMs: 2000, heartbeatIntervalMs: 10000, ...options } });
  clients.push(client); await client.start();
  return { client, diagnostic };
}
afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
});

describe('OneBot streaming load is bounded independently of chat events', () => {
  it('accepts >120 valid streamed chunks through real WebSockets and the actual collector', async () => {
    const bytes = Buffer.alloc(256, 3); const data = bytes.toString('base64');
    const { client, diagnostic } = await setup((socket, request) => {
      reply(socket, request.echo, { type: 'stream', data_type: 'file_info', file_name: 'test.bin', file_size: 256 * 256, chunk_size: 256 });
      for (let index = 0; index < 256; index++) reply(socket, request.echo, { type: 'stream', data_type: 'file_chunk', index,
        data, size: 256, base64_size: data.length });
      reply(socket, request.echo, { type: 'response', data_type: 'file_complete', total_chunks: 256, total_bytes: 256 * 256 });
    });
    const result = await downloadOneBotFile('test.bin', 'file', client.mediaTransport());
    expect(result.bytes).toEqual(Buffer.alloc(256 * 256, 3));
    expect(client.snapshot()).toMatchObject({ state: 'ready', pendingRequests: 0 });
    expect(diagnostic).not.toHaveBeenCalledWith('inbound_rate_limit');
  });
  it('keeps unknown echoes under the ordinary event limit even while a stream is pending', async () => {
    const { client, diagnostic } = await setup((socket) => {
      for (let i = 0; i < 8; i++) reply(socket, `unmatched:${i}`, { type: 'stream', data_type: 'file_chunk' });
    }, { maxFramesPerSecond: 5 });
    await expect(client.mediaTransport().streamAction('download_file_stream', { file_id: 'test' }, {
      onFrame: () => false, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'request_aborted' });
    expect(diagnostic).toHaveBeenCalledWith('inbound_rate_limit');
  });
  it('bounds a matched echo that never produces a terminating frame', async () => {
    const { client, diagnostic } = await setup((socket, request) => {
      for (let i = 0; i < 2050; i++) reply(socket, request.echo, { type: 'stream', data_type: 'file_chunk' });
    });
    const onFrame = vi.fn(() => false);
    await expect(client.mediaTransport().streamAction('download_file_stream', { file_id: 'test' }, {
      onFrame, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'request_aborted' });
    expect(onFrame).toHaveBeenCalledTimes(2048); expect(diagnostic).toHaveBeenCalledWith('media_stream_limit');
  });
  it('enforces the total frame bound even when frames stay below the rolling rate', async () => {
    const { client, diagnostic } = await setup((socket, request) => {
      let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now += 2);
      for (let i = 0; i < 4100; i++) reply(socket, request.echo, { type: 'stream', data_type: 'file_chunk' });
    });
    const onFrame = vi.fn(() => false);
    await expect(client.mediaTransport().streamAction('download_file_stream', { file_id: 'test' }, {
      onFrame, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'request_aborted' });
    expect(onFrame).toHaveBeenCalledTimes(4098);
    expect(diagnostic).toHaveBeenCalledWith('media_stream_limit');
  });
  it('keeps an absolute request deadline despite ongoing valid matched frames', async () => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const { client } = await setup((socket, request) => {
      interval = setInterval(() => { if (socket.readyState === WebSocket.OPEN) reply(socket, request.echo, { type: 'stream' }); }, 5);
    }, { requestTimeoutMs: 60 });
    try {
      await expect(client.mediaTransport().streamAction('download_file_stream', { file_id: 'test' }, {
        onFrame: () => false, signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'request_timeout' });
      expect(client.snapshot().pendingRequests).toBe(0);
    } finally { clearInterval(interval); }
  });
});
