import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MetaRedisFixture } from '../../helpers/meta-redis.js';
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

const f = vi.hoisted(() => ({ db: null as unknown as Database.Database, redis: null as unknown as MetaRedisFixture,
  recalled: new Set<number>(), cfg: { META_PENDING_INTENT_ENABLED: true, BOT_TOKEN: '12345:synthetic',
    META_L0_COALESCE_MS: 2800, META_DIRECT_COALESCE_MS: 800, META_DIRECT_COALESCE_MAX_MS: 2000, META_ATTENTION_TOP_N: 30 } }));
vi.mock('../../../src/env.js', () => ({ env: () => f.cfg }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => f.redis }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/meta/loop.js', () => ({ metaTick: vi.fn() }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: (_chat: number, id: number) => f.recalled.has(id) }));
vi.mock('../../../src/meta/input-scope.js', () => ({ inspectMetaAttention: (value: unknown) => ({ status: 'valid', value }), holdMetaScopeInput: async () => true }));
import { assertPendingIntentCurrent, confirmPendingIntent, inspectPendingIntent, observePendingIntent, pendingIntentForEvent,
  pendingInputControl, settlePendingIntent, isTaskInputAuthor } from '../../../src/meta/pending-intent.js';
import { _resetAttentionAccumulator, getAttentionAccumulator } from '../../../src/meta/attention.js';
import * as pendingStore from '../../../src/meta/pending-intent.js';

function message(id: number, text = '帮我看看', uid = 20, thread = 0, edit?: { at: number; update: number }): FormattedMessage {
  return { role: 'user', uid, username: '', fullName: `synthetic-${uid}`, timestamp: Date.now() / 1000,
    messageId: id, messageThreadId: thread || undefined, textContent: text, isForwarded: false,
    eventIdentity: createMessageEventIdentity({ ref: { conversation: { platform: 'telegram', accountId: '12345',
      idNamespace: 'telegram', conversationKind: 'group', id: '-100', ...(thread ? { threadId: String(thread) } : {}) }, id: String(id) },
      occurredAt: 1_700_000_000_000, receivedAt: Date.now(), edit: !!edit, editedAt: edit?.at, updateId: edit?.update, content: text }) };
}
async function intake(m: FormattedMessage, layer: 'L0' | 'L1' = 'L0') {
  m.pendingIntent = observePendingIntent(-100, m);
  return getAttentionAccumulator().ingestAsync({ chatId: -100, userId: m.uid, messageId: m.messageId, layer,
    reason: layer === 'L0' ? 'direct' : 'heart:reply', textPreview: m.textContent, messageThreadId: m.messageThreadId, pendingIntent: m.pendingIntent });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
  f.db = new Database(':memory:'); f.db.exec(readFileSync('migrations/0129_pending_reply_intents.sql', 'utf8'));
  f.redis = new MetaRedisFixture(); f.recalled.clear(); f.cfg.META_PENDING_INTENT_ENABLED = true; f.cfg.BOT_TOKEN = '12345:synthetic';
  _resetAttentionAccumulator();
});
afterEach(() => { _resetAttentionAccumulator(); f.db.close(); vi.useRealTimers(); });

