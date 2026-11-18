import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from 'grammy/types';
import type { FormattedMessage } from '../../../src/shared/types.js';
import { MetaRedisFixture } from '../../helpers/meta-redis.js';

const f = vi.hoisted(() => ({
  db: vi.fn(), redis: vi.fn(), heart: vi.fn(), gate: vi.fn(), dispatch: vi.fn(), legacy: vi.fn(),
  getRecent: vi.fn(), addMessage: vi.fn(), noAction: vi.fn(), wait: vi.fn(), tick: vi.fn(),
  sleep: vi.fn(), muted: vi.fn(), react: vi.fn(), busy: vi.fn(), runtime: vi.fn(), suppressed: vi.fn(), running: vi.fn(),
  warning: vi.fn(), counter: vi.fn(), postTask: vi.fn(), speaker: vi.fn(), taskId: vi.fn(), loadTask: vi.fn(), interrupt: vi.fn(), config: {
    DURABLE_INGRESS_ENABLED: false,
    META_PENDING_INTENT_ENABLED: true,
    META_TG_GROUP_COALESCE_MS: 100, META_TG_GROUP_COALESCE_MAX_MS: 300, META_TG_GROUP_COALESCE_CHAT_IDS: [-123, -456],
    ALLOWLIST_ENABLED: false, ALLOWLIST_REDIS_PREFIX: 'fixture:allowlist:',
    BOT_TOKEN: '12345:synthetic',
    ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: '42', ONEBOT_OWNER_ID: '99',
    ONEBOT_ALLOWED_GROUP_IDS: '', ONEBOT_ALLOWED_USER_IDS: '', MASTER_UID: 99,
    META_SUBAGENT_ENABLED: true, META_SUBAGENT_CHAT_IDS: [] as number[], META_ACTIVATED_AT_SEC: 1,
    CODEACT_ISOLATION_ENABLED: true, META_ATTENTION_TOP_N: 20, META_L0_COALESCE_MS: 2800,
    META_DIRECT_COALESCE_MS: 0, META_DIRECT_COALESCE_MAX_MS: 2000,
    META_DEFER_ENABLED: false, HEART_ENABLED: true, META_HEART_ENABLED: true,
    META_HEART_BYPASS_CHAT_IDS: [] as number[], META_HEART_REFRACTORY_MS: 20_000,
    META_QQ_HEART_REFRACTORY_MS: 0,
    META_QQ_GROUP_COALESCE_MS: 0, META_QQ_GROUP_COALESCE_MAX_MS: 4000, META_QQ_MENTION_HEART_ENABLED: false,
    HEART_DECIDES_TIMING: false, TIMING_GATE_ENABLED: true, META_DISPATCH_GATE_ENABLED: true,
    TIMING_WAIT_MIN_SEC: 8, BOT_USERNAME: 'fixture_bot', BOT_NICKNAMES: ['fixture-nyat'],
    RATE_LIMIT_PER_MIN: 100, NYATOS_SHADOW_ENABLED: false, TRENCH_DEBT_ATTENTION_ENABLED: false,
  },
}));
const shadow = vi.hoisted(() => ({ observe: vi.fn(), outcome: vi.fn() }));
vi.mock('../../../src/nyatos/shadow.js', () => ({
  runIngressShadow: shadow.observe, recordLiveOutcome: shadow.outcome,
  isNyatosShadowChat: (_chatId: number, opts: { enabled: boolean }) => opts.enabled,
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: f.db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: f.redis }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: f.warning, error: vi.fn() } }));
vi.mock('../../../src/shared/config.js', () => ({ loadCachedPrompt: () => '' }));
vi.mock('../../../src/queue/producer.js', () => ({ enqueue: f.legacy }));
vi.mock('../../../src/agent/cognitive-events.js', () => ({ appendTelegramMessageEvent: () => 'fixture:event' }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ addMessage: f.addMessage, getRecent: f.getRecent }));
vi.mock('../../../src/platform/onebot-media.js', () => ({
  registerOneBotMedia: vi.fn(() => { throw new Error('Cadence fixtures contain no media'); }),
}));
vi.mock('../../../src/memory/chroma.js', () => ({ memorizeMessage: vi.fn() }));
vi.mock('../../../src/tracking/activity.js', () => ({ recordMessage: vi.fn() }));
vi.mock('../../../src/tracking/user-profile.js', () => ({ recordUserMessage: vi.fn() }));
vi.mock('../../../src/tracking/reply-activity.js', () => ({ recordHumanMessage: vi.fn() }));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: async () => false, getSleepPhase: f.sleep }));
vi.mock('../../../src/tracking/life-state.js', () => ({ getLifeState: () => ({ energy: 1 }) }));
vi.mock('../../../src/tracking/self-history.js', () => ({ getSelfActSummary: vi.fn(), renderSelfActSummary: vi.fn() }));
vi.mock('../../../src/agent/cognitive-clock.js', () => ({ nextSelfWake: vi.fn(), renderPendingWake: vi.fn() }));
vi.mock('../../../src/tracking/repair.js', () => ({ findUnrepairedActs: vi.fn(), renderUnrepairedActs: vi.fn() }));
vi.mock('../../../src/metrics/social-ledger.js', () => ({ recordMessageSeen: vi.fn(), recordDecision: vi.fn() }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ reactToMessage: f.react }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: f.counter }));
vi.mock('../../../src/subagent/post-task-window.js', () => ({ ingestIncomingPostTask: f.postTask }));
vi.mock('../../../src/meta/speaker-burst.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/meta/speaker-burst.js')>('../../../src/meta/speaker-burst.js');
  return { markSpeakerBurst: vi.fn(), shouldForceSameSpeakerL0: f.speaker, isInFlightCodeActForUser: actual.isInFlightCodeActForUser };
});
vi.mock('../../../src/meta/loop.js', () => ({ metaTick: f.tick }));
vi.mock('../../../src/meta/ingress-intercepts.js', () => ({
  metaNeedsLegacyPipeline: () => false, metaMuteBlocksReply: f.muted, tryMetaIngressIntercepts: async () => 'continue',
}));
vi.mock('../../../src/meta/bookkeeping.js', () => ({ runMetaBookkeepingHooks: vi.fn(), metaSleepGate: f.sleep, messageHasMedia: () => false }));
vi.mock('../../../src/meta/index.js', async () => {
  const attention = await import('../../../src/meta/attention.js');
  const flags = await import('../../../src/meta/flags.js');
  return { getAttentionAccumulator: attention.getAttentionAccumulator, isMetaSubagentChat: flags.isMetaSubagentChat };
});
vi.mock('../../../src/pipeline/turn/actor.js', () => ({ isTurnActorChat: () => false }));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({ appendPending: vi.fn() }));
vi.mock('../../../src/pipeline/turn/abort-registry.js', () => ({ interruptGeneration: vi.fn() }));
vi.mock('../../../src/pipeline/turn/focus.js', () => ({ bumpFocus: vi.fn() }));
vi.mock('../../../src/queue/turn-scheduler.js', () => ({ scheduleTurn: vi.fn() }));
vi.mock('../../../src/pipeline/turn/obligation-store.js', () => ({
  saveObligation: vi.fn(), setActiveObligationId: vi.fn(), supersedeActiveObligation: vi.fn(),
  getActiveObligationId: vi.fn(), getObligation: vi.fn(), updateObligationState: vi.fn(), setActiveObligation: vi.fn(),
}));
// Keep Heart's engagement/refractory/wait adapter and both timing adapters real.
// Only model decisions and external side effects are controlled by this fixture.
vi.mock('../../../src/pipeline/heart/decision.js', () => ({ heartDecision: f.heart }));
vi.mock('../../../src/pipeline/heart/self-state.js', () => ({ composeSelfState: async () => ({}) }));
vi.mock('../../../src/pipeline/heart/mind.js', () => ({ noteThought: vi.fn() }));
vi.mock('../../../src/pipeline/timing/gate.js', () => ({ runTimingGate: f.gate }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({
  getChatState: f.runtime, getGateCooldownRemainingMs: async () => 0,
  isInContinuation: () => false, isChatSuppressed: f.suppressed,
  cancelWaitForScope: vi.fn(async () => {}), transitionToWait: f.wait, transitionToRunning: f.running, recordGateContinue: vi.fn(async () => {}),
  recordBotReply: vi.fn(), recordUserMessage: vi.fn(async () => {}),
}));
vi.mock('../../../src/pipeline/timing/state-store.js', () => ({ recordGateNoAction: f.noAction }));
vi.mock('../../../src/agent/agency-wait-dispatch.js', () => ({
  dispatchWaitViaAgency: async () => ({ attempted: false }), isAgencyWaitTransportEnabled: () => false,
}));
vi.mock('../../../src/meta/defer.js', () => ({ scheduleMetaDeferReeval: async () => false }));
vi.mock('../../../src/subagent/task-store.js', () => ({ isCodeActBusy: f.busy, loadCodeActTask: f.loadTask }));
vi.mock('../../../src/agent/checkpoint.js', () => ({ getAgentTaskIdForChat: f.taskId }));
vi.mock('../../../src/agent/interrupts.js', async original => ({
  ...await original<typeof import('../../../src/agent/interrupts.js')>(), pushInterrupt: f.interrupt }));
// The real session groups a chat's batch into one dispatch. Capture that final
// boundary, without creating a CodeAct worker, running model code or sending.
vi.mock('../../../src/meta/meta-api.js', () => ({ buildMetaApiContext: () => ({ dispatch: { taskToGroup: f.dispatch }, journal: {} }) }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn(() => { throw new Error('Unexpected model call'); }) }));
vi.mock('../../../src/context-engine/index.js', () => ({
  getContextEngine: vi.fn(() => { throw new Error('Unexpected Meta LLM'); }),
  staticText: vi.fn(), deltaText: vi.fn(), ephemeralText: vi.fn(), volatileText: vi.fn(),
}));
vi.mock('../../../src/cron/dream-journal.js', () => ({ getJournalChannelInfo: async () => null }));
vi.mock('../../../src/meta/session-digest.js', () => ({ persistDigest: vi.fn(), recentDigests: () => [] }));
vi.mock('../../../src/sandbox/codeact/runner.js', () => ({ executeIsolatedCode: vi.fn(() => { throw new Error('Unexpected sandbox execution'); }) }));


