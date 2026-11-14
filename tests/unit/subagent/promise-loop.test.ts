import { beforeEach, describe, expect, it, vi } from 'vitest';

const MASTER = 6251541967;
const GROUP = -1002450361141;

const sendMessage = vi.fn();
const sendChatAction = vi.fn(async () => undefined);
const tgSendFile = vi.fn(async () => ({ messageId: 777 }));
const getChat = vi.fn(async () => ({ title: '乐乐猫的快乐老家' }));
const getChatMember = vi.fn(async () => ({ status: 'member' }));
const dbAll = vi.fn(() => [] as unknown[]);
const createGoal = vi.fn(() => 42);
const callWithFallback = vi.fn(async () => ({ content: '{"promise": false, "topic": ""}' }));
const addAssistant = vi.fn(async () => undefined);
const getRecent = vi.fn(async () => []);
const markMessageAnswered = vi.fn(async () => undefined);
const noteMetaBotReply = vi.fn(async () => undefined);
const persistDigest = vi.fn(() => 1);
const zrange = vi.fn(async () => [String(GROUP)]);
const redisGet = vi.fn(async () => null);
const redisSet = vi.fn(async () => 'OK');

const envBase: Record<string, unknown> = {
  BOT_TOKEN: '123:synthetic-test-token',
  PROMISE_LOOP_ENABLED: true,
  MASTER_UID: MASTER,
  CODEACT_BANNED_WORDS: [],
  SANDBOX_ENABLED: false,
  POST_TASK_WINDOW_ENABLED: false,
  MEMORY_CROSS_CONTEXT_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: false,
  MEMORY_SENSITIVE_CHAT_IDS: [],
  DIGEST_PERSIST_ENABLED: true,
  GOAL_MAX_ACTIVE: 20,
};

vi.mock('../../../src/env.js', () => ({ env: () => envBase }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessage(...args),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: (...args: unknown[]) => sendChatAction(...args),
  sendFile: (...args: unknown[]) => tgSendFile(...args),
}));
vi.mock('../../../src/sandbox/paths.js', () => ({
  resolveInsideSandbox: (p: string) => `/sandbox/${p}`,
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBot: () => ({ api: { getChat: (...args: unknown[]) => getChat(...args), getChatMember: (...args: unknown[]) => getChatMember(...args) } }),
  getBotUid: () => 123,
  getBotDisplayName: () => '啾咪囝',
}));
vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: () => ({ all: (...args: unknown[]) => dbAll(...args) }) }),
}));
vi.mock('../../../src/agent/goals.js', () => ({
  createGoal: (...args: unknown[]) => createGoal(...args),
}));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallback(...args),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: (...args: unknown[]) => getRecent(...args),
  addAssistant: (...args: unknown[]) => addAssistant(...args),
}));
vi.mock('../../../src/meta/answered.js', () => ({
  markMessageAnswered: (...args: unknown[]) => markMessageAnswered(...args),
}));
vi.mock('../../../src/meta/timing-adapter.js', () => ({
  noteMetaBotReply: (...args: unknown[]) => noteMetaBotReply(...args),
}));
vi.mock('../../../src/meta/session-digest.js', () => ({
  persistDigest: (...args: unknown[]) => persistDigest(...args),
  searchDigests: (...args: unknown[]) => searchDigestsMock(...args),
}));
const searchDigestsMock = vi.fn(() => [] as Array<{ text: string }>);
vi.mock('../../../src/meta/post-task-window.js', () => ({}));
vi.mock('../../../src/subagent/post-task-window.js', () => ({
  noteBotSpoke: vi.fn(),
}));
vi.mock('../../../src/metrics/social-ledger.js', () => ({
  recordReplySent: vi.fn(),
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
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    zrange: (...args: unknown[]) => zrange(...args),
    zrevrange: (...args: unknown[]) => zrange(...args),
    hscan: vi.fn(async () => ['0', []]),
    mget: vi.fn(async () => []),
    get: (...args: unknown[]) => redisGet(...args),
    set: (...args: unknown[]) => redisSet(...args),
  }),
}));
const ingestAsync = vi.fn(async () => undefined);
vi.mock('../../../src/meta/attention.js', () => ({
  getAttentionAccumulator: () => ({ ingestAsync: (...args: unknown[]) => ingestAsync(...args) }),
}));

