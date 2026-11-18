import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from 'grammy/types';
import type { FormattedMessage } from '../../../src/shared/types.js';
import type { MessageJobData } from '../../../src/queue/jobs.js';
import type { HeartInput } from '../../../src/pipeline/heart/decision.js';
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
import { MetaRedisFixture } from '../../helpers/meta-redis.js';
import { timingWaitEval } from '../../helpers/timing-wait-redis.js';

const f = vi.hoisted(() => ({
  db: vi.fn(), redis: vi.fn(), heart: vi.fn(), gate: vi.fn(), model: vi.fn(), queueAdd: vi.fn(), enqueueCodeAct: vi.fn(), legacy: vi.fn(),
  getRecent: vi.fn(), addMessage: vi.fn(), noAction: vi.fn(), tick: vi.fn(),
  sleep: vi.fn(), muted: vi.fn(), react: vi.fn(), busy: vi.fn(),
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
    HEART_DECIDES_TIMING: false, TIMING_GATE_ENABLED: true, META_DISPATCH_GATE_ENABLED: true, TIMING_GATE_PRECHECK_ENABLED: false,
    TIMING_WAIT_MIN_SEC: 8, TIMING_WAIT_MAX_SEC: 120, TIMING_STATE_TTL_SEC: 86400, TIMING_GATE_COOLDOWN_SEC: 0,
    QUEUE_CONCURRENCY: 4, CODEACT_TIMEOUT_MS: 5000, CODEACT_BANNED_WORDS: [], BOT_USERNAME: 'fixture_bot', BOT_NICKNAMES: ['fixture-nyat'],
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
vi.mock('bullmq', async original => ({ ...await original<typeof import('bullmq')>(),
  Queue: class { add = f.queueAdd; } }));
vi.mock('../../../src/queue/producer.js', async original => ({ ...await original<typeof import('../../../src/queue/producer.js')>(), enqueue: f.legacy }));
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
vi.mock('../../../src/pipeline/timing/state-store.js', async original => ({
  ...await original<typeof import('../../../src/pipeline/timing/state-store.js')>(),
  recordGateNoAction: f.noAction, recordUserMessage: vi.fn(), recordContinue: vi.fn(),
}));
vi.mock('../../../src/agent/agency-wait-dispatch.js', () => ({
  dispatchWaitViaAgency: async () => ({ attempted: false }), isAgencyWaitTransportEnabled: () => false,
}));
vi.mock('../../../src/meta/defer.js', () => ({ scheduleMetaDeferReeval: async () => false }));
vi.mock('../../../src/subagent/task-store.js', async original => ({
  ...await original<typeof import('../../../src/subagent/task-store.js')>(), isCodeActBusy: f.busy, loadCodeActTask: f.loadTask }));
vi.mock('../../../src/agent/checkpoint.js', () => ({ getAgentTaskIdForChat: f.taskId }));
vi.mock('../../../src/agent/interrupts.js', async original => ({
  ...await original<typeof import('../../../src/agent/interrupts.js')>(), pushInterrupt: f.interrupt }));
vi.mock('../../../src/subagent/queue.js', () => ({ enqueueCodeActJob: f.enqueueCodeAct }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: f.model }));
vi.mock('../../../src/context-engine/index.js', () => ({
  getContextEngine: vi.fn(() => { throw new Error('Unexpected Meta LLM'); }),
  staticText: vi.fn(), deltaText: vi.fn(), ephemeralText: vi.fn(), volatileText: vi.fn(),
}));
vi.mock('../../../src/cron/dream-journal.js', () => ({ getJournalChannelInfo: async () => null }));
vi.mock('../../../src/meta/session-digest.js', () => ({ persistDigest: vi.fn(), recentDigests: () => [] }));
vi.mock('../../../src/sandbox/codeact/runner.js', () => ({ executeIsolatedCode: vi.fn(() => { throw new Error('Unexpected sandbox execution'); }) }));


import { ingestChatUpdate } from '../../../src/bot/handlers/message.js';
import { getAttentionAccumulator, _resetAttentionAccumulator } from '../../../src/meta/attention.js';
import { _resetTelegramHeartBatches, drainTelegramHeartBatches, startTelegramHeartBatchRecovery } from '../../../src/meta/telegram-heart-batch.js';
import { processTelegramHeartBatch } from '../../../src/meta/telegram-heart-processor.js';
import { _resetGlobalState, getGlobalState } from '../../../src/meta/global-state.js';
import { handleWaitResume } from '../../../src/pipeline/timing/chat-runtime.js';
import { runMetaSession } from '../../../src/meta/session.js';

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
  for (const migration of ['0118_platform_identity', '0120_onebot_notices', '0125_durable_ingress', '0129_pending_reply_intents', '0134_telegram_heart_batches', '0135_telegram_heart_source_wait']) {
    db.exec(readFileSync(`migrations/${migration}.sql`, 'utf8'));
  }
  redis = new MetaRedisFixture(); f.db.mockReturnValue(db); f.redis.mockReturnValue(redis); context.clear();
  const timingHashes = new Map<string, Record<string, string>>();
  const timingEval = timingWaitEval(timingHashes), metaEval = redis.eval.bind(redis);
  Object.assign(redis, {
    hgetall: async (key: string) => ({ ...timingHashes.get(key) }),
    eval: (script: string, n: number, key: string, ...args: Array<string | number>) => script.startsWith('-- timing-wait')
      ? timingEval(script, n, key, ...args) : metaEval(script, n, key),
  });
  _resetAttentionAccumulator(); _resetGlobalState(); _resetTelegramHeartBatches();
  Object.assign(f.config, { NYATOS_SHADOW_ENABLED: false, META_PENDING_INTENT_ENABLED: true, META_TG_GROUP_COALESCE_MS: 100,
    HEART_DECIDES_TIMING: false, TIMING_GATE_PRECHECK_ENABLED: false,
    META_TG_GROUP_COALESCE_CHAT_IDS: [-123, -456], META_HEART_REFRACTORY_MS: 0,
    ALLOWLIST_ENABLED: false, META_ACTIVATED_AT_SEC: Math.floor(Date.now() / 1000) - 60 });
  f.sleep.mockResolvedValue('awake'); f.muted.mockReturnValue(false); f.react.mockResolvedValue(true);
  f.busy.mockResolvedValue(false); f.speaker.mockResolvedValue(false); f.postTask.mockResolvedValue(false);
  f.taskId.mockResolvedValue(null); f.loadTask.mockResolvedValue(null);
  f.model.mockReset().mockImplementation(() => { throw new Error('Unexpected model call'); });
  f.queueAdd.mockImplementation(async (_name, _data, options) => ({ id: options.jobId }));
  f.heart.mockReset().mockImplementation(async (input: { targetMessageIds?: number[] }) => ({ act: 'reply', why: '可自然接话', path: 'chat', latencyMs: 1,
    ...(input.targetMessageIds ? { targetMessageIds: input.targetMessageIds } : {}) }));
  f.gate.mockResolvedValue({ action: 'continue', reason: '合适', shortCircuited: false, latencyMs: 1 });
  f.tick.mockImplementation(async () => {});
  f.addMessage.mockImplementation(async (chatId: number, message: FormattedMessage) => {
    context.set(chatId, [...(context.get(chatId) ?? []), structuredClone(message)]);
  });
  f.getRecent.mockImplementation(async (chatId: number, count: number, threadId?: number) =>
    (context.get(chatId) ?? []).filter(message => (message.messageThreadId ?? 0) === (threadId ?? 0)).slice(-count));
});
afterEach(async () => { await drainTelegramHeartBatches(); _resetAttentionAccumulator(); vi.clearAllTimers(); vi.useRealTimers(); db.close(); });

