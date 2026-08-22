import { beforeEach, describe, expect, it, vi } from 'vitest';

// host admin 命名空间：权限自检（admin 权限不一定给到）+ 底线闸测试。

const MASTER = 6251541967;
const GROUP = -1002450361141;

const getChatMemberMock = vi.fn(async () => ({
  status: 'administrator',
  can_delete_messages: true,
  can_restrict_members: true,
  can_pin_messages: true,
}));
const deleteMessageMock = vi.fn(async () => undefined);
const muteMemberMock = vi.fn(async () => true);
const pinMessageMock = vi.fn(async () => true);
const redisIncr = vi.fn(async () => 1);

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
vi.mock('../../../src/bot/bot.js', () => ({
  getBot: () => ({ api: { getChatMember: (...a: unknown[]) => getChatMemberMock(...a) } }),
  getBotUid: () => 999,
  getBotDisplayName: () => '啾咪囝',
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: vi.fn(async () => 1),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
  deleteMessage: (...a: unknown[]) => deleteMessageMock(...a),
  muteMember: (...a: unknown[]) => muteMemberMock(...a),
  unmuteMember: vi.fn(async () => true),
  pinMessage: (...a: unknown[]) => pinMessageMock(...a),
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
  return createHostApi(chatId, { onEnd: vi.fn(), taskId: 't-admin' });
}

describe('host admin（群管理动作）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChatMemberMock.mockResolvedValue({
      status: 'administrator',
      can_delete_messages: true,
      can_restrict_members: true,
      can_pin_messages: true,
    });
    redisIncr.mockResolvedValue(1);
  });

  it('有权限时 deleteMessage 成功', async () => {
    const api = await makeApi(GROUP);
    const r = await api.admin.deleteMessage(12345);
    expect(r.ok).toBe(true);
    expect(deleteMessageMock).toHaveBeenCalledWith(GROUP, 12345);
  });

  it('bot 不是管理 → admin_no_permission 带指路文案', async () => {
    getChatMemberMock.mockResolvedValue({ status: 'member' });
    const api = await makeApi(GROUP);
    await expect(api.admin.deleteMessage(1)).rejects.toThrow(/admin_no_permission.*群设置里给我开/);
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('是管理但没勾 delete 权限 → 同样指路', async () => {
    getChatMemberMock.mockResolvedValue({ status: 'administrator', can_delete_messages: false });
    const api = await makeApi(GROUP);
    await expect(api.admin.deleteMessage(1)).rejects.toThrow('admin_no_permission');
  });

  it('DM 里拒绝', async () => {
    const api = await makeApi(MASTER);
    await expect(api.admin.pin(1)).rejects.toThrow('admin_groups_only');
  });

  it('mute 不许对主人/bot 自己下手', async () => {
    const api = await makeApi(GROUP);
    await expect(api.admin.mute(MASTER, 10)).rejects.toThrow('admin_no_master');
    await expect(api.admin.mute(999, 10)).rejects.toThrow('admin_no_self');
    expect(muteMemberMock).not.toHaveBeenCalled();
  });

  it('mute 正常路径：分钟钳制 + 调 sender', async () => {
    const api = await makeApi(GROUP);
    const r = await api.admin.mute(12345, 99999); // 超上限 → 钳到 1440
    expect(r.ok).toBe(true);
    expect(muteMemberMock).toHaveBeenCalledWith(GROUP, 12345, 1440);
  });

  it('频率闸：每小时超 10 次拒绝', async () => {
    redisIncr.mockResolvedValue(11);
    const api = await makeApi(GROUP);
    await expect(api.admin.pin(1)).rejects.toThrow('admin_rate_limit');
  });
});
