import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { OneBotClient, OneBotClientError } from '../../../src/platform/onebot-client.js';
import type { OneBotClientOptions, OneBotSocketFactory } from '../../../src/platform/onebot-client.js';
import type { ConversationRef, NormalizedMessage, PlatformAction } from '../../../src/platform/types.js';

const clients: OneBotClient[] = [];
const servers: WebSocketServer[] = [];
const conversation: ConversationRef = {
  platform: 'qq', accountId: '42', idNamespace: 'qq-number', conversationKind: 'group', id: '123',
};
function action(text = 'test'): PlatformAction {
  return { action: 'send', conversation, segments: [{ type: 'text', text }] };
}
function event(id: number, extra: Record<string, unknown> = {}): object {
  return { post_type: 'message', self_id: 42, message_type: 'group', group_id: 123,
    user_id: 99, message_id: id, time: 1_700_000_000,
    message: [{ type: 'text', data: { text: `message-${id}` } }], ...extra };
}
interface Request { action: string; echo: string; params: Record<string, unknown>; }
function reply(socket: WebSocket, request: Request, data: unknown, fields: Record<string, unknown> = {}): void {
  socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data, ...fields }));
}
async function server(
  onRequest?: (socket: WebSocket, request: Request) => void,
  opts: { login?: boolean; autoPong?: boolean } = {},
) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: opts.autoPong ?? true });
  servers.push(wss);
  const sockets: WebSocket[] = [];
  const headers: Array<string | undefined> = [];
  const requests: Request[] = [];
  wss.on('connection', (socket, req) => {
    sockets.push(socket);
    headers.push(req.headers.authorization);
    socket.on('error', () => {});
    socket.on('message', data => {
      const request = JSON.parse(data.toString()) as Request;
      requests.push(request);
      if (request.action === 'get_login_info' && opts.login !== false) reply(socket, request, { user_id: 42 });
      else onRequest?.(socket, request);
    });
  });
  await once(wss, 'listening');
  return { endpoint: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, sockets, headers, requests };
}
function client(endpoint: string, options: Partial<OneBotClientOptions> = {}, factory?: OneBotSocketFactory): OneBotClient {
  const instance = new OneBotClient({
    endpoint, accessToken: 'test-bearer', accountId: '42', onMessage: () => {}, ...options,
    limits: { requestTimeoutMs: 250, connectTimeoutMs: 500, heartbeatIntervalMs: 10_000,
      maxReconnectAttempts: 0, reconnectBaseMs: 10, reconnectMaxMs: 20, ...options.limits },
  }, factory);
  clients.push(instance);
  return instance;
}
afterEach(async () => {
  for (const instance of clients.splice(0)) instance.stop();
  for (const wss of servers.splice(0)) {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  }
  vi.useRealTimers();
});

