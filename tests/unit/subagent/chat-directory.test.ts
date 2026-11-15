import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { once } from 'node:events';
import { Api } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ db: vi.fn(), zrevrange: vi.fn(), hscan: vi.fn(), mget: vi.fn(),
  getChat: vi.fn(), getMember: vi.fn(), qq: vi.fn(), botUid: 100,
  config: { BOT_TOKEN: '100:synthetic-test-token', MASTER_UID: 77, ONEBOT_ENABLED: true, OWNER_MEMORY_LINK_ENABLED: true,
    ONEBOT_ACCOUNT_ID: '42', ONEBOT_OWNER_ID: '99', MEMORY_SENSITIVE_CHAT_IDS: [] as number[],
    ALLOWLIST_REDIS_PREFIX: 'test:allowlist:' },
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: f.db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ zrevrange: f.zrevrange, hscan: f.hscan, mget: f.mget }) }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => f.botUid,
  getBot: () => ({ api: { getChat: f.getChat, getChatMember: f.getMember } }) }));
vi.mock('../../../src/platform/onebot-runtime.js', () => ({ getOneBotGroupDirectory: f.qq }));

import { getOrCreateConversationId, getOrCreateUserId } from '../../../src/platform/identity-store.js';
import { findBotGroups } from '../../../src/subagent/chat-directory.js';

let db: Database.Database;
let qqOwner: number;
let qqGroup: number;
beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0118_platform_identity.sql', 'utf8')); f.db.mockReturnValue(db);
  Object.assign(f.config, { BOT_TOKEN: '100:synthetic-test-token', MASTER_UID: 77, ONEBOT_ENABLED: true,
    ONEBOT_ACCOUNT_ID: '42', ONEBOT_OWNER_ID: '99', MEMORY_SENSITIVE_CHAT_IDS: [], OWNER_MEMORY_LINK_ENABLED: true });
  f.botUid = 100;
  qqOwner = getOrCreateUserId({ platform: 'qq', accountId: '42', idNamespace: 'qq-number', id: '99' });
  qqGroup = getOrCreateConversationId({ platform: 'qq', accountId: '42', idNamespace: 'qq-number', conversationKind: 'group', id: '123' });
  f.zrevrange.mockResolvedValue(['-1001']); f.hscan.mockResolvedValue(['0', []]); f.mget.mockResolvedValue(['赣江院（历史标题）']);
  f.getChat.mockImplementation(async (id: number) => ({ id, type: 'supergroup', title: '赣江院 TG 合成群' }));
  f.getMember.mockResolvedValue({ user: { id: 100 }, status: 'member' });
  f.qq.mockResolvedValue([{ groupId: '123', title: '赣江院 QQ 合成群' }, { groupId: '456', title: '其他合成群' }]);
});
afterEach(() => { db.close(); });

