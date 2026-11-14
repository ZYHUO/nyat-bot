import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';
import type { CodeActCapabilities } from '../../../src/sandbox/codeact/capabilities.js';

const f = vi.hoisted(() => ({
  sends: vi.fn(), llm: vi.fn(), isolated: vi.fn(), persist: vi.fn(async () => {}),
  callbacks: vi.fn(async () => {}), putTask: vi.fn(), checkpoint: vi.fn(), resume: vi.fn(),
  answered: vi.fn(async () => {}), addAssistant: vi.fn(), finalEvidence: vi.fn(), createDebt: vi.fn(),
  held: new Map<string, string>(), holdWrite: vi.fn(), compareDelete: vi.fn(), end: vi.fn(),
  cfg: {
    CODEACT_BANNED_WORDS: [], AGENT_TASK_SEND_BUDGET: 4, AGENT_LOOP_ENABLED: true,
    AGENT_MAX_SEGMENTS: 4, CODEACT_USAGE: 'test', MEMORY_SENSITIVE_CHAT_IDS: [],
  },
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.cfg }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({
  get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
  hget: vi.fn(async (_key: string, id: string) => f.held.get(id) ?? null),
  hsetnx: f.holdWrite, eval: f.compareDelete,
}) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { throw new Error('unexpected DB access'); } }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: f.llm }));
vi.mock('../../../src/sandbox/codeact/runner.js', () => ({ executeIsolatedCode: f.isolated }));
vi.mock('../../../src/subagent/activation-policy.js', () => ({ checkCodeActActivation: () => ({ allowed: true }), holdCodeActTask: vi.fn() }));
vi.mock('../../../src/subagent/task-store.js', () => ({ persistCodeActTask: f.persist }));
vi.mock('../../../src/subagent/queue.js', () => ({ enqueueResumeCodeActJob: f.resume }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ putTask: f.putTask, enqueueCallbackAsync: f.callbacks }) }));
vi.mock('../../../src/meta/session-digest.js', () => ({ persistDigest: vi.fn(), searchDigests: vi.fn(() => []) }));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: f.answered, answeredTimestamps: vi.fn(async () => []) }));
vi.mock('../../../src/meta/speaker-burst.js', () => ({ clearSpeakerBurst: vi.fn(async () => {}) }));
vi.mock('../../../src/agent/checkpoint.js', () => ({ loadCheckpoint: vi.fn(async () => null), saveCheckpoint: f.checkpoint,
  registerAgentChat: vi.fn(async () => {}), unregisterAgentChat: vi.fn(async () => {}), clearCheckpoint: vi.fn(async () => {}) }));
