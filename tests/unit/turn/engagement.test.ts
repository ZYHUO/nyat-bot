import { describe, it, expect, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

const lifeState = { energy: 0.85 };
vi.mock('../../../src/tracking/life-state.js', () => ({
  getLifeState: () => ({ state: 'normal', energy: lifeState.energy, hint: null, speedFactor: 1, lazyDay: false }),
}));

import { computeEngagement, HARD_PASS_BUDGET } from '../../../src/pipeline/heart/engagement.js';

const BOT = 9999;
const now = () => Math.floor(Date.now() / 1000);

let mid = 1;
function msg(role: 'user' | 'assistant', ageSec = 10): FormattedMessage {
  return {
    role,
    uid: role === 'assistant' ? BOT : 100 + mid,
    username: 'u',
    fullName: 'U',
    timestamp: now() - ageSec,
    messageId: mid++,
    textContent: 'x',
    isForwarded: false,
  };
}

describe('computeEngagement', () => {
  it('一次 4 段的回复折叠成一轮,不触发硬阈(review #13)', () => {
    // 8 user + 一段 4 气泡的 bot 回复:按条数 share=4/12≥1/3 会被禁言,
    // 折叠后 share=1/9,replies5m=1 → 正常参与
    const msgs = [
      ...Array.from({ length: 8 }, () => msg('user')),
      msg('assistant'), msg('assistant'), msg('assistant'), msg('assistant'),
    ];
    const e = computeEngagement(msgs, BOT, 5);
    expect(e.budget).toBeGreaterThan(HARD_PASS_BUDGET);
  });

  it('5 分钟内 4 **轮**独立发言 → 确定性硬阈', () => {
    const msgs: FormattedMessage[] = [];
    for (let i = 0; i < 4; i++) {
      msgs.push(msg('user'), msg('assistant'));
    }
    msgs.push(...Array.from({ length: 4 }, () => msg('user')));
    const e = computeEngagement(msgs, BOT, 5);
    expect(e.budget).toBe(0);
    expect(e.factors.join()).toContain('replies5m=4');
  });

  it('占比 ≥1/3(按轮)→ 硬阈,即使发言都在 5 分钟之外', () => {
    const msgs: FormattedMessage[] = [];
    for (let i = 0; i < 4; i++) {
      msgs.push(msg('user', 400), msg('assistant', 400));
    }
    msgs.push(...Array.from({ length: 4 }, () => msg('user', 350)));
    const e = computeEngagement(msgs, BOT, 0);
    expect(e.budget).toBe(0);
    expect(e.factors.join()).toContain('share=33%');
  });

  it('群速 ≥60 firehose → 硬阈(旧 hot_chat ≥60 必跳过的回归,review #4)', () => {
    const msgs = Array.from({ length: 10 }, () => msg('user'));
    const e = computeEngagement(msgs, BOT, 60);
    expect(e.budget).toBe(0);
    expect(e.factors.join()).toContain('velocity=60!');
  });

  it('四轴温和叠加不会连乘成静音(review #5)', () => {
    lifeState.energy = 0.25; // 深夜
    try {
      // share=3/12=25%、replies5m=3、velocity=25:全部软因子齐发
      const msgs: FormattedMessage[] = [];
      for (let i = 0; i < 3; i++) msgs.push(msg('user'), msg('assistant'));
      msgs.push(...Array.from({ length: 6 }, () => msg('user')));
      const e = computeEngagement(msgs, BOT, 25);
      expect(e.budget).toBeGreaterThan(HARD_PASS_BUDGET); // clamp 在硬阈之上
    } finally {
      lifeState.energy = 0.85;
    }
  });

  it('注记只发群速一种;自己话密不再重复喊"收着点"(review #10)', () => {
    // velocity 中间带 → 注记
    const quiet = Array.from({ length: 10 }, () => msg('user'));
    const v = computeEngagement(quiet, BOT, 45);
    expect(v.note).toContain('刷得很快');

    // share/replies 中间带、无 velocity → 无注记(heart.md 刷屏自检覆盖)
    const msgs: FormattedMessage[] = [];
    for (let i = 0; i < 3; i++) msgs.push(msg('user'), msg('assistant'));
    msgs.push(...Array.from({ length: 6 }, () => msg('user')));
    const s = computeEngagement(msgs, BOT, 5);
    expect(s.note).toBeNull();
  });
});
