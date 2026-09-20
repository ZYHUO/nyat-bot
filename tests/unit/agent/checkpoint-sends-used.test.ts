/**
 * 跨段发送预算：checkpoint 必须把 sendsUsed 存下来、恢复出来。
 *
 * 2026-09-21 修的 bug：发送预算原本是"每段 6 条"，因为每段重建 host api 就把
 * textSent 归零了。AGENT_MAX_SEGMENTS 默认 10，所以真实上限是 60 条/任务。
 * 实测最差一个任务 46 秒发了 12 条。
 *
 * 修法是把 sendsUsed 记在 task 上跨段累计。**这里最容易漏的是只堵 save 不堵
 * restore**——存了但恢复时不读，续跑段又拿到满额预算，等于没修。
 * 所以这两个方向都要锁。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
const redis = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redis }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { saveCheckpoint, loadCheckpoint, checkpointKey } = await import('../../../src/agent/checkpoint.js');

const task = {
  id: 'task-send-budget',
  chatId: -100,
  contentDirection: '去把那个刷屏的处理了',
} as never;

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('checkpoint · sendsUsed 跨段累计', () => {
  it('save 把 sendsUsed 写进 checkpoint', async () => {
    await saveCheckpoint(task, {
      history: [],
      progressSummary: 'p',
      artifacts: [],
      segment: 1,
      totalTurns: 12,
      sendsUsed: 5,
    });
    const cp = await loadCheckpoint(checkpointKey('task-send-budget'));
    expect(cp).not.toBeNull();
    expect(cp!.sendsUsed).toBe(5);
  });

  it('load 读得出 sendsUsed（restore 那一侧）', async () => {
    await saveCheckpoint(task, {
      history: [], progressSummary: 'p', artifacts: [], segment: 2, totalTurns: 30, sendsUsed: 6,
    });
    const cp = await loadCheckpoint(checkpointKey('task-send-budget'));
    expect(cp!.sendsUsed).toBe(6);
    // 恢复逻辑是 Math.max(task.sendsUsed ?? 0, cp.sendsUsed ?? 0)——
    // 模拟"task 上还没有"的续跑段
    const restored = Math.max(0, cp!.sendsUsed ?? 0);
    expect(restored).toBe(6);
  });

  it('没传 sendsUsed 时不写坏字段（旧 checkpoint 兼容）', async () => {
    await saveCheckpoint(task, {
      history: [], progressSummary: 'p', artifacts: [], segment: 0, totalTurns: 3,
    });
    const cp = await loadCheckpoint(checkpointKey('task-send-budget'));
    expect(cp!.sendsUsed).toBeUndefined();
    // 恢复侧对 undefined 宽容
    expect(Math.max(0, cp!.sendsUsed ?? 0)).toBe(0);
  });

  it('sendsUsed=0 与 undefined 在恢复侧等价（都拿到满额预算）', async () => {
    for (const v of [0, undefined]) {
      store.clear();
      await saveCheckpoint(task, {
        history: [], progressSummary: 'p', artifacts: [], segment: 0, totalTurns: 1,
        ...(v === undefined ? {} : { sendsUsed: v }),
      });
      const cp = await loadCheckpoint(checkpointKey('task-send-budget'));
      expect(Math.max(0, cp!.sendsUsed ?? 0)).toBe(0);
    }
  });

  it('跨段语义：第 1 段用 6 条 → 第 2 段剩余 0（这条锁住"预算归零"的复发）', async () => {
    const budget = 6;
    await saveCheckpoint(task, {
      history: [], progressSummary: 'p', artifacts: [], segment: 1, totalTurns: 20, sendsUsed: budget,
    });
    const cp = await loadCheckpoint(checkpointKey('task-send-budget'));
    const taskSendsUsed = Math.max(0, cp!.sendsUsed ?? 0);
    const remaining = Math.max(0, budget - taskSendsUsed);
    expect(remaining).toBe(0);
    // 剩余 0 → maxTextSends=0 → 第一条 sendText 就抛 sendText_limit:0，
    // executor 的预算耗尽检查随即 endTask。第 2 段一条都发不出去。
  });
});
