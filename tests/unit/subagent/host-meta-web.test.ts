import { beforeEach, describe, expect, it, vi } from 'vitest';

const ingestAsync = vi.fn(async (partial: Record<string, unknown>) => ({
  id: 'att-1',
  ...partial,
  createdAt: Date.now(),
  pressure: 95,
}));

const executeSearch = vi.fn(async () => '关于测试的搜索结果：ok');

vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: vi.fn(async () => 1),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({ CODEACT_BANNED_WORDS: [], CODEACT_WEB_SEARCH_ENABLED: true }),
}));

vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => []),
  searchMemoryByUser: vi.fn(async () => []),
  memorizeMessage: vi.fn(async () => undefined),
}));

vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: vi.fn(async () => undefined),
  getRecent: vi.fn(async () => []),
}));

vi.mock('../../../src/knowledge/sticker/store.js', () => ({
  getReadyStickersByIntent: () => [],
}));

vi.mock('../../../src/tracking/person-identity.js', () => ({
  getPersonIdentity: () => null,
  buildCrossGroupInjection: () => '',
}));

vi.mock('../../../src/meta/attention.js', () => ({
  getAttentionAccumulator: () => ({ ingestAsync }),
}));

vi.mock('../../../src/pipeline/tools/search.js', () => ({
  executeSearch: (...args: unknown[]) => executeSearch(...(args as [string])),
}));

describe('host web.search + meta.request', () => {
  beforeEach(() => {
    ingestAsync.mockClear();
    executeSearch.mockClear();
  });

  it('web.search delegates to executeSearch', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(1, { onEnd: () => {}, taskId: 't1' });
    const out = await host.web.search('今天天气');
    expect(executeSearch).toHaveBeenCalledWith('今天天气');
    expect(out).toContain('搜索结果');
  });

  it('meta.request queues subagent_request Attention once', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(7624515600, {
      onEnd: () => {},
      taskId: 'task-diary',
      defaultReplyTo: 88,
    });
    const r1 = await host.meta.request({ action: 'journal.write', detail: '主人要日记' });
    const r2 = await host.meta.request({ action: 'journal.write', detail: 'again' });
    expect(r1).toEqual({ queued: true, action: 'journal.write' });
    expect(r2.queued).toBe(false);
    expect(ingestAsync).toHaveBeenCalledTimes(1);
    expect(ingestAsync.mock.calls[0]![0]).toMatchObject({
      chatId: 7624515600,
      layer: 'L0',
      reason: 'subagent_request:journal.write',
      messageId: 88,
      payload: { action: 'journal.write', source: 'subagent', taskId: 'task-diary' },
    });
  });
});
