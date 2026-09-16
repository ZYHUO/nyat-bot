import { beforeEach, describe, expect, it, vi } from 'vitest';

// host telegram.forward：白名单群对群转发的隐私闸测试。

const MASTER = 6251541967;
const GROUP_A = -1002450361141;
const GROUP_B = -1003184176508;

const forwardMock = vi.fn(async () => 5555);
const redisIncr = vi.fn(async () => 1);

const envBase: Record<string, unknown> = {
  MASTER_UID: MASTER,
  CODEACT_BANNED_WORDS: [],
  ALLOWLIST_ENABLED: true,
  ALLOWLIST_REDIS_PREFIX: 'xxb:mal:',
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
  forwardMessage: (...args: unknown[]) => forwardMock(...args),
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ incr: (...a: unknown[]) => redisIncr(...a), expire: vi.fn(async () => 1) }),
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
  return createHostApi(chatId, { onEnd: vi.fn(), taskId: 't-fwd' });
}

describe('host telegram.forward（群对群转发）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forwardMock.mockResolvedValue(5555);
    redisIncr.mockResolvedValue(1);
  });

  it('任意群对群都能转（隐私判断归 AI，不硬闸白名单）', async () => {
    const api = await makeApi(GROUP_B);
    const r = await api.telegram.forward(GROUP_A, 12345);
    expect(r.messageId).toBe(5555);
    expect(forwardMock).toHaveBeenCalledWith(GROUP_B, GROUP_A, 12345);
  });

  it('DM 源/目标一律禁止（私聊内容不外流——唯一硬闸）', async () => {
    const api = await makeApi(MASTER);
    await expect(api.telegram.forward(GROUP_A, 123)).rejects.toThrow('forward_groups_only');
    const api2 = await makeApi(GROUP_B);
    await expect(api2.telegram.forward(7624515600, 123)).rejects.toThrow('forward_groups_only');
    expect(forwardMock).not.toHaveBeenCalled();
  });

  it('每任务限 2 次', async () => {
    const api = await makeApi(GROUP_B);
    await api.telegram.forward(GROUP_A, 1);
    await api.telegram.forward(GROUP_A, 2);
    await expect(api.telegram.forward(GROUP_A, 3)).rejects.toThrow('forward_limit:2_per_task');
  });

  it('目标群每天 cap 3：第 4 次返回 0 不炸', async () => {
    redisIncr.mockResolvedValue(4);
    const api = await makeApi(GROUP_B);
    const r = await api.telegram.forward(GROUP_A, 9);
    expect(r.messageId).toBe(0);
    expect(forwardMock).not.toHaveBeenCalled();
  });
});
