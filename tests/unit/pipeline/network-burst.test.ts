import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

vi.mock('../../../src/env.js', () => { const e: Record<string, unknown> = { NETWORK_BURST_ENABLED: true }; return { env: () => e, _e: e }; });
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

// in-memory redis with zset
const z = new Map<string, Map<string, number>>();
const kv = new Map<string, string>();
const redisMock = {
  zadd: vi.fn(async (k: string, score: number, m: string) => { (z.get(k) ?? z.set(k, new Map()).get(k)!).set(m, score); return 1; }),
  zremrangebyscore: vi.fn(async (k: string, _min: string, max: number) => { const s = z.get(k); if (s) for (const [m, sc] of s) if (sc <= max) s.delete(m); return 1; }),
  zcard: vi.fn(async (k: string) => z.get(k)?.size ?? 0),
  expire: vi.fn(async () => 1),
  del: vi.fn(async (k: string) => { z.delete(k); return 1; }),
  set: vi.fn(async (k: string, v: string, ...a: unknown[]) => { if (a.includes('NX') && kv.has(k)) return null; kv.set(k, v); return 'OK'; }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: vi.fn(async () => false) }));
vi.mock('../../../src/queue/chat-lock.js', () => ({ acquireChatLock: vi.fn(async () => vi.fn(async () => {})) }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ isChatSuppressed: vi.fn(async () => false) }));
const sendMessage = vi.fn(async () => 999);
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ addAssistant: vi.fn(async () => {}) }));
vi.mock('../../../src/pipeline/turn/proactive-turn.js', () => ({ generatePersonaProactiveText: vi.fn(async () => '又炸了?本喵瞅瞅喵') }));

const { _e: envVals } = (await import('../../../src/env.js')) as unknown as { _e: Record<string, unknown> };
const { maybeNetworkBurst, looksLikeNetworkTrouble } = await import('../../../src/pipeline/games/network-burst.js');

function m(text: string, mid: number): FormattedMessage {
  return { role: 'user', uid: mid, username: 'u', fullName: 'U', timestamp: 0, messageId: mid, textContent: text, isForwarded: false, isBot: false } as FormattedMessage;
}

beforeEach(() => { z.clear(); kv.clear(); envVals['NETWORK_BURST_ENABLED'] = true; vi.clearAllMocks(); });

describe('looksLikeNetworkTrouble', () => {
  it('故障短语命中', () => {
    for (const t of ['节点挂了', 'cf炸了', '连不上了', '机场跑路了', '严重丢包', '502 了上不去']) expect(looksLikeNetworkTrouble(t), t).toBe(true);
  });
  it('不误报普通含数字/CF 的句子', () => {
    expect(looksLikeNetworkTrouble('我住 502 房间')).toBe(false);
    expect(looksLikeNetworkTrouble('CF 是 Cloudflare 缩写')).toBe(false);
    expect(looksLikeNetworkTrouble('今天天气不错')).toBe(false);
  });
});

describe('maybeNetworkBurst', () => {
  it('窗内 <3 条 → 不冒', async () => {
    await maybeNetworkBurst(-100, m('挂了', 1), 9, 1000);
    await maybeNetworkBurst(-100, m('炸了', 2), 9, 1001);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('窗内 ≥3 条故障 → 冒一句', async () => {
    await maybeNetworkBurst(-100, m('挂了', 1), 9, 1000);
    await maybeNetworkBurst(-100, m('炸了', 2), 9, 1001);
    await maybeNetworkBurst(-100, m('连不上', 3), 9, 1002);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('冒过后冷却内不再冒', async () => {
    for (let i = 1; i <= 3; i++) await maybeNetworkBurst(-100, m('挂了', i), 9, 1000 + i);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    for (let i = 4; i <= 6; i++) await maybeNetworkBurst(-100, m('又挂了', i), 9, 1010 + i);
    expect(sendMessage).toHaveBeenCalledTimes(1); // 冷却挡住
  });

  it('非故障消息零计数', async () => {
    await maybeNetworkBurst(-100, m('今天吃啥', 1), 9, 1000);
    expect(redisMock.zadd).not.toHaveBeenCalled();
  });

  it('滑窗外的旧故障不计入(>45s)', async () => {
    await maybeNetworkBurst(-100, m('挂了', 1), 9, 1000);
    await maybeNetworkBurst(-100, m('炸了', 2), 9, 1002);
    await maybeNetworkBurst(-100, m('连不上', 3), 9, 1100); // 距第一条 100s,前两条已滚出窗
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
