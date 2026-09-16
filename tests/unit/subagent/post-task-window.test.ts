import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';

// ── 可变的 env 状态（repo 约定:env() mock 成普通对象按测试切换 flag） ──
const envState = {
  POST_TASK_WINDOW_ENABLED: true,
  POST_TASK_WINDOW_MS: 10_000,
  POST_TASK_FOLLOWUP_USAGE: 'judge',
  // loadCachedPrompt → getConfig() 会读这两个
  KNOWLEDGE_BASE_DIR: 'knowledge',
  PERSONA_DIR: '',
};

vi.mock('../../../src/env.js', () => ({ env: () => envState }));

// ── Redis 手 mock(不用 redis-mock 库;answered.ts 的真实实现走这里) ──
const redisStore = new Map<string, string>();
const redisSet = vi.fn(async (key: string, val: string, ..._rest: unknown[]) => {
  redisStore.set(key, val);
  return 'OK';
});
const redisGet = vi.fn(async (key: string) => redisStore.get(key) ?? null);

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: redisGet,
    set: redisSet,
    del: vi.fn(async () => 1),
  }),
}));

const enqueueMock = vi.fn(async (_task: unknown) => undefined);
vi.mock('../../../src/subagent/queue.js', () => ({
  enqueueCodeActJob: (...args: unknown[]) => enqueueMock(...args),
}));

const judgeResult = { content: '{"hasFollowUp":false,"reason":"纯附和"}' };
const callMock = vi.fn(async (_opts: unknown) => ({ ...judgeResult }));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callMock(...args),
}));

const CHAT = -100123;

async function loadModule() {
  return import('../../../src/subagent/post-task-window.js');
}

function firstUserPrompt(): string {
  const opts = callMock.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
  return String(opts.messages.find((m) => m.role === 'user')?.content ?? '');
}

function firstTask(): DispatchTask {
  return enqueueMock.mock.calls[0]![0] as DispatchTask;
}

