import { describe, it, expect, beforeEach, vi } from 'vitest';

const envValues: Record<string, unknown> = {};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

import {
  getChatVisibility,
  isPrivateChat,
  defaultVisibilityForChat,
  isCrossContextPrivate,
  scrubMemoryHits,
  scrubProfileFragments,
} from '../../../src/memory/visibility.js';

const GROUP_A = -1001;
const GROUP_B = -1002;
const SENSITIVE_GROUP = -1009;
const DM_UID = 42; // DM chatId 为正(= uid 惯例)

beforeEach(() => {
  for (const k of Object.keys(envValues)) delete envValues[k];
  Object.assign(envValues, {
    BOT_TOKEN: '123456:synthetic',
    MEMORY_VISIBILITY_ENABLED: true,
    MEMORY_SENSITIVE_CHAT_IDS: [SENSITIVE_GROUP],
    DM_AUTO_PRIVATE: true,
  });
});

describe('getChatVisibility / isPrivateChat', () => {
  it('DM(正 chatId)默认 private', () => {
    expect(getChatVisibility(DM_UID)).toBe('private');
    expect(isPrivateChat(DM_UID)).toBe(true);
  });
  it('DM_AUTO_PRIVATE 关闭不授予私聊披露权限', () => {
    envValues['DM_AUTO_PRIVATE'] = false;
    expect(getChatVisibility(DM_UID)).toBe('private');
  });
  it('敏感群种子 → private', () => {
    expect(getChatVisibility(SENSITIVE_GROUP)).toBe('private');
  });
  it('普通群 → shared', () => {
    expect(getChatVisibility(GROUP_A)).toBe('shared');
  });
  it('null/undefined 无法证明来源 → private', () => {
    expect(getChatVisibility(null)).toBe('private');
    expect(getChatVisibility(undefined)).toBe('private');
  });
});

describe('defaultVisibilityForChat', () => {
  it('DM/敏感 → private,普通群 → contextual', () => {
    expect(defaultVisibilityForChat(DM_UID)).toBe('private');
    expect(defaultVisibilityForChat(SENSITIVE_GROUP)).toBe('private');
    expect(defaultVisibilityForChat(GROUP_A)).toBe('contextual');
  });
});

describe('isCrossContextPrivate 真值表', () => {
  it('本会话记忆恒保留(即便 private)', () => {
    expect(isCrossContextPrivate({ visibility: 'private', sourceChatId: GROUP_A }, GROUP_A)).toBe(false);
  });
  it('private 跨界 → 丢', () => {
    expect(isCrossContextPrivate({ visibility: 'private', sourceChatId: DM_UID }, GROUP_A)).toBe(true);
  });
  it('public 跨界 → 保留', () => {
    expect(isCrossContextPrivate({ visibility: 'public', sourceChatId: GROUP_B, sourcePlatform: 'telegram', sourceAccountId: '123456' }, GROUP_A)).toBe(false);
  });
  it('普通群 contextual 没有公开授权，不能跨界', () => {
    expect(isCrossContextPrivate({ visibility: 'contextual', sourceChatId: GROUP_B }, GROUP_A)).toBe(true);
  });
  it('敏感群 contextual 跨界 → 丢(来源私密)', () => {
    expect(isCrossContextPrivate({ visibility: 'contextual', sourceChatId: SENSITIVE_GROUP }, GROUP_A)).toBe(true);
  });
  it('DM contextual 跨界 → 丢(来源私密)', () => {
    expect(isCrossContextPrivate({ visibility: 'contextual', sourceChatId: DM_UID }, GROUP_A)).toBe(true);
  });
  it('public 标签不能覆盖来源 DM 或敏感群的私密性', () => {
    expect(isCrossContextPrivate({ visibility: 'public', sourceChatId: DM_UID }, GROUP_A)).toBe(true);
    expect(isCrossContextPrivate({ visibility: 'public', sourceChatId: SENSITIVE_GROUP }, GROUP_A)).toBe(true);
  });
  it('缺来源或来源损坏时，各类标签均不能证明可跨会话共享', () => {
    for (const visibility of [undefined, 'contextual', 'public'] as const) {
      for (const sourceChatId of [undefined, null, 0, Number.NaN]) {
        expect(isCrossContextPrivate({ visibility, sourceChatId }, GROUP_A)).toBe(true);
      }
    }
  });
  it('缺 visibility 字段(存量)→ 按来源私密性判定', () => {
    expect(isCrossContextPrivate({ sourceChatId: DM_UID }, GROUP_A)).toBe(true);
    expect(isCrossContextPrivate({ sourceChatId: GROUP_B }, GROUP_A)).toBe(true);
  });
});

describe('scrubMemoryHits', () => {
  const hits = [
    { text: 'group A own', visibility: 'contextual' as const, sourceChatId: GROUP_A },
    { text: 'group B public', visibility: 'public' as const, sourceChatId: GROUP_B, sourcePlatform: 'telegram' as const, sourceAccountId: '123456' },
    { text: 'group B ctx', visibility: 'contextual' as const, sourceChatId: GROUP_B },
    { text: 'DM private', visibility: 'private' as const, sourceChatId: DM_UID },
    { text: 'sensitive ctx', visibility: 'contextual' as const, sourceChatId: SENSITIVE_GROUP },
  ];

  it('boundChat=群A:保留本群和可证明公开来源', () => {
    const { kept, dropped } = scrubMemoryHits(hits, GROUP_A);
    expect(kept.map((h) => h.text)).toEqual(['group A own', 'group B public']);
    expect(dropped).toBe(3);
  });

  it('visibility 关闭仍不能绕过隐私边界', () => {
    envValues['MEMORY_VISIBILITY_ENABLED'] = false;
    const { kept, dropped } = scrubMemoryHits(hits, GROUP_A);
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(3);
  });
});

describe('scrubProfileFragments', () => {
  it('注入群时剔除来自 DM 的私密片段', () => {
    const frags = [
      { text: '群里稳定表现', visibility: 'contextual' as const, sourceChatId: GROUP_A },
      { text: '私聊里说的秘密', visibility: 'private' as const, sourceChatId: DM_UID },
    ];
    const kept = scrubProfileFragments(frags, GROUP_A);
    expect(kept.map((f) => f.text)).toEqual(['群里稳定表现']);
  });
});
