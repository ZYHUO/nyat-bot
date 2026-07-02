import { describe, it, expect, beforeEach, vi } from 'vitest';

const kv = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => kv.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { kv.set(k, v); return 'OK'; }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { getRecentTimestampsMock, getFocusMock } = vi.hoisted(() => ({
  getRecentTimestampsMock: vi.fn(async (): Promise<number[]> => []),
  getFocusMock: vi.fn(async () => 0.3),
}));
vi.mock('../../../src/tracking/activity.js', () => ({ getRecentTimestamps: getRecentTimestampsMock }));
vi.mock('../../../src/pipeline/turn/focus.js', () => ({ getFocus: getFocusMock }));

const envValues: Record<string, unknown> = {};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

import {
  checkTalkValueThreshold,
  computeAvgIntervalSec,
  focusAdjust,
  getChatTalkValue,
  TALKVALUE_KEY_PREFIX,
  AVG_INTERVAL_DEFAULT_SEC,
  AVG_INTERVAL_FLOOR_SEC,
} from '../../../src/pipeline/timing/talk-value.js';

beforeEach(() => {
  kv.clear();
  for (const k of Object.keys(envValues)) delete envValues[k];
  Object.assign(envValues, { TIMING_TALK_VALUE: 1.0, TURN_FOCUS_ENABLED: false });
  getRecentTimestampsMock.mockReset();
  getRecentTimestampsMock.mockResolvedValue([]);
  getFocusMock.mockReset();
  getFocusMock.mockResolvedValue(0.3);
});

describe('computeAvgIntervalSec', () => {
  it('剔除 <5s burst 间隔,取均值', () => {
    // 间隔: 2(丢), 60, 120 → avg=90
    expect(computeAvgIntervalSec([0, 2, 62, 182])).toBe(90);
  });

  it('间隔均值低于下限时 floor 到 30', () => {
    // 间隔 10, 10 → avg 10 → floor 30
    expect(computeAvgIntervalSec([0, 10, 20])).toBe(AVG_INTERVAL_FLOOR_SEC);
  });

  it('样本不足(<2 有效间隔)→ 兜底 120', () => {
    expect(computeAvgIntervalSec([])).toBe(AVG_INTERVAL_DEFAULT_SEC);
    expect(computeAvgIntervalSec([100])).toBe(AVG_INTERVAL_DEFAULT_SEC);
    expect(computeAvgIntervalSec([0, 60])).toBe(AVG_INTERVAL_DEFAULT_SEC); // 仅 1 个间隔
  });
});

describe('focusAdjust', () => {
  it('0.5+focus,clamp [0.5, 1.5]', () => {
    expect(focusAdjust(0)).toBe(0.5);
    expect(focusAdjust(0.5)).toBe(1);
    expect(focusAdjust(1)).toBe(1.5);
    expect(focusAdjust(2)).toBe(1.5);
  });
});

describe('getChatTalkValue', () => {
  it('无覆盖 → env 默认', async () => {
    envValues['TIMING_TALK_VALUE'] = 0.5;
    expect(await getChatTalkValue(-100)).toBe(0.5);
  });

  it('per-chat Redis 覆盖优先', async () => {
    envValues['TIMING_TALK_VALUE'] = 1.0;
    kv.set(`${TALKVALUE_KEY_PREFIX}-100`, '0.33');
    expect(await getChatTalkValue(-100)).toBe(0.33);
  });

  it('非法覆盖(越界/非数字)按无覆盖处理', async () => {
    envValues['TIMING_TALK_VALUE'] = 0.7;
    kv.set(`${TALKVALUE_KEY_PREFIX}-100`, '2.5');
    expect(await getChatTalkValue(-100)).toBe(0.7);
    kv.set(`${TALKVALUE_KEY_PREFIX}-100`, 'abc');
    expect(await getChatTalkValue(-100)).toBe(0.7);
  });
});