describe('OneBot authenticated forward WebSocket', () => {
  it('uses a bearer header and bounded parser options; constructor makes no connection', async () => {
    const local = await server();
    const factory = vi.fn<OneBotSocketFactory>((endpoint, options) => new WebSocket(endpoint, options));
    const instance = client(local.endpoint, {}, factory);
    expect(factory).not.toHaveBeenCalled();
    await instance.start();
    expect(local.headers).toEqual(['Bearer test-bearer']);
    expect(factory.mock.calls[0]![0]).not.toContain('test-bearer');
    expect(factory.mock.calls[0]![1]).toMatchObject({ followRedirects: false, perMessageDeflate: false,
      maxPayload: 256 * 1024, maxFragments: 128, maxBufferedChunks: 256, maxPendingAutoPongs: 8 });
    expect(instance.snapshot().state).toBe('ready');
    expect(local.requests.map(r => r.action)).toEqual(['get_login_info']);
  });

  it.each([
    'http://127.0.0.1/', 'ws://user:SECRET@127.0.0.1/', 'ws://127.0.0.1/?access_token=SECRET',
    'ws://127.0.0.1/#SECRET', 'ws://127.0.0.1/api', 'ws://127.0.0.1/event/',
  ])('refuses unsafe or split endpoint %s without echoing URL content', endpoint => {
    expect(() => client(endpoint)).toThrow('OneBot: invalid_endpoint');
    try { client(endpoint); } catch (error) { expect(String(error)).not.toContain('SECRET'); }
  });

  it('drops pre-identity messages, then routes the verified account only', async () => {
    let login: Request | undefined;
    const local = await server((_socket, request) => { login = request; }, { login: false });
    const messages = vi.fn();
    const diagnostics = vi.fn();
    const instance = client(local.endpoint, { onMessage: messages, onDiagnostic: diagnostics });
    const started = instance.start();
    await vi.waitFor(() => expect(login).toBeDefined());
    local.sockets[0]!.send(JSON.stringify(event(1)));
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith('event_before_identity'));
    expect(messages).not.toHaveBeenCalled();
    reply(local.sockets[0]!, login!, { user_id: 42 });
    await started;
    local.sockets[0]!.send(JSON.stringify(event(2)));
    await vi.waitFor(() => expect(messages).toHaveBeenCalledTimes(1));
    expect(messages.mock.calls[0]![0].ref).toEqual({ conversation, id: '2' });
  });

  it('halts on login identity mismatch even when reconnects are enabled', async () => {
    const local = await server((socket, request) => reply(socket, request, { user_id: 77 }), { login: false });
    const instance = client(local.endpoint, { limits: { maxReconnectAttempts: 3 } });
    await expect(instance.start()).rejects.toMatchObject({ code: 'identity_mismatch', delivery: 'not_sent' });
    expect(instance.snapshot()).toMatchObject({ state: 'failed', reconnectAttempts: 0 });
    expect(local.sockets).toHaveLength(1);
  });

  it('halts on a foreign event self_id after login and never routes it', async () => {
    const local = await server();
    const messages = vi.fn();
    const instance = client(local.endpoint, { onMessage: messages, limits: { maxReconnectAttempts: 3 } });
    await instance.start();
    local.sockets[0]!.send(JSON.stringify(event(1, { self_id: 77 })));
    await vi.waitFor(() => expect(instance.snapshot().state).toBe('failed'));
    expect(messages).not.toHaveBeenCalled();
  });

  it('retains text alongside explicit media placeholders, without exposing media URLs', async () => {
    const local = await server();
    const messages = vi.fn();
    const instance = client(local.endpoint, { onMessage: messages });
    await instance.start();
    local.sockets[0]!.send(JSON.stringify(event(1, { message: [
      { type: 'text', data: { text: 'look' } }, { type: 'image', data: { file: 'https://private.invalid/SECRET' } },
      { type: 'at', data: { qq: '42' } }, { type: 'reply', data: { id: '-2' } },
    ] })));
    await vi.waitFor(() => expect(messages).toHaveBeenCalledTimes(1));
    const normalized = messages.mock.calls[0]![0] as NormalizedMessage;
    expect(normalized.segments.map(s => s.type)).toEqual(['text', 'unsupported', 'mention', 'reply']);
    expect(normalized.segments[1]).toEqual({ type: 'unsupported', platformType: 'image' });
    expect(JSON.stringify(normalized)).not.toContain('SECRET');
  });
});

