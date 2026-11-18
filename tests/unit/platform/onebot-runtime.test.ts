import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { MetaRedisFixture } from '../../helpers/meta-redis.js';

const f = vi.hoisted(() => ({ db: vi.fn(), redis: vi.fn(), core: vi.fn(), media: vi.fn(), clearMedia: vi.fn(),
  enqueue: vi.fn(async (_task: unknown) => undefined),
  config: {
    ONEBOT_ENABLED: true, ONEBOT_MEDIA_ENABLED: false, ONEBOT_ACCOUNT_ID: '42', ONEBOT_OWNER_ID: '99',
    ONEBOT_WS_URL: '', ONEBOT_ACCESS_TOKEN: 'synthetic-runtime-token',
    ONEBOT_ALLOWED_GROUP_IDS: '', ONEBOT_ALLOWED_USER_IDS: '', ONEBOT_ACTION_TIMEOUT_MS: 300,
    ONEBOT_HEARTBEAT_INTERVAL_MS: 30_000, ONEBOT_RECONNECT_DELAY_MS: 10,
    META_ACTIVATED_AT_SEC: 1, META_DIRECT_COALESCE_MS: 800, META_DIRECT_COALESCE_MAX_MS: 2000,
    QQ_ASSIGNMENTS_ENABLED: false, QQ_ASSIGNMENT_GROUP_IDS: '',
    META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true, META_SUBAGENT_CHAT_IDS: [] as number[],
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
vi.mock('../../../src/subagent/queue.js', () => ({ enqueueCodeActJob: f.enqueue }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: async () => [] }));
vi.mock('../../../src/platform/onebot-media.js', () => ({
  setOneBotMediaTransport: f.media, registerOneBotMedia: vi.fn(() => { throw new Error('No media fixture'); }),
}));

import { startOneBotRuntime, stopOneBotRuntime, pauseOneBotIngress, drainOneBotRecovery, getOneBotRuntimeStatus, getOneBotGroupDirectory } from '../../../src/platform/onebot-runtime.js';
import { getOrCreateConversationId } from '../../../src/platform/identity-store.js';
import { sendPlatformText } from '../../../src/platform/outbound.js';

interface Request { action: string; echo: string; params: Record<string, unknown>; }
const migrations = ['0118_platform_identity.sql', '0119_onebot_requests.sql', '0120_onebot_notices.sql', '0136_onebot_assignments.sql']
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
    ONEBOT_ALLOWED_USER_IDS: '', ONEBOT_ALLOWED_GROUP_IDS: '', QQ_ASSIGNMENTS_ENABLED: false,
    QQ_ASSIGNMENT_GROUP_IDS: '', META_SUBAGENT_CHAT_IDS: [], META_ACTIVATED_AT_SEC: Math.floor(Date.now() / 1000) - 60 });
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
        : request.action === 'get_group_list' ? [{ group_id: 123, group_name: '目录合成群' }]
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
  it('routes a real owner assignment through the authenticated socket to a separate target task once', async () => {
    Object.assign(f.config, { QQ_ASSIGNMENTS_ENABLED: true, QQ_ASSIGNMENT_GROUP_IDS: '123', ONEBOT_ALLOWED_GROUP_IDS: '123' });
    await ready();
    const command = '/qq_assign {"target":"123","mode":"once","text":"合成公开问候"}';
    emit(messageEvent(401, command));
    await vi.waitFor(() => expect(f.enqueue).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    const task = f.enqueue.mock.calls[0]![0] as Record<string, unknown>;
    const target = getOrCreateConversationId({ platform: 'qq', accountId: '42', idNamespace: 'qq-number', conversationKind: 'group', id: '123' });
    expect(task).toMatchObject({ chatId: target, status: 'queued', qqAssignmentId: expect.any(String) });
    for (const field of ['targetUserId', 'quoteMessageIds', 'pendingUserInput', 'checkpointKey']) expect(task[field]).toBeUndefined();
    expect(f.core).not.toHaveBeenCalled();
    emit(messageEvent(401, command));
    emit(messageEvent(402, 'ordinary DM after command'));
    await vi.waitFor(() => expect(f.core).toHaveBeenCalledTimes(1));
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(requests.some(request => request.action === 'send_group_msg')).toBe(false);
  });

  it('consumes marked edited commands without queueing work or treating them as model authorization', async () => {
    Object.assign(f.config, { QQ_ASSIGNMENTS_ENABLED: true, QQ_ASSIGNMENT_GROUP_IDS: '123', ONEBOT_ALLOWED_GROUP_IDS: '123' });
    await ready();
    emit(messageEvent(410, '/qq_assign {"target":"123","mode":"once"}', 99, { edited_at: 1 }));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(f.enqueue).not.toHaveBeenCalled(); expect(f.core).not.toHaveBeenCalled();
  });

  it('joins admitted runtime messages before clearing ingress while leaving sender usable', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    f.core.mockImplementationOnce(async () => { await blocked; });
    await ready(); emit(messageEvent(300, 'first')); emit(messageEvent(301, 'queued second'));
    await vi.waitFor(() => expect(getOneBotRuntimeStatus().queuedMessages).toBe(1));
    let clean = false; const drain = drainOneBotRecovery().then(() => { clean = true; });
    await Promise.resolve(); expect(clean).toBe(false);
    release(); await drain; expect(f.core).toHaveBeenCalledTimes(2);
    emit(messageEvent(302, 'after pause')); await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.core).toHaveBeenCalledTimes(2); expect(getOneBotRuntimeStatus().state).toBe('ready');
  });
  it('exposes a typed read-only directory only for the current authenticated runtime account', async () => {
    await expect(getOneBotGroupDirectory('42')).rejects.toMatchObject({ code: 'directory_unavailable' });
    await ready(false);
    expect(await getOneBotGroupDirectory('42')).toEqual([{ groupId: '123', title: '目录合成群' }]);
    await expect(getOneBotGroupDirectory('43')).rejects.toMatchObject({ code: 'directory_unavailable' });
    expect(requests.filter(request => request.action === 'get_group_list')).toHaveLength(1);
    expect(sent()).toHaveLength(0);
    stopOneBotRuntime();
    await expect(getOneBotGroupDirectory('42')).rejects.toMatchObject({ code: 'directory_unavailable' });
  });

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
