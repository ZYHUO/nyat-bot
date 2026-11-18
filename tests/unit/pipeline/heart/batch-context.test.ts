import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeartInput } from '../../../../src/pipeline/heart/decision.js';
import type { FormattedMessage } from '../../../../src/shared/types.js';
import { createMessageEventIdentity } from '../../../../src/shared/event-identity.js';

const f = vi.hoisted(() => ({ call: vi.fn(), counter: vi.fn(), config: { OUTCOME_TRACKING_ENABLED: false, HEART_REFLECT_ENABLED: false, TIMING_GATE_TIMEOUT_MS: 8000,
  META_TG_GROUP_COALESCE_MS: 100, META_TG_GROUP_COALESCE_CHAT_IDS: [-123], META_PENDING_INTENT_ENABLED: true,
  META_SUBAGENT_ENABLED: true, META_SUBAGENT_CHAT_IDS: [], HEART_ENABLED: true, META_HEART_ENABLED: true, META_HEART_BYPASS_CHAT_IDS: [],
} }));
vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: f.call }));
vi.mock('../../../../src/shared/config.js', () => ({ loadCachedPrompt: () => '固定身份和权限规则 {self_state}' }));
vi.mock('../../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../src/meta/answered.js', () => ({ answeredTimestamps: async () => [] }));
vi.mock('../../../../src/metrics/registry.js', () => ({ incrCounter: f.counter }));
vi.mock('../../../../src/metrics/social-ledger.js', () => ({ recordDecision: vi.fn() }));
vi.mock('../../../../src/pipeline/judge/rules.js', () => ({ isMentioningSelf: () => false }));
vi.mock('../../../../src/bot/bot.js', () => ({ getBotIdentity: () => ({ uid: 9, username: 'test_bot', nicknames: [] }) }));
vi.mock('../../../../src/platform/identity-store.js', () => ({ isPlatformInternalId: () => false }));
import { heartDecision } from '../../../../src/pipeline/heart/decision.js';

function message(id: number, uid: number, text: string, chatId = -123, threadId = 7): FormattedMessage {
  return { role: 'user', uid, username: `user${uid}`, fullName: `名字${uid}`, messageId: id, messageThreadId: threadId,
    timestamp: 123456, textContent: text, isForwarded: false,
    eventIdentity: createMessageEventIdentity({ ref: { conversation: { platform: 'telegram', idNamespace: 'telegram',
      accountId: '12345', id: String(chatId), conversationKind: 'group', threadId: String(threadId) }, id: String(id) }, occurredAt: 123456000 }) };
}
function input(): HeartInput {
  const first = message(1, 11, '第一个问题'), second = message(2, 11, '第一个问题的补充'), third = message(3, 22, '另一个人的问题');
  second.replyTo = { messageId: 1, uid: 11, fullName: '名字11', textSnippet: '第一个问题' };
  return { chatId: -123, message: third, batchMessages: [first, second, third], targetMessageIds: [2, 3],
    recentMessages: [message(99, 33, '同话题之前讨论'), message(98, 33, 'CROSS_CHAT_CANARY', -999), message(97, 33, 'CROSS_TOPIC_CANARY', -123, 8)],
    botUid: 9, botName: '测试喵', selfState: { narration: '正在听', narrationNoThought: '正在听', energy: 1 } };
}
function reply(targets?: unknown): void {
  f.call.mockResolvedValue({ content: JSON.stringify({ act: 'reply', path: 'chat', why: '可以接话',
    ...(targets !== undefined ? { targetMessageIds: targets } : {}) }) });
}
beforeEach(() => { f.call.mockReset(); f.counter.mockReset(); f.config.HEART_REFLECT_ENABLED = false;
  f.config.META_TG_GROUP_COALESCE_MS = 100; reply([2, 3]); });

