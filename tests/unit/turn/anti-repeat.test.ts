import { describe, it, expect, beforeEach, vi } from 'vitest';

const envState = { ANTI_REPEAT_ENABLED: true, ANTI_REPEAT_THRESHOLD: 0.85 };

const { getRecentMock } = vi.hoisted(() => ({
  getRecentMock: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: getRecentMock }));

import { similarityRatio, checkNearDuplicate } from '../../../src/pipeline/reply/anti-repeat.js';

const CHAT = -101000;

function botMsg(text: string) {
  return { role: 'assistant', uid: 9999, messageId: 1, textContent: text, timestamp: 0 };
}
function userMsg(text: string) {
  return { role: 'user', uid: 1, messageId: 2, textContent: text, timestamp: 0 };
}

beforeEach(() => {
  getRecentMock.mockReset().mockResolvedValue([]);
  envState.ANTI_REPEAT_ENABLED = true;
  envState.ANTI_REPEAT_THRESHOLD = 0.85;
});

describe('G13 anti-repeat guard', () => {
  it('similarityRatio: identical → 1, unrelated → low', () => {
    expect(similarityRatio('今天天气真不错喵', '今天天气真不错喵')).toBe(1);
    expect(similarityRatio('今天天气真不错喵', '数据库迁移失败了')).toBeLessThan(0.1);
  });

  it('similarityRatio: near-duplicates score high', () => {
    const a = '本喵觉得这个方案挺靠谱的,可以先试试看';
    const b = '本喵觉得这个方案挺靠谱的呀,可以先试试';
    expect(similarityRatio(a, b)).toBeGreaterThan(0.7);
  });

  it('flags a near-duplicate against the last bot messages', async () => {
    getRecentMock.mockResolvedValue([
      botMsg('本喵觉得这个方案挺靠谱的,可以先试试看'),
      userMsg('真的吗'),
    ]);
    envState.ANTI_REPEAT_THRESHOLD = 0.7;
    const res = await checkNearDuplicate(CHAT, '本喵觉得这个方案挺靠谱的,可以先试试');
    expect(res.isNearDuplicate).toBe(true);
    expect(res.collidedWith).toContain('靠谱');
  });

  it('different content passes', async () => {
    getRecentMock.mockResolvedValue([botMsg('本喵觉得这个方案挺靠谱的')]);
    const res = await checkNearDuplicate(CHAT, '换个话题,今天有人玩猜数字吗');
    expect(res.isNearDuplicate).toBe(false);
  });

  it('short replies are exempt (口癖不算复读)', async () => {
    getRecentMock.mockResolvedValue([botMsg('哈哈哈是的喵')]);
    const res = await checkNearDuplicate(CHAT, '哈哈哈是的喵');
    expect(res.isNearDuplicate).toBe(false);
    expect(getRecentMock).not.toHaveBeenCalled();
  });

  it('only compares against ASSISTANT messages', async () => {
    getRecentMock.mockResolvedValue([
      userMsg('本喵觉得这个方案挺靠谱的,可以先试试看'),
    ]);
    const res = await checkNearDuplicate(CHAT, '本喵觉得这个方案挺靠谱的,可以先试试看');
    expect(res.isNearDuplicate).toBe(false);
  });

  it('flag off → inert', async () => {
    envState.ANTI_REPEAT_ENABLED = false;
    getRecentMock.mockResolvedValue([botMsg('本喵觉得这个方案挺靠谱的,可以先试试看')]);
    const res = await checkNearDuplicate(CHAT, '本喵觉得这个方案挺靠谱的,可以先试试看');
    expect(res.isNearDuplicate).toBe(false);
  });
});
