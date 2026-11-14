import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { OneBotClient } from '../../../src/platform/onebot-client.js';
import type { OneBotClientOptions } from '../../../src/platform/onebot-client.js';
import type { ConversationRef } from '../../../src/platform/types.js';
import { downloadOneBotFile } from '../../../src/platform/onebot-media-stream.js';

interface Request { action: string; echo: string; params: Record<string, unknown>; }
const clients: OneBotClient[] = [];
const servers: WebSocketServer[] = [];
const conversation: ConversationRef = { platform: 'qq', accountId: '42', idNamespace: 'qq-number', conversationKind: 'group', id: '123' };
function reply(socket: WebSocket, request: Request, data: unknown, extra: Record<string, unknown> = {}): void {
  socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data, ...extra }));
}
async function server(onRequest: (socket: WebSocket, request: Request) => void = () => {}, autoLogin = true) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(wss);
  const sockets: WebSocket[] = []; const requests: Request[] = [];
  wss.on('connection', socket => {
    sockets.push(socket); socket.on('error', () => {});
    socket.on('message', data => {
      const request = JSON.parse(data.toString()) as Request; requests.push(request);
      if (request.action === 'get_login_info' && autoLogin) reply(socket, request, { user_id: 42 });
      else onRequest(socket, request);
    });
  });
  await once(wss, 'listening');
  return { sockets, requests, endpoint: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/` };
}
function client(endpoint: string, options: Partial<OneBotClientOptions> = {}): OneBotClient {
  const instance = new OneBotClient({ endpoint, accessToken: 'synthetic-token', accountId: '42', onMessage: () => {},
    mediaEnabled: true, ...options, limits: { requestTimeoutMs: 400, connectTimeoutMs: 1000,
      heartbeatIntervalMs: 30_000, maxReconnectAttempts: 0, reconnectBaseMs: 10, reconnectMaxMs: 20, ...options.limits } });
  clients.push(instance); return instance;
}
function requestEvent(flag: string, extra: Record<string, unknown> = {}) {
  return { post_type: 'request', self_id: 42, request_type: 'friend', user_id: 99, flag, comment: '合成申请', time: 1_794_657_600, ...extra };
}
function messageEvent(id: number) {
  return { post_type: 'message', self_id: 42, message_type: 'group', group_id: 123,
    user_id: 99, message_id: id, time: 1_794_657_600, message: [{ type: 'text', data: { text: '合成消息' } }] };
}
function info(fileSize = 6) { return { type: 'stream', data_type: 'file_info', file_size: fileSize, chunk_size: 3, file_name: 'fixture.txt' }; }
function chunk(index: number, text: string) {
  const bytes = Buffer.from(text); const data = bytes.toString('base64');
  return { type: 'stream', data_type: 'file_chunk', index, data, size: bytes.length, base64_size: data.length };
}
function complete() { return { type: 'response', data_type: 'file_complete', total_chunks: 2, total_bytes: 6 }; }
function acknowledgeUpload(socket: WebSocket, request: Request, uploads: Map<string, Record<string, unknown>>): void {
  const p = request.params; const stream = String(p['stream_id']);
  if (p['is_complete']) {
    const previous = uploads.get(stream)!;
    reply(socket, request, { type: 'response', status: 'file_complete', stream_id: stream,
      received_chunks: previous['total_chunks'], total_chunks: previous['total_chunks'], file_size: previous['file_size'],
      sha256: previous['expected_sha256'], file_path: `/tmp/napcat/${previous['filename']}` });
  } else {
    uploads.set(stream, p);
    reply(socket, request, { type: 'stream', status: 'chunk_received', stream_id: stream,
      received_chunks: Number(p['chunk_index']) + 1, total_chunks: p['total_chunks'] });
  }
}
afterEach(async () => {
  for (const instance of clients.splice(0)) instance.stop();
  for (const wss of servers.splice(0)) {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  }
});

describe('authenticated request events and confirmed decisions', () => {
  it('accepts a display name only after the login account matches', async () => {
    const identities = vi.fn();
    const endpoint = await server((socket, request) => {
      if (request.action === 'get_login_info') reply(socket, request, { user_id: 42, nickname: ' craftol ' });
    }, false);
    await client(endpoint.endpoint, { onIdentity: identities }).start();
    expect(identities).toHaveBeenCalledWith({ accountId: '42', displayName: 'craftol' });
    const wrong = await server((socket, request) => {
      if (request.action === 'get_login_info') reply(socket, request, { user_id: 43, nickname: 'stranger' });
    }, false);
    await expect(client(wrong.endpoint, { onIdentity: identities }).start()).rejects.toThrow();
    expect(identities).toHaveBeenCalledTimes(1);
  });

  it('does not expose requests before login, then rejects a foreign self_id', async () => {
    const local = await server(() => {}, false); const requests = vi.fn(); const diagnostics = vi.fn();
    const instance = client(local.endpoint, { onRequest: requests, onDiagnostic: diagnostics });
    const started = instance.start();
    await vi.waitFor(() => expect(local.requests).toHaveLength(1));
    local.sockets[0]!.send(JSON.stringify(requestEvent('private-flag')));
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith('event_before_identity'));
    expect(requests).not.toHaveBeenCalled();
    reply(local.sockets[0]!, local.requests[0]!, { user_id: 42 }); await started;
    local.sockets[0]!.send(JSON.stringify(requestEvent('valid-flag')));
    await vi.waitFor(() => expect(requests).toHaveBeenCalledOnce());
    expect(requests.mock.calls[0]![0]).toMatchObject({ accountId: '42', kind: 'friend', flag: 'valid-flag' });
    local.sockets[0]!.send(JSON.stringify(requestEvent('foreign-secret', { self_id: 43 })));
    await vi.waitFor(() => expect(instance.snapshot().state).toBe('failed'));
    expect(requests).toHaveBeenCalledOnce(); expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret');
  });

  it('serializes request and chat handlers through the same bounded queue', async () => {
    const local = await server(); const order: string[] = []; const diagnostics = vi.fn();
    let unblock!: () => void; const held = new Promise<void>(resolve => { unblock = resolve; });
    const instance = client(local.endpoint, { limits: { maxQueuedMessages: 1 }, onDiagnostic: diagnostics,
      onRequest: async request => { order.push(`request:${request.flag}`); await held; },
      onMessage: async message => { order.push(`message:${message.ref.id}`); } });
    await instance.start(); local.sockets[0]!.send(JSON.stringify(requestEvent('first')));
    await vi.waitFor(() => expect(order).toEqual(['request:first']));
    local.sockets[0]!.send(JSON.stringify(messageEvent(1)));
    local.sockets[0]!.send(JSON.stringify(requestEvent('overflow-secret')));
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith('message_queue_limit'));
    expect(instance.snapshot().queuedMessages).toBe(1); expect(order).toHaveLength(1);
    unblock(); await vi.waitFor(() => expect(order).toEqual(['request:first', 'message:1']));
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('overflow-secret');
  });

  it('confirms friend approval and group rejection without treating a mismatched account as authorized', async () => {
    const local = await server((socket, request) => reply(socket, request, null)); const instance = client(local.endpoint);
    await instance.start();
    await instance.setFriendAddRequest({ accountId: '42', flag: 'friend-test', approve: true, remark: '合成备注' });
    await instance.setGroupAddRequest({ accountId: '42', flag: 'group-test', subType: 'invite', approve: false, reason: '合成拒绝' });
    expect(local.requests.slice(1).map(request => [request.action, request.params])).toEqual([
      ['set_friend_add_request', { flag: 'friend-test', approve: true, remark: '合成备注' }],
      ['set_group_add_request', { flag: 'group-test', sub_type: 'invite', approve: false, reason: '合成拒绝' }],
    ]);
    await expect(instance.setFriendAddRequest({ accountId: '43', flag: 'x', approve: true })).rejects.toMatchObject({ code: 'wrong_account', delivery: 'not_sent' });
    expect(local.requests).toHaveLength(3);
  });

  it('leaves a disconnected approval unknown and never replays it on reconnect', async () => {
    const local = await server((socket, request) => { if (request.action === 'set_friend_add_request') socket.terminate(); });
    const instance = client(local.endpoint, { limits: { maxReconnectAttempts: 1 } }); await instance.start();
    await expect(instance.setFriendAddRequest({ accountId: '42', flag: 'opaque-test', approve: true }))
      .rejects.toMatchObject({ delivery: 'unknown' });
    await vi.waitFor(() => expect(local.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(instance.snapshot().state).toBe('ready'));
    expect(local.requests.filter(request => request.action === 'set_friend_add_request')).toHaveLength(1);
  });

  it.each([false, true])('validates member identity in permission receipts (matching=%s)', async matching => {
    const local = await server((socket, request) => reply(socket, request, { group_id: 123, user_id: matching ? 99 : 88, role: 'admin' }));
    const instance = client(local.endpoint); await instance.start();
    const result = instance.getGroupMemberInfo({ accountId: '42', groupId: '123', userId: '99' });
    if (matching) await expect(result).resolves.toEqual({ role: 'admin' });
    else await expect(result).rejects.toMatchObject({ code: 'invalid_member_receipt' });
  });
});

describe('real multi-frame media transport', () => {
  it.each([true, false])('routes opt-in group-upload notices only when media is enabled (%s)', async mediaEnabled => {
    const local = await server(); const messages = vi.fn();
    const instance = client(local.endpoint, { mediaEnabled, groupFileSource: 'notice', onMessage: messages });
    await instance.start();
    local.sockets[0]!.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_upload', self_id: 42,
      group_id: 123, user_id: 99, time: 1_794_657_600, file: { id: 'asset-test', name: 'fixture.txt', size: 6 } }));
    if (!mediaEnabled) {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(messages).not.toHaveBeenCalled();
      expect(local.requests).toHaveLength(1);
      return;
    }
    await vi.waitFor(() => expect(messages).toHaveBeenCalledOnce());
    expect(messages.mock.calls[0]![0].ref).toEqual({ conversation, id: expect.stringMatching(/^file:[0-9a-f]{64}$/) });
    expect(messages.mock.calls[0]![0].segments).toEqual([{ type: 'file', assetRef: 'asset-test', fileName: 'fixture.txt', fileSize: 6 }]);
  });

  it('waits for all same-echo chunks and explicit completion, ignoring an unrelated echo', async () => {
    const local = await server(); const instance = client(local.endpoint); await instance.start();
    const result = downloadOneBotFile('asset-test', 'file', instance.mediaTransport());
    let settled = false; void result.then(() => { settled = true; });
    await vi.waitFor(() => expect(local.requests).toHaveLength(2));
    const request = local.requests[1]!; const socket = local.sockets[0]!;
    reply(socket, request, info()); reply(socket, request, chunk(0, 'abc'));
    reply(socket, { ...request, echo: 'unrelated' }, complete());
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(settled).toBe(false); expect(instance.snapshot().pendingRequests).toBe(1);
    reply(socket, request, chunk(1, 'def')); reply(socket, request, complete());
    await expect(result).resolves.toEqual({ bytes: Buffer.from('abcdef'), fileName: 'fixture.txt' });
    expect(instance.snapshot().pendingRequests).toBe(0);
  });

  it('rejects reordered chunks without returning partial bytes', async () => {
    const local = await server((socket, request) => { reply(socket, request, info()); reply(socket, request, chunk(1, 'abc')); });
    const instance = client(local.endpoint); await instance.start();
    await expect(downloadOneBotFile('asset-test', 'file', instance.mediaTransport()))
      .rejects.toMatchObject({ code: 'invalid_media_stream' });
    expect(instance.snapshot().pendingRequests).toBe(0);
  });

  it('aborts an incomplete download on disconnect, with no replay and no reusable old transport', async () => {
    const local = await server((socket, request) => { reply(socket, request, info()); reply(socket, request, chunk(0, 'abc')); socket.terminate(); });
    const instance = client(local.endpoint, { limits: { maxReconnectAttempts: 1 } }); await instance.start();
    const oldTransport = instance.mediaTransport();
    await expect(downloadOneBotFile('asset-test', 'file', oldTransport)).rejects.toMatchObject({ delivery: 'not_sent' });
    await vi.waitFor(() => expect(local.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(instance.snapshot().state).toBe('ready'));
    await expect(downloadOneBotFile('asset-new', 'file', oldTransport)).rejects.toMatchObject({ code: 'request_aborted' });
    expect(local.requests.filter(request => request.action === 'download_file_stream')).toHaveLength(1);
    expect(instance.snapshot().pendingRequests).toBe(0);
  });

  it('cancels pending download state and rejects unapproved actions', async () => {
    const local = await server(); const instance = client(local.endpoint); await instance.start();
    const controller = new AbortController(); const transport = instance.mediaTransport();
    const download = downloadOneBotFile('asset-test', 'file', transport, { signal: controller.signal });
    const rejected = expect(download).rejects.toMatchObject({ code: 'qq_media_aborted' });
    await vi.waitFor(() => expect(instance.snapshot().pendingRequests).toBe(1));
    controller.abort(); await rejected;
    expect(instance.snapshot().pendingRequests).toBe(0);
    await expect(transport.request('send_group_msg', {}, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'unsupported_media_action' });
    expect(local.requests.filter(request => request.action === 'send_group_msg')).toHaveLength(0);
  });

  it('uploads verified chunks before sending media and requires a final message receipt', async () => {
    const uploads = new Map<string, Record<string, unknown>>();
    const local = await server((socket, request) => request.action === 'upload_file_stream'
      ? acknowledgeUpload(socket, request, uploads) : reply(socket, request, { message_id: -99 }));
    const instance = client(local.endpoint); await instance.start();
    const bytes = Buffer.alloc(50_000, 97);
    await expect(instance.sendMedia({ conversation, kind: 'file', bytes, fileName: 'fixture.txt', caption: '附件',
      replyTo: { conversation, id: '-1' } })).resolves.toEqual({ conversation, id: '-99' });
    expect(local.requests.map(request => request.action)).toEqual(['get_login_info', 'upload_file_stream', 'upload_file_stream', 'upload_file_stream', 'send_group_msg']);
    const message = local.requests.at(-1)!.params['message'];
    expect(message).toEqual([{ type: 'reply', data: { id: '-1' } }, { type: 'text', data: { text: '附件' } },
      { type: 'file', data: { file: expect.stringMatching(/^\/tmp\/napcat\/[0-9a-f-]+-fixture\.txt$/), name: 'fixture.txt' } }]);
  });

  it('does not retry an unknown final media send or claim the upload as delivery', async () => {
    const uploads = new Map<string, Record<string, unknown>>();
    const local = await server((socket, request) => { if (request.action === 'upload_file_stream') acknowledgeUpload(socket, request, uploads); });
    const instance = client(local.endpoint, { limits: { requestTimeoutMs: 100 } }); await instance.start();
    await expect(instance.sendMedia({ conversation, kind: 'image', bytes: Buffer.from('test'), fileName: 'fixture.png' }))
      .rejects.toMatchObject({ code: 'request_timeout', delivery: 'unknown' });
    expect(local.requests.filter(request => request.action === 'send_group_msg')).toHaveLength(1);
    expect(instance.snapshot().pendingRequests).toBe(0);
  });

  it('snapshots media metadata and bytes before an asynchronous upload', async () => {
    const uploads = new Map<string, Record<string, unknown>>();
    let firstUpload: { socket: WebSocket; request: Request } | undefined;
    const local = await server((socket, request) => {
      if (request.action !== 'upload_file_stream') { reply(socket, request, { message_id: 9 }); return; }
      if (!firstUpload) { firstUpload = { socket, request }; return; }
      acknowledgeUpload(socket, request, uploads);
    });
    const instance = client(local.endpoint); await instance.start();
    const input: Parameters<OneBotClient['sendMedia']>[0] = { conversation: { ...conversation }, kind: 'image',
      bytes: Buffer.from('original'), fileName: 'original.png', caption: 'original caption' };
    const result = instance.sendMedia(input);
    await vi.waitFor(() => expect(firstUpload).toBeDefined());
    input.kind = 'file'; input.fileName = 'changed.txt'; input.bytes.fill(120); input.conversation.id = '999'; input.caption = 'changed';
    acknowledgeUpload(firstUpload!.socket, firstUpload!.request, uploads);
    await expect(result).resolves.toEqual({ conversation, id: '9' });
    expect(Buffer.from(String(firstUpload!.request.params['chunk_data']), 'base64').toString()).toBe('original');
    expect(local.requests.at(-1)!.params).toMatchObject({ group_id: 123, message: [
      { type: 'text', data: { text: 'original caption' } },
      { type: 'image', data: { file: expect.stringMatching(/-original\.png$/) } },
    ] });
  });

  it('never sends media when upload confirmation is invalid or the feature is off', async () => {
    const local = await server((socket, request) => reply(socket, request, { status: 'file_complete', file_path: '/private/secret' }));
    const instance = client(local.endpoint); await instance.start();
    await expect(instance.sendMedia({ conversation, kind: 'image', bytes: Buffer.from('test'), fileName: 'fixture.png' }))
      .rejects.toMatchObject({ code: 'media_upload_failed', delivery: 'not_sent' });
    expect(local.requests.filter(request => request.action.startsWith('send_'))).toHaveLength(0);
    const disabled = client(local.endpoint, { mediaEnabled: false }); await disabled.start();
    await expect(disabled.sendMedia({ conversation, kind: 'file', bytes: Buffer.from('x'), fileName: 'x.txt' }))
      .rejects.toMatchObject({ code: 'media_disabled', delivery: 'not_sent' });
  });

  it('calls the host check exactly once after complete upload and before the chat RPC', async () => {
    const uploads = new Map<string, Record<string, unknown>>();
    let completeAckSent = false;
    const beforeSend = vi.fn(() => { expect(completeAckSent).toBe(true); });
    const local = await server((socket, request) => {
      if (request.action === 'upload_file_stream') {
        acknowledgeUpload(socket, request, uploads);
        if (request.params['is_complete']) completeAckSent = true;
      } else {
        expect(beforeSend).toHaveBeenCalledOnce();
        reply(socket, request, { message_id: 91 });
      }
    });
    const instance = client(local.endpoint); await instance.start();
    await expect(instance.sendMedia({ conversation, kind: 'file', bytes: Buffer.alloc(50_000, 97),
      fileName: 'fixture.txt', beforeSend })).resolves.toEqual({ conversation, id: '91' });
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(local.requests.filter(request => request.action === 'send_group_msg')).toHaveLength(1);
  });

  it('cancels before the chat RPC when host state changed during upload, with definite not-sent delivery', async () => {
    const uploads = new Map<string, Record<string, unknown>>();
    let firstUpload: { socket: WebSocket; request: Request } | undefined;
    let maySend = true;
    const beforeSend = vi.fn(() => { if (!maySend) throw new Error('private host state changed'); });
    const local = await server((socket, request) => {
      if (request.action !== 'upload_file_stream') { reply(socket, request, { message_id: 92 }); return; }
      if (!firstUpload) { firstUpload = { socket, request }; return; }
      acknowledgeUpload(socket, request, uploads);
    });
    const instance = client(local.endpoint); await instance.start();
    const result = instance.sendMedia({ conversation, kind: 'file', bytes: Buffer.from('fixture'), fileName: 'fixture.txt', beforeSend });
    const rejected = expect(result).rejects.toMatchObject({ code: 'media_send_cancelled', delivery: 'not_sent', message: 'OneBot: media_send_cancelled' });
    await vi.waitFor(() => expect(firstUpload).toBeDefined());
    expect(beforeSend).not.toHaveBeenCalled();
    maySend = false;
    acknowledgeUpload(firstUpload!.socket, firstUpload!.request, uploads);
    await rejected;
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(local.requests.filter(request => request.action.startsWith('send_'))).toHaveLength(0);
    expect(instance.snapshot().pendingRequests).toBe(0);
  });
});

describe('QQ reaction confirmation', () => {
  it.each(['👍', '❤️'])('sends a validated Unicode code point for %s even with media disabled', async emoji => {
    const local = await server((socket, request) => reply(socket, request, null));
    const instance = client(local.endpoint, { mediaEnabled: false }); await instance.start();
    await instance.react({ conversation, id: '-90' }, emoji);
    expect(local.requests[1]).toMatchObject({ action: 'set_msg_emoji_like', params: {
      message_id: -90, emoji_id: String(emoji.codePointAt(0)), set: true,
    } });
  });

  it.each(['a', '👍👍', '👍🏽', '👩‍💻', '🇨🇳', ''])('rejects unsupported compound or invalid reaction %s before transport', async emoji => {
    const local = await server(); const instance = client(local.endpoint); await instance.start();
    await expect(instance.react({ conversation, id: '1' }, emoji)).rejects.toMatchObject({ code: 'unsupported_reaction', delivery: 'not_sent' });
    expect(local.requests).toHaveLength(1);
  });

  it('requires an ACK and does not retry an unknown reaction', async () => {
    const local = await server(); const instance = client(local.endpoint, { limits: { requestTimeoutMs: 100 } }); await instance.start();
    await expect(instance.react({ conversation, id: '1' }, '👍')).rejects.toMatchObject({ code: 'request_timeout', delivery: 'unknown' });
    expect(local.requests.filter(request => request.action === 'set_msg_emoji_like')).toHaveLength(1);
    await expect(instance.react({ conversation: { ...conversation, accountId: '43' }, id: '1' }, '👍')).rejects.toMatchObject({ code: 'wrong_account' });
  });
});
