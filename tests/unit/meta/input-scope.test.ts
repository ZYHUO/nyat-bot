import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type { AttentionItem, DispatchTask, SubagentCallback } from '../../../src/meta/types.js';
import type { ConversationRef, UserRef } from '../../../src/platform/types.js';

const f = vi.hoisted(() => ({ db: null as unknown as Database.Database, unavailable: false,
  config: { ONEBOT_ACCOUNT_ID: '42', META_ATTENTION_TOP_N: 20, META_L0_COALESCE_MS: 0,
    META_DIRECT_COALESCE_MS: 0, META_DIRECT_COALESCE_MAX_MS: 2000,
    META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true, META_SUBAGENT_CHAT_IDS: [], META_ACTIVATED_AT_SEC: 1 },
  raw: [] as string[], archive: vi.fn(async (..._args: unknown[]) => 1), loadTask: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { if (f.unavailable) throw new Error('synthetic offline'); return f.db; } }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({
  hsetnx: f.archive, hget: f.loadTask, mget: async (...keys: string[]) => keys.map(() => null),
  eval: async () => f.raw.splice(0), lrange: async () => f.raw,
  multi: () => { const pipe = { lpush: (_key: string, raw: string) => { f.raw.unshift(raw); return pipe; },
    rpush: (_key: string, raw: string) => { f.raw.push(raw); return pipe; }, ltrim: () => pipe, exec: async () => [] }; return pipe; },
}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/meta/loop.js', () => ({ metaTick: vi.fn() }));
import { getOrCreateConversationId, getOrCreateMessageId, getOrCreateUserId } from '../../../src/platform/identity-store.js';
import { inspectMetaAttention, inspectMetaCallback, inspectMetaChatScope, inspectMetaTaskScope } from '../../../src/meta/input-scope.js';
import { checkCodeActTaskActivation } from '../../../src/subagent/activation-policy.js';
import { AttentionAccumulator, _resetAttentionAccumulator } from '../../../src/meta/attention.js';
import { getGlobalState, _resetGlobalState } from '../../../src/meta/global-state.js';
import { isDigestSourceChatId } from '../../../src/meta/digest-scope.js';

const conversation = (id = '123', accountId = '42', kind: 'private' | 'group' = 'group'): ConversationRef =>
  ({ platform: 'qq', accountId, idNamespace: 'qq-number', conversationKind: kind, id });
const user = (id = '99', accountId = '42'): UserRef => ({ platform: 'qq', accountId, idNamespace: 'qq-number', id });
function attention(chat: ConversationRef, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return { id: 'same-event-id', chatId: getOrCreateConversationId(chat), messageId: getOrCreateMessageId({ conversation: chat, id: '10' }),
    userId: getOrCreateUserId(user(chat.conversationKind === 'private' ? chat.id : '99', chat.accountId)),
    layer: 'L1', reason: 'synthetic', pressure: 60, textPreview: 'same-source body', createdAt: Date.now(), ...overrides };
}
function task(a: AttentionItem): DispatchTask {
  return { id: 'task', chatId: a.chatId, createdAt: a.createdAt, status: 'done', contentDirection: 'synthetic',
    targetUserId: a.userId, quoteMessageIds: [a.messageId!] };
}
function callback(t: DispatchTask): SubagentCallback {
  return { id: 'callback', taskId: t.id, chatId: t.chatId, summary: 'private synthetic result', createdAt: Date.now(), ok: true };
}
beforeEach(() => {
  vi.clearAllMocks(); _resetGlobalState(); _resetAttentionAccumulator(); f.raw.length = 0; f.unavailable = false;
  f.config.ONEBOT_ACCOUNT_ID = '42'; f.archive.mockResolvedValue(1); f.loadTask.mockResolvedValue(null);
  f.db = new Database(':memory:');
  for (const name of ['0118_platform_identity.sql', '0120_onebot_notices.sql']) {
    f.db.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'));
  }
});
afterEach(() => { _resetAttentionAccumulator(); f.db.close(); });

describe('Meta source boundaries with real platform mappings', () => {
  it('keeps Telegram and QQ numeric twins, groups and private peers distinct', () => {
    const group = attention(conversation('123')), dm = attention(conversation('123', '42', 'private'));
    expect(inspectMetaAttention(group).status).toBe('valid');
    expect(inspectMetaAttention(dm).status).toBe('valid');
    expect(inspectMetaAttention({ ...group, chatId: -123, userId: 99, messageId: 10 }).status).toBe('valid');
    expect(new Set([group.chatId, dm.chatId, -123, 123]).size).toBe(4);
    expect(inspectMetaAttention({ ...dm, messageId: group.messageId })).toMatchObject({ status: 'invalid', reason: 'message_scope_mismatch' });
    expect(inspectMetaAttention({ ...group, messageId: 10 }).status).toBe('invalid');
    expect(inspectMetaAttention({ ...group, chatId: -123, messageId: group.messageId }).status).toBe('invalid');
  });
  it('rejects a previous QQ account and unresolved reserved IDs without Telegram fallback', () => {
    const foreign = attention(conversation('123', '43'));
    expect(inspectMetaAttention(foreign)).toMatchObject({ status: 'invalid', reason: 'wrong_qq_account' });
    expect(isDigestSourceChatId(foreign.chatId)).toBe(false);
    expect(inspectMetaChatScope(-(2 ** 52 + 999))).toMatchObject({ status: 'invalid', reason: 'unresolved_qq_chat' });
  });
  it('strips a copied foreign quote but preserves body and a valid same-chat quote', () => {
    const a = attention(conversation()), other = attention(conversation('456'));
    const bad = inspectMetaAttention({ ...a, payload: { replyTo: { messageId: other.messageId, textSnippet: 'FOREIGN_PRIVATE' } } });
    expect(bad).toMatchObject({ status: 'valid', value: { textPreview: 'same-source body', payload: { replyTo: undefined } } });
    const good = { ...a, payload: { replyTo: { messageId: a.messageId, uid: a.userId, textSnippet: 'same-chat quote' } } };
    expect(inspectMetaAttention(good)).toEqual({ status: 'valid', value: good });
  });
  it('allows a private-chat quote of the bot while rejecting a different peer as sender', () => {
    const a = attention(conversation('99', '42', 'private'));
    const bot = getOrCreateUserId(user('42'));
    expect(inspectMetaAttention({ ...a, payload: { replyTo: { messageId: a.messageId, uid: bot } } }).status).toBe('valid');
    expect(inspectMetaAttention({ ...a, userId: getOrCreateUserId(user('98')) }).status).toBe('invalid');
  });
  it('rejects QQ references from another account even when opaque user IDs match', () => {
    const a = attention(conversation());
    expect(inspectMetaAttention({ ...a, userId: getOrCreateUserId(user('99', '43')) }).status).toBe('invalid');
  });
  it('checks recalls again after claim, and removes recalled quote copies only', () => {
    const a = attention(conversation());
    const quote = getOrCreateMessageId({ conversation: conversation(), id: '11' });
    f.db.prepare('INSERT INTO onebot_message_recalls VALUES (?, ?, ?, ?)').run(a.chatId, quote, '42', Date.now());
    expect(inspectMetaAttention({ ...a, payload: { replyTo: { messageId: quote, textSnippet: 'RECALLED' } } }))
      .toMatchObject({ status: 'valid', value: { payload: { replyTo: undefined } } });
    f.db.prepare('INSERT INTO onebot_message_recalls VALUES (?, ?, ?, ?)').run(a.chatId, a.messageId, '42', Date.now());
    expect(inspectMetaAttention(a)).toMatchObject({ status: 'invalid', reason: 'message_recalled' });
  });
  it('holds missing provenance rather than making unknown input public', async () => {
    f.raw.push(JSON.stringify({ id: 'legacy', layer: 'L1', textPreview: 'UNSCOPED_PRIVATE' }));
    expect(await new AttentionAccumulator().flush()).toEqual([]);
    expect(f.archive).toHaveBeenCalledOnce();
    expect(JSON.parse(f.archive.mock.calls[0]![2] as string).input.textPreview).toBe('UNSCOPED_PRIVATE');
  });
  it('retains an unavailable identity read for retry, then returns the same valid item', async () => {
    const a = attention(conversation()); f.raw.push(JSON.stringify(a));
    const acc = new AttentionAccumulator(); f.unavailable = true;
    expect(await acc.flush()).toEqual([]); expect(f.archive).not.toHaveBeenCalled(); expect(f.raw).toHaveLength(1);
    f.unavailable = false;
    expect(await acc.flush()).toEqual([a]);
  });
  it('does not let a failed quarantine write fall back to unverified dispatch', async () => {
    const a = attention(conversation('123', '43')); f.raw.push(JSON.stringify(a));
    f.archive.mockRejectedValueOnce(new Error('synthetic archive unavailable'));
    const acc = new AttentionAccumulator(); expect(await acc.flush()).toEqual([]); expect(f.raw).toHaveLength(1);
    expect(await acc.flush()).toEqual([]); expect(f.raw).toHaveLength(0); expect(f.archive).toHaveBeenCalledTimes(2);
  });
  it('validates callback against the original task instead of trusting callback.chatId', async () => {
    const t = task(attention(conversation('99', '42', 'private'))); getGlobalState().putTask(t);
    expect((await inspectMetaCallback(callback(t))).status).toBe('valid');
    expect(await inspectMetaCallback({ ...callback(t), chatId: getOrCreateConversationId(conversation()) }))
      .toMatchObject({ status: 'invalid', reason: 'task_chat_mismatch' });
    expect(await inspectMetaCallback({ ...callback(t), taskId: 'unknown' }))
      .toMatchObject({ status: 'invalid', reason: 'unknown_task_provenance' });
  });
  it('loads a durable callback task after restart and checks both ID and chat', async () => {
    const t = task(attention(conversation())); f.loadTask.mockResolvedValueOnce(JSON.stringify(t));
    expect((await inspectMetaCallback(callback(t))).status).toBe('valid');
    f.loadTask.mockResolvedValueOnce(JSON.stringify({ ...t, id: 'different-task' }));
    expect(await inspectMetaCallback(callback(t))).toMatchObject({ status: 'invalid', reason: 'task_chat_mismatch' });
  });
  it('distinguishes a temporary task-store outage from an absent legacy task', async () => {
    const t = task(attention(conversation())); f.loadTask.mockRejectedValueOnce(new Error('synthetic redis unavailable'));
    expect(await inspectMetaCallback(callback(t))).toMatchObject({ status: 'unavailable', reason: 'task_store_unavailable' });
    expect(await inspectMetaCallback(callback(t))).toMatchObject({ status: 'invalid', reason: 'unknown_task_provenance' });
  });
  it('validates queued tasks before model execution, including related quotes', () => {
    const a = attention(conversation()), b = attention(conversation('456')), t = task(a);
    expect(inspectMetaTaskScope(t).status).toBe('valid'); expect(checkCodeActTaskActivation(t).allowed).toBe(true);
    expect(checkCodeActTaskActivation({ ...t, relatedQuoteIds: [b.messageId!] }))
      .toEqual({ allowed: false, reason: 'task_scope_invalid' });
    expect(checkCodeActTaskActivation({ ...t, pendingUserInput: [{ text: 'FOREIGN_INPUT', messageId: b.messageId }] }))
      .toEqual({ allowed: false, reason: 'task_scope_invalid' });
  });
});
