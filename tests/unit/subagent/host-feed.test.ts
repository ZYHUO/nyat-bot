import { beforeEach, describe, expect, it, vi } from 'vitest';

// host web.feed：本地 RSS 谈资库读取（找分享过的新闻的出处先翻本地）。

const MASTER = 6251541967;

const redisKeys = vi.fn(async () => ['xxb:rss:fuel:-1002450361141']);
const redisLrange = vi.fn(async () => [
  JSON.stringify({ title: '全球首款全自主打网球机器人亮相', link: 'https://example.com/a', source: 'IT之家' }),
  JSON.stringify({ title: '第二届世界人形机器人运动会开幕', source: 'IT之家' }),
]);

const envBase: Record<string, unknown> = {
  MASTER_UID: MASTER,
  CODEACT_BANNED_WORDS: [],
  CODEACT_WEB_SEARCH_ENABLED: false,
  POST_TASK_WINDOW_ENABLED: false,
  MEMORY_CROSS_CONTEXT_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: false,
};

vi.mock('../../../src/env.js', () => ({ env: () => envBase }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    keys: (...a: unknown[]) => redisKeys(...a),
    lrange: (...a: unknown[]) => redisLrange(...a),
  }),
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: vi.fn(async () => 1),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: () => ({}), getBotUid: () => 999 }));
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
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: vi.fn(async () => undefined),
  getRecent: vi.fn(async () => []),
}));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: vi.fn(async () => undefined) }));
vi.mock('../../../src/meta/attention.js', () => ({
  getAttentionAccumulator: () => ({ ingestAsync: vi.fn(async () => undefined) }),
}));
vi.mock('../../../src/subagent/post-task-window.js', () => ({ noteBotSpoke: vi.fn() }));
vi.mock('../../../src/metrics/social-ledger.js', () => ({ recordReplySent: vi.fn() }));

describe('host web.feed（本地 RSS 谈资库）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisKeys.mockResolvedValue(['xxb:rss:fuel:-1002450361141']);
    redisLrange.mockResolvedValue([
      JSON.stringify({ title: '全球首款全自主打网球机器人亮相', link: 'https://example.com/a', source: 'IT之家' }),
      JSON.stringify({ title: '第二届世界人形机器人运动会开幕', source: 'IT之家' }),
    ]);
  });

  it('返回源+标题+链接的谈资列表', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const api = createHostApi(MASTER, { onEnd: vi.fn(), taskId: 't-feed' });
    const out = await api.web.feed();
    expect(out).toContain('[IT之家] 全球首款全自主打网球机器人亮相 https://example.com/a');
    expect(out).toContain('第二届世界人形机器人运动会开幕');
  });

  it('谈资库空 → 明确提示', async () => {
    redisKeys.mockResolvedValue([]);
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const api = createHostApi(MASTER, { onEnd: vi.fn(), taskId: 't-feed' });
    expect(await api.web.feed()).toBe('(谈资库是空的)');
  });

  it('坏 JSON 条目跳过不炸', async () => {
    redisLrange.mockResolvedValue(['{bad json', JSON.stringify({ title: '正常条目', source: 'S' })]);
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const api = createHostApi(MASTER, { onEnd: vi.fn(), taskId: 't-feed' });
    const out = await api.web.feed();
    expect(out).toBe('[S] 正常条目');
  });
});