// Replay the production legacy queue payload at its actual deadline. The
// rollout's source-specific timers run through the production batch recovery
// scan. Both transports therefore get an opportunity to settle the same input.
function startWaitReplay(): void {
  f.config.HEART_DECIDES_TIMING = true;
  f.queueAdd.mockImplementation(async (name: string, job: MessageJobData, opts: { jobId: string; delay: number }) => {
    if (name !== 'wait_resume') throw new Error('Unexpected queue job');
    setTimeout(() => handleWaitResume({ chatId: job.chatId, waitResume: job.waitResume, jobId: opts.jobId }), opts.delay);
    return { id: opts.jobId };
  });
  startTelegramHeartBatchRecovery(processTelegramHeartBatch);
}

function quoted(update: Update, source: Update): Update {
  update.message!.reply_to_message = source.message!;
  return update;
}

type ScriptedDecision = { act: string; why: string; targetMessageIds?: readonly number[] };

async function scriptHeart(decide: (input: HeartInput) => ScriptedDecision | Promise<ScriptedDecision>): Promise<void> {
  const { heartDecision } = await vi.importActual<typeof import('../../../src/pipeline/heart/decision.js')>(
    '../../../src/pipeline/heart/decision.js');
  f.heart.mockImplementation((input: HeartInput) => {
    f.model.mockImplementationOnce(async () => ({ content: JSON.stringify(await decide(input)) }));
    return heartDecision(input);
  });
}

