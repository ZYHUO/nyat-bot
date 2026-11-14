import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from 'grammy/types';
import type { FormattedMessage } from '../../../src/shared/types.js';
import type { DispatchArgs } from '../../../src/meta/meta-api.js';
import { MetaRedisFixture } from '../../helpers/meta-redis.js';

const f = vi.hoisted(() => ({
  db: vi.fn(), redis: vi.fn(), heart: vi.fn(), gate: vi.fn(), dispatch: vi.fn(), legacy: vi.fn(),
  getRecent: vi.fn(), addMessage: vi.fn(), noAction: vi.fn(), wait: vi.fn(), tick: vi.fn(),
  sleep: vi.fn(), muted: vi.fn(), react: vi.fn(), busy: vi.fn(), runtime: vi.fn(), suppressed: vi.fn(), running: vi.fn(),
  warning: vi.fn(), counter: vi.fn(), postTask: vi.fn(), speaker: vi.fn(), taskId: vi.fn(), loadTask: vi.fn(), interrupt: vi.fn(), config: {
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
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: async () => false }));
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
  transitionToWait: f.wait, transitionToRunning: f.running, recordGateContinue: vi.fn(async () => {}),
  recordBotReply: vi.fn(), recordUserMessage: vi.fn(async () => {}),
}));
vi.mock('../../../src/pipeline/timing/state-store.js', () => ({ recordGateNoAction: f.noAction }));
vi.mock('../../../src/agent/agency-wait-dispatch.js', () => ({
  dispatchWaitViaAgency: async () => ({ attempted: false }), isAgencyWaitTransportEnabled: () => false,
}));
vi.mock('../../../src/meta/defer.js', () => ({ scheduleMetaDeferReeval: async () => false }));
vi.mock('../../../src/subagent/task-store.js', () => ({ isCodeActBusy: f.busy, loadCodeActTask: f.loadTask }));
vi.mock('../../../src/agent/checkpoint.js', () => ({ getAgentTaskIdForChat: f.taskId }));
vi.mock('../../../src/agent/interrupts.js', () => ({ pushInterrupt: f.interrupt }));
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

import { createOneBotCodec } from '../../../src/platform/onebot.js';
import { OneBotClient } from '../../../src/platform/onebot-client.js';
import { _resetQqHeartBatches, closeQqHeartBatches } from '../../../src/meta/qq-heart-batch.js';
import { filterRecalledOneBotMessages } from '../../../src/platform/onebot-notices.js';
import { oneBotToCoreUpdate, ingestOneBotMessage } from '../../../src/platform/onebot-ingress.js';
import { ingestChatUpdate } from '../../../src/bot/handlers/message.js';
import { getAttentionAccumulator, _resetAttentionAccumulator } from '../../../src/meta/attention.js';
import { resumeMetaWaitAttention } from '../../../src/meta/timing-adapter.js';
import { runMetaSession } from '../../../src/meta/session.js';
import { _resetGlobalState, getGlobalState } from '../../../src/meta/global-state.js';

