import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedMessage, UpdateLike } from '../../../src/shared/types.js';

const envValues: Record<string, unknown> = {};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const kv = new Map<string, string>();
const redisMock = {
  set: vi.fn(async (k: string, v: string, ...a: unknown[]) => { if (a.includes('NX') && kv.has(k)) return null; kv.set(k, v); return 'OK'; }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: vi.fn(async () => false) }));
const sendMessage = vi.fn(async () => 555);
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ addAssistant: vi.fn(async () => {}) }));
const callWithFallback = vi.fn();
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: (...a: unknown[]) => callWithFallback(...a) }));

import { maybeDeepThink } from '../../../src/pipeline/deep-think.js';

const BOT = { uid: 9, username: 'nyat_bot', nicknames: ['啾咪'] };

// 造一条"回复 bot"的 update(detectDirectInteraction 认 reply_to_bot)
function replyToBotUpdate(text: string): UpdateLike {
  return { message: { text, chat: { type: 'supergroup' }, reply_to_message: { from: { id: BOT.uid } } } } as unknown as UpdateLike;
}
function plainUpdate(text: string): UpdateLike {
  return { message: { text, chat: { type: 'supergroup' } } } as unknown as UpdateLike;
}
function fmt(text: string): FormattedMessage {
  return { role: 'user', uid: 100, username: 'u', fullName: 'U', timestamp: 0, messageId: 42, textContent: text, isForwarded: false, isBot: false } as FormattedMessage;
}

// callWithFallback:第一次调用是廉价判定(judge),第二次是 mundo 深答。
function setClassify(hard: boolean) {
  callWithFallback.mockResolvedValueOnce({ content: JSON.stringify({ hard }), label: 'stepfun' });
}
function setMundo(content: string, label = 'mundo') {
  callWithFallback.mockResolvedValueOnce({ content, label });
}

beforeEach(() => {
  kv.clear();
  vi.clearAllMocks();
  callWithFallback.mockReset();
  sendMessage.mockReset();
  for (const k of Object.keys(envValues)) delete envValues[k];
  Object.assign(envValues, { DEEP_THINK_ENABLED: true, MUNDO_ENABLED: true });
});

describe('maybeDeepThink', () => {
  it('直接问 bot + 判定硬技术 + mundo 深答 → 补发', async () => {
    setClassify(true);
    setMundo('用 min-cut 建图,复杂度 O(V·E)……(足够长的深答内容)');
    await maybeDeepThink(-100, replyToBotUpdate('这个最大流建图怎么想?卡在退化情况'), fmt('这个最大流建图怎么想?卡在退化情况'), BOT);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toContain('我仔细想了下');
    expect(sendMessage.mock.calls[0]![2]).toBe(42); // reply-to 原消息
  });

  it('flag 关 → 完全不动', async () => {
    envValues['DEEP_THINK_ENABLED'] = false;
    await maybeDeepThink(-100, replyToBotUpdate('硬技术问题'), fmt('硬技术问题这么长的一句话'), BOT);
    expect(callWithFallback).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('不是直接问 bot(没@没回复)→ 不触发', async () => {
    await maybeDeepThink(-100, plainUpdate('随便群里聊聊算法什么的'), fmt('随便群里聊聊算法什么的'), BOT);
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('判定为非硬技术 → 只判定不深答,不补发', async () => {
    setClassify(false);
    const t = '啾咪你在吗晚上一起来玩会儿游戏呗好不好呀';
    await maybeDeepThink(-100, replyToBotUpdate(t), fmt(t), BOT);
    expect(callWithFallback).toHaveBeenCalledTimes(1); // 只有廉价判定
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('mundo 失败回退到 stepfun(label≠mundo)→ 不补发(不让兜底冒充深答)', async () => {
    setClassify(true);
    setMundo('兜底模型的回答', 'stepfun');
    const t = '一个需要认真深想才能答好的硬核技术问题';
    await maybeDeepThink(-100, replyToBotUpdate(t), fmt(t), BOT);
    expect(callWithFallback).toHaveBeenCalledTimes(2); // 判定 + mundo 都调了
    expect(sendMessage).not.toHaveBeenCalled();       // 但回退了,不补发
  });

  it('太短的消息不触发', async () => {
    await maybeDeepThink(-100, replyToBotUpdate('嗯?'), fmt('嗯?'), BOT);
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('DM(chatId>0)不走这里', async () => {
    await maybeDeepThink(100, replyToBotUpdate('私聊里的硬技术问题够长'), fmt('私聊里的硬技术问题够长'), BOT);
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('冷却内不重复触发(NX 占坑)', async () => {
    setClassify(true); setMundo('第一次的深答内容写得足够长足够充实这样才能超过二十字的下限门槛哦');
    await maybeDeepThink(-100, replyToBotUpdate('第一个需要深想的硬核技术问题内容'), fmt('第一个需要深想的硬核技术问题内容'), BOT);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // 第二条:冷却锁还在 → 直接返回,不再判定
    await maybeDeepThink(-100, replyToBotUpdate('第二个需要深想的硬核技术问题内容'), fmt('第二个需要深想的硬核技术问题内容'), BOT);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