describe('host-owned pending reply revisions', () => {
  it('deduplicates a replay and never upgrades the generation snapshot on send', () => {
    const a = message(1); const ref = observePendingIntent(-100, a)!;
    expect(observePendingIntent(-100, a)).toEqual(ref);
    expect(pendingIntentForEvent(a.eventIdentity!.eventId)).toEqual(ref);
    assertPendingIntentCurrent(ref);
    const next = observePendingIntent(-100, message(2, '刚才数字改成18'))!;
    expect(next).toMatchObject({ intentId: ref.intentId, revision: 2 });
    expect(() => assertPendingIntentCurrent(ref)).toThrow('pending_intent_changed');
    assertPendingIntentCurrent(next);
    expect(ref.revision).toBe(1);
  });
  it('isolates same raw sender across account, thread and actor; a stranger cannot cancel', () => {
    const a = observePendingIntent(-100, message(1))!;
    const stranger = observePendingIntent(-100, message(2, '不用了', 21))!;
    const thread = observePendingIntent(-100, message(3, '不用了', 20, 9))!;
    expect(stranger.laneKey).not.toBe(a.laneKey); expect(thread.laneKey).not.toBe(a.laneKey);
    assertPendingIntentCurrent(a);
    f.cfg.BOT_TOKEN = '67890:synthetic';
    expect(() => assertPendingIntentCurrent(a)).toThrow();
    expect(observePendingIntent(-100, message(4))).toBeUndefined(); // old account provenance rejected
  });
  it('cancels only the matching intent and does not revive it via an old edit', () => {
    const a = observePendingIntent(-100, message(1))!;
    observePendingIntent(-100, message(2, '不用了'));
    expect(inspectPendingIntent(a).state).toBe('cancelled');
    expect(observePendingIntent(-100, message(1, '旧消息更改', 20, 0, { at: Date.now(), update: 3 }))).toBeUndefined();
    const b = observePendingIntent(-100, message(3, '现在问另一件事'))!;
    expect(b.intentId).not.toBe(a.intentId); assertPendingIntentCurrent(b);
  });
  it('binds edits to the source author and orders two same-second edits without original rollback', () => {
    const original = message(1); observePendingIntent(-100, original);
    const first = message(1, '18元', 20, 0, { at: Date.now(), update: 2 });
    const a = observePendingIntent(-100, first)!;
    vi.setSystemTime(Date.now() + 10);
    const b = observePendingIntent(-100, message(1, '28元', 20, 0, { at: first.eventIdentity!.editedAt!, update: 3 }))!;
    expect(b.revision).toBe(3); expect(() => assertPendingIntentCurrent(a)).toThrow();
    expect(observePendingIntent(-100, message(1, 'forged author', 21, 0, { at: Date.now(), update: 4 }))).toBeUndefined();
    expect(observePendingIntent(-100, original)?.revision).toBe(1);
    assertPendingIntentCurrent(b);
  });
  it('keeps a confirmed prefix after correction without settling the newer revision', () => {
    const first = observePendingIntent(-100, message(1))!;
    confirmPendingIntent(first);
    const next = observePendingIntent(-100, message(2))!;
    confirmPendingIntent(first); settlePendingIntent(first);
    expect(f.db.prepare('SELECT state,revision,confirmed_revision FROM pending_reply_intents').get())
      .toEqual({ state: 'pending', revision: 2, confirmed_revision: 1 });
    assertPendingIntentCurrent(next);
    settlePendingIntent(next); expect(inspectPendingIntent(next).state).toBe('settled');
  });
  it('checks recalled real source IDs immediately before output', () => {
    const a = observePendingIntent(-100, message(1))!;
    f.recalled.add(1); expect(() => assertPendingIntentCurrent(a)).toThrow('pending_intent_recalled');
  });
  it('a real edit after a confirmed settled answer creates a new generation', () => {
    const original = message(1); const first = observePendingIntent(-100, original)!;
    confirmPendingIntent(first); settlePendingIntent(first);
    vi.setSystemTime(Date.now() + 1000);
    const edit = observePendingIntent(-100, message(1, '修正成28元', 20, 0, { at: Date.now(), update: 20 }))!;
    expect(edit.intentId).not.toBe(first.intentId); expect(edit.revision).toBe(1);
    assertPendingIntentCurrent(edit); expect(() => assertPendingIntentCurrent(first)).toThrow();
    expect(observePendingIntent(-100, original)).toEqual(first); // replay never becomes the new draft
    assertPendingIntentCurrent(edit);
  });
  it('a newer genuine edit of an older answered topic replaces only this author lane', () => {
    const first = observePendingIntent(-100, message(1))!; settlePendingIntent(first);
    const current = observePendingIntent(-100, message(2, '另一件事'))!;
    const other = observePendingIntent(-100, message(3, '别人的问题', 21))!;
    const edit = observePendingIntent(-100, message(1, '更正旧问题', 20, 0, { at: Date.now(), update: 30 }))!;
    expect(edit.intentId).not.toBe(current.intentId); assertPendingIntentCurrent(edit); assertPendingIntentCurrent(other);
    expect(() => assertPendingIntentCurrent(current)).toThrow();
    observePendingIntent(-100, message(4, '不用了')); observePendingIntent(-100, message(5, '新问题'));
    expect(observePendingIntent(-100, message(1, '不复活已取消来源', 20, 0, { at: Date.now(), update: 31 }))).toBeUndefined();
  });
  it('requires actual task author and topic, never display names', () => {
    const task = { chatId: -100, targetUserId: 20, messageThreadId: 9 };
    expect(isTaskInputAuthor(task, { chatId: -100, userId: 20, messageThreadId: 9 })).toBe(true);
    expect(isTaskInputAuthor(task, { chatId: -100, userId: 21, messageThreadId: 9 })).toBe(false);
    expect(isTaskInputAuthor(task, { chatId: -100, userId: 20 })).toBe(false);
    expect(isTaskInputAuthor(task, { chatId: -200, userId: 20, messageThreadId: 9 })).toBe(false);
  });
  it('does not interpret quoted examples or long text as stop/hold', () => {
    expect(pendingInputControl('等我贴完再说')).toBe('hold');
    expect(pendingInputControl('发完了')).toBe('release');
    expect(pendingInputControl('例子中的“等我发完”是什么意思')).toBeNull();
    expect(pendingInputControl('别停下来')).toBeNull();
  });
});

