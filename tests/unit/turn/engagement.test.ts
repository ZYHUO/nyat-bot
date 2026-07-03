import { describe, it, expect, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

const lifeState = { energy: 0.85 };
vi.mock('../../../src/tracking/life-state.js', () => ({
  getLifeState: () => ({ state: 'normal', energy: lifeState.energy, hint: null, speedFactor: 1, lazyDay: false }),
}));

import { computeEngagement, filterForTurnStart, HARD_PASS_BUDGET } from '../../../src/pipeline/heart/engagement.js';

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

describe('filterForTurnStart(分人回复修复)', () => {
  const turnStartedAt = (now() - 50) * 1000; // 回合开始于 50 秒前

  it('turnStartedAt 为 undefined → 原样返回,零行为变化', () => {
    const msgs = [msg('user'), msg('assistant')];
    expect(filterForTurnStart(msgs, BOT, undefined)).toEqual(msgs);
  });

  it('回合开始后才发的 bot 消息(本回合兄弟组的回复)→ 过滤掉', () => {
    const msgs = [msg('user', 60), msg('assistant', 10)]; // bot 消息 10s 前发,晚于回合开始(50s 前)
    const filtered = filterForTurnStart(msgs, BOT, turnStartedAt);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.role).toBe('user');
  });

  it('回合开始前就存在的历史 bot 消息 → 保留(跨回合防刷不受影响)', () => {
    const msgs = [msg('assistant', 100), msg('user', 60)]; // bot 消息 100s 前,早于回合开始
    const filtered = filterForTurnStart(msgs, BOT, turnStartedAt);
    expect(filtered).toHaveLength(2);
  });

  it('用户消息无论何时都保留', () => {
    const msgs = [msg('user', 10), msg('user', 100)];
    expect(filterForTurnStart(msgs, BOT, turnStartedAt)).toHaveLength(2);
  });

  it('端到端:组1 刚发的回复会让组2 误触硬阈,过滤后组2 恢复正常参与', () => {
    // 复刻 bug 场景:5 分钟窗口内已有 3 轮历史 user+assistant(share=25%/
    // replies5m=3,均在软带、未到硬阈),组1 在回合开始(50s 前)之后又发
    // 一条回复 → 实时口径 share=33%(4/12)+replies5m=4,双双命中硬阈;
    // 过滤掉组1 这条回合开始后发的回复 → 组2 看到的仍是 3 轮历史,正常参与。
    const msgs: FormattedMessage[] = [
      msg('user', 280),
      msg('assistant', 270), msg('user', 260),
      msg('assistant', 250), msg('user', 240),
      msg('assistant', 230), // 3 轮历史(回合开始前),均在 5 分钟窗内
      msg('user', 100), msg('user', 90), msg('user', 80), msg('user', 70), msg('user', 60),
      msg('user', 50), // 本回合:另一个人的独立提问
      msg('assistant', 10), // 组1 刚发的回复(回合开始后,10s 前)
    ];

    const live = computeEngagement(msgs, BOT, 5);
    expect(live.budget).toBe(0); // 未过滤:组2 会被组1 的回复误判硬阈(share=33%/replies5m=4)

    const filtered = filterForTurnStart(msgs, BOT, turnStartedAt);
    const fixed = computeEngagement(filtered, BOT, 5);
    expect(fixed.budget).toBeGreaterThan(HARD_PASS_BUDGET); // 过滤后:组2 恢复正常参与(软带,非硬阈)
  });
});