const codec = createOneBotCodec('42');
const migration = readFileSync('migrations/0118_platform_identity.sql', 'utf8');
const noticeMigration = readFileSync('migrations/0120_onebot_notices.sql', 'utf8');
const context = new Map<number, FormattedMessage[]>();
const realSetTimeout = globalThis.setTimeout;
let db: Database.Database;
let redis: MetaRedisFixture;
function incoming(platform: 'qq' | 'telegram', id: number, kind: 'group' | 'private' = 'group', direct = false, sender = 99) {
  const normalized = codec.normalize({ post_type: 'message', self_id: 42, user_id: sender, message_type: kind,
    group_id: 123, message_id: id, time: Math.floor(Date.now() / 1000), sender: { nickname: '测试用户' },
    message: [...(direct ? [{ type: 'at', data: { qq: '42' } }] : []), { type: 'text', data: { text: `刚才说到的这件事 ${id}` } }],
  })!;
  const update: Update = platform === 'qq' ? oneBotToCoreUpdate(normalized) : { update_id: id, message: {
    message_id: id, date: Math.floor(Date.now() / 1000), from: { id: 99, first_name: '测试用户', is_bot: false },
    chat: kind === 'group' ? { id: -123, type: 'group', title: '测试群' } : { id: 99, type: 'private', first_name: '测试用户' },
    text: `刚才说到的这件事 ${id}`,
  } };
  return { chatId: update.message!.chat.id, messageId: update.message!.message_id, userId: update.message!.from!.id,
    ingest: () => platform === 'qq' ? ingestOneBotMessage(normalized, { signal: new AbortController().signal }) : ingestChatUpdate(update) };
}
async function settleIngress(): Promise<void> {
  await vi.dynamicImportSettled();
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function flushSession(): Promise<void> { await runMetaSession(await getAttentionAccumulator().flush(), []); }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')); vi.clearAllMocks();
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(migration); db.exec(noticeMigration);
  redis = new MetaRedisFixture(); f.db.mockReturnValue(db); f.redis.mockReturnValue(redis); context.clear();
  _resetAttentionAccumulator(); _resetGlobalState();
  _resetQqHeartBatches();
  Object.assign(f.config, { HEART_ENABLED: true, HEART_DECIDES_TIMING: false, META_L0_COALESCE_MS: 2800,
    META_HEART_REFRACTORY_MS: 20_000, META_QQ_HEART_REFRACTORY_MS: 0,
    META_QQ_GROUP_COALESCE_MS: 0, META_QQ_GROUP_COALESCE_MAX_MS: 4000, META_QQ_MENTION_HEART_ENABLED: false,
    META_DIRECT_COALESCE_MS: 0, META_DIRECT_COALESCE_MAX_MS: 2000,
    META_SUBAGENT_CHAT_IDS: [], META_ACTIVATED_AT_SEC: Math.floor(Date.now() / 1000) - 60 });
  f.sleep.mockResolvedValue('awake'); f.muted.mockReturnValue(false);
  f.react.mockResolvedValue(true); f.busy.mockResolvedValue(false);
  f.speaker.mockResolvedValue(false);
  f.taskId.mockResolvedValue(null); f.loadTask.mockResolvedValue(null);
  f.runtime.mockResolvedValue({ state: 'RUNNING', lastBotReplyAt: 0 }); f.suppressed.mockResolvedValue(false);
  f.heart.mockResolvedValue({ act: 'reply', why: '可自然接话', path: 'chat', latencyMs: 1 });
  f.gate.mockResolvedValue({ action: 'continue', reason: '合适', shortCircuited: false, latencyMs: 1 });
  f.dispatch.mockResolvedValue({ taskId: 'fixture-only-no-worker' });
  f.tick.mockImplementation(flushSession);
  f.addMessage.mockImplementation(async (chatId: number, message: FormattedMessage) => {
    context.set(chatId, [...(context.get(chatId) ?? []), structuredClone(message)]);
  });
  f.getRecent.mockImplementation(async (chatId: number) => filterRecalledOneBotMessages(chatId, context.get(chatId) ?? []));
});
afterEach(async () => { closeQqHeartBatches(); await settleIngress(); _resetAttentionAccumulator(); vi.clearAllTimers(); vi.useRealTimers(); db.close(); });