import { ingestChatUpdate } from '../../../src/bot/handlers/message.js';
import { getAttentionAccumulator, _resetAttentionAccumulator } from '../../../src/meta/attention.js';
import { _resetTelegramHeartBatches, drainTelegramHeartBatches } from '../../../src/meta/telegram-heart-batch.js';
import { _resetGlobalState, getGlobalState } from '../../../src/meta/global-state.js';

const context = new Map<number, FormattedMessage[]>();
let db: Database.Database;
let redis: MetaRedisFixture;
function incoming(id: number, uid = 99, text = `独立问题 ${id}`, chatId = -123, threadId?: number): Update {
  return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000),
    from: { id: uid, first_name: `用户${uid}`, is_bot: false },
    chat: chatId < 0 ? { id: chatId, type: 'supergroup', title: '测试群' } : { id: chatId, type: 'private', first_name: '测试用户' },
    text, ...(threadId ? { message_thread_id: threadId, is_topic_message: true } : {}) } };
}
async function settle(): Promise<void> { await vi.dynamicImportSettled(); for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function advance(ms = 100): Promise<void> { await vi.advanceTimersByTimeAsync(ms); await settle(); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')); vi.clearAllMocks();
  db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  for (const migration of ['0118_platform_identity', '0120_onebot_notices', '0125_durable_ingress', '0129_pending_reply_intents', '0134_telegram_heart_batches']) {
    db.exec(readFileSync(`migrations/${migration}.sql`, 'utf8'));
  }
  redis = new MetaRedisFixture(); f.db.mockReturnValue(db); f.redis.mockReturnValue(redis); context.clear();
  _resetAttentionAccumulator(); _resetGlobalState(); _resetTelegramHeartBatches();
  Object.assign(f.config, { NYATOS_SHADOW_ENABLED: false, META_PENDING_INTENT_ENABLED: true, META_TG_GROUP_COALESCE_MS: 100,
    META_TG_GROUP_COALESCE_CHAT_IDS: [-123, -456], META_HEART_REFRACTORY_MS: 0,
    ALLOWLIST_ENABLED: false, META_ACTIVATED_AT_SEC: Math.floor(Date.now() / 1000) - 60 });
  f.sleep.mockResolvedValue('awake'); f.muted.mockReturnValue(false); f.react.mockResolvedValue(true);
  f.busy.mockResolvedValue(false); f.speaker.mockResolvedValue(false); f.postTask.mockResolvedValue(false);
  f.taskId.mockResolvedValue(null); f.loadTask.mockResolvedValue(null);
  f.runtime.mockResolvedValue({ state: 'RUNNING', lastBotReplyAt: 0 }); f.suppressed.mockResolvedValue(false);
  f.heart.mockReset().mockImplementation(async (input: { targetMessageIds?: number[] }) => ({ act: 'reply', why: '可自然接话', path: 'chat', latencyMs: 1,
    ...(input.targetMessageIds ? { targetMessageIds: input.targetMessageIds } : {}) }));
  f.gate.mockResolvedValue({ action: 'continue', reason: '合适', shortCircuited: false, latencyMs: 1 });
  f.tick.mockImplementation(async () => {});
  f.addMessage.mockImplementation(async (chatId: number, message: FormattedMessage) => {
    context.set(chatId, [...(context.get(chatId) ?? []), structuredClone(message)]);
  });
  f.getRecent.mockImplementation(async (chatId: number) => context.get(chatId) ?? []);
});
afterEach(async () => { await drainTelegramHeartBatches(); _resetAttentionAccumulator(); vi.clearAllTimers(); vi.useRealTimers(); db.close(); });

