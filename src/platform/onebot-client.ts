import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { ClientOptions, RawData } from 'ws';
import { accountKey, conversationKey } from './identity.js';
import { createOneBotCodec } from './onebot.js';
import type { OneBotSendCommand } from './onebot.js';
import { PlatformBoundaryError } from './types.js';
import type { MessageRef, NormalizedMessage, PlatformAction } from './types.js';

export type OneBotDelivery = 'not_sent' | 'unknown' | 'rejected';
export class OneBotClientError extends Error {
  constructor(readonly code: string, readonly delivery: OneBotDelivery = 'not_sent') {
    // Never attach transport errors, URLs, response bodies, or access tokens.
    super(`OneBot: ${code}`);
    this.name = 'OneBotClientError';
  }
}

export interface OneBotClientLimits {
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  heartbeatIntervalMs: number;
  pongTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  maxReconnectAttempts: number;
  reconnectResetAfterMs: number;
  maxPayloadBytes: number;
  maxOutboundBytes: number;
  maxPendingRequests: number;
  maxQueuedMessages: number;
  maxFramesPerSecond: number;
  maxSegments: number;
}

const DEFAULT_LIMITS: Readonly<OneBotClientLimits> = Object.freeze({
  connectTimeoutMs: 10_000, requestTimeoutMs: 15_000,
  heartbeatIntervalMs: 15_000, pongTimeoutMs: 5_000,
  reconnectBaseMs: 500, reconnectMaxMs: 30_000, maxReconnectAttempts: 8,
  reconnectResetAfterMs: 60_000,
  maxPayloadBytes: 256 * 1024, maxOutboundBytes: 64 * 1024,
  maxPendingRequests: 32, maxQueuedMessages: 32, maxFramesPerSecond: 120, maxSegments: 64,
});

export type OneBotClientState = 'stopped' | 'connecting' | 'authenticating' | 'ready' | 'backoff' | 'failed';
export interface OneBotClientSnapshot {
  state: OneBotClientState;
  pendingRequests: number;
  queuedMessages: number;
  handlingMessage: boolean;
  reconnectAttempts: number;
  lastHeartbeatAt: number | null;
}
export interface OneBotClientOptions {
  /** Combined API/event endpoint. URL credentials, query strings and fragments are refused. */
  endpoint: string;
  accessToken: string;
  /** Expected QQ number, independent of the service's configured account. */
  accountId: string;
  /** Must settle or honor abort. A hung handler retains its single slot across reconnects. */
  onMessage: (message: NormalizedMessage, context: { signal: AbortSignal }) => void | Promise<void>;
  onState?: (snapshot: OneBotClientSnapshot) => void;
  onDiagnostic?: (code: string) => void;
  limits?: Partial<OneBotClientLimits>;
}

// ws >= 8.23 supplies these parser/control-frame bounds; some @types/ws versions
// lag the implementation. Do not replace this transport with unbounded WHATWG WS.
export type OneBotSocketOptions = ClientOptions & {
  maxFragments: number;
  maxBufferedChunks: number;
  maxPendingAutoPongs: number;
};
export type OneBotSocketFactory = (endpoint: string, options: OneBotSocketOptions) => WebSocket;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: OneBotClientError) => void;
  timer: ReturnType<typeof setTimeout>;
  sideEffect: boolean;
}
interface QueuedMessage { message: NormalizedMessage; signal: AbortSignal; }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function integerId(value: unknown, positive: boolean): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    value = String(value);
  }
  if (typeof value !== 'string' || !(positive ? /^[1-9]\d*$/ : /^-?\d+$/).test(value)) return null;
  return value;
}
function normalizeEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new OneBotClientError('invalid_endpoint'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#') ||
    /\/(?:api|event)\/?$/.test(url.pathname)) {
    throw new OneBotClientError('invalid_endpoint');
  }
  return url.href;
}
function makeLimits(overrides: Partial<OneBotClientLimits> = {}): Readonly<OneBotClientLimits> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === 'maxReconnectAttempts' ? 0 : 1) || value > 2 ** 30) {
      throw new OneBotClientError('invalid_limits');
    }
  }
  if (limits.reconnectBaseMs > limits.reconnectMaxMs || limits.maxReconnectAttempts > 20 ||
    limits.maxPayloadBytes > 1024 * 1024 || limits.maxOutboundBytes > 1024 * 1024 ||
    limits.maxPendingRequests > 256 || limits.maxQueuedMessages > 256 || limits.maxSegments > 256) {
    throw new OneBotClientError('invalid_limits');
  }
  return Object.freeze(limits);
}

