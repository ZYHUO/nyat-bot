import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { OneBotClient } from '../../../src/platform/onebot-client.js';

interface Request { action: string; echo: string; params: Record<string, unknown>; }
const clients: OneBotClient[] = [];
const servers: WebSocketServer[] = [];
async function setup(data: unknown, retcode = 0, sendReply = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(server);
  const requests: Request[] = [];
  server.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw.toString()) as Request; requests.push(request);
    if (request.action !== 'get_login_info' && !sendReply) return;
    socket.send(JSON.stringify({ echo: request.echo, status: retcode && request.action !== 'get_login_info' ? 'failed' : 'ok',
      retcode: request.action === 'get_login_info' ? 0 : retcode,
      data: request.action === 'get_login_info' ? { user_id: 42 } : data }));
  }));
  await once(server, 'listening');
  const client = new OneBotClient({ endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`, accountId: '42',
    accessToken: 'synthetic-directory-token', onMessage: () => {},
    limits: { requestTimeoutMs: 300, connectTimeoutMs: 1000, heartbeatIntervalMs: 30000, maxReconnectAttempts: 0 } });
  clients.push(client); await client.start(); return { client, requests };
}
afterEach(async () => {
  clients.splice(0).forEach(client => client.stop());
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('OneBot authenticated group directory over a real loopback socket', () => {
  it('returns only validated metadata after self identity authentication', async () => {
    const { client, requests } = await setup([{ group_id: 123, group_name: '合成群', member_count: 4, secret_extra: 'not returned' }]);
    expect(await client.getGroupList({ accountId: '42' })).toEqual([{ groupId: '123', title: '合成群' }]);
    expect(requests.map(request => request.action)).toEqual(['get_login_info', 'get_group_list']);
    expect(requests[1]?.params).toEqual({});
  });

  it('rejects another account before making a request', async () => {
    const { client, requests } = await setup([]);
    await expect(client.getGroupList({ accountId: '43' })).rejects.toMatchObject({ code: 'wrong_account' });
    expect(requests).toHaveLength(1);
  });

  it.each([null, {}, [{ group_id: 0, group_name: 'bad' }], [{ group_id: 123, group_name: '' }],
    [{ group_id: 123, group_name: 'same' }, { group_id: 123, group_name: 'same' }],
    [{ group_id: '9007199254740993', group_name: 'unsafe' }]])('rejects malformed successful receipts instead of treating them as an empty directory: %j', async data => {
    const { client } = await setup(data);
    await expect(client.getGroupList({ accountId: '42' })).rejects.toMatchObject({ code: 'invalid_group_list_receipt' });
  });

  it('accepts a verified empty snapshot, but failed API calls stay errors', async () => {
    const ok = await setup([]);
    expect(await ok.client.getGroupList({ accountId: '42' })).toEqual([]);
    const bad = await setup([], 100);
    await expect(bad.client.getGroupList({ accountId: '42' })).rejects.toMatchObject({ code: 'api_rejected', delivery: 'not_sent' });
  });

  it('does not retry a timeout or return an invented empty snapshot', async () => {
    const { client, requests } = await setup([], 0, false);
    await expect(client.getGroupList({ accountId: '42' })).rejects.toMatchObject({ code: 'request_timeout', delivery: 'not_sent' });
    expect(requests.filter(request => request.action === 'get_group_list')).toHaveLength(1);
    client.stop();
    await expect(client.getGroupList({ accountId: '42' })).rejects.toMatchObject({ code: 'not_ready' });
  });
});