describe('Heart batch context and target contract', () => {
  it('renders the whole scope-bound batch once with true speaker IDs, source IDs and replies', async () => {
    const result = await heartDecision(input());
    expect(result.targetMessageIds).toEqual([2, 3]); expect(f.call).toHaveBeenCalledOnce();
    const prompt = f.call.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === 'user').content;
    for (const text of ['第一个问题', '第一个问题的补充', '另一个人的问题', '同话题之前讨论', '⟨uid:11⟩', '⟨uid:22⟩', '#1', '#2', '#3', '→回复', '[2,3]']) expect(prompt).toContain(text);
    expect(prompt).not.toContain('CROSS_CHAT_CANARY'); expect(prompt).not.toContain('CROSS_TOPIC_CANARY');
    expect(prompt).toContain('对整批消息做一次决定');
  });

  it.each([
    { act: 'wait', selection: undefined, expected: [2, 3] },
    { act: 'wait', selection: [2], expected: [2] },
    { act: 'wait', selection: [99], expected: null },
    { act: 'wait', selection: ['2'], expected: null },
    { act: 'react', selection: [2], expected: null },
    { act: 'react', selection: undefined, expected: [3] },
  ])('binds $act with $selection to the reconsidered source set', async ({ act, selection, expected }) => {
    const value = input();
    value.reconsideringMessageIds = [2];
    f.call.mockResolvedValue({ content: JSON.stringify({ act, path: 'chat', why: '看看后续', targetMessageIds: selection }) });
    const decision = await heartDecision(value);
    expect(decision).toMatchObject(expected ? { act, targetMessageIds: expected } : { act: 'pass', why: 'batch_targets_invalid' });
    expect(f.call.mock.calls[0]![0].messages.at(-1).content).toContain('现在重评的消息 ID：[2]');
  });

  it.each(['chat', 'topic', 'account'] as const)('rejects a mixed %s batch before any model call', async mismatch => {
    const value = input(), wrong = value.batchMessages![0]!;
    if (mismatch === 'chat') wrong.eventIdentity!.ref.conversation.id = '-999';
    if (mismatch === 'topic') wrong.messageThreadId = 8;
    if (mismatch === 'account') wrong.eventIdentity!.ref.conversation.accountId = 'another';
    expect(await heartDecision(value)).toMatchObject({ act: 'pass', why: 'batch_scope_invalid' });
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each([[], [999], [2, 999], '2', [2.5], [0], [true]])('rejects explicit invalid/empty targets %j without latest-message fallback', async targets => {
    reply(targets); expect(await heartDecision(input())).toMatchObject({ act: 'pass', why: 'batch_targets_invalid' });
  });

  it('rejects omitted targets when multiple independent anchors could be meant', async () => {
    reply(); expect(await heartDecision(input())).toMatchObject({ act: 'pass', why: 'batch_targets_invalid' });
  });

  it('allows omitted targets only when the host supplied a unique current anchor', async () => {
    reply(); const value = input(); value.targetMessageIds = [3];
    expect(await heartDecision(value)).toMatchObject({ act: 'reply', targetMessageIds: [3] });
  });

  it('does not authorize a source outside the host-supplied target set merely because it is batch context', async () => {
    reply([1]); expect(await heartDecision(input())).toMatchObject({ act: 'pass', why: 'batch_targets_invalid' });
  });

  it('normalizes duplicate selections without inventing another target', async () => {
    reply([2, 2]); expect(await heartDecision(input())).toMatchObject({ act: 'reply', targetMessageIds: [2] });
  });

  it('counts actual logical primary, repair and reflection calls and preserves selected context during reflection', async () => {
    f.config.HEART_REFLECT_ENABLED = true;
    f.call.mockResolvedValueOnce({ content: 'invalid JSON' })
      .mockResolvedValueOnce({ content: JSON.stringify({ act: 'reply', path: 'chat', why: '接第一个问题', targetMessageIds: [2] }) })
      .mockResolvedValueOnce({ content: '说清引用的依据' });
    expect(await heartDecision(input())).toMatchObject({ act: 'reply', targetMessageIds: [2] });
    expect(f.counter.mock.calls.filter(([name]) => name === 'telegram_heart_model_calls_total')).toEqual([
      ['telegram_heart_model_calls_total', { phase: 'primary' }], ['telegram_heart_model_calls_total', { phase: 'repair' }],
      ['telegram_heart_model_calls_total', { phase: 'reflect' }],
    ]);
    const reflection = f.call.mock.calls[2]![0].messages;
    expect(reflection[0].content).toContain('消息 [2]'); expect(reflection[1].content).toContain('第一个问题的补充');
    expect(reflection[1].content).not.toContain('CROSS_CHAT_CANARY');
  });

  it('does not count targeted WAIT calls outside the enabled Telegram batch rollout', async () => {
    f.config.META_TG_GROUP_COALESCE_MS = 0; f.config.HEART_REFLECT_ENABLED = true;
    f.call.mockResolvedValueOnce({ content: 'invalid JSON' })
      .mockResolvedValueOnce({ content: JSON.stringify({ act: 'reply', path: 'chat', why: '正常等待重评', targetMessageIds: [2] }) })
      .mockResolvedValueOnce({ content: '保持目标归属' });
    expect(await heartDecision(input())).toMatchObject({ act: 'reply', targetMessageIds: [2] });
    expect(f.call).toHaveBeenCalledTimes(3);
    expect(f.counter.mock.calls.filter(([name]) => name === 'telegram_heart_model_calls_total')).toEqual([]);
  });
});