describe('bot group metadata directory (real identity and owner gates)', () => {
  it('owner DM sees verified TG and QQ metadata without granting message content', async () => {
    f.config.MEMORY_SENSITIVE_CHAT_IDS = [-1001, qqGroup];
    const result = await findBotGroups(77, 77, '赣江院');
    expect(result).toMatchObject({ status: 'matched', scope: 'owner_directory', groups: [
      { chatId: -1001, platform: 'telegram', accountId: '100', title: '赣江院 TG 合成群', membership: 'member', sensitive: true, contentAccess: 'not_granted' },
      { chatId: qqGroup, platform: 'qq', accountId: '42', title: '赣江院 QQ 合成群', membership: 'member', sensitive: true, contentAccess: 'not_granted' },
    ] });
    expect(result.coverage).toEqual([
      expect.objectContaining({ platform: 'telegram', kind: 'known_only', complete: false }),
      expect.objectContaining({ platform: 'qq', kind: 'live_snapshot', complete: true }),
    ]);
    expect(f.getMember).toHaveBeenCalledWith(-1001, 100, expect.any(AbortSignal));
    expect(f.qq).toHaveBeenCalledWith('42');
    expect(JSON.stringify(result)).not.toContain('历史标题');
  });

  it('configured QQ owner DM can inspect the same linked metadata with explicit platform identities', async () => {
    const result = await findBotGroups(qqOwner, qqOwner, '赣江院');
    expect(result.status).toBe('matched');
    expect(new Set(result.groups.map(g => g.platform))).toEqual(new Set(['telegram', 'qq']));
    expect(result.groups.every(g => g.contentAccess === 'not_granted')).toBe(true);
  });

  it.each([[78, 77], [77, 78]])('non-owner or mismatched requester %s/%s cannot enumerate anything', async (chat, requester) => {
    const result = await findBotGroups(chat, requester, '赣江院');
    expect(result).toMatchObject({ status: 'restricted', scope: 'none', groups: [], coverage: [] });
    expect(result.note).toContain('不能解释成');
    expect(f.zrevrange).not.toHaveBeenCalled(); expect(f.getChat).not.toHaveBeenCalled(); expect(f.qq).not.toHaveBeenCalled();
  });

  it('a group, even when its speaker is the owner, can inspect only itself', async () => {
    const result = await findBotGroups(-1001, 77, '');
    expect(result.scope).toBe('current_group'); expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.chatId).toBe(-1001);
    expect(f.getChat.mock.calls.map(call => call[0])).toEqual([-1001]);
    expect(f.zrevrange).not.toHaveBeenCalled(); expect(f.qq).not.toHaveBeenCalled();
  });

  it('QQ current-group lookup never sends a surrogate to Telegram or reveals other-group counts', async () => {
    const result = await findBotGroups(qqGroup, qqOwner, '');
    expect(result.groups).toHaveLength(1); expect(result.groups[0]?.title).toBe('赣江院 QQ 合成群');
    expect(result.coverage[0]).toMatchObject({ kind: 'current_group', checked: 1 });
    expect(JSON.stringify(result)).not.toContain('其他合成群'); expect(f.getChat).not.toHaveBeenCalled();
  });

  it('permission/transport errors with a matching old title remain unknown, never absent', async () => {
    f.getMember.mockRejectedValue(new Error('synthetic-secret-403'));
    f.qq.mockRejectedValue(new Error('synthetic-secret-transport'));
    const result = await findBotGroups(77, 77, '赣江院');
    expect(result.status).toBe('unavailable'); expect(result.groups).toEqual([]);
    expect(result.coverage.every(c => c.unavailable > 0 && !c.complete)).toBe(true);
    expect(result.note).toContain('不能推断'); expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });

  it.each(['left', 'kicked', 'restricted'])('only a current explicit %s receipt can confirm not_member', async status => {
    f.getMember.mockResolvedValue({ user: { id: 100 }, status, is_member: false }); f.qq.mockResolvedValue([]);
    const result = await findBotGroups(77, 77, '赣江院');
    expect(result.status).toBe('matched'); expect(result.groups).toEqual([
      expect.objectContaining({ chatId: -1001, membership: 'not_member', evidence: 'telegram_getChatMember' }),
    ]);
    expect(result.coverage[0]).toMatchObject({ checked: 1, complete: false, unavailable: 0 });
  });

  it('restricted member with is_member=true is still present', async () => {
    f.getMember.mockResolvedValue({ user: { id: 100 }, status: 'restricted', is_member: true });
    expect((await findBotGroups(-1001, 77, '赣江院')).groups).toHaveLength(1);
  });

  it.each([{ status: 'unknown' }, { status: 'restricted' }])('does not treat a malformed member receipt as confirmed absence: %j', async row => {
    f.getMember.mockResolvedValue({ user: { id: 100 }, ...row });
    const result = await findBotGroups(-1001, 77, '赣江院');
    expect(result.status).toBe('unavailable'); expect(result.groups).toEqual([]);
  });

  it('with cross-platform linking disabled, owner DM can inspect only its own platform directory', async () => {
    f.config.OWNER_MEMORY_LINK_ENABLED = false;
    const result = await findBotGroups(77, 77, '赣江院');
    expect(result.groups.map(group => group.platform)).toEqual(['telegram']);
    expect(f.qq).not.toHaveBeenCalled();
  });

  it('rejects a foreign self identity or mismatched chat receipt', async () => {
    f.getMember.mockResolvedValue({ user: { id: 999 }, status: 'member' });
    expect((await findBotGroups(-1001, 77, '赣江院')).status).toBe('unavailable');
    f.getMember.mockResolvedValue({ user: { id: 100 }, status: 'member' });
    f.getChat.mockResolvedValue({ id: -1002, type: 'supergroup', title: '赣江院' });
    expect((await findBotGroups(-1001, 77, '赣江院')).status).toBe('unavailable');
  });

  it('does not use historical candidates with a different running Telegram bot identity', async () => {
    f.botUid = 999;
    const result = await findBotGroups(-1001, 77, '赣江院');
    expect(result.status).toBe('unavailable'); expect(f.getChat).not.toHaveBeenCalled();
  });

  it('finds quiet groups from allowlist candidates but verifies them live regardless of approval', async () => {
    f.zrevrange.mockResolvedValue([]);
    f.hscan.mockResolvedValue(['0', ['-1001', JSON.stringify({ chat_id: -1001, title: '赣江院旧名', approved: true, enabled: false })]]);
    const result = await findBotGroups(77, 77, '赣江院');
    expect(result.groups.some(group => group.chatId === -1001)).toBe(true);
    expect(f.getMember).toHaveBeenCalledWith(-1001, 100, expect.any(AbortSignal));
  });

  it('searches recent candidates, prioritizes a name hint, and caps live checks without claiming completeness', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => String(-2000 - index));
    f.zrevrange.mockResolvedValue(ids);
    f.mget.mockResolvedValue(ids.map((_, index) => index === 99 ? '赣江院' : '无关群'));
    f.getChat.mockImplementation(async (id: number) => ({ id, type: 'supergroup', title: id === -2099 ? '赣江院' : '无关群' }));
    const result = await findBotGroups(77, 77, '赣江院');
    expect(f.zrevrange).toHaveBeenCalledWith('xxb:active_groups', 0, 256);
    expect(f.getChat.mock.calls[0]?.[0]).toBe(-2099); expect(f.getChat).toHaveBeenCalledTimes(24);
    expect(result.coverage[0]).toMatchObject({ kind: 'known_only', truncated: true, complete: false });
    expect(result.groups.some(group => group.chatId === -2099)).toBe(true);
  });

  it('returns invalid query without any lookup; empty text lists only authorized metadata', async () => {
    expect((await findBotGroups(77, 77, 'x'.repeat(101))).status).toBe('invalid_query');
    expect(f.getChat).not.toHaveBeenCalled();
    expect((await findBotGroups(77, 77, '')).groups.length).toBeGreaterThan(0);
  });

  it('cancels real grammY HTTP requests with the native shared deadline instead of returning a false absence', async () => {
    const methods: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((request, _response) => {
      methods.push(request.url?.split('/').at(-1) ?? '');
      request.resume(); // Deliberately never respond: only cancellation can finish.
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const api = new Api('100:synthetic-test-token', { apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    f.getChat.mockImplementation((...args: Parameters<typeof api.getChat>) => api.getChat(...args));
    f.getMember.mockImplementation((...args: Parameters<typeof api.getChatMember>) => api.getChatMember(...args));
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    // Exercise the real abort event without adding eight seconds to every suite.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(250));
    try {
      const result = await findBotGroups(-1001, 77, '赣江院');
      expect(timeout).toHaveBeenCalledExactlyOnceWith(8000);
      expect(methods.sort()).toEqual(['getChat', 'getChatMember']);
      expect(result).toMatchObject({ status: 'unavailable', groups: [], coverage: [{ checked: 0, unavailable: 1, complete: false }] });
      const signal = f.getChat.mock.calls[0]?.[1] as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal); expect(signal.aborted).toBe(true);
      expect(f.getMember.mock.calls[0]?.[2]).toBe(signal);
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    } finally {
      timeout.mockRestore();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
