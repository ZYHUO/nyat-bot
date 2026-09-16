import { beforeEach, describe, expect, it, vi } from 'vitest';

// host telegram.sendPoll：群投票（真人感「事件型」动作）的闸测试。

const MASTER = 6251541967;
const GROUP = -1002450361141;

const sendPollMock = vi.fn(async () => 4242);
const redisIncr = vi.fn(async () => 1);
const redisExpire = vi.fn(async () => 1);

const envBase: Record<string, unknown> = {
  MASTER_UID: MASTER,
  CODEACT_BANNED_WORDS: [],
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
  sendPoll: (...args: unknown[]) => sendPollMock(...args),
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    incr: (...a: unknown[]) => redisIncr(...a),
    expire: (...a: unknown[]) => redisExpire(...a),
  }),
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

async function makeApi(chatId: number) {
  const { createHostApi } = await import('../../../src/subagent/host-api.js');
  return createHostApi(chatId, { onEnd: vi.fn(), taskId: 't-poll' });
}

describe('host telegram.sendPoll（群投票）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendPollMock.mockResolvedValue(4242);
    redisIncr.mockResolvedValue(1);
  });

  it('群聊成功发起，写入上下文记录', async () => {
    const api = await makeApi(GROUP);
    const r = await api.telegram.sendPoll('今晚吃什么喵', ['鳗鱼饭', '寿司', '拉面']);
    expect(r.messageId).toBe(4242);
    expect(sendPollMock).toHaveBeenCalledWith(GROUP, '今晚吃什么喵', ['鳗鱼饭', '寿司', '拉面'], undefined);
  });

  it('DM 拒绝（投票只在群里）', async () => {
    const api = await makeApi(MASTER);
    await expect(api.telegram.sendPoll('q', ['a', 'b'])).rejects.toThrow('sendPoll_groups_only');
    expect(sendPollMock).not.toHaveBeenCalled();
  });

  it('选项不足 2 个拒绝', async () => {
    const api = await makeApi(GROUP);
    await expect(api.telegram.sendPoll('q', ['只有一个'])).rejects.toThrow('sendPoll_need_2_options');
  });

  it('每任务限 1 次', async () => {
    const api = await makeApi(GROUP);
    await api.telegram.sendPoll('第一个', ['a', 'b']);
    await expect(api.telegram.sendPoll('第二个', ['a', 'b'])).rejects.toThrow('sendPoll_limit:1_per_task');
  });

  it('每群每天 cap 2：第 3 次返回 messageId 0 不炸', async () => {
    redisIncr.mockResolvedValue(3); // 今天已发 2 次，这是第 3 次
    const api = await makeApi(GROUP);
    const r = await api.telegram.sendPoll('又来', ['a', 'b']);
    expect(r.messageId).toBe(0);
    expect(sendPollMock).not.toHaveBeenCalled();
  });
});
