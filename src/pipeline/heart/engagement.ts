// ────────────────────────────────────────
// Engagement Budget — 参与预算(P2:四套抑制合一)
// ────────────────────────────────────────
//
// 此前四个互不相识的抑制器作用在同一条被动消息上:
//   hot_chat 骰子(L0 RNG)/ gate 冷却 / 刷屏闸(占比+速率)/ 精力调制
// 各自为政 → 行为难预测、难调参、bug 滋生地。
// 现在一个 0..1 标量:budget ≤ 硬阈 → 确定性 pass(不烧心流调用);
// 中间带 → 给心流一句中文注记,让"我话多了"成为它自己的体感。

import { getLifeState } from '../../tracking/life-state.js';
import type { FormattedMessage } from '../../shared/types.js';

export interface Engagement {
  /** 0..1,越低越该闭嘴 */
  budget: number;
  /** 注入心流 prompt 的体感注记(无需提醒时 null) */
  note: string | null;
  /** 遥测:哪些因素压低了预算 */
  factors: string[];
}

/** budget ≤ 此值 → 不问心流,确定性 pass */
export const HARD_PASS_BUDGET = 0.12;

export function computeEngagement(
  recentMessages: FormattedMessage[],
  botUid: number,
  messagesLast5Min: number,
): Engagement {
  let budget = 1;
  const factors: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  // 占比:最近 12 条里 bot 份额(真群友不霸屏)
  const win = recentMessages.slice(-12);
  if (win.length >= 6) {
    const share = win.filter((m) => m.role === 'assistant' || m.uid === botUid).length / win.length;
    if (share >= 1 / 3) { budget = 0; factors.push(`share=${Math.round(share * 100)}%`); }
    else if (share >= 0.25) { budget *= 0.45; factors.push(`share=${Math.round(share * 100)}%`); }
  }

  // 速率:5 分钟内 bot 已回条数(节奏上限)
  const replies5m = recentMessages.filter(
    (m) => (m.role === 'assistant' || m.uid === botUid) && m.timestamp >= nowSec - 300,
  ).length;
  if (replies5m >= 4) { budget = 0; factors.push(`replies5m=${replies5m}`); }
  else if (replies5m >= 3) { budget *= 0.5; factors.push(`replies5m=${replies5m}`); }

  // 群速:刷得太快时凑热闹的边际价值低(替代 hot_chat 骰子,确定性)
  if (messagesLast5Min > 40) { budget *= 0.3; factors.push(`velocity=${messagesLast5Min}`); }
  else if (messagesLast5Min > 20) { budget *= 0.65; factors.push(`velocity=${messagesLast5Min}`); }

  // 精力:深夜/犯懒整体收缩
  try {
    const energy = getLifeState().energy;
    if (energy < 0.3) { budget *= 0.6; factors.push(`energy=${energy.toFixed(2)}`); }
  } catch { /* fail-soft */ }

  let note: string | null = null;
  if (budget > HARD_PASS_BUDGET && budget < 0.5) {
    note = factors.some((f) => f.startsWith('velocity'))
      ? '(群里刷得很快,你凑热闹的兴致一般,收着点)'
      : '(你最近话有点密了,真群友说完几句会安静听别人说)';
  }

  return { budget, note, factors };
}
