/**
 * 发送预算（send budget）—— 每任务，不是每段。
 *
 * 2026-09-21 的实测把病因钉死了：
 *   · self_replies 里 1555 个任务 / 2965 次投递，5% 的任务（≥6 条）占 20% 的量
 *   · 最差的一个任务 46 秒发了 12 条（log 里同一个 taskId 连续 11 次投递）
 *   · 投递数分布恰好在 6 条处跳变（31 → 51），而 6 正是 maxTextSends
 *     → 说明闸在拦，只是**每段重建 host api 就把 textSent 归零了**
 *   · AGENT_MAX_SEGMENTS 默认 10 → 真实上限 6 × 10 = 60 条/任务
 *
 * 所以这里锁三件事：
 *   ① 单段内仍然拦（原行为不能退）
 *   ② onSend 每次都通报（executor 靠它跨段记账）
 *   ③ 额度为 0 时立刻拦（续跑段拿到"剩余额度"可能就是 0）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.fn(async () => 42);

vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessage(...(args as [number, string, number?])),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));
vi.mock('../../../src/env.js', () => ({
  env: () => ({ CODEACT_BANNED_WORDS: [], CODEACT_WEB_SEARCH_ENABLED: true }),
}));
vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => []),
  searchMemoryByUser: vi.fn(async () => []),
  memorizeMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: vi.fn(async () => undefined),
  getRecent: vi.fn(async () => []),
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ get: async () => null, set: async () => 'OK', del: async () => 1 }),
}));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: vi.fn(async () => {}),
  answeredTimestamps: vi.fn(async () => [] as number[]) }));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ noteMetaBotReply: vi.fn(async () => {}) }));
vi.mock('../../../src/pipeline/reply/anti-repeat.js', () => ({
  checkNearDuplicate: vi.fn(async () => ({ isNearDuplicate: false, ratio: 0 })),
}));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getReadyStickersByIntent: () => [] }));
vi.mock('../../../src/tracking/person-identity.js', () => ({
  getPersonIdentity: () => null,
  buildCrossGroupInjection: () => '',
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const GROUP = -1003821093564;

async function makeApi(opts: { maxTextSends?: number; onSend?: () => void }) {
  const { createHostApi } = await import('../../../src/subagent/host-api.js');
  return createHostApi(GROUP, { onEnd: vi.fn(), taskId: 't-budget', ...opts });
}

describe('host sendText 发送预算', () => {
  beforeEach(() => {
    sendMessage.mockClear();
  });

  it('① 单段内到顶就拦（原行为不能退）', async () => {
    const api = await makeApi({ maxTextSends: 3 });
    await api.telegram.sendText('今天群里怎么这么安静');
    await api.telegram.sendText('我刚把昨天的统计对完了');
    await api.telegram.sendText('结果有点意外，晚点说');
    await expect(api.telegram.sendText('这句应该发不出去')).rejects.toThrow(/sendText_limit:3/);
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it('② 每发成功一条，onSend 就通报一次（executor 靠它跨段记账）', async () => {
    const onSend = vi.fn();
    const api = await makeApi({ maxTextSends: 2, onSend });
    await api.telegram.sendText('第一句正常话，够长不会撞回声');
    await api.telegram.sendText('第二句也是正常话，内容完全不一样');
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('②b 发送失败不通报（没发出去就不算花钱）', async () => {
    const onSend = vi.fn();
    const api = await makeApi({ maxTextSends: 2, onSend });
    sendMessage.mockRejectedValueOnce(new Error('telegram 500'));
    await expect(api.telegram.sendText('这句会发失败，不算花额度')).rejects.toThrow();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('③ 剩余额度为 0 → 一条都发不出（续跑段拿到 0 时必须立刻收尾）', async () => {
    const api = await makeApi({ maxTextSends: 0 });
    await expect(api.telegram.sendText('额度是零，这条发不出去')).rejects.toThrow(/sendText_limit:0/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('③b 默认值仍是 2（不传 maxTextSends 时行为不变）', async () => {
    const api = await makeApi({});
    await api.telegram.sendText('默认额度下的第一句话，够长');
    await api.telegram.sendText('默认额度下的第二句话，内容不同');
    await expect(api.telegram.sendText('第三句应该被默认额度拦下')).rejects.toThrow(/sendText_limit:2/);
  });
});