describe('promise loop (承诺闭环)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envBase.PROMISE_LOOP_ENABLED = true;
    envBase.MASTER_UID = MASTER;
    envBase.MEMORY_SENSITIVE_CHAT_IDS = [];
    let mid = 100;
    sendMessage.mockImplementation(async () => ++mid);
    createGoal.mockReturnValue(42);
    callWithFallback.mockResolvedValue({ content: '{"promise": false, "topic": ""}' });
    getChat.mockResolvedValue({ title: '乐乐猫的快乐老家' });
    getChatMember.mockResolvedValue({ status: 'member' });
    dbAll.mockReturnValue([]);
    zrange.mockResolvedValue([String(GROUP)]);
    redisGet.mockResolvedValue(null);
    getRecent.mockResolvedValue([]);
  });

  async function makeApi(chatId = MASTER) {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const onEnd = vi.fn();
    const api = createHostApi(chatId, { onEnd, taskId: 'task-1' });
    return { api, onEnd };
  }

  it('sendToChat: flag off → throws promise_loop_disabled', async () => {
    envBase.PROMISE_LOOP_ENABLED = false;
    const { api } = await makeApi();
    await expect(api.telegram.sendToChat(GROUP, 'hi')).rejects.toThrow('promise_loop_disabled');
  });

  it('sendToChat: non-master task chat → master_dm_only', async () => {
    const { api } = await makeApi(GROUP);
    await expect(api.telegram.sendToChat(GROUP, 'hi')).rejects.toThrow('sendToChat_master_dm_only');
  });

  it('sendToChat: positive uid without DM history → dm_unavailable; with DM → delivers', async () => {
    const { api } = await makeApi();
    getChat.mockRejectedValueOnce(new Error('chat not found'));
    await expect(api.telegram.sendToChat(7916374789, 'hi')).rejects.toThrow('sendToChat_dm_unavailable');
    // 有私聊历史（getChat 成功）→ 允许发 DM
    getChat.mockResolvedValue({ id: 7916374789 });
    const r = await api.telegram.sendToChat(7916374789, '券给你喵');
    expect(r.messageId).toBeGreaterThan(0);
    expect(sendMessage).toHaveBeenCalledWith(7916374789, '券给你喵');
  });

  it('sendToChat: bot not in group → not_member', async () => {
    getChat.mockRejectedValueOnce(new Error('chat not found'));
    const { api } = await makeApi();
    await expect(api.telegram.sendToChat(GROUP, 'hi')).rejects.toThrow('sendToChat_not_member');
  });

  it('sendToChat: delivers + bookkeeping + per-task limit 2', async () => {
    const { api } = await makeApi();
    const r1 = await api.telegram.sendToChat(GROUP, '七夕快乐喵');
    expect(r1.messageId).toBeGreaterThan(0);
    expect(sendMessage).toHaveBeenCalledWith(GROUP, '七夕快乐喵');
    expect(addAssistant).toHaveBeenCalledWith(GROUP, expect.objectContaining({ textContent: '七夕快乐喵' }));
    expect(persistDigest).toHaveBeenCalled();
    await api.telegram.sendToChat(GROUP, '第二条');
    await expect(api.telegram.sendToChat(GROUP, '第三条')).rejects.toThrow('sendToChat_limit:2');
  });

  it('sendToChat: with filePath → sends document with caption, marks [file] in context', async () => {
    const { api } = await makeApi();
    const r = await api.telegram.sendToChat(GROUP, '七夕券给你喵', 'coupon.png');
    expect(r.messageId).toBe(777);
    expect(tgSendFile).toHaveBeenCalledWith(GROUP, '/sandbox/coupon.png', { caption: '七夕券给你喵' });
    expect(addAssistant).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({ textContent: expect.stringContaining('[file] coupon.png') }),
    );
  });

  it('chats.find: verifies the current group and reports coverage instead of implying a complete inventory', async () => {
    zrange.mockResolvedValue(['-1002', String(GROUP)]);
    getChat.mockResolvedValue({ id: GROUP, type: 'supergroup', title: '乐乐猫的快乐老家' });
    getChatMember.mockResolvedValue({ user: { id: 123 }, status: 'member' });
    const { api } = await makeApi(GROUP);
    const hits = await api.chats.find('乐乐猫');
    expect(hits).toMatchObject({ status: 'matched', scope: 'current_group', groups: [{ chatId: GROUP, title: '乐乐猫的快乐老家', contentAccess: 'not_granted' }] });
    expect(getChat.mock.calls.map(call => call[0])).toEqual([GROUP]);
    const miss = await api.chats.find('不存在的群');
    expect(miss).toMatchObject({ status: 'no_match', groups: [] });
    expect(miss.note).toContain('不能推断');
  });

  it('goals.add: creates goal with task chat default; flag off disabled', async () => {
    const { api } = await makeApi();
    const r = await api.goals.add('把七夕券送给缪缪');
    expect(r).toEqual({ goalId: 42, reason: 'created' });
    expect(createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ topic: '把七夕券送给缪缪', chatId: MASTER, checkIntervalSec: 900 }),
      20,
    );
    envBase.PROMISE_LOOP_ENABLED = false;
    const r2 = await api.goals.add('另一件事');
    expect(r2.reason).toBe('promise_loop_disabled');
  });

  it('goals.add: even a master-DM task cannot schedule its content in another chat', async () => {
    const { api } = await makeApi();
    expect(await api.goals.add('private task', GROUP)).toEqual({ goalId: null, reason: 'goal_target_chat_mismatch' });
    expect(await api.goals.add('invalid target', 0)).toEqual({ goalId: null, reason: 'goal_target_chat_mismatch' });
    expect(createGoal).not.toHaveBeenCalled();
    expect(await api.goals.add('same chat follow-up', MASTER)).toEqual({ goalId: 42, reason: 'created' });
    expect(createGoal).toHaveBeenCalledWith(expect.objectContaining({ chatId: MASTER }), 20);
  });

  it.each([false, true])('metadata lookup grants owner DM no right to foreign member or message content, sensitive=%s', async (sensitive) => {
    envBase.MEMORY_SENSITIVE_CHAT_IDS = sensitive ? [GROUP] : [];
    dbAll.mockReturnValue([{ chat_id: GROUP, uid: 7, username: 'private_marker', full_name: 'private name', sender_tag: null }]);
    getChat.mockResolvedValue({ id: GROUP, type: 'supergroup', title: '乐乐猫的快乐老家' });
    getChatMember.mockResolvedValue({ user: { id: 123 }, status: 'member' });
    const { api } = await makeApi();
    const chats = await api.chats.find('乐乐猫');
    expect(chats).toMatchObject({ status: 'matched', groups: [{ chatId: GROUP, contentAccess: 'not_granted', sensitive }] });
    getChat.mockClear(); getChatMember.mockClear(); redisGet.mockClear();
    const members = await api.members.find('private_marker');
    expect(await api.chats.recentMessages(GROUP)).toBe('(private context unavailable)');
    expect(Array.isArray(members) ? members : []).toEqual([]);
    expect(getChatMember).not.toHaveBeenCalled();
    expect(getChat).not.toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('backstop: LLM judges unfulfilled promise → auto goal on endTask', async () => {
    callWithFallback.mockResolvedValue({ content: '{"promise": true, "topic": "去乐乐猫群喊缪缪送券"}' });
    const { api, onEnd } = await makeApi();
    await api.telegram.sendText('知道啦～那本喵等下去那个群里喊她一声喵');
    api.runtime.endTask('短回完成');
    await new Promise((r) => setTimeout(r, 10));
    expect(onEnd).toHaveBeenCalled();
    expect(callWithFallback).toHaveBeenCalled();
    expect(createGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: expect.stringContaining('promise-backstop'),
        chatId: MASTER,
        checkIntervalSec: 900,
        topic: expect.stringContaining('去乐乐猫群喊缪缪送券'),
      }),
      20,
    );
  });

  it('backstop: LLM says no promise → no goal', async () => {
    callWithFallback.mockResolvedValue({ content: '{"promise": false, "topic": ""}' });
    const { api } = await makeApi();
    await api.telegram.sendText('七夕快乐喵～');
    createGoal.mockClear();
    api.runtime.endTask('done');
    await new Promise((r) => setTimeout(r, 10));
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('backstop: LLM failure → fail-soft, no goal, no throw', async () => {
    callWithFallback.mockRejectedValue(new Error('provider down'));
    const { api } = await makeApi();
    await api.telegram.sendText('那本喵等下去群里喊她喵');
    createGoal.mockClear();
    api.runtime.endTask('done');
    await new Promise((r) => setTimeout(r, 10));
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('backstop: goals.add already called → LLM not even consulted', async () => {
    const { api } = await makeApi();
    await api.goals.add('去群里喊缪缪');
    await api.telegram.sendText('行，这事本喵记下了，办好了跟你说喵');
    callWithFallback.mockClear();
    createGoal.mockClear();
    api.runtime.endTask('done');
    await new Promise((r) => setTimeout(r, 10));
    expect(callWithFallback).not.toHaveBeenCalled();
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('backstop: sendToChat used → LLM not consulted', async () => {
    const { api } = await makeApi();
    await api.telegram.sendToChat(GROUP, '缪缪，主人让本喵送七夕券给你喵');
    await api.telegram.sendText('已经送去啦');
    callWithFallback.mockClear();
    createGoal.mockClear();
    api.runtime.endTask('done');
    await new Promise((r) => setTimeout(r, 10));
    expect(callWithFallback).not.toHaveBeenCalled();
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('members.find: 本群画像 → 成员确认，异群画像不能覆盖本群名字或暴露成员', async () => {
    dbAll.mockReturnValue([
      { chat_id: -1002, uid: 7916374789, username: 'FOREIGN_NAME_MARKER', full_name: 'foreign name', sender_tag: null },
      { chat_id: -1002, uid: 888, username: 'FOREIGN_USER_MARKER', full_name: 'foreign user', sender_tag: null },
      { chat_id: GROUP, uid: 7916374789, username: 'auto_ccb', full_name: 'CCB', sender_tag: null },
    ]);
    getChatMember.mockImplementation(async (cid: unknown) =>
      cid === -1002 ? { status: 'left' } : { status: 'member' },
    );
    getChat.mockImplementation(async (cid: unknown) =>
      cid === 7916374789 ? { id: 7916374789 } : { title: '乐乐猫游乐场' },
    );
    const { api } = await makeApi(GROUP);
    const hits = await api.members.find('ccb');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      uid: 7916374789,
      username: 'auto_ccb',
      groups: [{ chatId: GROUP, title: '乐乐猫游乐场' }],
      dmAvailable: true,
    });
    expect(getChatMember.mock.calls).toEqual([[GROUP, 7916374789]]);
    expect(getChat.mock.calls).toEqual([[GROUP], [7916374789]]);
    expect(JSON.stringify(hits)).not.toContain('FOREIGN_');
  });

  it('members.find: 查无此人 → 指路字符串', async () => {
    dbAll.mockReturnValue([]);
    const { api } = await makeApi();
    expect(String(await api.members.find('不存在的人'))).toContain('没找到');
    expect(await api.members.find('')).toEqual([]);
  });

  it('chats.recentMessages: 本群内容可读，异群请求在访问上下文前拒绝', async () => {
    getRecent.mockResolvedValue([
      { role: 'user', uid: 1, username: 'ccb', fullName: 'CCB', timestamp: 1, messageId: 1, textContent: '压抑', isForwarded: false },
    ]);
    const { api } = await makeApi(GROUP);
    const out = await api.chats.recentMessages(GROUP, 5);
    expect(out).toContain('压抑');
    expect(getRecent).toHaveBeenCalledWith(GROUP, 5, undefined);
    getRecent.mockClear();
    expect(await api.chats.recentMessages(-1002, 5)).toBe('(private context unavailable)');
    expect(getRecent).not.toHaveBeenCalled();
    getRecent.mockResolvedValue([]);
    expect(await api.chats.recentMessages(GROUP, 5)).toBe('(那个群最近没有记录)');
    expect(await api.chats.recentMessages(0, 5)).toBe('(invalid chatId)');
  });

  it('memory.searchDigests: FTS 检索自己的过往动作', async () => {
    searchDigestsMock.mockReturnValue([{ text: '回复养父的『压抑』，自然接话关心了一句' }]);
    const { api } = await makeApi();
    const out = await api.memory.searchDigests('养父');
    expect(out).toContain('回复养父');
    searchDigestsMock.mockReturnValue([]);
    expect(await api.memory.searchDigests('没有的事')).toBe('(没有找到相关记录)');
  });

  it('meta.request: fabricated action → hard error with tool guidance', async () => {
    const { api } = await makeApi();
    await expect(api.meta.request({ action: 'list_chats' })).rejects.toThrow(/unknown_action:list_chats[\s\S]*chats\.find/);
    expect(ingestAsync).not.toHaveBeenCalled();
  });

  it('meta.request: valid journal action → queued', async () => {
    const { api } = await makeApi();
    const r = await api.meta.request({ action: 'journal.write', detail: '写日记' });
    expect(r).toEqual({ queued: true, action: 'journal.write' });
    expect(ingestAsync).toHaveBeenCalled();
  });
});
