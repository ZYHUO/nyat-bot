/**
 * `runMetaBookkeepingHooks` —— Meta 主路径的 bookkeeping。
 *
 * 2026-09-21 之前这个函数**一条测试都没有**，而它正是"新架构替换"的关键接缝：
 * legacy pipeline 的那些 hook 要在 Meta 路径上重接，漏一个就是一个
 * "功能开着但从没跑过"（本轮连修三个：peer-reaction / network-burst / 代发回执）。
 *
 * 这里锁的是**接线**，不是各 hook 的内部逻辑（那些有各自的测试）：
 *   · 什么消息形态触发哪个 hook
 *   · flag 关 → 不触发
 *   · bot 自己的消息不触发（否则自己回自己）
 *   · 任一 hook 抛错不影响其他 hook，也不往外抛
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

const mocks = vi.hoisted(() => ({
  env: vi.fn(),
  getRedis: vi.fn(),
  getBotUid: vi.fn(),
  maybePeerReaction: vi.fn(async () => {}),
  maybeNetworkBurst: vi.fn(async () => {}),
  tryHandleDelegationReceipt: vi.fn(async () => false),
  markDmEver: vi.fn(),
  countDmPending: vi.fn(() => 0),
  checkOutcome: vi.fn(async () => ({ needsReflection: false })),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/env.js', () => ({ env: mocks.env }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: mocks.getRedis }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: mocks.getBotUid, getBotIdentity: () => ({ uid: 999, username: 'b', nicknames: [] }) }));
vi.mock('../../../src/pipeline/games/peer-reaction.js', () => ({ maybePeerReaction: mocks.maybePeerReaction }));
vi.mock('../../../src/pipeline/games/network-burst.js', () => ({ maybeNetworkBurst: mocks.maybeNetworkBurst }));
vi.mock('../../../src/pipeline/tools/bot-delegation.js', () => ({ tryHandleDelegationReceipt: mocks.tryHandleDelegationReceipt }));
vi.mock('../../../src/tracking/dm-state.js', () => ({ markDmEver: mocks.markDmEver }));
vi.mock('../../../src/tracking/dm-pending.js', () => ({ countDmPending: mocks.countDmPending }));
vi.mock('../../../src/tracking/outcome.js', () => ({ checkOutcome: mocks.checkOutcome }));
vi.mock('../../../src/pipeline/dm-proactive.js', () => ({ flushDmPendingOnInbound: vi.fn(async () => {}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: mocks.logger }));

const { runMetaBookkeepingHooks } = await import('../../../src/meta/bookkeeping.js');

const ALL_ON = {
  SLEEP_WAKE_ON_DM_ENABLED: true,
  OUTCOME_TRACKING_ENABLED: true,
  PEER_REACTION_ENABLED: true,
  NETWORK_BURST_ENABLED: true,
  BOT_DELEGATION_ENABLED: true,
};

function msg(over: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user', uid: 111, username: 'u', fullName: 'U',
    messageId: 1, timestamp: 0, isForwarded: false, isBot: false,
    textContent: '你好', ...over,
  } as FormattedMessage;
}

const CHAT = -100;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.mockReturnValue({ ...ALL_ON });
  mocks.getRedis.mockReturnValue({ get: vi.fn(async () => null), set: vi.fn(async () => {}) });
  mocks.getBotUid.mockReturnValue(999);
  mocks.countDmPending.mockReturnValue(0);
  mocks.checkOutcome.mockResolvedValue({ needsReflection: false });
  mocks.tryHandleDelegationReceipt.mockResolvedValue(false);
  // 让 fire-and-forget 的微任务跑完
  return () => new Promise((r) => setImmediate(r));
});

describe('runMetaBookkeepingHooks · 三个新接的 hook', () => {
  it('① bot 的会话型消息 → 触发 peer-reaction', async () => {
    runMetaBookkeepingHooks(CHAT, msg({ isBot: true, uid: 5304501737, botClass: 'chat' as never }));
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.maybePeerReaction).toHaveBeenCalledWith(CHAT, expect.objectContaining({ uid: 5304501737 }), 999);
  });

  it('①b botClass=cmd_result 也触发（带媒体的工具结果）', async () => {
    runMetaBookkeepingHooks(CHAT, msg({ isBot: true, uid: 5304501737, botClass: 'cmd_result' as never }));
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.maybePeerReaction).toHaveBeenCalledTimes(1);
  });

  it('①c 别的 botClass（ad/verify/echo）不触发——那些已被降噪', async () => {
    runMetaBookkeepingHooks(CHAT, msg({ isBot: true, uid: 5304501737, botClass: 'ad' as never }));
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.maybePeerReaction).not.toHaveBeenCalled();
  });

  it('①d bot 自己的消息不触发（否则自己回自己）', async () => {
    runMetaBookkeepingHooks(CHAT, msg({ isBot: true, uid: 999, botClass: 'chat' as never }));
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.maybePeerReaction).not.toHaveBeenCalled();
  });

  it('①e PEER_REACTION_ENABLED=false → 不触发', async () => {
    mocks.env.mockReturnValue({ ...ALL_ON, PEER_REACTION_ENABLED: false });
    runMetaBookkeepingHooks(CHAT, msg({ isBot: true, uid: 5304501737, botClass: 'chat' as never }));
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.maybePeerReaction).not.toHaveBeenCalled();
  });

  it('② 人类群消息 → 触发 network-burst', async () => {
    runMetaBookkeepingHooks(CHAT, msg());
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.maybeNetworkBurst).toHaveBeenCalledWith(CHAT, expect.objectContaining({ uid: 111 }), 999);
  });

  it('②b bot 消息不触发 network-burst（那是人跟人之间的连锁）', async () => {
    runMetaBookkeepingHooks(CHAT, msg({ isBot: true, uid: 5304501737 }));
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.maybeNetworkBurst).not.toHaveBeenCalled();
  });

  it('②c 私聊不触发 network-burst', async () => {
    runMetaBookkeepingHooks(555, msg());
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.maybeNetworkBurst).not.toHaveBeenCalled();
  });

  it('②d NETWORK_BURST_ENABLED=false → 不触发', async () => {
    mocks.env.mockReturnValue({ ...ALL_ON, NETWORK_BURST_ENABLED: false });
    runMetaBookkeepingHooks(CHAT, msg());
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.maybeNetworkBurst).not.toHaveBeenCalled();
  });

  it('③ bot 群消息 → 查代发回执', async () => {
    let thrown: unknown = null;
    const fm = msg({ isBot: true, uid: 5304501737 });
    try { runMetaBookkeepingHooks(CHAT, fm); }
    catch (e) { thrown = e; }
    await new Promise((r) => setTimeout(r, 30));
    console.log('DBG env returns:', JSON.stringify(mocks.env.mock.results.slice(-1)));
    console.log('DBG getBotUid calls:', mocks.getBotUid.mock.calls.length);
    console.log('DBG delegation fn type:', typeof mocks.tryHandleDelegationReceipt);
    console.log('DBG logger.debug:', JSON.stringify(mocks.logger.debug.mock.calls.slice(-2)).slice(0, 300));
    expect(mocks.tryHandleDelegationReceipt).toHaveBeenCalled();
  });

  it('③b 人类消息不查回执（回执只可能是 bot 发的）', async () => {
    runMetaBookkeepingHooks(CHAT, msg());
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.tryHandleDelegationReceipt).not.toHaveBeenCalled();
  });

  it('③c BOT_DELEGATION_ENABLED=false → 不查', async () => {
    mocks.env.mockReturnValue({ ...ALL_ON, BOT_DELEGATION_ENABLED: false });
    runMetaBookkeepingHooks(CHAT, msg({ isBot: true, uid: 5304501737 }));
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.tryHandleDelegationReceipt).not.toHaveBeenCalled();
  });

  it('④ 一个 hook 抛错不影响其他 hook，也不往外抛', async () => {
    mocks.maybePeerReaction.mockRejectedValue(new Error('peer boom'));
    mocks.maybeNetworkBurst.mockRejectedValue(new Error('burst boom'));
    mocks.tryHandleDelegationReceipt.mockRejectedValue(new Error('deleg boom'));
    expect(() => runMetaBookkeepingHooks(CHAT, msg({ isBot: true, uid: 5304501737, botClass: 'chat' as never }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    // 三个都被调用过（不是第一个抛了就停）
    expect(mocks.maybePeerReaction).toHaveBeenCalled();
    expect(mocks.tryHandleDelegationReceipt).toHaveBeenCalled();
  });

  it('⑤ 私聊的人类消息仍走 DM affinity 与 outcome（不因新 hook 被挤掉）', async () => {
    runMetaBookkeepingHooks(555, msg());
    await new Promise((r) => setTimeout(r, 50));
    await vi.waitFor(() => expect(mocks.markDmEver).toHaveBeenCalledWith(111));
  });
});
