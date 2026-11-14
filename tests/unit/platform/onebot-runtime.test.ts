import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { MetaRedisFixture } from '../../helpers/meta-redis.js';

const f = vi.hoisted(() => ({ db: vi.fn(), redis: vi.fn(), core: vi.fn(), media: vi.fn(), clearMedia: vi.fn(),
  config: {
    ONEBOT_ENABLED: true, ONEBOT_MEDIA_ENABLED: false, ONEBOT_ACCOUNT_ID: '42', ONEBOT_OWNER_ID: '99',
    ONEBOT_WS_URL: '', ONEBOT_ACCESS_TOKEN: 'synthetic-runtime-token',
    ONEBOT_ALLOWED_GROUP_IDS: '', ONEBOT_ALLOWED_USER_IDS: '', ONEBOT_ACTION_TIMEOUT_MS: 300,
    ONEBOT_HEARTBEAT_INTERVAL_MS: 30_000, ONEBOT_RECONNECT_DELAY_MS: 10,
    META_ACTIVATED_AT_SEC: 1, META_DIRECT_COALESCE_MS: 800, META_DIRECT_COALESCE_MAX_MS: 2000,
  },
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: f.db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: f.redis }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// Keep the actual socket, request store, owner-command parser, platform ingress,
// SQLite identity mapping and outbound receipts. Stop at cognition, so no model
// worker or external service can run during this loopback integration test.
vi.mock('../../../src/bot/handlers/message.js', () => ({ ingestChatUpdate: f.core }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: async () => [] }));
vi.mock('../../../src/platform/onebot-media.js', () => ({
  setOneBotMediaTransport: f.media, registerOneBotMedia: vi.fn(() => { throw new Error('No media fixture'); }),
}));

import { startOneBotRuntime, stopOneBotRuntime, pauseOneBotIngress, getOneBotRuntimeStatus } from '../../../src/platform/onebot-runtime.js';
import { getOrCreateConversationId } from '../../../src/platform/identity-store.js';
import { sendPlatformText } from '../../../src/platform/outbound.js';

interface Request { action: string; echo: string; params: Record<string, unknown>; }
const migrations = ['0118_platform_identity.sql', '0119_onebot_requests.sql', '0120_onebot_notices.sql']
  .map(name => readFileSync(`migrations/${name}`, 'utf8'));
let db: Database.Database;
let wss: WebSocketServer;
const sockets: WebSocket[] = [];
const requests: Request[] = [];
let omitDecisionAck = false;
function emit(value: unknown): void { sockets[0]!.send(JSON.stringify(value)); }
function requestEvent(flag = 'opaque-capability') {
  return { post_type: 'request', request_type: 'friend', self_id: 42, user_id: 88,
    flag, comment: '合成验证文本', time: Math.floor(Date.now() / 1000) };
}
function messageEvent(id: number, text: string, userId = 99, overrides: Record<string, unknown> = {}) {
  return { post_type: 'message', self_id: 42, message_type: 'private', user_id: userId,
    message_id: id, time: Math.floor(Date.now() / 1000), sender: { nickname: '合成用户' },
    message: [{ type: 'text', data: { text } }], ...overrides };
}
function row(): { id: string; status: string } | undefined {
  return db.prepare('SELECT id, status FROM onebot_requests LIMIT 1').get() as { id: string; status: string } | undefined;
}
const sent = () => requests.filter(request => request.action === 'send_private_msg');
async function ready(acceptMessages = true): Promise<void> {
  startOneBotRuntime(acceptMessages);
  await vi.waitFor(() => expect(getOneBotRuntimeStatus().state).toBe('ready'));
}
beforeEach(async () => {
  vi.clearAllMocks(); sockets.length = 0; requests.length = 0; omitDecisionAck = false;
  Object.assign(f.config, { ONEBOT_ENABLED: true, ONEBOT_MEDIA_ENABLED: false,
    ONEBOT_ALLOWED_USER_IDS: '', META_ACTIVATED_AT_SEC: Math.floor(Date.now() / 1000) - 60 });
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrations.forEach(sql => db.exec(sql));
  f.db.mockReturnValue(db); f.redis.mockReturnValue(new MetaRedisFixture());
  f.media.mockReturnValue(f.clearMedia);
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', socket => {
    sockets.push(socket); socket.on('error', () => {});
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString()) as Request; requests.push(request);
      if (omitDecisionAck && request.action === 'set_friend_add_request') return;
      const data = request.action === 'get_login_info' ? { user_id: 42 }
        : request.action.startsWith('send_') ? { message_id: 900 + requests.length } : null;
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }));
    });
  });
  await once(wss, 'listening'); f.config.ONEBOT_WS_URL = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`;
});
afterEach(async () => {
  stopOneBotRuntime();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  db.close();
});

describe('OneBot runtime request and ingress integration', () => {
  it('stores a request, handles an owner approval, and returns a confirmed same-account DM receipt', async () => {
    await ready(); emit(requestEvent());
    await vi.waitFor(() => expect(row()?.status).toBe('pending'));
    const id = row()!.id;
    emit(messageEvent(1, '/qqrequests'));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]!.params['user_id']).toBe(99);
    expect(JSON.stringify(sent()[0]!.params)).toContain(id);
    expect(JSON.stringify(sent()[0]!.params)).not.toContain('opaque-capability');
    emit(messageEvent(2, `/qqapprove ${id}`));
    await vi.waitFor(() => expect(row()?.status).toBe('approved'));
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    expect(requests.filter(request => request.action === 'set_friend_add_request')).toEqual([
      expect.objectContaining({ params: { flag: 'opaque-capability', approve: true } }),
    ]);
    expect(f.core).not.toHaveBeenCalled();
    const refs = db.prepare("SELECT ref_json FROM platform_identity_refs WHERE ref_kind = 'message'").all() as Array<{ ref_json: string }>;
    const receipts = refs.map(ref => JSON.parse(ref.ref_json) as { id: string }).filter(ref => ref.id.startsWith('9'));
    expect(receipts).toHaveLength(2);
  });

  it('consumes unauthorized audit commands but routes ordinary allowed messages into cognition once', async () => {
    await ready(); emit(messageEvent(10, '/qqrequests', 88));
    emit(messageEvent(11, '普通消息', 88)); emit(messageEvent(11, '普通消息', 88));
    await vi.waitFor(() => expect(f.core).toHaveBeenCalledOnce());
    expect(sent()).toHaveLength(0);
    expect(f.core.mock.calls[0]![0].message.text).toBe('普通消息');
    expect(f.core.mock.calls[0]![0].message.chat.id).toBeGreaterThan(2 ** 52);
    emit(messageEvent(12, '旧消息', 88, { time: f.config.META_ACTIVATED_AT_SEC - 1 }));
    f.config.ONEBOT_ALLOWED_USER_IDS = '99'; emit(messageEvent(13, '不允许的会话', 88));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.core).toHaveBeenCalledOnce();
  });

  it('persists an unknown approval and refuses a second automatic attempt', async () => {
    omitDecisionAck = true; await ready(); emit(requestEvent());
    await vi.waitFor(() => expect(row()?.status).toBe('pending'));
    const id = row()!.id; emit(messageEvent(20, `/qqapprove ${id}`));
    await vi.waitFor(() => expect(row()?.status).toBe('unknown'));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    emit(messageEvent(21, `/qqapprove ${id}`));
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    expect(requests.filter(request => request.action === 'set_friend_add_request')).toHaveLength(1);
    expect(JSON.stringify(sent())).not.toContain('opaque-capability');
    expect(f.core).not.toHaveBeenCalled();
  });

  it('a sender-only worker ignores incoming events and pause preserves outbound drain', async () => {
    await ready(false); emit(requestEvent()); emit(messageEvent(30, '不能重复入站'));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(row()).toBeUndefined(); expect(f.core).not.toHaveBeenCalled();
    const chatId = getOrCreateConversationId({ platform: 'qq', accountId: '42', idNamespace: 'qq-number', conversationKind: 'private', id: '99' });
    pauseOneBotIngress();
    expect(await sendPlatformText(chatId, '仅回环服务器接收的测试发送')).toBeGreaterThan(2 ** 52);
    stopOneBotRuntime();
    await expect(sendPlatformText(chatId, '已关闭')).rejects.toMatchObject({ code: 'onebot_sender_unavailable' });
  });

  it('registers and clears the media transport once and reports the configured cadence', async () => {
    f.config.ONEBOT_MEDIA_ENABLED = true; await ready(); startOneBotRuntime(true);
    expect(sockets).toHaveLength(1); expect(f.media).toHaveBeenCalledOnce();
    expect(f.media.mock.calls[0]![0]).toBe('42');
    const factory = f.media.mock.calls[0]![1] as () => unknown;
    expect(factory()).toHaveProperty('streamAction');
    expect(getOneBotRuntimeStatus()).toMatchObject({ supported: expect.arrayContaining(['file', 'friend-requests']),
      cadence: { directQuietMs: 800, directMaxMs: 2000 } });
    stopOneBotRuntime(); expect(f.clearMedia).toHaveBeenCalledOnce();
    expect(() => factory()).toThrow();
    expect(getOneBotRuntimeStatus().state).toBe('stopped');
  });
});
