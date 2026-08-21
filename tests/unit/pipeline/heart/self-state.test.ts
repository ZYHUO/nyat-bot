import { describe, it, expect, vi, beforeEach } from 'vitest';

// #38 自我状态合成:四源并行取、叙述顺序固定、双变体(含/不含念头)、
// 来源 fail-soft。mock 全部动态导入的源。

const mocks = vi.hoisted(() => ({
  getLifeState: vi.fn(),
  getChatMood: vi.fn(),
  moodPromptHint: vi.fn(),
  getFocus: vi.fn(),
  socialStateHint: vi.fn(),
  getMind: vi.fn(),
  getObsession: vi.fn(),
}));

vi.mock('../../../../src/tracking/life-state.js', () => ({ getLifeState: mocks.getLifeState }));
vi.mock('../../../../src/tracking/mood.js', () => ({
  getChatMood: mocks.getChatMood,
  moodPromptHint: mocks.moodPromptHint,
}));
vi.mock('../../../../src/pipeline/turn/focus.js', () => ({ getFocus: mocks.getFocus }));
vi.mock('../../../../src/tracking/social-needs.js', () => ({ socialStateHint: mocks.socialStateHint }));
vi.mock('../../../../src/pipeline/heart/mind.js', () => ({ getMind: mocks.getMind }));
vi.mock('../../../../src/tracking/obsessions.js', () => ({ getObsession: mocks.getObsession }));
// 上学日程源(A0/A3)与本组「源顺序」用例无关 —— 关掉,保持叙述确定性
vi.mock('../../../../src/tracking/school-state.js', () => ({ getSchoolSelfStateLine: () => null }));
// 天气源（2026-08-22）：mock 行为源本身——vi.mock(env) 对深层动态 import 链
// 不可靠（实测穿透拿到真 env，WEATHER_ENABLED=true 时真发 fetch 并写 db0）。
vi.mock('../../../../src/shared/weather.js', () => ({ getWeatherHint: async () => null }));
vi.mock('../../../../src/env.js', () => ({ env: () => ({ SCHOOL_SCHEDULE_ENABLED: false }) }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { composeSelfState } from '../../../../src/pipeline/heart/self-state.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLifeState.mockReturnValue({ state: 'awake', energy: 0.8, lazyDay: false });
  mocks.getChatMood.mockReturnValue({});
  mocks.moodPromptHint.mockReturnValue(null);
  mocks.getFocus.mockResolvedValue(0.4); // 中间值:不触发任何 part
  mocks.socialStateHint.mockResolvedValue(null);
  mocks.getMind.mockResolvedValue({});
  mocks.getObsession.mockResolvedValue({ hint: '' });
});

describe('composeSelfState (#38)', () => {
  it('assembles parts in fixed order: mood → focus → social → thought → stance → obsession', async () => {
    mocks.moodPromptHint.mockReturnValue('[群心情] 群里气氛不错');
    mocks.getFocus.mockResolvedValue(0.9);
    mocks.socialStateHint.mockResolvedValue('你有点想找人说话');
    mocks.getMind.mockResolvedValue({ lastThought: '这话题有意思', stance: '我支持A' });
    mocks.getObsession.mockResolvedValue({ hint: '[执念] 最近迷恋猫毛。后半句不要' });

    const s = await composeSelfState(-1);

    expect(s.narration).toBe(
      '群里气氛不错；这个群你刚才说过几句话了；你有点想找人说话；' +
      '你刚才心里想的是:「这话题有意思」；你最近一次发言的落点:「我支持A」(别自相矛盾)；' +
      '最近迷恋猫毛。',
    );
  });

  it('narrationNoThought drops ONLY the lastThought sentence (stance stays)', async () => {
    mocks.getMind.mockResolvedValue({ lastThought: '念头X', stance: '立场Y' });

    const s = await composeSelfState(-1);

    expect(s.narration).toContain('你刚才心里想的是:「念头X」');
    expect(s.narrationNoThought).not.toContain('念头X');
    expect(s.narrationNoThought).toContain('立场Y');
  });

  it('variants are identical when there is no lastThought', async () => {
    const s = await composeSelfState(-1);
    expect(s.narrationNoThought).toBe(s.narration);
  });

  it('energy blends life-state energy with focus (0.6/0.4)', async () => {
    mocks.getLifeState.mockReturnValue({ state: 'awake', energy: 1.0, lazyDay: false });
    mocks.getFocus.mockResolvedValue(0.5);

    const s = await composeSelfState(-1);
    expect(s.energy).toBeCloseTo(1.0 * 0.6 + 0.5 * 0.4, 5);
  });

  it('every source failing → default narration, never throws', async () => {
    mocks.getLifeState.mockImplementation(() => { throw new Error('life down'); });
    mocks.moodPromptHint.mockImplementation(() => { throw new Error('mood down'); });
    mocks.getFocus.mockRejectedValue(new Error('focus down'));
    mocks.socialStateHint.mockRejectedValue(new Error('social down'));
    mocks.getMind.mockRejectedValue(new Error('mind down'));
    mocks.getObsession.mockRejectedValue(new Error('obsession down'));

    const s = await composeSelfState(-1);
    expect(s.narration).toBe('你状态正常,精神还不错。');
    expect(s.narrationNoThought).toBe('你状态正常,精神还不错。');
    expect(s.energy).toBe(0.8); // life 失败 → 默认值,focus 失败 → 不融合
  });

  it('async sources are fetched concurrently, not serially', async () => {
    // 每个源 sleep 30ms;串行 ≥120ms,并行 ≈30ms
    const slow = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 30));
    mocks.getFocus.mockImplementation(() => slow(0.4));
    mocks.socialStateHint.mockImplementation(() => slow(null));
    mocks.getMind.mockImplementation(() => slow({}));
    mocks.getObsession.mockImplementation(() => slow({ hint: '' }));

    const t0 = performance.now();
    await composeSelfState(-1);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(90); // 串行会 ≥120ms
  });
});
