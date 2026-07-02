import { describe, it, expect, beforeEach, vi } from 'vitest';

const envValues: Record<string, unknown> = {};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { callWithFallbackMock, getUserContextsMock, getUserProfilePromptMock, getAggregatedAffinityMock, setGlobalProfileMock, isPrivateChatMock } = vi.hoisted(() => ({
  callWithFallbackMock: vi.fn(),
  getUserContextsMock: vi.fn(async (): Promise<number[]> => []),
  getUserProfilePromptMock: vi.fn((): string | null => null),
  getAggregatedAffinityMock: vi.fn(() => ({ affinity: 50, bucket: '熟', interactionTotal: 20, chatCount: 2, primaryChatId: -1001 })),
  setGlobalProfileMock: vi.fn(),
  isPrivateChatMock: vi.fn((chatId: number) => chatId > 0),
}));

vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: callWithFallbackMock }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getUserContexts: getUserContextsMock }));
vi.mock('../../../src/tracking/user-profile.js', () => ({ getUserProfilePrompt: getUserProfilePromptMock }));
vi.mock('../../../src/tracking/user-affinity.js', () => ({ getAggregatedAffinity: getAggregatedAffinityMock }));
vi.mock('../../../src/tracking/person-identity.js', () => ({ setGlobalProfile: setGlobalProfileMock }));
vi.mock('../../../src/memory/visibility.js', () => ({ isPrivateChat: isPrivateChatMock }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => ({ prepare: () => ({ all: () => [] }) }) }));

import { mergeGlobalProfile } from '../../../src/cron/profile-merge.js';

beforeEach(() => {
  for (const k of Object.keys(envValues)) delete envValues[k];
  Object.assign(envValues, { PROFILE_MERGE_ENABLED: true, PROFILE_MERGE_USAGE: 'summarize', PROFILE_MERGE_CHAT_IDS: [] });
  vi.clearAllMocks();
  getUserProfilePromptMock.mockReturnValue(null);
  getAggregatedAffinityMock.mockReturnValue({ affinity: 50, bucket: '熟', interactionTotal: 20, chatCount: 2, primaryChatId: -1001 });
  isPrivateChatMock.mockImplementation((chatId: number) => chatId > 0);
});

describe('mergeGlobalProfile', () => {
  it('两个有料场景 → LLM 提炼 → setGlobalProfile 写回', async () => {
    getUserContextsMock.mockResolvedValue([-1001, 42]); // 一个群 + 一个 DM
    getUserProfilePromptMock.mockImplementation((chatId: number) =>
      chatId === -1001 ? '在技术群里爱聊架构、偶尔毒舌' : '私聊里常半夜来吐槽工作',
    );
    callWithFallbackMock.mockResolvedValue({
      content: '{"traits":["毒舌","技术控"],"interests":["架构","猫"],"comm_style":"短句直接","relation_to_bot":"老熟人","stable_patterns":["深夜活跃"],"confidence":0.8}',
    });

    const ok = await mergeGlobalProfile(42);
    expect(ok).toBe(true);
    expect(setGlobalProfileMock).toHaveBeenCalledWith(42, expect.objectContaining({
      traits: ['毒舌', '技术控'],
      interests: ['架构', '猫'],
      commStyle: '短句直接',
      relationToBot: '老熟人',
      stablePatterns: ['深夜活跃'],
      sourceContextIds: [-1001, 42],
      confidence: 0.8,
    }));
  });

  it('单上下文 → 不合并(不调 LLM)', async () => {
    getUserContextsMock.mockResolvedValue([-1001]);
    const ok = await mergeGlobalProfile(42);
    expect(ok).toBe(false);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('多上下文但只有 <2 个有料 → 不合并', async () => {
    getUserContextsMock.mockResolvedValue([-1001, -1002, 42]);
    getUserProfilePromptMock.mockImplementation((chatId: number) => (chatId === -1001 ? '有料的画像文本够长啦' : null));
    const ok = await mergeGlobalProfile(42);
    expect(ok).toBe(false);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('LLM 输出无法解析 → false,不写回(水位线不推进)', async () => {
    getUserContextsMock.mockResolvedValue([-1001, 42]);
    getUserProfilePromptMock.mockReturnValue('够长的画像文本内容在这里');
    callWithFallbackMock.mockResolvedValue({ content: '这不是 JSON' });
    const ok = await mergeGlobalProfile(42);
    expect(ok).toBe(false);
    expect(setGlobalProfileMock).not.toHaveBeenCalled();
  });

  it('confidence 缺失 → 默认 0.5;带 ```json 围栏能抠出', async () => {
    getUserContextsMock.mockResolvedValue([-1001, -1002]);
    getUserProfilePromptMock.mockReturnValue('够长的群内画像文本内容');
    callWithFallbackMock.mockResolvedValue({
      content: '```json\n{"traits":["a"],"interests":[],"comm_style":"x","relation_to_bot":"y","stable_patterns":[]}\n```',
    });
    const ok = await mergeGlobalProfile(42);
    expect(ok).toBe(true);
    expect(setGlobalProfileMock).toHaveBeenCalledWith(42, expect.objectContaining({ confidence: 0.5 }));
  });
});
