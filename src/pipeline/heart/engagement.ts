// ────────────────────────────────────────
// Engagement Budget — 参与预算(P2:四套抑制合一)
// ────────────────────────────────────────
//
// 此前四个互不相识的抑制器作用在同一条被动消息上:
//   hot_chat 骰子(L0 RNG)/ gate 冷却 / 刷屏闸(占比+速率)/ 精力调制
// 各自为政 → 行为难预测、难调参、bug 滋生地。
//
// 语义(review #4/#5/#13 校准后):
//   - 硬阈是**单一主导因子**(占比≥1/3 / 5min≥4轮 / 群速≥60),与旧刷屏闸
//     1:1 对齐 —— 不做多因子连乘,温和的四轴叠加不该连乘成静音。
//   - 软因子只用来压低 budget 进中间带,给心流一句中文注记
//     ("我话多了"成为它自己的体感),绝不会自己跌破硬阈。
//   - bot 的连续气泡折叠成"轮":一次分 4 段的回复只算一次发言,
//     不然 bot 刚表达完一次就被自己的气泡数禁言。

import { getLifeState } from '../../tracking/life-state.js';
import type { FormattedMessage } from '../../shared/types.js';

export interface Engagement {
  /** 0..1,越低越该闭嘴(0 = 确定性硬阈命中) */
  budget: number;
  /** 注入心流 prompt 的体感注记(无需提醒时 null) */
  note: string | null;
  /** 遥测:哪些因素压低了预算 */
  factors: string[];
}

/** budget ≤ 此值 → 不问心流,确定性 pass */
export const HARD_PASS_BUDGET = 0.12;

/** 群速 ≥ 此值 → firehose,确定性闭嘴(旧 hot_chat ≥60 必跳过的等价物) */
const FIREHOSE_5MIN = 60;

export function computeEngagement(
  recentMessages: FormattedMessage[],
  botUid: number,
  messagesLast5Min: number,
): Engagement {
  const factors: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const isBot = (m: FormattedMessage) => m.role === 'assistant' || m.uid === botUid;

  // 连续 assistant 气泡折叠成"轮"(保留每轮最后一条的时间戳)——
  // 一次多段回复在上下文里是 N 条 assistant 记录,按条数算会把
  // "刚表达了一次"误判成"连说了 N 次"(review #13)。
  const collapsed: FormattedMessage[] = [];
  for (const m of recentMessages) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && isBot(prev) && isBot(m)) {
      collapsed[collapsed.length - 1] = m;
      continue;
    }
    collapsed.push(m);
  }

  // 占比:最近 12 轮里 bot 份额(真群友不霸屏)
  const win = collapsed.slice(-12);
  const share = win.length >= 6 ? win.filter(isBot).length / win.length : 0;
  // 速率:5 分钟内 bot 已回的轮数(节奏上限)
  const replies5m = collapsed.filter((m) => isBot(m) && m.timestamp >= nowSec - 300).length;

  // ── 确定性硬阈(单一主导因子,与旧刷屏闸对齐)──
  let hard = false;
  if (share >= 1 / 3) { hard = true; factors.push(`share=${Math.round(share * 100)}%`); }
  if (replies5m >= 4) { hard = true; factors.push(`replies5m=${replies5m}`); }
  if (messagesLast5Min >= FIREHOSE_5MIN) { hard = true; factors.push(`velocity=${messagesLast5Min}!`); }
  if (hard) return { budget: 0, note: null, factors };

  // ── 软预算:只塑造中间带注记,clamp 在硬阈之上(连乘不致静音)──
  let budget = 1;
  if (share >= 0.25) { budget *= 0.45; factors.push(`share=${Math.round(share * 100)}%`); }
  if (replies5m >= 3) { budget *= 0.5; factors.push(`replies5m=${replies5m}`); }
  let velocityFactor = false;
  if (messagesLast5Min > 40) { budget *= 0.3; velocityFactor = true; factors.push(`velocity=${messagesLast5Min}`); }
  else if (messagesLast5Min > 20) { budget *= 0.65; velocityFactor = true; factors.push(`velocity=${messagesLast5Min}`); }

  // 精力:深夜/犯懒整体收缩
  try {
    const energy = getLifeState().energy;
    if (energy < 0.3) { budget *= 0.6; factors.push(`energy=${energy.toFixed(2)}`); }
  } catch { /* fail-soft */ }

  budget = Math.max(budget, HARD_PASS_BUDGET + 0.01);

  // 注记只发群速一种:"自己话密"已由 heart.md 刷屏自检 + 自我状态的
  // focus 在场感覆盖,三个声音同时喊"闭嘴"会把心流吓哑(review #10)。
  const note = budget < 0.5 && velocityFactor
    ? '(群里刷得很快,你凑热闹的兴致一般,收着点)'
    : null;

  return { budget, note, factors };
}