describe.each(['qq', 'telegram'] as const)('%s shared participation and timing', platform => {
  it('accepts an ordinary group message without @, waits for quiet, and dispatches once', async () => {
    const message = incoming(platform, 100);
    await message.ingest(); await settleIngress();
    expect(f.heart).toHaveBeenCalledOnce();
    expect(f.heart).toHaveBeenCalledWith(expect.objectContaining({ chatId: message.chatId }));
    expect(await getAttentionAccumulator().peek()).toEqual([expect.objectContaining({ layer: 'L1', chatId: message.chatId })]);
    await flushSession(); expect(f.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2830); await settleIngress();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.dispatch).toHaveBeenCalledWith(message.chatId, expect.objectContaining({ quotes: [message.messageId] }));
    expect(f.gate).toHaveBeenCalledOnce(); expect(f.legacy).not.toHaveBeenCalled();
  });

  it('keeps Heart pass silent instead of dispatching every incoming message', async () => {
    f.heart.mockResolvedValue({ act: 'pass', why: '正在听', latencyMs: 1 });
    const message = incoming(platform, 101);
    await message.ingest(); await settleIngress(); await flushSession();
    expect(f.heart).toHaveBeenCalledOnce(); expect(f.noAction).toHaveBeenCalledWith(message.chatId, expect.any(Number));
    expect(await redis.get(`xxb:meta:heart_arm:${message.chatId}`)).toBeNull();
    expect(await getAttentionAccumulator().size()).toBe(0); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('preserves a same-chat Heart wait and resumes it only once', async () => {
    f.heart.mockResolvedValue({ act: 'wait', why: '等大家说完', path: 'chat', latencyMs: 1 });
    const message = incoming(platform, 102);
    await message.ingest(); await settleIngress(); await flushSession();
    expect(f.wait).toHaveBeenCalledWith(message.chatId, 8, message.messageId, expect.any(Number));
    expect(await redis.get(`xxb:meta:heart_arm:${message.chatId}`)).toBeNull();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(JSON.parse((await redis.get(`xxb:meta:wait-anchor:${message.chatId}`))!)).toMatchObject({
      chatId: message.chatId, messageId: message.messageId, reason: 'heart:等大家说完',
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await resumeMetaWaitAttention(message.chatId)).toBe(true);
    expect(await resumeMetaWaitAttention(message.chatId)).toBe(false);
    await flushSession(); await vi.advanceTimersByTimeAsync(2830); await settleIngress();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.dispatch).toHaveBeenCalledWith(message.chatId, expect.objectContaining({ quotes: [message.messageId] }));
  });

  it.each(['wait', 'no_action'] as const)('honors dispatch gate %s after Heart chose to reply', async action => {
    f.gate.mockResolvedValue({ action, reason: '先听一听', waitSec: 12, shortCircuited: false, latencyMs: 1 });
    const message = incoming(platform, 103);
    await message.ingest(); await settleIngress(); await flushSession();
    await vi.advanceTimersByTimeAsync(2830); await settleIngress();
    expect(f.gate).toHaveBeenCalledOnce(); expect(f.dispatch).not.toHaveBeenCalled();
    if (action === 'wait') expect(f.wait).toHaveBeenCalledWith(message.chatId, 12, message.messageId, expect.any(Number));
    else expect(f.noAction).toHaveBeenCalledWith(message.chatId, expect.any(Number));
  });

  it('allows only one Heart elevation from a concurrent passive burst', async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.heart.mockImplementation(async () => { await barrier; return { act: 'reply', why: '一起接话', path: 'chat', latencyMs: 1 }; });
    const messages = [110, 111, 112].map(id => incoming(platform, id));
    for (const message of messages) await message.ingest();
    await settleIngress(); expect(f.heart).toHaveBeenCalledTimes(3);
    release(); await settleIngress();
    expect(await getAttentionAccumulator().size()).toBe(1);
    expect(context.get(messages[0]!.chatId)).toHaveLength(3);
    await flushSession(); await vi.advanceTimersByTimeAsync(2830); await settleIngress();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it('coalesces a same-batch DM burst into one task anchored to the last message', async () => {
    const messages = [120, 121, 122].map(id => incoming(platform, id, 'private'));
    for (const message of messages) await message.ingest();
    await vi.advanceTimersByTimeAsync(50); await settleIngress();
    expect(f.heart).not.toHaveBeenCalled(); expect(f.gate).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
    const [chatId, args] = f.dispatch.mock.calls[0]! as [number, DispatchArgs];
    expect(chatId).toBe(messages[0]!.chatId);
    expect(args.quotes).toEqual([messages[2]!.messageId]);
    expect(args.relatedQuotes).toHaveLength(2);
    expect(new Set(args.relatedQuotes)).toEqual(new Set(messages.slice(0, 2).map(message => message.messageId)));
    expect(args.contentDirection).toContain('连发了 3 条');
  });

  it('when enabled, combines DM bubbles 300 ms apart instead of dispatching one task per bubble', async () => {
    f.config.META_DIRECT_COALESCE_MS = 800;
    const messages = [123, 124, 125].map(id => incoming(platform, id, 'private'));
    await messages[0]!.ingest();
    await vi.advanceTimersByTimeAsync(300); await messages[1]!.ingest();
    await vi.advanceTimersByTimeAsync(300); await messages[2]!.ingest();
    await vi.advanceTimersByTimeAsync(799); await settleIngress();
    expect(f.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await settleIngress();
    expect(f.dispatch).toHaveBeenCalledOnce();
    const [, args] = f.dispatch.mock.calls[0]! as [number, DispatchArgs];
    expect(args.quotes).toEqual([messages[2]!.messageId]);
    expect(args.relatedQuotes).toEqual(messages.slice(0, 2).map(message => message.messageId));
    expect(f.heart).not.toHaveBeenCalled(); expect(f.gate).not.toHaveBeenCalled();
  });

  it('keeps mute and sleep guards before passive Heart participation', async () => {
    f.muted.mockReturnValue(true); await incoming(platform, 130).ingest();
    f.muted.mockReturnValue(false); f.sleep.mockResolvedValue('silent'); await incoming(platform, 131).ingest();
    await settleIngress();
    expect(f.heart).not.toHaveBeenCalled(); expect(await getAttentionAccumulator().size()).toBe(0);
  });
});

it('QQ explicit @ remains direct while normal messages retain Heart discretion', async () => {
  const message = incoming('qq', 140, 'group', true);
  await message.ingest(); await vi.advanceTimersByTimeAsync(50); await settleIngress();
  expect(f.heart).not.toHaveBeenCalled(); expect(f.gate).not.toHaveBeenCalled();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('QQ can reconsider ordinary chatter after its short window while Telegram retains 45 seconds', async () => {
  f.config.META_HEART_REFRACTORY_MS = 45_000; f.config.META_QQ_HEART_REFRACTORY_MS = 10_000;
  const qq = incoming('qq', 170); const tg = incoming('telegram', 170);
  await qq.ingest(); await tg.ingest(); await settleIngress();
  expect(f.heart).toHaveBeenCalledTimes(2);
  await flushSession();
  await vi.advanceTimersByTimeAsync(3000); await settleIngress();
  const sentAt = Date.now();
  f.runtime.mockResolvedValue({ state: 'RUNNING', lastBotReplyAt: sentAt });
  await vi.advanceTimersByTimeAsync(9999);
  await incoming('qq', 171).ingest(); await incoming('telegram', 171).ingest(); await settleIngress();
  expect(f.heart).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  f.heart.mockResolvedValue({ act: 'pass', why: '听到了但暂不接话', latencyMs: 1 });
  await incoming('qq', 172).ingest(); await incoming('telegram', 172).ingest(); await settleIngress();
  expect(f.heart).toHaveBeenCalledTimes(3);
  expect(f.heart.mock.calls[2]![0].chatId).toBe(qq.chatId);
  // A newly eligible message still asks Heart, which can remain silent.
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(f.noAction).toHaveBeenCalledWith(qq.chatId, expect.any(Number));
});

it.each(['busy', 'recent-reply'] as const)('QQ short window rechecks a late Heart result against %s', async changed => {
  f.config.META_QQ_HEART_REFRACTORY_MS = 10_000;
  f.busy.mockResolvedValue(true);
  await incoming('qq', 180).ingest(); await settleIngress();
  expect(f.heart).not.toHaveBeenCalled();
  f.busy.mockResolvedValue(false);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.heart.mockImplementation(async () => { await barrier; return { act: 'reply', why: '晚到的判断', path: 'chat', latencyMs: 1 }; });
  const message = incoming('qq', 181); await message.ingest(); await settleIngress();
  expect(f.heart).toHaveBeenCalledOnce();
  if (changed === 'busy') f.busy.mockResolvedValue(true);
  else f.runtime.mockResolvedValue({ state: 'RUNNING', lastBotReplyAt: Date.now() });
  release(); await settleIngress(); await vi.advanceTimersByTimeAsync(3000); await settleIngress();
  expect(await redis.get(`xxb:meta:heart_arm:${message.chatId}`)).toBeNull();
  expect(await getAttentionAccumulator().size()).toBe(0); expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['success', 'false', 'rejected', 'unknown'] as const)('QQ reaction %s never becomes a text reply or takes the text lock', async outcome => {
  f.heart.mockResolvedValue({ act: 'react', emoji: '👍', why: '轻回应就够了', latencyMs: 1 });
  if (outcome === 'false') f.react.mockResolvedValue(false);
  if (outcome === 'rejected' || outcome === 'unknown') f.react.mockRejectedValue(Object.assign(new Error('fixture'), { delivery: outcome }));
  const message = incoming('qq', 190); await message.ingest(); await settleIngress();
  expect(f.react).toHaveBeenCalledWith(message.chatId, message.messageId, '👍');
  if (outcome !== 'success') {
    expect(f.warning).toHaveBeenCalledWith(expect.objectContaining({
      chatId: message.chatId, reason: outcome === 'unknown' ? 'heart_react_unknown' : 'heart_react_undelivered',
    }), 'Meta heart: reaction ended without text fallback');
    expect(f.counter).toHaveBeenCalledWith(outcome === 'unknown' ? 'meta_react_unknown_total' : 'meta_react_undelivered_total', { chat: message.chatId });
  }
  expect(await redis.get(`xxb:meta:heart_arm:${message.chatId}`)).toBeNull();
  expect(await getAttentionAccumulator().size()).toBe(0); expect(f.dispatch).not.toHaveBeenCalled();
  // An independent next event can be reconsidered; there is no forced replay.
  f.heart.mockResolvedValue({ act: 'pass', why: '继续听', latencyMs: 1 });
  await incoming('qq', 191).ingest(); await settleIngress();
  expect(f.heart).toHaveBeenCalledTimes(2); expect(f.dispatch).not.toHaveBeenCalled();
});

it('Telegram keeps its existing failed-reaction fallback', async () => {
  f.heart.mockResolvedValue({ act: 'react', emoji: '👍', why: '旧平台行为', latencyMs: 1 });
  f.react.mockResolvedValue(false);
  const message = incoming('telegram', 192); await message.ingest(); await settleIngress();
  expect(await redis.get(`xxb:meta:heart_arm:${message.chatId}`)).not.toBeNull();
  await flushSession(); await vi.advanceTimersByTimeAsync(2830); await settleIngress(); expect(f.dispatch).toHaveBeenCalledOnce();
});

it('QQ direct follow-up interrupts a wait and bypasses a recent passive reply', async () => {
  f.heart.mockResolvedValue({ act: 'wait', why: '先等等', latencyMs: 1 });
  const first = incoming('qq', 193); await first.ingest(); await settleIngress();
  expect(f.wait).toHaveBeenCalledOnce();
  f.suppressed.mockResolvedValue(true);
  f.runtime.mockResolvedValue({ state: 'WAIT', lastBotReplyAt: Date.now() });
  const followup = incoming('qq', 194, 'group', true); await followup.ingest(); await settleIngress();
  await vi.advanceTimersByTimeAsync(50); await settleIngress();
  expect(f.running).toHaveBeenCalledWith(first.chatId);
  expect(f.heart).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledWith(first.chatId, expect.objectContaining({ quotes: [followup.messageId] }));
});

function enableQqBatch(): void {
  f.config.META_QQ_GROUP_COALESCE_MS = 1500;
  f.config.META_QQ_MENTION_HEART_ENABLED = true;
}

it('real OneBot WebSocket intake collects three one-second bubbles before one slow Heart decision', async () => {
  const now = Date.now(); vi.useRealTimers();
  // Keep WebSocket I/O's immediate/microtask queues real while controlling only
  // the debounce clock; faking those queues can stall the TCP handshake itself.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); vi.setSystemTime(now);
  enableQqBatch();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.heart.mockImplementation(async () => { await barrier; return { act: 'reply', why: '合并听完再接', path: 'chat', latencyMs: 1 }; });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let socket: WebSocket | undefined;
  server.on('connection', peer => {
    socket = peer;
    peer.on('message', data => {
      const request = JSON.parse(data.toString()) as { action: string; echo: string };
      if (request.action === 'get_login_info') peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { user_id: 42 } }));
    });
  });
  await once(server, 'listening');
  const client = new OneBotClient({ endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    accountId: '42', accessToken: 'fixture-token', onMessage: async (message, scope) => { await ingestOneBotMessage(message, scope); },
    limits: { heartbeatIntervalMs: 60_000, maxReconnectAttempts: 0 } });
  const waitForIntake = async (count: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (f.addMessage.mock.calls.length === count && !client.snapshot().handlingMessage) return;
      await new Promise<void>(resolve => realSetTimeout(resolve, 5));
    }
    throw new Error('Synthetic WebSocket intake did not drain');
  };
  try {
    await client.start();
    for (let i = 0; i < 3; i++) {
      socket!.send(JSON.stringify({ post_type: 'message', self_id: 42, message_type: 'group', group_id: 123,
        user_id: 99, message_id: 210 + i, time: Math.floor(Date.now() / 1000), sender: { nickname: '合成用户' },
        message: [{ type: 'text', data: { text: ['第一句交代背景', '第二句补充条件', '第三句说明真正的问题'][i] } }] }));
      await waitForIntake(i + 1);
      expect(f.heart).not.toHaveBeenCalled();
      if (i < 2) await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(1499); expect(f.heart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await settleIngress();
    expect(f.heart).toHaveBeenCalledOnce(); expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.postTask).not.toHaveBeenCalled(); expect(f.speaker).not.toHaveBeenCalled();
    const input = f.heart.mock.calls[0]![0];
    expect(input.recentMessages.map((message: FormattedMessage) => message.textContent)).toEqual([
      '第一句交代背景', '第二句补充条件', '第三句说明真正的问题',
    ]);
    const ids = f.addMessage.mock.calls.map(call => call[1].messageId as number);
    expect(input.message.messageId).toBe(ids[2]); expect(input.burstNote).toContain('3 条');
    release(); await settleIngress(); await flushSession();
    await vi.advanceTimersByTimeAsync(2830); await settleIngress();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.dispatch.mock.calls[0]![1].quotes).toEqual([ids[2]]);
    expect(f.dispatch.mock.calls[0]![1].relatedQuotes).toHaveLength(2);
    expect(new Set(f.dispatch.mock.calls[0]![1].relatedQuotes)).toEqual(new Set(ids.slice(0, 2)));
  } finally {
    release(); client.stop(); socket?.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each(['pass', 'react', 'reply', 'wait'] as const)('an earlier QQ mention stays addressed across a batch and Heart may %s', async act => {
  enableQqBatch();
  f.runtime.mockResolvedValue({ state: 'RUNNING', lastBotReplyAt: Date.now() });
  f.heart.mockResolvedValue({ act, emoji: '👍', why: '结合完整话语', path: 'chat', latencyMs: 1 });
  const messages = [incoming('qq', 220, 'group', true), incoming('qq', 221), incoming('qq', 222)];
  for (const [index, message] of messages.entries()) {
    await message.ingest(); if (index < 2) await vi.advanceTimersByTimeAsync(1000);
  }
  expect(f.heart).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500); await settleIngress();
  expect(f.heart).toHaveBeenCalledOnce();
  expect(f.heart).toHaveBeenCalledWith(expect.objectContaining({ addressed: true,
    message: expect.objectContaining({ messageId: messages[2]!.messageId }) }));
  if (act === 'wait') {
    expect(f.wait).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await resumeMetaWaitAttention(messages[0]!.chatId)).toBe(true);
  }
  await flushSession(); await vi.advanceTimersByTimeAsync(60); await settleIngress();
  if (act === 'reply' || act === 'wait') {
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.gate).not.toHaveBeenCalled();
    expect(f.dispatch.mock.calls[0]![1].quotes).toEqual([messages[2]!.messageId]);
    expect(f.dispatch.mock.calls[0]![1].relatedQuotes).toHaveLength(2);
    expect(new Set(f.dispatch.mock.calls[0]![1].relatedQuotes)).toEqual(new Set(messages.slice(0, 2).map(message => message.messageId)));
  } else expect(f.dispatch).not.toHaveBeenCalled();
});

it('removes a recalled mention before judging the remaining ordinary batch', async () => {
  enableQqBatch();
  f.heart.mockResolvedValue({ act: 'pass', why: '继续听', latencyMs: 1 });
  const first = incoming('qq', 230, 'group', true); const second = incoming('qq', 231);
  await first.ingest(); await vi.advanceTimersByTimeAsync(1000); await second.ingest();
  db.prepare('INSERT INTO onebot_message_recalls VALUES (?, ?, ?, ?)').run(first.chatId, first.messageId, '42', Date.now());
  await vi.advanceTimersByTimeAsync(1500); await settleIngress();
  expect(f.heart).toHaveBeenCalledOnce();
  expect(f.heart.mock.calls[0]![0]).toMatchObject({ addressed: false, message: { messageId: second.messageId } });
  expect(f.heart.mock.calls[0]![0].recentMessages).toHaveLength(1);
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('shutdown cancels queued QQ judgment and prevents a running result from dispatching late', async () => {
  enableQqBatch();
  const queued = incoming('qq', 240); await queued.ingest(); closeQqHeartBatches();
  await vi.advanceTimersByTimeAsync(4000); await settleIngress(); expect(f.heart).not.toHaveBeenCalled();
  _resetQqHeartBatches();
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  f.heart.mockImplementation(async () => { await barrier; return { act: 'reply', why: '迟到', path: 'chat', latencyMs: 1 }; });
  await incoming('qq', 241).ingest(); await vi.advanceTimersByTimeAsync(1500); await settleIngress();
  expect(f.heart).toHaveBeenCalledOnce(); closeQqHeartBatches(); release(); await settleIngress();
  await vi.advanceTimersByTimeAsync(4000); await settleIngress();
  expect(await getAttentionAccumulator().size()).toBe(0); expect(f.dispatch).not.toHaveBeenCalled();
});

it.each([true, false])('only the active task sender gets grouped follow-up priority: matching=%s', async matching => {
  enableQqBatch();
  const ownerMessage = incoming('qq', 250);
  const task = { id: 'active-fixture', chatId: ownerMessage.chatId, targetUserId: ownerMessage.userId,
    contentDirection: '正在处理合成请求', status: 'running' as const, createdAt: Date.now() };
  getGlobalState().putTask(task); f.taskId.mockResolvedValue(task.id); f.loadTask.mockResolvedValue(task); f.busy.mockResolvedValue(true);
  const messages = [251, 252, 253].map(id => incoming('qq', id, 'group', false, matching ? 99 : 100));
  for (const [index, message] of messages.entries()) { await message.ingest(); if (index < 2) await vi.advanceTimersByTimeAsync(1000); }
  await vi.advanceTimersByTimeAsync(1500); await settleIngress(); await flushSession();
  await vi.advanceTimersByTimeAsync(60); await settleIngress();
  expect(f.dispatch).not.toHaveBeenCalled();
  if (matching) {
    expect(f.heart).toHaveBeenCalledWith(expect.objectContaining({ addressed: true, ongoingFollowup: true }));
    expect(f.interrupt).toHaveBeenCalledTimes(3);
    expect(f.interrupt.mock.calls.map(call => call[1].messageId)).toEqual(messages.map(message => message.messageId));
  } else {
    expect(f.heart).not.toHaveBeenCalled(); expect(f.interrupt).not.toHaveBeenCalled();
  }
});

it('wait replay restores each QQ message quote independently instead of cloning the last anchor quote', async () => {
  const first = incoming('qq', 260); const second = incoming('qq', 261); const quote = incoming('qq', 262);
  const replyTo = { messageId: quote.messageId, uid: quote.userId, textSnippet: '合成被引用消息' };
  await redis.set(`xxb:meta:wait-anchor:${first.chatId}`, JSON.stringify({ chatId: first.chatId, layer: 'L0',
    reason: 'heart:wait', messageId: second.messageId, createdAt: Date.now(),
    payload: { replyTo, qqBatch: [{ messageId: first.messageId, userId: first.userId, textPreview: '没有引用' },
      { messageId: second.messageId, userId: second.userId, textPreview: '引用另一条', replyTo }] } }));
  expect(await resumeMetaWaitAttention(first.chatId)).toBe(true);
  const pending = await getAttentionAccumulator().peek();
  expect(pending.find(item => item.messageId === first.messageId)?.payload?.replyTo).toBeUndefined();
  expect(pending.find(item => item.messageId === second.messageId)?.payload?.replyTo).toMatchObject(replyTo);
});

it('a delayed QQ wait cannot cross activation or change its conversation scope', async () => {
  const message = incoming('qq', 141);
  const key = `xxb:meta:wait-anchor:${message.chatId}`;
  await redis.set(key, JSON.stringify({ chatId: -123, layer: 'L1', reason: 'heart:wait', createdAt: Date.now() }));
  expect(await resumeMetaWaitAttention(message.chatId)).toBe(true);
  await redis.set(key, JSON.stringify({ chatId: message.chatId, layer: 'L1', reason: 'heart:wait', createdAt: 1 }));
  expect(await resumeMetaWaitAttention(message.chatId)).toBe(true);
  expect(await getAttentionAccumulator().size()).toBe(0);
  expect(redis.hashes.get('xxb:meta:activation-held')?.size).toBe(2);
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('removes recalled QQ anchors and copied quote text before a batched task starts', async () => {
  f.config.META_DIRECT_COALESCE_MS = 800;
  const first = incoming('qq', 150, 'private');
  const second = incoming('qq', 151, 'private');
  await first.ingest();
  await getAttentionAccumulator().ingestAsync({ chatId: first.chatId, messageId: second.messageId,
    userId: first.chatId, layer: 'L0', reason: 'dm', textPreview: '仍可回答的新消息',
    payload: { replyTo: { messageId: first.messageId, uid: first.chatId, textSnippet: '已经撤回的私密内容' } },
  });
  db.prepare('INSERT INTO onebot_message_recalls VALUES (?, ?, ?, ?)').run(first.chatId, first.messageId, '42', Date.now());
  await vi.advanceTimersByTimeAsync(800); await settleIngress();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledWith(first.chatId, expect.objectContaining({ quotes: [second.messageId] }));
  expect(JSON.stringify(f.dispatch.mock.calls)).not.toContain('已经撤回的私密内容');
  expect(await getAttentionAccumulator().size()).toBe(0);
});

it('holds QQ Attention through recall-store failure without losing it or delaying Telegram', async () => {
  const qq = incoming('qq', 160, 'private'); const tg = incoming('telegram', 161, 'private');
  await qq.ingest(); await tg.ingest();
  db.exec('DROP TABLE onebot_message_recalls');
  await vi.advanceTimersByTimeAsync(50); await settleIngress();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.dispatch.mock.calls[0]![0]).toBe(tg.chatId);
  // The input remains queued, but readers cannot expose its unverified body
  // while the recall/source store is unavailable. Restore must dispatch it once.
  expect(await getAttentionAccumulator().size()).toBe(1);
  expect(await getAttentionAccumulator().peek()).toEqual([]);
  db.exec(noticeMigration);
  await vi.advanceTimersByTimeAsync(1000); await settleIngress();
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(f.dispatch.mock.calls[1]![0]).toBe(qq.chatId);
  expect(await getAttentionAccumulator().size()).toBe(0);
});
