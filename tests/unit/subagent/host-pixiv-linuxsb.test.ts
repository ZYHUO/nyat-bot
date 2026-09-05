import { describe, expect, it, vi } from 'vitest';

const envBase: Record<string, unknown> = {
  MASTER_UID: 6251541967,
  CODEACT_BANNED_WORDS: [],
  CODEACT_TIMEOUT_MS: 5000,
  CODEACT_WEB_SEARCH_ENABLED: true,
  CODEACT_PIXIV_ENABLED: true,
  CODEACT_LINUXSB_ENABLED: true,
  SANDBOX_ENABLED: false,
  PROMISE_LOOP_ENABLED: false,
  POST_TASK_WINDOW_ENABLED: false,
  MEMORY_CROSS_CONTEXT_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: false,
};

const pixivSearch = vi.fn(async () => [
  {
    id: '123',
    title: '安全猫图',
    pageUrl: 'https://www.pixiv.net/artworks/123',
    userName: '画师A',
    tags: ['cat'],
    width: 1200,
    height: 900,
    pageCount: 1,
  },
]);
const pixivDownload = vi.fn(async () => ({ path: 'pixiv/123.jpg', id: '123', bytes: 12345 }));
const linuxSbLatest = vi.fn(async () => [
  {
    id: 18305,
    title: '新人报道',
    url: 'https://linux.sb/topic/18305',
    author: '南柯一梦',
    forum: '错误地方',
    time: '1分钟前',
    pinned: false,
  },
]);
const linuxSbTopic = vi.fn(async () => ({
  id: 18305,
  title: '新人报道',
  url: 'https://linux.sb/topic/18305',
  forum: '错误地方',
  posts: [{ id: 18305, author: '南柯一梦', time: '1分钟前', text: '大家好' }],
}));
const linuxSbSearch = vi.fn(async () => [
  {
    id: 15484,
    title: '【油猴脚本】宽屏现代 UI',
    url: 'https://linux.sb/topic/15484',
    author: 'token',
    forum: '技术交流',
    time: '昨天',
    pinned: false,
  },
]);

vi.mock('../../../src/env.js', () => ({ env: () => envBase }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/pipeline/tools/pixiv.js', () => ({
  searchPixiv: pixivSearch,
  downloadPixivImage: pixivDownload,
}));
vi.mock('../../../src/pipeline/tools/linuxsb.js', () => ({
  fetchLinuxSbLatest: linuxSbLatest,
  fetchLinuxSbTopic: linuxSbTopic,
  searchLinuxSb: linuxSbSearch,
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: vi.fn(async () => 1),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));
vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => ''),
  searchMemoryByUser: vi.fn(async () => ''),
}));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getReadyStickersByIntent: vi.fn(() => []) }));
vi.mock('../../../src/tracking/person-identity.js', () => ({
  getPersonIdentity: vi.fn(() => null),
  buildCrossGroupInjection: vi.fn(() => ''),
}));

describe('host pixiv + linuxsb namespaces', () => {
  it('pixiv.search delegates and returns compact results', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(1, { onEnd: () => {}, taskId: 't1' });
    const out = await host.pixiv.search('猫', 3);
    expect(pixivSearch).toHaveBeenCalledWith('猫', { limit: 3 });
    expect(out).toContain('安全猫图');
    expect(out).toContain('https://www.pixiv.net/artworks/123');
  });

  it('pixiv.download saves image inside sandbox', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(1, { onEnd: () => {}, taskId: 't1' });
    const out = await host.pixiv.download('https://www.pixiv.net/artworks/123');
    expect(pixivDownload).toHaveBeenCalledWith('https://www.pixiv.net/artworks/123');
    expect(out).toEqual({ path: 'pixiv/123.jpg', id: '123', bytes: 12345 });
  });

  it('linuxsb.latest and linuxsb.topic return readable text', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(1, { onEnd: () => {}, taskId: 't1' });
    const latest = await host.linuxsb.latest('comment', 5);
    const topic = await host.linuxsb.topic('https://linux.sb/topic/18305');
    expect(linuxSbLatest).toHaveBeenCalledWith({ sort: 'comment', limit: 5 });
    expect(linuxSbTopic).toHaveBeenCalledWith('https://linux.sb/topic/18305', { limit: undefined });
    expect(latest).toContain('新人报道');
    expect(topic).toContain('大家好');
  });

  it('linuxsb.search delegates keyword matching', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(1, { onEnd: () => {}, taskId: 't1' });
    const out = await host.linuxsb.search('油猴', 3);
    expect(linuxSbSearch).toHaveBeenCalledWith('油猴', { limit: 3 });
    expect(out).toContain('宽屏现代 UI');
  });
});
