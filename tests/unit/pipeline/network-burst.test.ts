import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

vi.mock('../../../src/env.js', () => { const e: Record<string, unknown> = { NETWORK_BURST_ENABLED: true }; return { env: () => e, _e: e }; });
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

// in-memory redis with zset + kv + list
const z = new Map<string, Map<string, number>>();
const kv = new Map<string, string>();
const lists = new Map<string, string[]>();
const redisMock = {
  zadd: vi.fn(async (k: string, score: number, m: string) => { (z.get(k) ?? z.set(k, new Map()).get(k)!).set(m, score); return 1; }),
  zremrangebyscore: vi.fn(async (k: string, _min: string, max: number) => { const s = z.get(k); if (s) for (const [m, sc] of s) if (sc <= max) s.delete(m); return 1; }),
  zcard: vi.fn(async (k: string) => z.get(k)?.size ?? 0),
  expire: vi.fn(async () => 1),
  del: vi.fn(async (k: string) => { z.delete(k); lists.delete(k); return 1; }),
  set: vi.fn(async (k: string, v: string, ...a: unknown[]) => { if (a.includes('NX') && kv.has(k)) return null; kv.set(k, v); return 'OK'; }),
  rpush: vi.fn(async (k: string, v: string) => { const l = lists.get(k) ?? lists.set(k, []).get(k)!; l.push(v); return l.length; }),
  ltrim: vi.fn(async (k: string, start: number, end: number) => {
    const l = lists.get(k);
    if (l) lists.set(k, l.slice(start < 0 ? Math.max(0, l.length + start) : start, end === -1 ? l.length : end + 1));
    return 'OK';
  }),
  lrange: vi.fn(async (k: string, start: number, end: number) => {
    const l = lists.get(k) ?? [];
    return l.slice(start < 0 ? Math.max(0, l.length + start) : start, end === -1 ? l.length : end + 1);
  }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: vi.fn(async () => false) }));
vi.mock('../../../src/queue/chat-lock.js', () => ({ acquireChatLock: vi.fn(async () => vi.fn(async () => {})) }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ isChatSuppressed: vi.fn(async () => false) }));
const sendMessage = vi.fn(async () => 999);
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ addAssistant: vi.fn(async () => {}) }));
vi.mock('../../../src/pipeline/turn/proactive-turn.js', () => ({ generatePersonaProactiveText: vi.fn(async () => '又炸了?本喵瞅瞅喵') }));
const callWithFallbackMock = vi.fn(async () => ({ content: '{"trouble": true}' }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: (...a: unknown[]) => callWithFallbackMock(...a) }));

const { _e: envVals } = (await import('../../../src/env.js')) as unknown as { _e: Record<string, unknown> };
const { maybeNetworkBurst } = await import('../../../src/pipeline/games/network-burst.js');

function m(text: string, mid: number): FormattedMessage {
  return { role: 'user', uid: mid, username: 'u', fullName: 'U', timestamp: 0, messageId: mid, textContent: text, isForwarded: false, isBot: false } as FormattedMessage;
}

beforeEach(() => {
  z.clear(); kv.clear(); lists.clear();
  envVals['NETWORK_BURST_ENABLED'] = true;
  vi.clearAllMocks();
  callWithFallbackMock.mockResolvedValue({ content: '{"trouble": true}' });
});

describe('maybeNetworkBurst', () => {
  it('窗内 <5 条 → 不冒(不调 LLM)', async () => {
    for (let i = 1; i <= 4; i++) await maybeNetworkBurst(-100, m('挂了', i), 9, 1000 + i);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('窗内 ≥5 条 + LLM 判是故障 → 冒一句', async () => {
    for (let i = 1; i <= 5; i++) await maybeNetworkBurst(-100, m(`消息${i}挂了`, i), 9, 1000 + i);
    expect(callWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // 分类器拿到的是最近的原始文本,不是关键词匹配结果
    const userMsg = callWithFallbackMock.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(userMsg.messages[1]!.content).toContain('挂了');
  });

  it('窗内 ≥5 条但 LLM 判否 → 不冒,短冷却后仍可重新起波', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '{"trouble": false}' });
    for (let i = 1; i <= 5; i++) await maybeNetworkBurst(-100, m(`聊天${i}`, i), 9, 1000 + i);
    expect(callWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('LLM 调用异常 → 视为非故障(fail-safe),不发送', async () => {
    callWithFallbackMock.mockRejectedValue(new Error('boom'));
    for (let i = 1; i <= 5; i++) await maybeNetworkBurst(-100, m(`消息${i}`, i), 9, 1000 + i);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('冒过后冷却内不再冒(即使继续故障消息)', async () => {
    for (let i = 1; i <= 5; i++) await maybeNetworkBurst(-100, m('挂了', i), 9, 1000 + i);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    for (let i = 6; i <= 10; i++) await maybeNetworkBurst(-100, m('又挂了', i), 9, 1010 + i);
    expect(sendMessage).toHaveBeenCalledTimes(1); // 冷却挡住,LLM 也不会被再调用
    expect(callWithFallbackMock).toHaveBeenCalledTimes(1);
  });

  it('空文本不计数', async () => {
    await maybeNetworkBurst(-100, m('', 1), 9, 1000);
    expect(redisMock.zadd).not.toHaveBeenCalled();
  });

  it('滑窗外的旧消息不计入(>30s)', async () => {
    await maybeNetworkBurst(-100, m('消息1', 1), 9, 1000);
    await maybeNetworkBurst(-100, m('消息2', 2), 9, 1010);
    await maybeNetworkBurst(-100, m('消息3', 3), 9, 1020);
    await maybeNetworkBurst(-100, m('消息4', 4), 9, 1031); // 消息1(距今31s)已滚出窗
    await maybeNetworkBurst(-100, m('消息5', 5), 9, 1032);
    expect(callWithFallbackMock).not.toHaveBeenCalled(); // 窗内实际只有4条,不到阈值5
  });

  it('DM(chatId>0)不触发', async () => {
    for (let i = 1; i <= 5; i++) await maybeNetworkBurst(100, m('挂了', i), 9, 1000 + i);
    expect(redisMock.zadd).not.toHaveBeenCalled();
  });
});
