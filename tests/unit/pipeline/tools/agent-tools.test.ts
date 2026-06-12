import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getAllMock, getGroupMembersMock, addAssistantMock, searchMemoryMock, sendPhotoMock } = vi.hoisted(() => ({
  getAllMock: vi.fn(),
  getGroupMembersMock: vi.fn(),
  addAssistantMock: vi.fn(async () => {}),
  searchMemoryMock: vi.fn(),
  sendPhotoMock: vi.fn(),
}));

vi.mock('../../../../src/pipeline/context/manager.js', () => ({
  getAll: getAllMock,
  getGroupMembers: getGroupMembersMock,
  addAssistant: addAssistantMock,
}));
vi.mock('../../../../src/memory/chroma.js', () => ({ searchMemory: searchMemoryMock }));
vi.mock('../../../../src/tracking/user-profile.js', () => ({
  getProfileSections: vi.fn(() => [{ section_name: '性格', bullets: ['毒舌', '夜猫子'] }]),
  getUserPreferences: vi.fn(() => null),
}));
vi.mock('../../../../src/tracking/relationship.js', () => ({
  getRelationship: vi.fn(() => ({})),
  relationshipPromptHint: vi.fn(() => '熟人'),
}));
vi.mock('../../../../src/bot/bot.js', () => ({
  getBot: () => ({ api: { sendPhoto: sendPhotoMock } }),
}));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  executeQueryMemory,
  executeQueryPersonProfile,
  executeFetchHistory,
  executeSendImage,
} from '../../../../src/pipeline/tools/agent-tools.js';

const CHAT = -100777;

function msg(id: number, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: 'user', uid: 1, fullName: `u${id}`, timestamp: 1781000000 + id, messageId: id, textContent: text, ...extra };
}

describe('agent builtin tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('QUERY_MEMORY: 命中时按行渲染,未命中给提示', async () => {
    searchMemoryMock.mockResolvedValue([
      { fullName: '小明', textContent: '我要去日本', timestamp: 1781000000 },
    ]);
    const hit = await executeQueryMemory(CHAT, '日本');
    expect(hit).toContain('小明');
    expect(hit).toContain('我要去日本');

    searchMemoryMock.mockResolvedValue([]);
    expect(await executeQueryMemory(CHAT, 'xyz')).toContain('没有找到');
  });

  it('QUERY_PERSON_PROFILE: 名字模糊匹配 + 画像分节渲染', async () => {
    getGroupMembersMock.mockResolvedValue([
      { uid: 42, username: 'ming', fullName: '小明同学', lastSeen: 1 },
    ]);
    const out = await executeQueryPersonProfile(CHAT, '小明');
    expect(out).toContain('小明同学');
    expect(out).toContain('性格: 毒舌;夜猫子');
    expect(out).toContain('你和TA: 熟人');
  });

  it('QUERY_PERSON_PROFILE: 找不到时列出在场成员', async () => {
    getGroupMembersMock.mockResolvedValue([
      { uid: 1, username: 'a', fullName: '阿狸', lastSeen: 1 },
    ]);
    const out = await executeQueryPersonProfile(CHAT, '不存在的人');
    expect(out).toContain('没找到');
    expect(out).toContain('阿狸');
  });

  it('FETCH_HISTORY: 从指定 message_id 往前切片', async () => {
    getAllMock.mockResolvedValue([msg(1, 'a'), msg(2, 'b'), msg(3, 'c'), msg(4, 'd'), msg(5, 'e')]);
    const out = await executeFetchHistory(CHAT, 4, 40);
    expect(out).toContain('#1');
    expect(out).toContain('#3');
    expect(out).not.toContain('#4');
    expect(out).not.toContain('#5');
  });

  it('FETCH_HISTORY: 没有更早历史时明确说明', async () => {
    getAllMock.mockResolvedValue([msg(1, 'a')]);
    expect(await executeFetchHistory(CHAT, 1, 40)).toContain('没有更早');
  });

  it('SEND_IMAGE: 找到图片→发送+ctx 簿记;无图消息拒绝', async () => {
    getAllMock.mockResolvedValue([msg(7, '看图', { imageFileId: 'FILE7' }), msg(8, '纯文本')]);
    sendPhotoMock.mockResolvedValue({ message_id: 999 });

    const ok = await executeSendImage(CHAT, 7, '给你看');
    expect(sendPhotoMock).toHaveBeenCalledWith(CHAT, 'FILE7', { caption: '给你看' });
    expect(addAssistantMock).toHaveBeenCalledWith(CHAT, expect.objectContaining({ messageId: 999 }));
    expect(ok).toContain('已发送');

    const noImg = await executeSendImage(CHAT, 8);
    expect(noImg).toContain('没有图片');
  });

  it('SEND_IMAGE: 发送失败返回降级提示而非 throw', async () => {
    getAllMock.mockResolvedValue([msg(7, '看图', { imageFileId: 'FILE7' })]);
    sendPhotoMock.mockRejectedValue(new Error('blocked'));
    expect(await executeSendImage(CHAT, 7)).toContain('失败');
  });
});