describe('post-task window', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    redisStore.clear();
    envState.POST_TASK_WINDOW_ENABLED = true;
    envState.POST_TASK_WINDOW_MS = 10_000;
    callMock.mockResolvedValue({ ...judgeResult });
    const mod = await loadModule();
    mod._resetPostTaskWindowManager();
  });

  afterEach(async () => {
    const mod = await loadModule();
    mod._resetPostTaskWindowManager();
    vi.useRealTimers();
  });

  it('flag 关闭时完全 no-op', async () => {
    envState.POST_TASK_WINDOW_ENABLED = false;
    const mod = await loadModule();
    mod.noteBotSpoke(CHAT, { messageId: 900, textPreview: 'bot 刚说的话' });
    mod.ingestIncomingPostTask(CHAT, { messageId: 1001, userId: 7, username: 'alice', textPreview: '追问' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mod.getPostTaskWindowManager().hasActiveWindow(CHAT)).toBe(false);
    expect(callMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('flag 开时开窗;DM 不开窗(只有群聊)', async () => {
    const mod = await loadModule();
    mod.noteBotSpoke(CHAT, { messageId: 900, textPreview: 'bot 刚说的话' });
    expect(mod.getPostTaskWindowManager().hasActiveWindow(CHAT)).toBe(true);
    mod.noteBotSpoke(7624515600, { messageId: 901, textPreview: 'DM 发言' });
    expect(mod.getPostTaskWindowManager().hasActiveWindow(7624515600)).toBe(false);
  });

  it('缓冲窗口内消息,去重相同 messageId', async () => {
    const mod = await loadModule();
    mod.noteBotSpoke(CHAT, { messageId: 900, textPreview: '温度别超了' });
    mod.ingestIncomingPostTask(CHAT, { messageId: 1001, userId: 7, username: 'alice', textPreview: '哈哈' });
    mod.ingestIncomingPostTask(CHAT, { messageId: 1002, userId: 8, username: 'bob', textPreview: '收到' });
    // 重复入站同一条 → 只算一次
    mod.ingestIncomingPostTask(CHAT, { messageId: 1001, userId: 7, username: 'alice', textPreview: '哈哈' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callMock).toHaveBeenCalledTimes(1);
    const prompt = firstUserPrompt();
    expect(prompt.match(/#1001/g)).toHaveLength(1);
    expect(prompt).toContain('#1002');
    expect(prompt).toContain('温度别超了');
    // judge usage 走 env 配置
    expect((callMock.mock.calls[0]![0] as { usage: string }).usage).toBe('judge');
  });

  it('judge=true → 直接 dispatch CodeAct 续答并标 answered', async () => {
    callMock.mockResolvedValue({
      content: '{"hasFollowUp":true,"triggerMessageId":1002,"reason":"bob 追问了温度"}',
    });
    const mod = await loadModule();
    mod.noteBotSpoke(CHAT, { messageId: 900, textPreview: '先别超频', taskId: 'task-1' });
    mod.ingestIncomingPostTask(CHAT, { messageId: 1001, userId: 7, username: 'alice', textPreview: '哈哈' });
    mod.ingestIncomingPostTask(CHAT, { messageId: 1002, userId: 8, username: 'bob', textPreview: '那温度墙多少?' });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const task = firstTask();
    expect(task.chatId).toBe(CHAT);
    expect(task.quoteMessageIds).toEqual([1002]);
    expect(task.relatedQuoteIds).toEqual([1001]);
    expect(task.targetUserId).toBe(8);
    expect(task.trackingKey).toBe('post-task:task-1');
    expect(task.status).toBe('queued');
    expect(task.contentDirection).toContain('Post-task window');
    expect(task.contentDirection).toContain('bob');
    expect(task.contentDirection).toContain('#1002');
    expect(task.contentDirection).toContain('禁止复读');

    // trigger + 缓冲消息全部标 answered(防 Meta 双回)
    expect(redisStore.get(`xxb:meta:answered:${CHAT}:1001`)).toBe('1');
    expect(redisStore.get(`xxb:meta:answered:${CHAT}:1002`)).toBe('1');
  });

  it('judge=false → 不 dispatch、不标 answered', async () => {
    const mod = await loadModule();
    mod.noteBotSpoke(CHAT, { messageId: 900, textPreview: '先别超频' });
    mod.ingestIncomingPostTask(CHAT, { messageId: 1001, userId: 7, username: 'alice', textPreview: '哈哈' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('每窗口最多 2 次续答,配额耗尽后不再调 judge', async () => {
    envState.POST_TASK_WINDOW_MS = 60_000;
    callMock.mockResolvedValue({
      content: '{"hasFollowUp":true,"reason":"接住了"}',
    });
    const mod = await loadModule();
    mod.noteBotSpoke(CHAT, { messageId: 900, textPreview: 'bot 的话' });

    mod.ingestIncomingPostTask(CHAT, { messageId: 1001, userId: 7, username: 'a', textPreview: '追问 1' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    mod.ingestIncomingPostTask(CHAT, { messageId: 1002, userId: 8, username: 'b', textPreview: '追问 2' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(enqueueMock).toHaveBeenCalledTimes(2);

    // 第 3 批:配额耗尽,直接分诊掉,连 judge 都不调
    mod.ingestIncomingPostTask(CHAT, { messageId: 1003, userId: 9, username: 'c', textPreview: '追问 3' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(callMock).toHaveBeenCalledTimes(2);
  });

  it('窗口到期关闭,之后入站的消息不再缓冲', async () => {
    const mod = await loadModule();
    mod.noteBotSpoke(CHAT, { messageId: 900, textPreview: 'bot 的话' });
    mod.ingestIncomingPostTask(CHAT, { messageId: 1001, userId: 7, username: 'alice', textPreview: '追问' });
    // 直接跳到窗口结束之后(tick 与 expiry 都已过)
    await vi.advanceTimersByTimeAsync(11_000);
    expect(mod.getPostTaskWindowManager().hasActiveWindow(CHAT)).toBe(false);

    mod.ingestIncomingPostTask(CHAT, { messageId: 1002, userId: 7, username: 'alice', textPreview: '又追问' });
    await vi.advanceTimersByTimeAsync(10_000);
    // 只有第一批被 judge 过一次;关窗后不再有判定
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('judge 调用失败 → fail-soft 跳过该批,窗口继续工作', async () => {
    callMock.mockRejectedValueOnce(new Error('llm down'));
    const mod = await loadModule();
    mod.noteBotSpoke(CHAT, { messageId: 900, textPreview: 'bot 的话' });
    mod.ingestIncomingPostTask(CHAT, { messageId: 1001, userId: 7, username: 'alice', textPreview: '追问' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(enqueueMock).not.toHaveBeenCalled();

    // 下一批恢复正常 → 照常 dispatch
    callMock.mockResolvedValue({ content: '{"hasFollowUp":true,"triggerMessageId":1002}' });
    mod.ingestIncomingPostTask(CHAT, { messageId: 1002, userId: 8, username: 'bob', textPreview: '再追问' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(firstTask().quoteMessageIds).toEqual([1002]);
  });
});
