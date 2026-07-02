import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = {};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

const { reflectChatMock, mergeGlobalProfileMock, getMock, setMock, groupsRows, peopleRows } = vi.hoisted(() => ({
  reflectChatMock: vi.fn(async (): Promise<number> => 100),
  mergeGlobalProfileMock: vi.fn(async (): Promise<boolean> => true),
  getMock: vi.fn(async (): Promise<string | null> => null),
  setMock: vi.fn(async (): Promise<void> => undefined),
  groupsRows: [] as Array<{ chat_id: number }>,
  peopleRows: [] as Array<{ uid: number }>,
}));

vi.mock('../../../src/cron/deep-reflection.js', () => ({ reflectChat: reflectChatMock }));
vi.mock('../../../src/cron/profile-merge.js', () => ({ mergeGlobalProfile: mergeGlobalProfileMock }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ get: getMock, set: setMock }) }));
vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => (sql.includes('user_profiles') ? groupsRows : peopleRows),
    }),
  }),
}));

import { runStepfunConsumer } from '../../../src/cron/stepfun-consumer.js';

beforeEach(() => {
  for (const k of Object.keys(envValues)) delete envValues[k];
  Object.assign(envValues, {
    STEPFUN_CONSUMER_ENABLED: true,
    STEPFUN_CONSUMER_CALLS_PER_TICK: 10,
    STEPFUN_CONSUMER_CONCURRENCY: 4,
    STEPFUN_CONSUMER_REFLECT_WEIGHT: 3,
    STEPFUN_CONSUMER_USAGE: 'summarize',
  });
  vi.clearAllMocks();
  groupsRows.length = 0;
  peopleRows.length = 0;
  reflectChatMock.mockResolvedValue(100);
  mergeGlobalProfileMock.mockResolvedValue(true);
  getMock.mockResolvedValue(null);
});

describe('runStepfunConsumer', () => {
  it('flag 关 → 不跑', async () => {
    envValues['STEPFUN_CONSUMER_ENABLED'] = false;
    groupsRows.push({ chat_id: -1 });
    await runStepfunConsumer();
    expect(reflectChatMock).not.toHaveBeenCalled();
  });

  it('空池 → 不跑(不推进游标)', async () => {
    await runStepfunConsumer();
    expect(reflectChatMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });

  it('群按 REFLECT_WEIGHT 重复入池 + 跨上下文合并,跑满 perTick', async () => {
    groupsRows.push({ chat_id: -1001 }, { chat_id: -1002 }); // ×3 权重 = 6 群项
    peopleRows.push({ uid: 5 }, { uid: 6 }, { uid: 7 }, { uid: 8 }); // 4 合并项 → 池共 10
    await runStepfunConsumer();
    // perTick=10 == 池大小,应把 6 反思 + 4 合并全跑一遍
    expect(reflectChatMock).toHaveBeenCalledTimes(6);
    expect(mergeGlobalProfileMock).toHaveBeenCalledTimes(4);
    expect(setMock).toHaveBeenCalled(); // 游标推进
  });

  it('游标从上次位置继续(滚动覆盖),环绕取模', async () => {
    groupsRows.push({ chat_id: -1001 }); // ×3 = 3 群项,无人 → 池大小 3
    getMock.mockResolvedValue('2'); // 从索引 2 起
    envValues['STEPFUN_CONSUMER_CALLS_PER_TICK'] = 3;
    await runStepfunConsumer();
    expect(reflectChatMock).toHaveBeenCalledTimes(3); // 环绕仍覆盖 3 次
    // 下一个游标 = (2+3) % 3 = 2
    expect(setMock).toHaveBeenCalledWith('xxb:stepfun_consumer:cursor', '2');
  });

  it('单项抛错不影响整批(容错)', async () => {
    groupsRows.push({ chat_id: -1001 }); // ×3 = 3 项
    envValues['STEPFUN_CONSUMER_CALLS_PER_TICK'] = 3;
    reflectChatMock.mockRejectedValueOnce(new Error('boom'));
    await expect(runStepfunConsumer()).resolves.toBeUndefined();
    expect(reflectChatMock).toHaveBeenCalledTimes(3);
  });
});