describe('overlapping WAIT replay through Telegram ingress, deadlines and CodeAct dispatch', () => {
  it.each([
    { order: 'unresolved first', together: false, answerAt: 2_000, maxCalls: 4 },
    { order: 'self-answered first', together: false, answerAt: 8_200, maxCalls: 5 },
    { order: 'same initial batch', together: true, answerAt: 2_000, maxCalls: 3 },
    { order: 'isolated unresolved control', together: false, answerAt: 0, maxCalls: 2 },
    { order: 'downstream gate declines', together: true, answerAt: 2_000, maxCalls: 3, gateDeclines: true },
  ])('keeps the unresolved physical source and respects the final dispatch gate ($order)', async ({ order, together, answerAt, gateDeclines, maxCalls }) => {
    startWaitReplay();
    const started = Date.now(), group = -123, topic = 7, authorA = 11, authorB = 22;
    // Telegram IDs follow arrival order, including in the reversed case.
    const bId = order === 'unresolved first' || !answerAt ? 501 : 502;
    const aId = bId === 501 ? 502 : 501;
    const a = quoted(incoming(aId, authorA, '哪一站换车？', group, topic),
      incoming(470, 33, '路线图', group, topic));
    const b = quoted(incoming(bId, authorB, '明天从哪个门进场？', group, topic),
      incoming(480, 44, '场馆通知', group, topic));

    // Only the provider response is scripted. The production Heart parser,
    // scoped source selector, WAIT store, Attention flush, Meta session and
    // quote/author fences all decide whether a queue handoff can actually occur.
    if (gateDeclines) {
      f.config.HEART_DECIDES_TIMING = false;
      f.config.TIMING_GATE_PRECHECK_ENABLED = true;
      const { runTimingGate } = await vi.importActual<typeof import('../../../src/pipeline/timing/gate.js')>(
        '../../../src/pipeline/timing/gate.js');
      f.gate.mockImplementation(runTimingGate);
    }
    let firstB: number | undefined;
    const bRechecks: HeartInput[] = [];
    await scriptHeart(input => {
      const ids = input.targetMessageIds ?? [];
      const answerSeen = input.recentMessages.some(message => message.uid === authorA
        && message.messageId === 503 && message.replyTo?.messageId === aId);
      let act = 'wait', targetMessageIds: number[] | undefined;
      if (ids.includes(bId)) {
        firstB ??= Date.now();
        if (Date.now() >= firstB + 8_000) {
          bRechecks.push(input); act = 'reply'; targetMessageIds = [bId];
        } else if (answerSeen) targetMessageIds = [bId];
      } else if (answerSeen) act = 'pass';
      return { act, why: '回放裁决', targetMessageIds };
    });
    if (!answerAt) await ingestChatUpdate(b);
    else {
      const [first, second] = aId < bId ? [a, b] : [b, a];
      await ingestChatUpdate(first!); await advance(together ? 35 : 400);
      await ingestChatUpdate(second!);
    }
    await advance(100);
    expect(f.heart.mock.calls.flatMap(([input]: [HeartInput]) => input.targetMessageIds)).toContain(bId);
    expect(f.model).toHaveBeenCalledTimes(f.heart.mock.calls.length);
    expect(await getAttentionAccumulator().peek()).toEqual([]);
    if (answerAt) {
      await advance(started + answerAt - Date.now());
      const answer = quoted(incoming(503, authorA, '我找到路线了，在南站换车。', group, topic), a);
      await ingestChatUpdate(answer);
      await ingestChatUpdate(answer); // Telegram redelivery.
    }
    await advance(started + 12_000 - Date.now());
    await advance(f.config.META_L0_COALESCE_MS + 1);
    const pending = await getAttentionAccumulator().flush();
    expect(pending.map(item => ({ message: item.messageId, author: item.userId, topic: item.messageThreadId,
      quote: (item.payload?.['replyTo'] as { messageId?: number } | undefined)?.messageId }))).toEqual([
      { message: bId, author: authorB, topic, quote: 480 },
    ]);
    expect(bRechecks).toHaveLength(1);
    if (answerAt) expect(bRechecks[0]!.recentMessages).toContainEqual(expect.objectContaining({
      messageId: 503, uid: authorA, replyTo: expect.objectContaining({ messageId: aId, uid: authorA }),
    }));
    expect(bRechecks[0]!.batchMessages).toContainEqual(expect.objectContaining({
      messageId: bId, uid: authorB, replyTo: expect.objectContaining({ messageId: 480, uid: 44 }),
    }));
    await runMetaSession(pending, []);
    if (gateDeclines) {
      expect(f.gate).toHaveBeenCalledOnce();
      await expect(f.gate.mock.results[0]!.value).resolves.toMatchObject({ action: 'no_action', reason: 'precheck_human_to_human' });
    } else {
      expect(f.gate).not.toHaveBeenCalled();
      expect(f.enqueueCodeAct).toHaveBeenCalledOnce();
      expect(f.enqueueCodeAct.mock.calls[0]![0]).toMatchObject({ chatId: group, messageThreadId: topic,
        targetUserId: authorB, quoteMessageIds: [bId], contentDirection: expect.stringContaining('#480'),
        pendingIntent: { senderId: authorB, threadId: topic, accountId: '12345' } });
      expect(f.enqueueCodeAct.mock.calls[0]![0].relatedQuoteIds).toBeUndefined();
    }

    // Duplicate wake-up, duplicate ingress and a restarted scheduler cannot
    // enqueue the same action again or speak on the self-answered question.
    for (const [name, data, opts] of f.queueAdd.mock.calls) {
      if (name === 'wait_resume') await handleWaitResume({ chatId: group, waitResume: data.waitResume, jobId: opts.jobId });
    }
    const callsBeforeDuplicate = f.model.mock.calls.length;
    expect(callsBeforeDuplicate).toBeLessThanOrEqual(maxCalls);
    await drainTelegramHeartBatches(); _resetTelegramHeartBatches();
    startTelegramHeartBatchRecovery(processTelegramHeartBatch);
    await ingestChatUpdate(b); await advance(10_000);
    expect(await getAttentionAccumulator().flush()).toEqual([]);
    expect(f.model).toHaveBeenCalledTimes(callsBeforeDuplicate);
    expect(f.enqueueCodeAct).toHaveBeenCalledTimes(gateDeclines ? 0 : 1); expect(f.react).not.toHaveBeenCalled();
  });

  it('reconsiders B exactly once when A self-answers during B’s in-flight deadline decision', async () => {
    startWaitReplay();
    const started = Date.now(), group = -123, topic = 7;
    const b = quoted(incoming(601, 22, '明天从哪个门进场？', group, topic), incoming(580, 44, '场馆通知', group, topic));
    const a = quoted(incoming(602, 11, '哪一站换车？', group, topic), incoming(570, 33, '路线图', group, topic));
    let releaseStale: (() => void) | undefined;
    const reviewsOfB: HeartInput[] = [];
    await scriptHeart(async input => {
      const canAnswerB = input.targetMessageIds?.includes(601) && Date.now() >= started + 8_100;
      const hasAnswer = input.recentMessages.some(message => message.messageId === 603 && message.uid === 11
        && message.replyTo?.messageId === 602);
      if (canAnswerB) reviewsOfB.push(input);
      if (canAnswerB && !hasAnswer && reviewsOfB.length === 1) {
        // Deliberately finish with a reply even if aborted. Storage and the
        // adapter must refuse an obsolete result from an uncooperative provider.
        await new Promise<void>(resolve => { releaseStale = resolve; });
        return { act: 'reply', why: '过时的群况', targetMessageIds: [601] };
      }
      if (canAnswerB) return { act: 'reply', why: '已经看过换车人的自答', targetMessageIds: [601] };
      return { act: hasAnswer ? 'pass' : 'wait', why: '等群友补充' };
    });
    await ingestChatUpdate(b); await advance(1_200);
    await ingestChatUpdate(a); await advance(100);
    expect(f.heart.mock.calls.map(([input]) => input.targetMessageIds)).toEqual([[601], [602]]);
    await advance(started + 8_300 - Date.now());
    const answer = quoted(incoming(603, 11, '路线我找到了，在南站换车。', group, topic), a);
    try {
      expect(releaseStale).toBeTypeOf('function');
      expect(reviewsOfB[0]!.targetMessageIds).toEqual([601]); // A's own WAIT has not expired.
      await ingestChatUpdate(answer); await advance(120);
      expect(reviewsOfB).toHaveLength(1);
      expect(await getAttentionAccumulator().peek()).toEqual([]);
    } finally {
      releaseStale?.();
    }
    await settle(); await advance(2_500); await advance(f.config.META_L0_COALESCE_MS + 1);
    expect(reviewsOfB).toHaveLength(2);
    expect(reviewsOfB[1]!.recentMessages).toContainEqual(expect.objectContaining({
      messageId: 603, uid: 11, replyTo: expect.objectContaining({ messageId: 602 }),
    }));
    const ready = await getAttentionAccumulator().flush();
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ messageId: 601, userId: 22, messageThreadId: topic,
      reason: expect.stringContaining('已经看过换车人的自答'), payload: { replyTo: { messageId: 580, uid: 44 } } });
    await runMetaSession(ready, []);
    await ingestChatUpdate(answer); await advance(12_000);
    expect(await getAttentionAccumulator().flush()).toEqual([]);
    expect(f.enqueueCodeAct).toHaveBeenCalledOnce();
    expect(f.enqueueCodeAct.mock.calls[0]![0]).toMatchObject({ chatId: group, messageThreadId: topic,
      targetUserId: 22, quoteMessageIds: [601] });
    expect(f.model.mock.calls.length).toBeLessThanOrEqual(5);
    expect(f.react).not.toHaveBeenCalled();
  });

  it.each(['outside the 40-message window', 'changed body', 'changed author', 'changed revision', 'changed photo', 'photo changed during Heart'])(
    'reconsiders only verified sources from a shared WAIT when A is %s', async mismatch => {
      startWaitReplay();
      const started = Date.now(), group = -123, topic = 7;
      const reconsidered: HeartInput[] = [];
      await scriptHeart(input => {
        const ids = input.targetMessageIds ?? [];
        const atDeadline = Date.now() >= started + 8_100;
        if (atDeadline) {
          reconsidered.push(input);
          if (mismatch === 'photo changed during Heart' && ids.includes(701)) {
            context.get(group)!.find(message => message.messageId === 701)!.imageFileId = 'new-photo-while-deciding';
          }
        }
        const decision = atDeadline ? { act: 'reply', targetMessageIds: ids }
          : { act: ids.includes(701) && ids.includes(702) ? 'wait' : 'pass' };
        return { ...decision, why: '检查当前话题里仍能核对的问题' };
      });
      await ingestChatUpdate(incoming(701, 11, '哪个站换车？', group, topic));
      await ingestChatUpdate(quoted(incoming(702, 22, '哪个门进场？', group, topic), incoming(680, 44, '场馆通知', group, topic)));
      await advance(100);
      expect(f.heart).toHaveBeenCalledOnce();
      expect(f.heart.mock.calls[0]![0].targetMessageIds).toEqual([701, 702]);
      if (mismatch === 'outside the 40-message window') {
        for (let id = 703; id <= 741; id++) await ingestChatUpdate(incoming(id, 33, '持续讨论', group, topic));
        await advance(1_000);
        expect((await f.getRecent(group, 40, topic)).map((message: FormattedMessage) => message.messageId))
          .toEqual(Array.from({ length: 40 }, (_, i) => 702 + i));
      } else if (mismatch !== 'photo changed during Heart') {
        // Simulate a divergent stored projection independently of edit ingress:
        // a physical ID alone cannot authenticate the retained source.
        const copy = context.get(group)!.find(message => message.messageId === 701)!;
        if (mismatch === 'changed body') copy.textContent = '修订后的另一句话';
        else if (mismatch === 'changed photo') copy.imageFileId = 'different-photo-on-the-same-source';
        else if (mismatch === 'changed author') copy.uid = 55;
        else copy.eventIdentity = createMessageEventIdentity({ ref: copy.eventIdentity!.ref,
          occurredAt: copy.eventIdentity!.occurredAt, editedAt: Date.now(), edit: true, updateId: 799, content: copy.textContent });
      }
      await advance(started + 12_000 - Date.now()); await advance(f.config.META_L0_COALESCE_MS + 1);
      expect(reconsidered.map(input => input.targetMessageIds)).toEqual(mismatch === 'photo changed during Heart'
        ? [[701, 702], [702]] : [[702]]);
      const ready = await getAttentionAccumulator().flush();
      expect(ready.map(item => [item.messageId, item.userId])).toEqual([[702, 22]]);
      await runMetaSession(ready, []);
      expect(f.enqueueCodeAct).toHaveBeenCalledOnce();
      expect(f.enqueueCodeAct.mock.calls[0]![0]).toMatchObject({ targetUserId: 22, quoteMessageIds: [702], messageThreadId: topic });
      expect(f.react).not.toHaveBeenCalled();
    });

  it('rechecks an unresolved question when a self-answer arrives after Attention admission but before dispatch', async () => {
    startWaitReplay();
    const started = Date.now(), group = -123, topic = 7;
    const b = quoted(incoming(801, 22, '几点进场？', group, topic), incoming(780, 44, '场馆通知', group, topic));
    const a = incoming(802, 11, '哪一站换车？', group, topic);
    const bDecisions: boolean[] = [];
    await scriptHeart(input => {
      const hasAnswer = input.recentMessages.some(message => message.messageId === 803 && message.replyTo?.messageId === 802);
      const bDue = Date.now() >= started + 8_100 && input.targetMessageIds?.includes(801);
      if (bDue) bDecisions.push(hasAnswer);
      return bDue ? { act: 'reply', targetMessageIds: [801], why: hasAnswer ? '甲已自答仍可接乙' : '甲还没自答' }
        : { act: hasAnswer ? 'pass' : 'wait', why: '等两位各自补充' };
    });
    await ingestChatUpdate(b); await advance(1_200);
    await ingestChatUpdate(a); await advance(started + 8_300 - Date.now());
    const [original] = await getAttentionAccumulator().peek();
    expect(original).toMatchObject({ messageId: 801, userId: 22, reason: expect.stringContaining('甲还没自答') });
    expect(f.enqueueCodeAct).not.toHaveBeenCalled();

    await ingestChatUpdate(quoted(incoming(803, 11, '我找到了，在南站换车。', group, topic), a));
    // The old decision must be dropped before the session sees it. Only a
    // fresh model verdict may cross the boundary after a source was revised.
    expect(await getAttentionAccumulator().flush()).toEqual([]);
    expect(f.enqueueCodeAct).not.toHaveBeenCalled();
    await advance(3_000); await advance(f.config.META_L0_COALESCE_MS + 1);
    const ready = await getAttentionAccumulator().flush();
    expect(bDecisions).toEqual([false, true]);
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ chatId: group, messageThreadId: topic, messageId: 801, userId: 22,
      reason: expect.stringContaining('甲已自答仍可接乙'), payload: { replyTo: { messageId: 780, uid: 44 } } });
    expect(ready[0]!.id).not.toBe(original!.id);
    expect(ready[0]!.waitRecovery?.generation).not.toBe(original!.waitRecovery?.generation);
    await runMetaSession(ready, []);
    await advance(12_000);
    expect(await getAttentionAccumulator().flush()).toEqual([]);
    expect(f.enqueueCodeAct).toHaveBeenCalledOnce();
    expect(f.enqueueCodeAct.mock.calls[0]![0]).toMatchObject({ chatId: group, messageThreadId: topic,
      targetUserId: 22, quoteMessageIds: [801], waitRecovery: ready[0]!.waitRecovery });
    expect(f.react).not.toHaveBeenCalled();
  });
});

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
