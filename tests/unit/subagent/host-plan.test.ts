import { beforeEach, describe, expect, it, vi } from 'vitest';

// runtime.setPlan（auto+plan 模式）：任务内计划状态 + dirty 标记语义。

const MASTER = 6251541967;

const envBase: Record<string, unknown> = {
  MASTER_UID: MASTER,
  CODEACT_BANNED_WORDS: [],
  CODEACT_TIMEOUT_MS: 5000,
  POST_TASK_WINDOW_ENABLED: false,
  MEMORY_CROSS_CONTEXT_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: false,
};

vi.mock('../../../src/env.js', () => ({ env: () => envBase }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: vi.fn(async () => 1),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: () => ({}), getBotUid: () => 999 }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
}));
vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => []),
  searchMemoryByUser: vi.fn(async () => []),
  memorizeMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({
  getReadyStickersByIntent: vi.fn(() => []),
}));
vi.mock('../../../src/tracking/person-identity.js', () => ({
  getPersonIdentity: vi.fn(() => null),
  buildCrossGroupInjection: vi.fn(() => ''),
}));
vi.mock('../../../src/tracking/scratchpad.js', () => ({
  setScratch: vi.fn(async () => undefined),
  clearScratch: vi.fn(async () => undefined),
}));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: vi.fn(async () => undefined) }));
vi.mock('../../../src/meta/attention.js', () => ({
  getAttentionAccumulator: () => ({ ingestAsync: vi.fn(async () => undefined) }),
}));
vi.mock('../../../src/subagent/post-task-window.js', () => ({ noteBotSpoke: vi.fn() }));
vi.mock('../../../src/metrics/social-ledger.js', () => ({ recordReplySent: vi.fn() }));

describe('runtime.setPlan（auto+plan 模式）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('setPlan → getPlan dirty → markPlanRead 清 dirty', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const api = createHostApi(MASTER, { onEnd: vi.fn(), taskId: 't-plan' });
    expect(api.runtime.getPlan?.()).toBeNull();
    api.runtime.setPlan(['查资料', '画图', '交付']);
    const p1 = api.runtime.getPlan?.();
    expect(p1?.steps).toEqual(['查资料', '画图', '交付']);
    expect(p1?.dirty).toBe(true);
    api.runtime.markPlanRead?.();
    expect(api.runtime.getPlan?.()?.dirty).toBe(false);
  });

  it('空步骤/超 8 步处理', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const api = createHostApi(MASTER, { onEnd: vi.fn(), taskId: 't-plan' });
    api.runtime.setPlan(['  ', '']);
    expect(api.runtime.getPlan?.()).toBeNull();
    api.runtime.setPlan(Array.from({ length: 12 }, (_, i) => `步骤${i + 1}`));
    expect(api.runtime.getPlan?.()?.steps).toHaveLength(8);
  });

  it('CodeAct 沙盒里 runtime.setPlan 可用', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const { runHostCodeForTest } = await import('../../../src/subagent/executor.js');
    const host = createHostApi(MASTER, { onEnd: vi.fn(), taskId: 't-plan' });
    const r = await runHostCodeForTest(
      `runtime.setPlan(['第一步','第二步']); return runtime.getPlan().steps.join(',');`,
      host,
      { isClosed: () => false, onTimeout: () => undefined, timeoutMs: 30_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe('第一步,第二步');
  }, 20_000);
});