describe('OneBot confirmed effects and request lifecycle', () => {
  it('correlates out-of-order echoes and confirms signed message IDs', async () => {
    const sends: Request[] = [];
    const local = await server((_socket, request) => sends.push(request));
    const instance = client(local.endpoint);
    await instance.start();
    const first = instance.send(action('first'));
    const second = instance.send(action('second'));
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    reply(local.sockets[0]!, { ...sends[0]!, echo: 'unknown-echo' }, { message_id: 999 });
    reply(local.sockets[0]!, sends[1]!, { message_id: -20 });
    reply(local.sockets[0]!, sends[0]!, { message_id: 10 });
    await expect(first).resolves.toEqual({ conversation, id: '10' });
    await expect(second).resolves.toEqual({ conversation, id: '-20' });
    expect(instance.snapshot().pendingRequests).toBe(0);
  });

  it.each([
    [{ status: 'failed', retcode: 100 }, null, 'api_rejected', 'rejected'],
    [{ status: 'async', retcode: 1 }, null, 'invalid_api_receipt', 'unknown'],
    [{ status: 'ok', retcode: 1 }, { message_id: 1 }, 'invalid_api_receipt', 'unknown'],
    [{ status: 'ok', retcode: 0 }, {}, 'invalid_send_receipt', 'unknown'],
    [{ status: 'ok', retcode: 0 }, { message_id: 1.2 }, 'invalid_send_receipt', 'unknown'],
  ])('does not claim delivery for malformed or failed receipt %#', async (fields, data, code, delivery) => {
    const local = await server((socket, request) => reply(socket, request, data, fields as Record<string, unknown>));
    const instance = client(local.endpoint);
    await instance.start();
    await expect(instance.send(action())).rejects.toMatchObject({ code, delivery });
    expect(local.requests.filter(r => r.action === 'send_group_msg')).toHaveLength(1);
  });

  it('binds receipts to the validated destination snapshot even if caller objects mutate', async () => {
    let sent: Request | undefined;
    const local = await server((_socket, request) => { sent = request; });
    const instance = client(local.endpoint);
    await instance.start();
    const destination = { ...conversation };
    const sending = instance.send({ action: 'send', conversation: destination, segments: [{ type: 'text', text: 'x' }] });
    await vi.waitFor(() => expect(sent).toBeDefined());
    destination.id = '999';
    destination.accountId = '77';
    reply(local.sockets[0]!, sent!, { message_id: 7 });
    await expect(sending).resolves.toEqual({ conversation, id: '7' });
    expect(sent!.params['group_id']).toBe(123);
  });

  it('times out uncertain sends without retry, and ignores a later duplicate receipt', async () => {
    let sent: Request | undefined;
    const local = await server((_socket, request) => { sent = request; });
    const instance = client(local.endpoint, { limits: { requestTimeoutMs: 30 } });
    await instance.start();
    await expect(instance.send(action())).rejects.toMatchObject({ code: 'request_timeout', delivery: 'unknown' });
    expect(instance.snapshot().pendingRequests).toBe(0);
    reply(local.sockets[0]!, sent!, { message_id: 1 });
    expect(local.requests.filter(r => r.action === 'send_group_msg')).toHaveLength(1);
  });

  it('rejects in-flight effects on disconnect, reauthenticates, and never resends them', async () => {
    const local = await server(socket => socket.terminate());
    const instance = client(local.endpoint, { limits: { maxReconnectAttempts: 2 } });
    await instance.start();
    await expect(instance.send(action())).rejects.toMatchObject({ code: 'connection_closed', delivery: 'unknown' });
    await vi.waitFor(() => expect(local.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(instance.snapshot().state).toBe('ready'));
    expect(local.requests.map(r => r.action)).toEqual(['get_login_info', 'send_group_msg', 'get_login_info']);
    expect(instance.snapshot().pendingRequests).toBe(0);
  });

  it('confirms delete responses and refuses unsupported outbound actions before transport', async () => {
    const local = await server((socket, request) => reply(socket, request, null));
    const instance = client(local.endpoint);
    await instance.start();
    await expect(instance.delete({ conversation, id: '-12' })).resolves.toBeUndefined();
    expect(local.requests[1]).toMatchObject({ action: 'delete_msg', params: { message_id: -12 } });
    await expect(instance.send({ action: 'send', conversation, segments: [{ type: 'image', assetRef: 'x' }] }))
      .rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(instance.delete({ conversation: { ...conversation, accountId: '77' }, id: '1' }))
      .rejects.toMatchObject({ code: 'wrong_account', delivery: 'not_sent' });
    expect(local.requests).toHaveLength(2);
  });

  it('bounds pending requests and outgoing bytes without sending rejected work', async () => {
    const sends: Request[] = [];
    const local = await server((_socket, request) => sends.push(request));
    const instance = client(local.endpoint, { limits: { maxPendingRequests: 1, maxOutboundBytes: 512 } });
    await expect(instance.send(action())).rejects.toMatchObject({ code: 'not_ready', delivery: 'not_sent' });
    await instance.start();
    await expect(instance.send(action('x'.repeat(1024)))).rejects.toMatchObject({ code: 'outbound_limit', delivery: 'not_sent' });
    const first = instance.send(action());
    await expect(instance.send(action())).rejects.toMatchObject({ code: 'pending_limit', delivery: 'not_sent' });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    reply(local.sockets[0]!, sends[0]!, { message_id: 1 });
    await first;
  });

  it('stops handshake waiters and never schedules another connection', async () => {
    const local = await server(undefined, { login: false });
    const instance = client(local.endpoint, { limits: { maxReconnectAttempts: 3 } });
    const waiting = instance.start().catch(error => error);
    await vi.waitFor(() => expect(local.requests).toHaveLength(1));
    instance.stop();
    expect(await waiting).toMatchObject({ code: 'stopped', delivery: 'not_sent' });
    expect(instance.snapshot()).toMatchObject({ state: 'stopped', pendingRequests: 0 });
    expect(local.sockets).toHaveLength(1);
  });
});

describe('OneBot bounded ingress and connection recovery', () => {
  it('keeps handlers serial, drops overflow explicitly and aborts remaining work on stop', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    let signal: AbortSignal | undefined;
    const local = await server();
    const diagnostics = vi.fn();
    const instance = client(local.endpoint, {
      limits: { maxQueuedMessages: 1 }, onDiagnostic: diagnostics,
      onMessage: async (message, context) => { seen.push(message.ref.id); signal = context.signal; await held; },
    });
    await instance.start();
    for (let id = 1; id <= 3; id++) local.sockets[0]!.send(JSON.stringify(event(id)));
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith('message_queue_limit'));
    expect(seen).toEqual(['1']);
    expect(instance.snapshot()).toMatchObject({ handlingMessage: true, queuedMessages: 1 });
    instance.stop();
    expect(signal?.aborted).toBe(true);
    release();
    await vi.waitFor(() => expect(instance.snapshot().handlingMessage).toBe(false));
    expect(seen).toEqual(['1']);
  });

  it('continues serial processing after a handler rejection without logging its private text', async () => {
    const local = await server();
    const diagnostics = vi.fn();
    const handler = vi.fn().mockRejectedValueOnce(new Error('SECRET_PAYLOAD')).mockResolvedValue(undefined);
    const instance = client(local.endpoint, { onMessage: handler, onDiagnostic: diagnostics });
    await instance.start();
    local.sockets[0]!.send(JSON.stringify(event(1)));
    local.sockets[0]!.send(JSON.stringify(event(2)));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(diagnostics).toHaveBeenCalledWith('message_handler_failed');
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('SECRET');
  });

  it.each(['payload', 'binary', 'rate', 'fragments'] as const)('rejects %s abuse before routing', async kind => {
    const local = await server();
    const handler = vi.fn();
    const diagnostics = vi.fn();
    const instance = client(local.endpoint, { onMessage: handler, onDiagnostic: diagnostics,
      limits: { maxPayloadBytes: kind === 'payload' ? 128 : 1024, maxFramesPerSecond: kind === 'rate' ? 2 : 120 } });
    await instance.start();
    const socket = local.sockets[0]!;
    if (kind === 'payload') socket.send('x'.repeat(1024));
    if (kind === 'binary') socket.send(Buffer.from('{}'));
    if (kind === 'rate') for (let i = 0; i < 3; i++) socket.send(JSON.stringify({
      post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 42,
    }));
    if (kind === 'fragments') {
      for (let i = 0; i < 130; i++) socket.send('x', { fin: false });
      socket.send('x', { fin: true });
    }
    await vi.waitFor(() => expect(instance.snapshot().state).toBe('failed'));
    expect(handler).not.toHaveBeenCalled();
    if (kind === 'fragments' || kind === 'payload') expect(diagnostics).toHaveBeenCalledWith('socket_error');
    if (kind === 'rate') expect(diagnostics).toHaveBeenCalledWith('inbound_rate_limit');
  });

  it('drops oversized segment lists while keeping the authenticated connection', async () => {
    const local = await server();
    const diagnostics = vi.fn();
    const handler = vi.fn();
    const instance = client(local.endpoint, { onDiagnostic: diagnostics, onMessage: handler, limits: { maxSegments: 1 } });
    await instance.start();
    local.sockets[0]!.send(JSON.stringify(event(1, { message: [
      { type: 'text', data: { text: 'a' } }, { type: 'text', data: { text: 'b' } },
    ] })));
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith('segment_limit'));
    expect(handler).not.toHaveBeenCalled();
    expect(instance.snapshot().state).toBe('ready');
  });

  it('handles application heartbeat status and detects a dead socket using ping/pong', async () => {
    const local = await server(undefined, { autoPong: false });
    const diagnostics = vi.fn();
    const instance = client(local.endpoint, { onDiagnostic: diagnostics,
      limits: { heartbeatIntervalMs: 20, pongTimeoutMs: 20 } });
    await instance.start();
    local.sockets[0]!.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat',
      self_id: 42, status: { online: true, good: true }, interval: 5000 }));
    await vi.waitFor(() => expect(instance.snapshot().lastHeartbeatAt).not.toBeNull());
    await vi.waitFor(() => expect(instance.snapshot().state).toBe('failed'));
    expect(diagnostics).toHaveBeenCalledWith('pong_timeout');
  });

  it('stays connected when pong acknowledgements match its keepalive nonce', async () => {
    const local = await server();
    const instance = client(local.endpoint, { limits: { heartbeatIntervalMs: 20, pongTimeoutMs: 100 } });
    await instance.start();
    const pings = vi.fn();
    local.sockets[0]!.on('ping', pings);
    await vi.waitFor(() => expect(pings.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(instance.snapshot().state).toBe('ready');
  });

  it('caps exponential reconnect delays and attempts, sanitizing constructor failures', async () => {
    vi.useFakeTimers();
    const factory = vi.fn<OneBotSocketFactory>(() => { throw new Error('SECRET_TOKEN wss://private/'); });
    const diagnostics = vi.fn();
    const instance = client('wss://example.invalid/', { onDiagnostic: diagnostics,
      limits: { maxReconnectAttempts: 3, reconnectBaseMs: 10, reconnectMaxMs: 15 } }, factory);
    const failed = instance.start().catch(error => error);
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15);
    expect(factory).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(15);
    expect(factory).toHaveBeenCalledTimes(4);
    expect(await failed).toBeInstanceOf(OneBotClientError);
    expect(instance.snapshot()).toMatchObject({ state: 'failed', reconnectAttempts: 3 });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('SECRET');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory).toHaveBeenCalledTimes(4);
  });
});