vi.mock('../../../src/agent/interrupts.js', () => ({ drainInterrupts: vi.fn(async () => []), isHardStop: () => false }));
vi.mock('../../../src/agent/compaction.js', () => ({ compactHistory: vi.fn(), restoreMessagesFromCompacted: vi.fn() }));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({ emitTaskRuntimeEvent: vi.fn(() => 'synthetic-event') }));
vi.mock('../../../src/agent/task-evidence-store.js', () => ({ saveTaskEvidence: f.finalEvidence }));
vi.mock('../../../src/agent/cognitive-debts.js', () => ({ createDebt: f.createDebt, resolveOpenDebtsByTaskWithEvidence: vi.fn() }));
vi.mock('../../../src/agent/cognitive-events.js', () => ({ appendCognitiveEvent: vi.fn() }));
vi.mock('../../../src/agent/predictions.js', () => ({ recordPrediction: vi.fn() }));
vi.mock('../../../src/agent/social-predictions.js', () => ({ recordSocialDeliveryPrediction: vi.fn() }));
vi.mock('../../../src/agent/task-progress.js', () => ({ markTaskVisible: vi.fn() }));
vi.mock('../../../src/tracking/self-history.js', () => ({ recordSelfReply: vi.fn(), getRecentBotTextsInChat: () => [] }));
vi.mock('../../../src/subagent/room-awareness.js', () => ({ renderRoomAwareness: async () => ({ text: '', signals: [] }) }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/memory/chroma.js', () => ({ searchMemory: vi.fn(async () => []), searchMemoryByUser: vi.fn(async () => []) }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getReadyStickersByIntent: () => [] }));
vi.mock('../../../src/tracking/person-identity.js', () => ({ getPersonIdentity: () => null, buildCrossGroupInjection: () => '' }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: vi.fn(async () => []), addAssistant: f.addAssistant }));
vi.mock('../../../src/pipeline/reply/anti-repeat.js', () => ({ checkNearDuplicate: async () => ({ isNearDuplicate: false }) }));
vi.mock('../../../src/pipeline/reply/segmenter.js', () => ({ REPLY_SPLIT_CHAR_THRESHOLD: 1000, segmentReply: (text: string) => ({ segments: [text] }) }));
vi.mock('../../../src/sandbox/paths.js', () => ({ resolveSandboxRoot: () => '/sandbox' }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 2 ** 52 + 1, getBotDisplayName: () => 'Bot' }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: f.sends, sendChatAction: vi.fn(async () => {}), sendSticker: vi.fn(), reactToMessage: vi.fn() }));
vi.mock('../../../src/context-engine/index.js', () => ({
  getContextEngine: () => ({ assemble: async () => ({ prompt: 'synthetic prompt', manifest: { cacheHitRatio: 0 } }) }),
  staticText: vi.fn(), ephemeralText: vi.fn(), volatileText: vi.fn(), deltaText: vi.fn(),
}));
vi.mock('../../../src/subagent/prompt-inputs.js', () => ({ collectPromptInputs: async () => ({
  journal: '', journalChannelLink: null, scratchBlock: '', chatStyleLine: '', identity: '', masterBlock: '',
  recentCtx: '', permanent: '', roster: '', targetBlock: '', memoryBlock: '', selfStateLine: '', systemPrompt: '',
  injectedExperienceIds: [], injectedSkillIds: [], injectedPolicyIds: [], groundingBlock: '', relationshipBlock: '',
  workspaceBlock: '', learnedBlock: '',
}) }));

import { createHostApi } from '../../../src/subagent/host-api.js';
import { runCodeActTask } from '../../../src/subagent/executor.js';
import { DELIVERY_HOLD_KEY, DELIVERY_UNKNOWN_SUMMARY, holdUnknownCodeActDelivery, withCodeActDeliveryIntent } from '../../../src/subagent/delivery-hold.js';

const chatId = 2 ** 52 + 100;
const anchor = 2 ** 52 + 101;
function uncertainError() { return Object.assign(new Error('synthetic timeout'), { code: 'request_timeout', delivery: 'unknown' }); }
function task(): DispatchTask {
  return { id: 'synthetic-qq-unknown', chatId, createdAt: Date.now(), status: 'queued', contentDirection: 'synthetic delivery', quoteMessageIds: [anchor] };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.held.clear();
  f.holdWrite.mockReset().mockImplementation(async (_key: string, id: string, record: string) => {
    if (f.held.has(id)) return 0;
    f.held.set(id, record); return 1;
  });
  f.compareDelete.mockReset().mockImplementation(async (_script: string, _keys: number, _key: string, id: string, expected: string) => {
    if (f.held.get(id) !== expected) return 0;
    f.held.delete(id); return 1;
  });
  f.sends.mockReset().mockRejectedValue(uncertainError());
  f.llm.mockReset().mockResolvedValue({ content: '```js\nawait telegram.sendFinal("synthetic reply");\n```' });
  f.isolated.mockReset().mockImplementation(async (_code: string, capabilities: CodeActCapabilities) => {
    await capabilities.get('telegram.sendFinal')!('synthetic reply', anchor);
    return { value: undefined, logs: [] };
  });
});