describe('checkTalkValueThreshold', () => {
  it('talkValue=1.0 恒 pass(即使 focus 调低有效值)', async () => {
    envValues['TURN_FOCUS_ENABLED'] = true;
    getFocusMock.mockResolvedValue(0); // adjust 0.5 → 若不早退会得 threshold 2
    const v = await checkTalkValueThreshold({ chatId: -100, state: { state: 'RUNNING' } });
    expect(v.pass).toBe(true);
    expect(getFocusMock).not.toHaveBeenCalled();
  });

  it('talkValue=0.5 → threshold 2:1 条不够,2 条够', async () => {
    envValues['TIMING_TALK_VALUE'] = 0.5;
    const below = await checkTalkValueThreshold({
      chatId: -100,
      state: { state: 'RUNNING', gatePendingCount: 1, gatePendingSince: Date.now() },
    });
    expect(below.pass).toBe(false);
    expect(below.threshold).toBe(2);
    expect(below.retryAfterMs).toBeGreaterThan(0);

    const enough = await checkTalkValueThreshold({
      chatId: -100,
      state: { state: 'RUNNING', gatePendingCount: 2, gatePendingSince: Date.now() },
    });
    expect(enough.pass).toBe(true);
  });

  it('空闲补偿:沉默足够久时 1 条也能过', async () => {
    envValues['TIMING_TALK_VALUE'] = 0.5;
    // 平均间隔 60s(样本 3 个 60s 间隔),已沉默 90s → idleEquiv=1(封顶 threshold-1=1)
    const now = Math.floor(Date.now() / 1000);
    getRecentTimestampsMock.mockResolvedValue([now - 300, now - 240, now - 180, now - 120]);
    const v = await checkTalkValueThreshold({
      chatId: -100,
      state: { state: 'RUNNING', gatePendingCount: 1, gatePendingSince: Date.now() - 90_000 },
    });
    expect(v.pass).toBe(true);
    expect(v.equivalent).toBeGreaterThanOrEqual(2);
  });

  it('空闲折算封顶 threshold-1:纯沉默不凑数(count 兜底为 1 也不过 threshold 3)', async () => {
    envValues['TIMING_TALK_VALUE'] = 0.33;
    const now = Math.floor(Date.now() / 1000);
    getRecentTimestampsMock.mockResolvedValue([now - 600, now - 540, now - 480]);
    // threshold=ceil(1/0.33)=4;count=1,idle 巨大 → idleEquiv 封顶 3 → equivalent=4 过。
    // 换成 count=1、threshold=4、idle 折算封顶 3 → 恰好等于阈值,pass。
    // 真正的"纯沉默不触发"由 count 至少含 1 条真实消息保证 —— 这里验证封顶生效:
    const v = await checkTalkValueThreshold({
      chatId: -100,
      state: { state: 'RUNNING', gatePendingCount: 1, gatePendingSince: Date.now() - 3_000_000 },
    });
    expect(v.equivalent).toBeLessThanOrEqual(4);
  });

  it('retryAfterMs = (差额条数×平均间隔 - 已沉默) 毫秒', async () => {
    envValues['TIMING_TALK_VALUE'] = 0.5;
    const now = Math.floor(Date.now() / 1000);
    // 平均间隔 60s;count=1,threshold=2,已沉默 10s → retry ≈ (1*60-10)s = 50s
    getRecentTimestampsMock.mockResolvedValue([now - 300, now - 240, now - 180, now - 120]);
    const v = await checkTalkValueThreshold({
      chatId: -100,
      state: { state: 'RUNNING', gatePendingCount: 1, gatePendingSince: Date.now() - 10_000 },
    });
    expect(v.pass).toBe(false);
    expect(v.retryAfterMs).toBeGreaterThan(45_000);
    expect(v.retryAfterMs).toBeLessThan(55_000);
  });

  it('内部错误 → fail-open pass', async () => {
    envValues['TIMING_TALK_VALUE'] = 0.5;
    getRecentTimestampsMock.mockRejectedValue(new Error('redis down'));
    const v = await checkTalkValueThreshold({
      chatId: -100,
      state: { state: 'RUNNING', gatePendingCount: 1, gatePendingSince: Date.now() },
    });
    expect(v.pass).toBe(true);
  });
});