/** Authenticated OneBot v11 forward WS. Construction does not open a connection. */
export class OneBotClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly codec: ReturnType<typeof createOneBotCodec>;
  private readonly limits: Readonly<OneBotClientLimits>;
  private readonly echoPrefix = randomUUID();
  private echoCounter = 0;
  private state: OneBotClientState = 'stopped';
  private socket: WebSocket | undefined;
  private connectionScope: AbortController | undefined;
  private stopped = true;
  private retries = 0;
  private readyAt = 0;
  private lastHeartbeatAt: number | null = null;
  private startPromise: Promise<void> | undefined;
  private startResolve: (() => void) | undefined;
  private startReject: ((error: OneBotClientError) => void) | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private pingNonce: string | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messages: QueuedMessage[] = [];
  private handlingMessage = false;
  private frameWindowAt = 0;
  private framesInWindow = 0;

  constructor(
    private readonly options: OneBotClientOptions,
    private readonly socketFactory: OneBotSocketFactory = (endpoint, opts) => new WebSocket(endpoint, opts),
  ) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    if (typeof options.accessToken !== 'string' || !options.accessToken.trim() ||
      options.accessToken.length > 8192 || /[^\x21-\x7e]/.test(options.accessToken)) {
      throw new OneBotClientError('invalid_access_token');
    }
    this.token = options.accessToken;
    this.codec = createOneBotCodec(options.accountId);
    this.limits = makeLimits(options.limits);
  }

  snapshot(): OneBotClientSnapshot {
    return { state: this.state, pendingRequests: this.pending.size, queuedMessages: this.messages.length,
      handlingMessage: this.handlingMessage, reconnectAttempts: this.retries,
      lastHeartbeatAt: this.lastHeartbeatAt };
  }

  start(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const promise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.startPromise = promise;
    if (this.stopped || this.state === 'failed') {
      this.stopped = false;
      this.retries = 0;
      this.connect();
    }
    return promise;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.dropConnection('stopped');
    this.setState('stopped');
    this.settleStart(new OneBotClientError('stopped'));
  }

  async send(action: PlatformAction): Promise<MessageRef> {
    if (action.action !== 'send') throw new OneBotClientError('unsupported_action');
    const conversation = { ...action.conversation };
    // The codec enforces account, namespace, reply scope and outbound capabilities.
    let command: OneBotSendCommand;
    try { command = this.codec.encode({ ...action, conversation }); }
    catch (error) {
      throw new OneBotClientError(error instanceof PlatformBoundaryError ? error.code : 'invalid_outbound_action');
    }
    const data = object(await this.request(command.action, command.params, true));
    const id = integerId(data?.['message_id'], false);
    if (id === null) throw new OneBotClientError('invalid_send_receipt', 'unknown');
    return { conversation, id };
  }

  async delete(message: MessageRef): Promise<void> {
    conversationKey(message.conversation);
    if (accountKey(message.conversation) !== accountKey(this.codec.account) || message.conversation.threadId !== undefined) {
      throw new OneBotClientError('wrong_account');
    }
    const id = integerId(message.id, false);
    if (id === null || !Number.isSafeInteger(Number(id))) throw new OneBotClientError('invalid_message_id');
    await this.request('delete_msg', { message_id: Number(id) }, true);
  }

  private diagnostic(code: string): void {
    try { this.options.onDiagnostic?.(code); } catch { /* Diagnostic consumers cannot break transport cleanup. */ }
  }
  private setState(state: OneBotClientState): void {
    this.state = state;
    try { this.options.onState?.(this.snapshot()); } catch { this.diagnostic('state_handler_failed'); }
  }
  private settleStart(error?: OneBotClientError): void {
    if (error) this.startReject?.(error); else this.startResolve?.();
    this.startPromise = undefined;
    this.startResolve = undefined;
    this.startReject = undefined;
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState('connecting');
    if (this.stopped) return;
    this.lastHeartbeatAt = null;
    this.frameWindowAt = Date.now();
    this.framesInWindow = 0;
    let socket: WebSocket;
    try {
      socket = this.socketFactory(this.endpoint, {
        headers: { Authorization: `Bearer ${this.token}` },
        handshakeTimeout: this.limits.connectTimeoutMs, followRedirects: false,
        maxPayload: this.limits.maxPayloadBytes, perMessageDeflate: false,
        maxFragments: 128, maxBufferedChunks: 256, maxPendingAutoPongs: 8,
        allowSynchronousEvents: false,
      });
    } catch { this.disconnected(undefined, 'connect_failed'); return; }
    this.socket = socket;
    this.connectionScope = new AbortController();
    this.connectTimer = setTimeout(() => this.disconnected(socket, 'connect_timeout'), this.limits.connectTimeoutMs);
    this.connectTimer.unref();
    socket.on('open', () => { void this.authenticate(socket); });
    socket.on('message', (data: RawData, binary: boolean) => this.receive(socket, data, binary));
    socket.on('ping', () => { this.admitFrame(socket); });
    socket.on('pong', (data: Buffer) => {
      if (!this.admitFrame(socket) || this.pingNonce === undefined || data.toString() !== this.pingNonce) return;
      this.pingNonce = undefined;
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    });
    socket.on('error', () => this.disconnected(socket, 'socket_error'));
    socket.on('close', () => this.disconnected(socket, 'connection_closed'));
  }

  private async authenticate(socket: WebSocket): Promise<void> {
    if (this.socket !== socket || this.stopped) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.setState('authenticating');
    try {
      const data = object(await this.request('get_login_info', {}, false, true));
      if (this.socket !== socket || this.stopped) return;
      if (integerId(data?.['user_id'], true) !== this.codec.account.accountId) {
        this.disconnected(socket, 'identity_mismatch', false);
        return;
      }
      this.readyAt = Date.now();
      this.setState('ready');
      if (this.stopped || this.socket !== socket) return;
      this.settleStart();
      this.heartbeatTimer = setInterval(() => this.ping(socket), this.limits.heartbeatIntervalMs);
      this.heartbeatTimer.unref();
    } catch {
      if (this.socket === socket) this.disconnected(socket, 'authentication_failed');
    }
  }

  private ping(socket: WebSocket): void {
    if (socket !== this.socket || this.state !== 'ready' || this.pingNonce !== undefined) return;
    this.pingNonce = randomUUID();
    this.pongTimer = setTimeout(() => this.disconnected(socket, 'pong_timeout'), this.limits.pongTimeoutMs);
    this.pongTimer.unref();
    try {
      socket.ping(this.pingNonce, undefined, (error?: Error) => {
        if (error) this.disconnected(socket, 'ping_failed');
      });
    } catch { this.disconnected(socket, 'ping_failed'); }
  }

  private dropConnection(code: string): void {
    const socket = this.socket;
    this.socket = undefined; // Old callbacks cannot tear down a replacement socket.
    clearTimeout(this.connectTimer);
    clearTimeout(this.pongTimer);
    clearInterval(this.heartbeatTimer);
    this.connectTimer = undefined;
    this.pongTimer = undefined;
    this.heartbeatTimer = undefined;
    this.pingNonce = undefined;
    this.connectionScope?.abort();
    this.connectionScope = undefined;
    this.messages.length = 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new OneBotClientError(code, pending.sideEffect ? 'unknown' : 'not_sent'));
    }
    this.pending.clear();
    try { socket?.terminate(); } catch { /* Already closed. */ }
  }

  private disconnected(socket: WebSocket | undefined, code: string, retry = true): void {
    if (this.stopped || socket !== this.socket) return;
    if (this.readyAt && Date.now() - this.readyAt >= this.limits.reconnectResetAfterMs) this.retries = 0;
    this.readyAt = 0;
    this.dropConnection(code);
    this.diagnostic(code);
    if (!retry || this.retries >= this.limits.maxReconnectAttempts) {
      this.setState('failed');
      this.settleStart(new OneBotClientError(code));
      return;
    }
    const delay = Math.min(this.limits.reconnectMaxMs, this.limits.reconnectBaseMs * 2 ** this.retries++);
    this.setState('backoff');
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, delay);
    this.reconnectTimer.unref();
  }

  private request(action: string, params: unknown, sideEffect: boolean, authenticating = false): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN ||
      (this.state !== 'ready' && !(authenticating && this.state === 'authenticating'))) {
      return Promise.reject(new OneBotClientError('not_ready'));
    }
    if (this.pending.size >= this.limits.maxPendingRequests) return Promise.reject(new OneBotClientError('pending_limit'));
    const echo = `${this.echoPrefix}:${++this.echoCounter}`;
    const frame = JSON.stringify({ action, params, echo });
    if (Buffer.byteLength(frame) + socket.bufferedAmount > this.limits.maxOutboundBytes) {
      return Promise.reject(new OneBotClientError('outbound_limit'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(echo)) return;
        reject(new OneBotClientError('request_timeout', sideEffect ? 'unknown' : 'not_sent'));
      }, this.limits.requestTimeoutMs);
      timer.unref();
      this.pending.set(echo, { resolve, reject, timer, sideEffect });
      try {
        socket.send(frame, (error?: Error) => {
          if (error) this.disconnected(socket, 'send_transport_failed');
        });
      } catch { this.disconnected(socket, 'send_transport_failed'); }
    });
  }

  private admitFrame(socket: WebSocket): boolean {
    if (socket !== this.socket || this.stopped) return false;
    if (Date.now() - this.frameWindowAt >= 1000) {
      this.frameWindowAt = Date.now();
      this.framesInWindow = 0;
    }
    if (++this.framesInWindow > this.limits.maxFramesPerSecond) {
      this.disconnected(socket, 'inbound_rate_limit'); return false;
    }
    return true;
  }

  private receive(socket: WebSocket, data: RawData, binary: boolean): void {
    if (!this.admitFrame(socket)) return;
    const length = Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
    if (binary || length > this.limits.maxPayloadBytes) {
      this.disconnected(socket, binary ? 'binary_frame_refused' : 'payload_limit'); return;
    }
    let frame: Record<string, unknown> | null;
    try {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
      frame = object(JSON.parse(buffer.toString()));
    } catch { this.disconnected(socket, 'invalid_json'); return; }
    if (!frame) { this.disconnected(socket, 'invalid_frame'); return; }
    if (Object.hasOwn(frame, 'echo')) { this.receiveResponse(frame); return; }
    // No event is buffered before the login API proves this is the intended account.
    if (this.state !== 'ready') { this.diagnostic('event_before_identity'); return; }
    if (integerId(frame['self_id'], true) !== this.codec.account.accountId) {
      this.disconnected(socket, 'event_identity_mismatch', false); return;
    }
    if (frame['post_type'] === 'meta_event' && frame['meta_event_type'] === 'heartbeat') {
      this.lastHeartbeatAt = Date.now();
      const status = object(frame['status']);
      if (status?.['online'] === false || status?.['good'] === false) this.disconnected(socket, 'account_offline');
      return;
    }
    try {
      if (Array.isArray(frame['message']) && frame['message'].length > this.limits.maxSegments) {
        this.diagnostic('segment_limit'); return;
      }
      const message = this.codec.normalize(frame);
      if (!message) return;
      if (message.segments.length > this.limits.maxSegments) { this.diagnostic('segment_limit'); return; }
      // Preserve accompanying text and an explicit unsupported placeholder. Do not
      // turn untrusted media URLs into network/file capabilities at this boundary.
      message.segments = message.segments.map(segment =>
        ['image', 'voice', 'file'].includes(segment.type)
          ? { type: 'unsupported' as const, platformType: segment.type } : segment);
      if (this.messages.length >= this.limits.maxQueuedMessages) {
        this.diagnostic('message_queue_limit'); return;
      }
      const signal = this.connectionScope!.signal;
      this.messages.push({ message, signal });
      void this.drainMessages();
    } catch { this.diagnostic('invalid_event'); }
  }

  private receiveResponse(frame: Record<string, unknown>): void {
    if (typeof frame['echo'] !== 'string') { this.diagnostic('unmatched_response'); return; }
    const pending = this.pending.get(frame['echo']);
    if (!pending) { this.diagnostic('unmatched_response'); return; }
    this.pending.delete(frame['echo']);
    clearTimeout(pending.timer);
    if (frame['status'] === 'ok' && frame['retcode'] === 0) {
      pending.resolve(frame['data']);
    } else {
      const rejected = frame['status'] === 'failed' && typeof frame['retcode'] === 'number' &&
        Number.isSafeInteger(frame['retcode']) && frame['retcode'] !== 0;
      pending.reject(new OneBotClientError(rejected ? 'api_rejected' : 'invalid_api_receipt',
        !pending.sideEffect ? 'not_sent' : rejected ? 'rejected' : 'unknown'));
    }
  }

  private async drainMessages(): Promise<void> {
    if (this.handlingMessage) return;
    this.handlingMessage = true;
    try {
      for (;;) {
        const next = this.messages.shift();
        if (!next) break;
        if (next.signal.aborted) continue;
        try { await this.options.onMessage(next.message, { signal: next.signal }); }
        catch { this.diagnostic('message_handler_failed'); }
      }
    } finally { this.handlingMessage = false; }
  }
}