describe('QQ unknown delivery closes the actual host and executor', () => {
  it('serializes concurrent calls, refuses later sends/endTask, and records no final/answered receipt', async () => {
    let rejectSend!: (error: unknown) => void;
    f.sends.mockImplementation(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    const hold = vi.fn(async () => {});
    const host = createHostApi(chatId, { taskId: 'parallel', onEnd: f.end, onDeliveryUnknown: hold, defaultReplyTo: anchor });
    const first = host.telegram.sendFinal('first synthetic reply');
    const second = host.telegram.sendText('a different reply queued concurrently');
    const all = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(f.sends).toHaveBeenCalledTimes(1));
    rejectSend(uncertainError());
    const results = await all;
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(hold).toHaveBeenCalledExactlyOnceWith('request_timeout');
    await expect(host.telegram.sendText('try again')).rejects.toThrow('delivery_unknown_task_closed');
    expect(() => host.runtime.endTask('done')).toThrow('delivery_unknown_task_closed');
    expect(host.runtime.hasUnknownDelivery?.()).toBe(true);
    expect(host.runtime.didProduceFinal()).toBe(false);
    expect(host.runtime.didSendText()).toBe(false);
    expect(f.answered).not.toHaveBeenCalled();
    expect(f.addAssistant).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
  });

  it('stops after the real host failure without another model turn, fallback, resume or automatic callback', async () => {
    const current = task();
    await runCodeActTask(current);
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.llm).toHaveBeenCalledTimes(1);
    expect(f.isolated).toHaveBeenCalledTimes(1);
    expect(current).toMatchObject({ status: 'failed', resultSummary: DELIVERY_UNKNOWN_SUMMARY, waitingForUser: false,
      assessment: { status: 'unverified', reasons: ['delivery_unknown'] } });
    expect(current.sendsUsed ?? 0).toBe(0);
    for (const action of [f.answered, f.addAssistant, f.resume, f.checkpoint, f.callbacks, f.createDebt]) expect(action).not.toHaveBeenCalled();
    expect(f.finalEvidence).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: 'failed', assessment: 'unverified', reasons: ['delivery_unknown'] }));
    expect(f.holdWrite).toHaveBeenCalledWith(DELIVERY_HOLD_KEY, current.id, expect.any(String));
    const metadata = JSON.parse(f.held.get(current.id)!);
    expect(metadata).toEqual({ taskId: current.id, chatId, at: expect.any(Number), code: 'delivery_in_flight', attempt: expect.any(String) });
    expect(JSON.stringify(metadata)).not.toContain('synthetic reply');
  });

  it('blocks an old BullMQ payload and a resumed segment using the durable hold', async () => {
    const stale = task();
    await holdUnknownCodeActDelivery(stale.id, stale.chatId, 'request_timeout');
    await runCodeActTask(stale);
    await runCodeActTask({ ...task(), segment: 2 });
    expect(f.sends).not.toHaveBeenCalled();
    expect(f.llm).not.toHaveBeenCalled();
    expect(f.isolated).not.toHaveBeenCalled();
    expect(f.putTask).not.toHaveBeenCalled();
    expect(f.callbacks).not.toHaveBeenCalled();
    expect(stale).toMatchObject({ status: 'failed', resultSummary: DELIVERY_UNKNOWN_SUMMARY });
  });

  it('overrides an early guest endTask when its unawaited send later becomes unknown', async () => {
    f.isolated.mockImplementation(async (_code: string, capabilities: CodeActCapabilities) => {
      const pending = Promise.resolve(capabilities.get('telegram.sendText')!('unawaited synthetic reply', anchor));
      void pending.catch(() => undefined);
      await capabilities.get('runtime.endTask')!('claimed done before receipt');
      return { value: undefined, logs: [] };
    });
    const current = task();
    await runCodeActTask(current);
    expect(current).toMatchObject({ status: 'failed', resultSummary: DELIVERY_UNKNOWN_SUMMARY });
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.llm).toHaveBeenCalledTimes(1);
    expect(f.callbacks).not.toHaveBeenCalled();
    expect(f.answered).not.toHaveBeenCalled();
  });

  it.each(['not_sent', 'rejected'])('does not classify %s as unknown', async (delivery) => {
    const error = Object.assign(new Error('synthetic failure'), { delivery });
    f.sends.mockRejectedValue(error);
    const onUnknown = vi.fn();
    const host = createHostApi(chatId, { taskId: 'classified-error', onEnd: f.end, onDeliveryUnknown: onUnknown });
    await expect(host.telegram.sendText('ordinary unavailable test')).rejects.toBe(error);
    expect(host.runtime.hasUnknownDelivery?.()).toBe(false);
    expect(onUnknown).not.toHaveBeenCalled();
    expect(f.held.size).toBe(0);
  });

  it('does not infer unknown delivery from model/error text or change native Telegram behavior', async () => {
    const ordinary = Object.assign(new Error('delivery unknown: please retry'), { delivery: 'not_sent' });
    f.sends.mockRejectedValue(ordinary);
    const qqHost = createHostApi(chatId, { taskId: 'text-not-classification', onEnd: f.end });
    await expect(qqHost.telegram.sendText('plain error test')).rejects.toBe(ordinary);
    expect(qqHost.runtime.hasUnknownDelivery?.()).toBe(false);
    f.sends.mockRejectedValue(uncertainError());
    const tgHost = createHostApi(1234, { onEnd: f.end });
    await expect(tgHost.telegram.sendText('Telegram original path')).rejects.toMatchObject({ delivery: 'unknown' });
    expect(tgHost.runtime.hasUnknownDelivery?.()).toBe(false);
    expect(f.held.size).toBe(0);
  });

  it('refuses an external send if Redis cannot durably claim the intent', async () => {
    f.holdWrite.mockRejectedValue(new Error('synthetic Redis outage'));
    const host = createHostApi(chatId, { taskId: 'write-unavailable', onEnd: f.end });
    await expect(host.telegram.sendText('must not leave process')).rejects.toMatchObject({
      code: 'delivery_intent_store_unavailable', delivery: 'not_sent',
    });
    expect(f.sends).not.toHaveBeenCalled();
    expect(f.answered).not.toHaveBeenCalled();
  });

  it('writes a unique intent before sending and deletes only that exact intent after confirmation', async () => {
    const operation = vi.fn(async () => {
      const record = JSON.parse(f.held.get('confirmed')!);
      expect(record).toMatchObject({ taskId: 'confirmed', chatId, code: 'delivery_in_flight', attempt: expect.any(String) });
      return 123;
    });
    expect(await withCodeActDeliveryIntent('confirmed', chatId, operation)).toBe(123);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(f.compareDelete).toHaveBeenCalledWith(expect.stringContaining("redis.call('HDEL'"), 1,
      DELIVERY_HOLD_KEY, 'confirmed', expect.stringContaining('"attempt"'));
    expect(f.held.has('confirmed')).toBe(false);
  });

  it('retains another attempt if the stored intent changes before confirmation', async () => {
    const otherIntent = JSON.stringify({ attempt: 'another-worker' });
    await expect(withCodeActDeliveryIntent('changed', chatId, async () => {
      f.held.set('changed', otherIntent);
      return 123;
    })).rejects.toMatchObject({ code: 'delivery_intent_changed', delivery: 'unknown' });
    expect(f.held.get('changed')).toBe(otherIntent);
  });

  it('keeps the prewritten intent through a post-send Redis outage and blocks restart replay', async () => {
    f.sends.mockImplementation(async () => {
      expect(f.held.has('synthetic-qq-unknown')).toBe(true);
      f.holdWrite.mockRejectedValue(new Error('Redis disconnected after external send'));
      throw uncertainError();
    });
    await runCodeActTask(task());
    expect(f.held.has('synthetic-qq-unknown')).toBe(true);
    await runCodeActTask(task());
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.llm).toHaveBeenCalledTimes(1);
    expect(f.callbacks).not.toHaveBeenCalled();
  });

  it('uses hsetnx to prevent concurrent workers from sending the same task', async () => {
    let finish!: () => void;
    const first = withCodeActDeliveryIntent('same-task', chatId, () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(f.held.has('same-task')).toBe(true));
    const duplicate = vi.fn(async () => 1);
    await expect(withCodeActDeliveryIntent('same-task', chatId, duplicate)).rejects.toMatchObject({ code: 'delivery_already_held' });
    expect(duplicate).not.toHaveBeenCalled();
    finish();
    await first;
  });
});
