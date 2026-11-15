import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OneBotClient } from '../../../src/platform/onebot-client.js';
import type { NormalizedMessage } from '../../../src/platform/types.js';

const clients: OneBotClient[] = []; const servers: WebSocketServer[] = [];
const notice = { post_type: 'notice', notice_type: 'group_upload', self_id: 42, group_id: 123, user_id: 99,
  time: 1730000002, file: { id: '0123456789abcdef0123456789abcdef', name: 'same.txt', size: 10, busid: 102 } };
function message(id: number, segments = [{ type: 'file', data: { file: 'same.txt', file_id: 'file-uuid', file_size: '10' } }], privateChat = false) {
  return { post_type: 'message', self_id: 42, message_type: privateChat ? 'private' : 'group', group_id: privateChat ? undefined : 123,
    user_id: 99, message_id: id, time: 1730000000, message: segments };
}
async function setup(groupFileSource?: 'message' | 'notice') {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(server);
  let socket: WebSocket | undefined;
  server.on('connection', connected => {
    socket = connected; connected.on('error', () => {});
    connected.on('message', data => {
      const request = JSON.parse(data.toString());
      connected.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { user_id: 42 } }));
    });
  });
  await once(server, 'listening');
  const received: NormalizedMessage[] = [];
  const client = new OneBotClient({ endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    accessToken: 'test-only', accountId: '42', mediaEnabled: true, groupFileSource,
    onMessage: value => { received.push(value); }, limits: { maxReconnectAttempts: 0, heartbeatIntervalMs: 10000 } });
  clients.push(client); await client.start();
  return { received, send: (value: unknown) => socket!.send(JSON.stringify(value)) };
}
afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('authoritative OneBot group-file source', () => {
  it.each([undefined, 'message'] as const)('keeps the actual message ID in %s mode despite different notice MD5/time', async mode => {
    const local = await setup(mode); local.send(notice); local.send(message(1));
    local.send(message(2, [{ type: 'text', data: { text: 'marker' } }] as never));
    await vi.waitFor(() => expect(local.received).toHaveLength(2));
    expect(local.received[0]?.ref.id).toBe('1');
    expect(local.received[0]?.segments[0]).toMatchObject({ type: 'file', assetRef: 'file-uuid' });
    expect(local.received[1]?.ref.id).toBe('2');
  });
  it('takes only the notice in notice mode while retaining accompanying normal text', async () => {
    const local = await setup('notice'); local.send(message(1)); local.send(notice);
    local.send(message(2, [{ type: 'file', data: { file: 'same.txt', file_id: 'file-uuid' } },
      { type: 'text', data: { text: 'marker' } }] as never));
    await vi.waitFor(() => expect(local.received).toHaveLength(2));
    expect(local.received[0]?.ref.id).toMatch(/^file:/);
    expect(local.received[1]?.segments).toEqual([{ type: 'text', text: 'marker' }]);
  });
  it('does not suppress private file messages when group notice mode is selected', async () => {
    const local = await setup('notice'); local.send(message(1, undefined, true));
    await vi.waitFor(() => expect(local.received).toHaveLength(1));
    expect(local.received[0]?.ref.conversation.conversationKind).toBe('private');
    expect(local.received[0]?.segments[0]?.type).toBe('file');
  });
  it('does not merge distinct native uploads with identical filename, size and timestamp', async () => {
    const local = await setup(); local.send(message(1)); local.send(message(2));
    await vi.waitFor(() => expect(local.received).toHaveLength(2));
    expect(local.received.map(value => value.ref.id)).toEqual(['1', '2']);
  });
});
