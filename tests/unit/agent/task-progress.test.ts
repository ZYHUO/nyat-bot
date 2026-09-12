import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.fn(async () => 123);
const keys = new Set<string>();
const redis = {
  set: vi.fn(async (key: string, _value: string, ...args: unknown[]) => {
    const nx = args.includes('NX');
    if (nx && keys.has(key)) return null;
    keys.add(key);
    return 'OK';
  }),
};
const envMock = vi.fn();

vi.mock('../../../src/env.js', () => ({ env: () => envMock() }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redis }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { notifyTaskProgress, markTaskVisible, resetTaskProgressMemory } = await import('../../../src/agent/task-progress.js');

beforeEach(() => {
  envMock.mockReturnValue({
    TASK_PROGRESS_ENABLED: true,
    TASK_PROGRESS_MIN_INTERVAL_MS: 30_000,
    TASK_PROGRESS_MAX_VISIBLE_UPDATES: 6,
  });
  sendMessage.mockClear();
  redis.set.mockClear();
  keys.clear();
  resetTaskProgressMemory();
});

describe('task progress notifier', () => {
  it('deduplicates the same task phase', async () => {
    const event = { taskId: 'task-1', chatId: -100, phase: 'started' as const, text: '收到，我开始看了' };
    await notifyTaskProgress(event);
    await notifyTaskProgress(event);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not send an automatic update immediately after a model message', async () => {
    markTaskVisible('task-2');
    await notifyTaskProgress({ taskId: 'task-2', chatId: -100, phase: 'searching', text: '我先查一下' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps terminal notifications available after regular updates', async () => {
    await notifyTaskProgress({ taskId: 'task-3', chatId: -100, phase: 'started', text: '开始处理了' });
    await notifyTaskProgress({ taskId: 'task-3', chatId: -100, phase: 'done', text: '整理好了' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(-100, '整理好了', undefined, undefined);
  });

  it('swallows Telegram failures', async () => {
    sendMessage.mockRejectedValueOnce(new Error('telegram down'));
    await expect(notifyTaskProgress({ taskId: 'task-4', chatId: -100, phase: 'started', text: '开始处理了' })).resolves.toBeUndefined();
  });
});