describe('existing Attention scheduling with durable intent lanes', () => {
  it('explicit wait survives normal max and only same-author release makes inputs eligible', async () => {
    await intake(message(1, '等我发完'));
    await vi.advanceTimersByTimeAsync(5000);
    await intake(message(2, '第一部分数字是18'));
    await intake(message(3, '好了', 21));
    await vi.advanceTimersByTimeAsync(5000);
    expect((await getAttentionAccumulator().flush()).map(x => x.messageId)).toEqual([3]);
    await intake(message(4, '发完了'));
    await vi.advanceTimersByTimeAsync(801);
    expect((await getAttentionAccumulator().flush()).map(x => x.messageId)).toEqual([1, 2, 4]);
  });
  it('other people cannot postpone an earlier direct lane', async () => {
    await intake(message(1));
    await vi.advanceTimersByTimeAsync(500); await intake(message(2, '另一个问题', 21));
    await vi.advanceTimersByTimeAsync(301);
    expect((await getAttentionAccumulator().flush()).map(x => x.messageId)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(500);
    expect((await getAttentionAccumulator().flush()).map(x => x.messageId)).toEqual([2]);
  });
  it('an explicit hold is not silently expired by the ordinary thirty-minute queue age', async () => {
    await intake(message(1, '等我贴完')); expect(await getAttentionAccumulator().flush()).toEqual([]);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    expect(await getAttentionAccumulator().flush()).toEqual([]);
    expect(await getAttentionAccumulator().size()).toBe(1);
    await intake(message(2, '发完了')); await vi.advanceTimersByTimeAsync(801);
    expect((await getAttentionAccumulator().flush()).map(item => item.messageId)).toEqual([1, 2]);
  });
  it('bounds a continuous passive lane at four seconds instead of endless quiet resets', async () => {
    await intake(message(1), 'L1');
    for (let id = 2; id <= 5; id++) { await vi.advanceTimersByTimeAsync(1000); await intake(message(id), 'L1'); }
    expect((await getAttentionAccumulator().flush()).map(x => x.messageId)).toEqual([1,2,3,4,5]);
  });
  it('late Heart results alone cannot dispatch an older revision', async () => {
    const old = message(1); old.pendingIntent = observePendingIntent(-100, old);
    observePendingIntent(-100, message(2, '补充最新约束'));
    await getAttentionAccumulator().ingestAsync({ chatId: -100, userId: 20, messageId: 1, layer: 'L0', reason: 'late heart', pendingIntent: old.pendingIntent });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await getAttentionAccumulator().flush()).toEqual([]);
  });
  it('retains claimed input when the final revision read becomes unavailable', async () => {
    await intake(message(1)); await vi.advanceTimersByTimeAsync(801);
    const actual = pendingStore.inspectPendingIntent;
    const read = vi.spyOn(pendingStore, 'inspectPendingIntent').mockImplementationOnce(actual)
      .mockImplementationOnce(() => { throw new Error('synthetic SQLite unavailable'); });
    expect(await getAttentionAccumulator().flush()).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2); read.mockRestore();
    expect((await getAttentionAccumulator().flush()).map(item => item.messageId)).toEqual([1]);
  });
});
