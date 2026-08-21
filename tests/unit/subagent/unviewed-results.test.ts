import { beforeEach, describe, expect, it, vi } from 'vitest';

// 2026-08-21 goal_2 事故回归：web.search 明明返回 1247 字，模型没 return →
// 只看到 'ok' → 向主人报「工具只回 ok，办不到」。机制修复：host 给查询类工具
// 结果留摘要，executor 在模型没 return 时捡回附进 output。

const MASTER = 6251541967;

const executeSearch = vi.fn(async () => 'DeepSeek API 新定价 8/16 UTC 生效，峰谷价差翻倍，V4 系列普涨……（共1247字）');
const callWithFallback = vi.fn(async () => ({ content: '{"promise": false, "topic": ""}' }));

const envBase: Record<string, unknown> = {
  MASTER_UID: MASTER,
  CODEACT_BANNED_WORDS: [],
  CODEACT_TIMEOUT_MS: 5000,
  CODEACT_WEB_SEARCH_ENABLED: true,
  SANDBOX_ENABLED: false,
  PROMISE_LOOP_ENABLED: true,
  POST_TASK_WINDOW_ENABLED: false,
  MEMORY_CROSS_CONTEXT_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: false,
};

vi.mock('../../../src/env.js', () => ({ env: () => envBase }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/pipeline/tools/search.js', () => ({
  executeSearch: (...args: unknown[]) => executeSearch(...args),
}));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallback(...args),
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: vi.fn(async () => 1),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBot: () => ({ api: { getChat: vi.fn(async () => ({})) } }),
  getBotUid: () => 999,
  getBotDisplayName: () => '啾咪囝',
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: vi.fn(async () => undefined),
  getRecent: vi.fn(async () => []),
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
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: vi.fn(async () => undefined) }));
vi.mock('../../../src/meta/attention.js', () => ({
  getAttentionAccumulator: () => ({ ingestAsync: vi.fn(async () => undefined) }),
}));
vi.mock('../../../src/subagent/post-task-window.js', () => ({ noteBotSpoke: vi.fn() }));
vi.mock('../../../src/metrics/social-ledger.js', () => ({ recordReplySent: vi.fn() }));

async function makeHostAndRunner() {
  const { createHostApi } = await import('../../../src/subagent/host-api.js');
  const { runHostCodeForTest } = await import('../../../src/subagent/executor.js');
  const host = createHostApi(MASTER, { onEnd: vi.fn(), taskId: 't-unviewed' });
  const opts = { isClosed: () => false, onTimeout: () => undefined, timeoutMs: 30_000 };
  return { host, run: (code: string) => runHostCodeForTest(code, host, opts) };
}

describe('unviewed tool results (「只回 ok」机制修复)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envBase.CODEACT_WEB_SEARCH_ENABLED = true;
  });

  it('调了 web.search 但没 return → output 捡回结果摘要并提示下次 return', async () => {
    const { run } = await makeHostAndRunner();
    const r = await run(`await web.search('DeepSeek 价格调整 最新进展');`);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('没 return');
    expect(r.output).toContain('DeepSeek API 新定价');
    expect(executeSearch).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('return 了搜索结果 → 正常输出，不附提示', async () => {
    const { run } = await makeHostAndRunner();
    const r = await run(`return await web.search('DeepSeek 价格');`);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('DeepSeek API 新定价');
    expect(r.output).not.toContain('没 return');
  }, 20_000);

  it('没调任何查询工具 → output 就是 ok，不附提示', async () => {
    const { run } = await makeHostAndRunner();
    const r = await run(`const x = 1 + 1;`);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('ok');
  }, 20_000);
});
