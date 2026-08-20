import { beforeEach, describe, expect, it, vi } from 'vitest';

// host 层 allowlist 命名空间测试：闸（flag / DM-only / master-only）+ 到 bot-flow 的接线。
// bot-flow 模块整体 mock 掉——流程逻辑在 tests/unit/allowlist/bot-flow.test.ts 覆盖。

const MASTER = 6251541967;
const OTHER_USER = 12345;
const GROUP = -1002450361141;

const applyViaBot = vi.fn(async () => ({ kind: 'approved', chatId: GROUP, title: '好群', confidence: 0.95, reason: 'ok' }));
const masterApprove = vi.fn(async () => ({ kind: 'approved', chatId: GROUP, title: '好群' }));
const masterReject = vi.fn(async () => ({ kind: 'rejected', chatId: GROUP, title: '好群' }));
const listForMaster = vi.fn(async () => '待评判 (0):\n已通过 (0):\n已拒绝 (0):');

const envBase: Record<string, unknown> = {
  MASTER_UID: MASTER,
  CODEACT_BANNED_WORDS: [],
  ALLOWLIST_BOT_FLOW_ENABLED: true,
  POST_TASK_WINDOW_ENABLED: false,
  MEMORY_CROSS_CONTEXT_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: false,
};

vi.mock('../../../src/env.js', () => ({ env: () => envBase }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/allowlist/bot-flow.js', () => ({
  applyViaBot: (...args: unknown[]) => applyViaBot(...args),
  masterApprove: (...args: unknown[]) => masterApprove(...args),
  masterReject: (...args: unknown[]) => masterReject(...args),
  listForMaster: (...args: unknown[]) => listForMaster(...args),
  configFromEnv: () => ({ enabled: true }),
  defaultGetRecentContext: async () => '',
}));
vi.mock('../../../src/allowlist/ai-call.js', () => ({
  callAllowlistReviewModel: vi.fn(async () => null),
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: vi.fn(async () => 1),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBot: () => ({ api: { getChat: vi.fn(async () => ({ username: 'u', first_name: 'n' })) } }),
  getBotUid: () => 999,
  getBotDisplayName: () => '啾咪囝',
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
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
  return createHostApi(chatId, { onEnd: vi.fn(), taskId: 'task-1' });
}

describe('host allowlist namespace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envBase.ALLOWLIST_BOT_FLOW_ENABLED = true;
  });

  it('flag 关闭 → 全部拒绝', async () => {
    envBase.ALLOWLIST_BOT_FLOW_ENABLED = false;
    const api = await makeApi(OTHER_USER);
    await expect(api.allowlist.apply('@x')).rejects.toThrow('allowlist_bot_flow_disabled');
    await expect(api.allowlist.list()).rejects.toThrow('allowlist_bot_flow_disabled');
  });

  it('apply：群任务里不可用（必须私聊，DM chatId 即申请人 uid）', async () => {
    const api = await makeApi(GROUP);
    await expect(api.allowlist.apply('@x')).rejects.toThrow('allowlist_apply_dm_only');
    expect(applyViaBot).not.toHaveBeenCalled();
  });

  it('apply：普通用户私聊可用，申请人 uid = DM chatId', async () => {
    const api = await makeApi(OTHER_USER);
    const r = await api.allowlist.apply('@goodgroup', '群主想玩');
    expect(r.kind).toBe('approved');
    expect(applyViaBot).toHaveBeenCalledTimes(1);
    const params = applyViaBot.mock.calls[0]![1] as { applicantUid: number; target: string; note?: string };
    expect(params.applicantUid).toBe(OTHER_USER);
    expect(params.target).toBe('@goodgroup');
    expect(params.note).toBe('群主想玩');
  });

  it('approve/reject/list：非主人拒绝', async () => {
    const api = await makeApi(OTHER_USER);
    await expect(api.allowlist.approve(String(GROUP))).rejects.toThrow('allowlist_master_only');
    await expect(api.allowlist.reject(String(GROUP))).rejects.toThrow('allowlist_master_only');
    await expect(api.allowlist.list()).rejects.toThrow('allowlist_master_only');
    expect(masterApprove).not.toHaveBeenCalled();
    expect(masterReject).not.toHaveBeenCalled();
    expect(listForMaster).not.toHaveBeenCalled();
  });

  it('approve/reject/list：主人走通', async () => {
    const api = await makeApi(MASTER);
    const a = await api.allowlist.approve(String(GROUP));
    expect(a.kind).toBe('approved');
    const r = await api.allowlist.reject(String(GROUP), '不合适');
    expect(r.kind).toBe('rejected');
    const l = await api.allowlist.list();
    expect(l).toContain('待评判');
    expect(masterApprove).toHaveBeenCalledTimes(1);
    expect((masterReject.mock.calls[0] as unknown[])[2]).toBe('不合适');
    expect(listForMaster).toHaveBeenCalledTimes(1);
  });
});
