import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `closeCodeActWorker` 关机时不能再把整条关机链拖死（round 189）。
 *
 * 实测（全日志 384 次关机）：53 次 `Forced exit after shutdown timeout`，
 * 其中 **48 次卡在第一步** —— 最后一条 `shutdown step` 是 `cron`，
 * 而 cron 那步之后紧接着就是 `await closeCodeActWorker()`。
 * 只有 3 次卡在 worker、2 次在 ingress、0 次在 redis+db。
 *
 * 也就是说 round 64 修的 closeRedis（redis+db 步）已经不再卡，
 * **故障搬了家**：BullMQ 的 `_worker.close()` / `_queue.close()`
 * 会等在飞 job 或等一个已经不回的 Redis 连接。
 *
 * 代价不只是"重启慢"：forced exit 是 `process.exit(1)`（systemd 记失败），
 * 而 index.ts 的注释写明 status=9/KILL 会跳过 WAL checkpoint / token 记账 /
 * BullMQ 锁释放 —— 这一步卡住是在丢数据。
 */

const { workerCloseMock, queueCloseMock, loggerInfoMock } = vi.hoisted(() => ({
  workerCloseMock: vi.fn(),
  queueCloseMock: vi.fn(),
  loggerInfoMock: vi.fn(),
}));

/** 让 close 永不 resolve —— 模拟"等一个不回来的连接"。 */
function hang(): Promise<never> {
  return new Promise<never>(() => { /* 永远不 resolve */ });
}

vi.mock('bullmq', () => ({
  Queue: class { add() { return Promise.resolve({ id: 'j' }); } close() { return queueCloseMock(); } },
  Worker: class { on() { return this; } close() { return workerCloseMock(); } },
  DelayedError: class extends Error {},
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_CONCURRENCY: 1 }) }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ putTask: vi.fn() }) }));
vi.mock('../../../src/subagent/task-store.js', () => ({
  tryMarkCodeActActive: vi.fn(),
  clearCodeActActive: vi.fn(),
  persistCodeActTask: vi.fn(async () => true),
}));
vi.mock('../../../src/subagent/executor.js', () => ({ enqueueSubagentTaskLocal: vi.fn() }));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({ emitTaskRuntimeEvent: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: (...a: unknown[]) => loggerInfoMock(...a), warn: vi.fn(), error: vi.fn() },
}));

// 必须真的入队一次，才会把模块级的 _worker / _queue 建起来。
import {
  closeCodeActWorker,
  enqueueCodeActJob,
  startCodeActWorker,
} from '../../../src/subagent/queue.js';

let seq = 0;
beforeEach(async () => {
  workerCloseMock.mockReset();
  queueCloseMock.mockReset();
  loggerInfoMock.mockClear();
  // 重建 _worker / _queue：closeCodeActWorker 关完就把它们置 undefined，
  // 不重建的话第二个测试就没有可关的东西（第一版漏了，测试之间互相串味）。
  await enqueueCodeActJob({ id: `t${++seq}`, chatId: -100 } as never);
  startCodeActWorker();   // _worker 是这个函数建的，enqueue 不建
});

// 挂着的那几条会真的等满 5s 赛跑上限，vitest 默认 5s 会先被砍。
describe('closeCodeActWorker 不再拖死关机链', { timeout: 15000 }, () => {
  it('① worker.close() 挂住时，函数仍会返回（不等 25s）', async () => {
    workerCloseMock.mockImplementation(hang);
    const started = Date.now();
    await closeCodeActWorker();
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('② queue.close() 挂住时，函数仍会返回', async () => {
    queueCloseMock.mockImplementation(hang);
    const started = Date.now();
    await closeCodeActWorker();
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('③ 两个都挂住也返回（最坏形状）', async () => {
    workerCloseMock.mockImplementation(hang);
    queueCloseMock.mockImplementation(hang);
    await closeCodeActWorker();
    expect(queueCloseMock).toHaveBeenCalled();
  });

  it('④ 分步日志：worker 和 queue 各有自己的 shutdown step（下次能看出卡哪个）', async () => {
    workerCloseMock.mockImplementation(async () => {});
    queueCloseMock.mockImplementation(async () => {});
    await closeCodeActWorker();
    const steps = loggerInfoMock.mock.calls
      .map((c) => (c[0] as { step?: string } | undefined)?.step)
      .filter(Boolean);
    expect(steps).toContain('codeact-worker');
    expect(steps).toContain('codeact-queue');
  });

  it('⑤ 正常路径（都秒回）仍然真的关掉，且两次都调', async () => {
    workerCloseMock.mockImplementation(async () => {});
    queueCloseMock.mockImplementation(async () => {});
    await closeCodeActWorker();
    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('⑥ close 抛错不炸关机（与步骤无关的错误也要吞掉）', async () => {
    workerCloseMock.mockImplementation(async () => { throw new Error('boom'); });
    queueCloseMock.mockImplementation(async () => {});
    await expect(closeCodeActWorker()).resolves.toBeUndefined();
    expect(queueCloseMock).toHaveBeenCalled();
  });
});