describe('Telegram pre-Heart batching through the real message handler', () => {
  it('makes one logical Heart call for three passive messages and preserves independent author anchors', async () => {
    f.config.NYATOS_SHADOW_ENABLED = true;
    f.heart.mockResolvedValue({ act: 'reply', why: '同一问题的补充合并', path: 'chat', latencyMs: 1, targetMessageIds: [2, 3] });
    await ingestChatUpdate(incoming(1, 11, '问题第一部分')); await advance(30);
    await ingestChatUpdate(incoming(2, 11, '问题补充')); await advance(30);
    await ingestChatUpdate(incoming(3, 22, '另一个独立问题'));
    expect(f.heart).not.toHaveBeenCalled(); await advance();
    expect(f.heart).toHaveBeenCalledOnce();
    expect(f.heart.mock.calls[0]![0]).toMatchObject({ chatId: -123, targetMessageIds: [1, 2, 3],
      batchMessages: [expect.objectContaining({ messageId: 1, uid: 11 }), expect.objectContaining({ messageId: 2, uid: 11 }), expect.objectContaining({ messageId: 3, uid: 22 })] });
    expect((await getAttentionAccumulator().peek()).map(item => [item.messageId, item.userId]).sort()).toEqual([[2, 11], [3, 22]]);
    expect(f.postTask).not.toHaveBeenCalled(); expect(f.speaker).not.toHaveBeenCalled();
    expect(shadow.outcome.mock.calls.map(([record]) => record)).toEqual([1, 2, 3].map(messageId => ({
      chatId: -123, messageId, outcome: 'batch_accepted',
    })));
  });

  it('drains simultaneous bursts in sixteen groups within the fresh evaluation concurrency limit', async () => {
    const chats = Array.from({ length: 16 }, (_, index) => -5000 - index);
    f.config.META_TG_GROUP_COALESCE_CHAT_IDS = chats;
    let active = 0;
    let peak = 0;
    f.heart.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      active--;
      return { act: 'pass', why: '旁听', path: 'chat', latencyMs: 20 };
    });
    for (let messageId = 1; messageId <= 8; messageId++) {
      for (const chatId of chats) await ingestChatUpdate(incoming(messageId, 20 + messageId, '群内讨论', chatId));
    }
    await advance(300);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(f.heart).toHaveBeenCalledTimes(chats.length);
    expect(new Set(f.heart.mock.calls.map(([input]) => input.chatId))).toEqual(new Set(chats));
    for (const [input] of f.heart.mock.calls) {
      expect(input.batchMessages.map((m: FormattedMessage) => m.messageId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(input.batchMessages.every((m: FormattedMessage) => m.eventIdentity?.ref.conversation.id === String(input.chatId))).toBe(true);
    }
    expect(await getAttentionAccumulator().peek()).toEqual([]);
  });

  it('dispatches only the model-selected real anchor and never falls back from ambiguous targets', async () => {
    f.heart.mockResolvedValue({ act: 'reply', why: '只接第一个问题', path: 'chat', latencyMs: 1, targetMessageIds: [10] });
    await ingestChatUpdate(incoming(10, 11)); await ingestChatUpdate(incoming(11, 22)); await advance();
    expect((await getAttentionAccumulator().peek()).map(item => item.messageId)).toEqual([10]);
    f.heart.mockResolvedValue({ act: 'reply', why: '归属不明', path: 'chat', latencyMs: 1 });
    await ingestChatUpdate(incoming(12, 33)); await ingestChatUpdate(incoming(13, 44)); await advance();
    expect((await getAttentionAccumulator().peek()).map(item => item.messageId)).toEqual([10]);
  });

  it('keeps accounts/chats/topics separate and evaluates separate topics serially in a chat', async () => {
    await ingestChatUpdate(incoming(20, 11, '话题甲', -123, 7));
    await ingestChatUpdate(incoming(21, 22, '话题乙', -123, 8));
    await ingestChatUpdate(incoming(22, 33, '另一个群', -456)); await advance();
    expect(f.heart).toHaveBeenCalledTimes(3);
    for (const [input] of f.heart.mock.calls) {
      expect(input.batchMessages).toHaveLength(1);
      expect(input.batchMessages[0].eventIdentity.ref.conversation.id).toBe(String(input.chatId));
    }
  });

  it('keeps @ and private input on the fast path while invalidating only the addressed passive scope', async () => {
    await ingestChatUpdate(incoming(30, 11, '待接问题', -123, 7));
    await ingestChatUpdate(incoming(31, 22, '其他话题', -123, 8));
    await ingestChatUpdate(incoming(32, 11, '@fixture_bot 请接话', -123, 7));
    await ingestChatUpdate(incoming(33, 55, '私聊问题', 55)); await settle();
    expect(f.heart).not.toHaveBeenCalled(); await advance();
    expect(f.heart).toHaveBeenCalledOnce(); expect(f.heart.mock.calls[0]![0].message.messageId).toBe(31);
    const attention = await getAttentionAccumulator().peek();
    expect(attention.map(item => item.messageId)).not.toContain(30);
    expect(attention.map(item => item.messageId)).toEqual(expect.arrayContaining([31, 32, 33]));
  });

  it('does not dispatch a late in-flight reply after the sender stops', async () => {
    let release!: (value: unknown) => void;
    f.heart.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await ingestChatUpdate(incoming(40, 11)); await advance(); expect(f.heart).toHaveBeenCalledOnce();
    await ingestChatUpdate(incoming(41, 11, '先别回复'));
    release({ act: 'reply', why: '过时结论', path: 'chat', latencyMs: 1, targetMessageIds: [40] }); await advance();
    const attention = await getAttentionAccumulator().peek();
    expect(attention).toHaveLength(1); expect(attention[0]).toMatchObject({ messageId: 41, reason: 'pending_input_control' });
    expect(f.react).not.toHaveBeenCalled();
  });

  it('waits for an active group evaluation without aborting independent input or running another Heart concurrently', async () => {
    let release!: (value: unknown) => void;
    f.heart.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await ingestChatUpdate(incoming(50, 11)); await advance();
    await ingestChatUpdate(incoming(51, 22)); await advance(); expect(f.heart).toHaveBeenCalledOnce();
    release({ act: 'reply', why: '第一人问题', path: 'chat', latencyMs: 1, targetMessageIds: [50] }); await advance();
    expect(f.heart).toHaveBeenCalledTimes(2);
    expect((await getAttentionAccumulator().peek()).map(item => item.messageId).sort()).toEqual([50, 51]);
  });

  it('drops a muted author before Heart while retaining another author in the same cohort', async () => {
    await ingestChatUpdate(incoming(60, 11)); await ingestChatUpdate(incoming(61, 22));
    f.muted.mockImplementation((_chatId: number, message: FormattedMessage) => message.uid === 11); await advance();
    expect(f.heart).toHaveBeenCalledOnce();
    expect(f.heart.mock.calls[0]![0].batchMessages.map((m: FormattedMessage) => m.messageId)).toEqual([61]);
    expect((await getAttentionAccumulator().peek()).map(item => item.messageId)).toEqual([61]);
  });

  it('rechecks sleep after the model and never publishes a stale allowed verdict', async () => {
    f.heart.mockImplementationOnce(async () => { f.sleep.mockResolvedValue('night'); return { act: 'reply', why: '过时结论', path: 'chat', targetMessageIds: [70], latencyMs: 1 }; });
    await ingestChatUpdate(incoming(70, 11)); await advance();
    expect(f.heart).toHaveBeenCalledOnce(); expect(await getAttentionAccumulator().peek()).toEqual([]);
  });

  it('reconsiders the remaining author when another author becomes muted during the pure evaluation', async () => {
    f.heart.mockImplementationOnce(async () => {
      f.muted.mockImplementation((_chatId: number, message: FormattedMessage) => message.uid === 11);
      return { act: 'reply', why: '旧批判断', path: 'chat', targetMessageIds: [75, 76], latencyMs: 1 };
    });
    await ingestChatUpdate(incoming(75, 11)); await ingestChatUpdate(incoming(76, 22)); await advance(400);
    expect(f.heart).toHaveBeenCalledTimes(2);
    expect(f.heart.mock.calls[1]![0].batchMessages.map((message: FormattedMessage) => message.messageId)).toEqual([76]);
    expect((await getAttentionAccumulator().peek()).map(item => item.messageId)).toEqual([76]);
  });

  it('leaves the existing per-message route active when the opt-in flag is off', async () => {
    f.config.META_TG_GROUP_COALESCE_MS = 0;
    await ingestChatUpdate(incoming(1, 11, '问题第一部分')); await advance(30);
    await ingestChatUpdate(incoming(2, 11, '问题补充')); await advance(30);
    await ingestChatUpdate(incoming(3, 22, '另一个独立问题')); await advance();
    expect(f.heart).toHaveBeenCalledTimes(3);
    expect(f.heart.mock.calls.every(([input]) => input.targetMessageIds === undefined)).toBe(true);
  });

  it('preserves two independent quoted questions by the same author with one frozen current intent', async () => {
    const first = incoming(90, 11, '这个结论依据是什么？'), second = incoming(91, 11, '另一件事怎么处理？');
    for (const [update, parent] of [[first, 900], [second, 901]] as const) {
      update.message!.reply_to_message = { message_id: parent, date: Math.floor(Date.now() / 1000),
        chat: update.message!.chat, from: { id: 22, first_name: '别人', is_bot: false }, text: `独立引用 ${parent}` };
    }
    await ingestChatUpdate(first); await ingestChatUpdate(second); await advance();
    expect(f.heart).toHaveBeenCalledOnce(); expect(f.heart.mock.calls[0]![0].targetMessageIds).toEqual([90, 91]);
    const attention = (await getAttentionAccumulator().peek()).sort((a, b) => a.messageId! - b.messageId!);
    expect(attention).toHaveLength(2);
    expect(attention[0]).toMatchObject({ messageId: 90, userId: 11, pendingIntent: { revision: 2 }, payload: { heartBatchTarget: true, replyTo: { messageId: 900 } } });
    expect(attention[1]).toMatchObject({ messageId: 91, userId: 11, pendingIntent: { revision: 2 }, payload: { heartBatchTarget: true, replyTo: { messageId: 901 } } });
  });

  it.each([{ targetMessageIds: [95, 96] }, { targetMessageIds: undefined }, { targetMessageIds: [] }])('keeps unquoted independent questions selectable and requires explicit selection %j', async ({ targetMessageIds }) => {
    f.heart.mockResolvedValue({ act: 'reply', why: '两件独立的事', path: 'chat', latencyMs: 1, targetMessageIds });
    await ingestChatUpdate(incoming(95, 11, '明天出发的集合时间是什么？', -123, 7));
    await ingestChatUpdate(incoming(96, 11, '还有，这段程序为什么报错？', -123, 7)); await advance();
    expect(f.heart).toHaveBeenCalledOnce();
    expect(f.heart.mock.calls[0]![0]).toMatchObject({ targetMessageIds: [95, 96],
      batchMessages: [expect.objectContaining({ messageId: 95, uid: 11 }), expect.objectContaining({ messageId: 96, uid: 11 })] });
    const attention = (await getAttentionAccumulator().peek()).sort((a, b) => a.messageId! - b.messageId!);
    if (!targetMessageIds?.length) expect(attention).toEqual([]);
    else {
      expect(attention.map(item => item.messageId)).toEqual([95, 96]);
      for (const item of attention) expect(item).toMatchObject({ userId: 11, messageThreadId: 7,
        pendingIntent: { revision: 2 }, payload: { heartBatchTarget: true } });
    }
  });

  it('allows a same-author same-topic active task supplement onto L0 without Heart', async () => {
    await ingestChatUpdate(incoming(100, 11, '@fixture_bot 帮我查一下', -123, 7)); await settle();
    const direct = (await getAttentionAccumulator().peek())[0]!;
    getGlobalState().putTask({ id: 'active-task', chatId: -123, targetUserId: 11, messageThreadId: 7,
      pendingIntent: direct.pendingIntent, createdAt: Date.now(), status: 'running', contentDirection: '查询' });
    f.speaker.mockResolvedValue(true);
    await ingestChatUpdate(incoming(101, 11, '再补充一个限制', -123, 7)); await advance();
    expect(f.heart).not.toHaveBeenCalled();
    expect(await getAttentionAccumulator().peek()).toContainEqual(expect.objectContaining({ messageId: 101, reason: 'same_speaker_burst', messageThreadId: 7 }));
    await ingestChatUpdate(incoming(102, 11, '另一个话题的新问题', -123, 8)); await advance();
    expect(f.heart).toHaveBeenCalledOnce(); expect(f.heart.mock.calls[0]![0].message.messageId).toBe(102);
  });

  it('excludes an expired source while evaluating a current independent author', async () => {
    const old = incoming(110, 11); old.message!.date -= 400;
    await ingestChatUpdate(old); await ingestChatUpdate(incoming(111, 22)); await advance();
    expect(f.heart).toHaveBeenCalledOnce();
    expect(f.heart.mock.calls[0]![0].batchMessages.map((m: FormattedMessage) => m.messageId)).toEqual([111]);
  });

  it('rechecks the actual allowlist after evaluation and keeps transient read failures retryable', async () => {
    f.config.ALLOWLIST_ENABLED = true;
    const read = vi.fn().mockResolvedValue(JSON.stringify({ approved: true, enabled: true }));
    Object.assign(redis, { hget: read });
    f.heart.mockImplementationOnce(async () => { read.mockResolvedValue(null); return { act: 'reply', path: 'chat', why: '过时', targetMessageIds: [120], latencyMs: 1 }; });
    await ingestChatUpdate(incoming(120, 11)); await advance();
    expect(f.heart).toHaveBeenCalledOnce(); expect(await getAttentionAccumulator().peek()).toEqual([]);
    read.mockRejectedValueOnce(new Error('fixture transient read')).mockResolvedValue(JSON.stringify({ approved: true, enabled: true }));
    await ingestChatUpdate(incoming(121, 22)); await advance(400);
    expect(f.heart).toHaveBeenCalledTimes(2);
    expect((await getAttentionAccumulator().peek()).map(item => item.messageId)).toEqual([121]);
    expect(read.mock.calls.every(call => call[0] === 'fixture:allowlist:groups' && call[1] === '-123')).toBe(true);
  });

  it('does not enqueue commands or replay a duplicate source as another passive decision', async () => {
    await ingestChatUpdate(incoming(130, 11, '/help')); await settle();
    expect(f.heart).not.toHaveBeenCalled();
    const message = incoming(131, 22); await ingestChatUpdate(message); await advance();
    await ingestChatUpdate(message); await advance();
    expect(f.heart).toHaveBeenCalledOnce();
    expect(f.heart.mock.calls[0]![0].batchMessages.map((m: FormattedMessage) => m.messageId)).toEqual([131]);
  });

  it('re-evaluates a changed source with independent input retained and no original text recycled', async () => {
    let release!: (value: unknown) => void;
    f.heart.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const original = incoming(140, 11, '旧版本问题');
    await ingestChatUpdate(original); await ingestChatUpdate(incoming(141, 22, '独立作者问题')); await advance();
    await ingestChatUpdate({ update_id: 142, edited_message: { ...original.message!, edit_date: Math.floor(Date.now() / 1000), text: '修正后的问题' } });
    release({ act: 'reply', why: '旧结果', path: 'chat', targetMessageIds: [140, 141], latencyMs: 1 }); await advance(400);
    const reruns = f.heart.mock.calls.slice(1).flatMap(([value]) => value.batchMessages as FormattedMessage[]);
    expect(reruns.some(m => m.messageId === 141)).toBe(true);
    expect(reruns.some(m => m.textContent === '修正后的问题')).toBe(true);
    expect(reruns.some(m => m.textContent === '旧版本问题')).toBe(false);
    expect((await getAttentionAccumulator().peek()).map(item => item.messageId).sort()).toEqual([140, 141]);
  });

  it('reports rejected capacity without falling back to one Heart call per overflow message', async () => {
    f.config.NYATOS_SHADOW_ENABLED = true;
    for (let id = 200; id < 330; id++) await ingestChatUpdate(incoming(id, 1000 + id));
    await settle();
    expect(f.warning).toHaveBeenCalledWith(expect.objectContaining({ chatId: -123, reason: 'capacity_or_scope_changed' }),
      'Telegram Heart candidate not accepted at ingress');
    expect(shadow.outcome).toHaveBeenCalledWith({ chatId: -123, messageId: 329, outcome: 'batch_rejected' });
    expect(f.heart).not.toHaveBeenCalled();
  });
});
