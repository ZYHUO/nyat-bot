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
  it('DM_AUTO_PRIVATE 关时 DM 视作 shared', () => {
    envValues['DM_AUTO_PRIVATE'] = false;
    expect(getChatVisibility(DM_UID)).toBe('shared');
  });
  it('敏感群种子 → private', () => {
    expect(getChatVisibility(SENSITIVE_GROUP)).toBe('private');
  });
  it('普通群 → shared', () => {
    expect(getChatVisibility(GROUP_A)).toBe('shared');
  });
  it('null/undefined → shared', () => {
    expect(getChatVisibility(null)).toBe('shared');
    expect(getChatVisibility(undefined)).toBe('shared');
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
    expect(isCrossContextPrivate({ visibility: 'public', sourceChatId: GROUP_B }, GROUP_A)).toBe(false);
  });
  it('普通群 contextual 跨界 → 保留(默认尺度:非私密来源 contextual 可带出)', () => {
    expect(isCrossContextPrivate({ visibility: 'contextual', sourceChatId: GROUP_B }, GROUP_A)).toBe(false);
  });
  it('敏感群 contextual 跨界 → 丢(来源私密)', () => {
    expect(isCrossContextPrivate({ visibility: 'contextual', sourceChatId: SENSITIVE_GROUP }, GROUP_A)).toBe(true);
  });
  it('DM contextual 跨界 → 丢(来源私密)', () => {
    expect(isCrossContextPrivate({ visibility: 'contextual', sourceChatId: DM_UID }, GROUP_A)).toBe(true);
  });
  it('缺 visibility 字段(存量)→ 按来源私密性判定', () => {
    expect(isCrossContextPrivate({ sourceChatId: DM_UID }, GROUP_A)).toBe(true);
    expect(isCrossContextPrivate({ sourceChatId: GROUP_B }, GROUP_A)).toBe(false);
  });
});

describe('scrubMemoryHits', () => {
  const hits = [
    { text: 'group A own', visibility: 'contextual' as const, sourceChatId: GROUP_A },
    { text: 'group B public', visibility: 'public' as const, sourceChatId: GROUP_B },
    { text: 'group B ctx', visibility: 'contextual' as const, sourceChatId: GROUP_B },
    { text: 'DM private', visibility: 'private' as const, sourceChatId: DM_UID },
    { text: 'sensitive ctx', visibility: 'contextual' as const, sourceChatId: SENSITIVE_GROUP },
  ];

  it('boundChat=群A:保留本群+B公开+B上下文,剔除 DM 私密与敏感群', () => {
    const { kept, dropped } = scrubMemoryHits(hits, GROUP_A);
    expect(kept.map((h) => h.text)).toEqual(['group A own', 'group B public', 'group B ctx']);
    expect(dropped).toBe(2);
  });

  it('visibility 关时原样返回(不 scrub)', () => {
    envValues['MEMORY_VISIBILITY_ENABLED'] = false;
    const { kept, dropped } = scrubMemoryHits(hits, GROUP_A);
    expect(kept).toHaveLength(5);
    expect(dropped).toBe(0);
  });
});

describe('scrubProfileFragments', () => {
  it('注入群时剔除来自 DM 的私密片段', () => {
    const frags = [
      { text: '群里稳定表现', visibility: 'contextual' as const, sourceChatId: GROUP_B },
      { text: '私聊里说的秘密', visibility: 'private' as const, sourceChatId: DM_UID },
    ];
    const kept = scrubProfileFragments(frags, GROUP_A);
    expect(kept.map((f) => f.text)).toEqual(['群里稳定表现']);
  });
});
