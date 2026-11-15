// ────────────────────────────────────────
// Nyat Trench · 自我状态（Self State）——决策点缺失的那三个数
// ────────────────────────────────────────
//
// 论文 §三 成员 B 的诊断：现有 41,552 行代码里，`myUnansweredStreak` /
// `myShare30m` / `discourseCredit` **一个都不存在**。这就是它学不会克制的原因——
// shadow 226 个 speak、线上 155 次"想说却没说"，系统里却没有任何一个数字在记录
// "它已经连续多少次没被理了"。
//
// 2026-09-19 实测（scripts/decision-equivalence.mts，近 7 天）：
//   shadow 想 speak 1675 次，线上只回了 139 次 → top-level 一致率 **10.1%**
// 这不是 shadow 判错，是**它没有身体**：它不知道自己刚叭叭了一堆没人理。
// （budget.ts 头部的 Phase 2.3 负结果已经证明过同一件事：把"你 2 分钟发了 4 条、
//   3 条没人理"当事实告诉它之前，它 28 分钟想发言 48 次。）
//
// 本模块只做**读数**，不做裁决：把宿主已经知道的事实算成三个数，渲染成 Frame 里
// 的身体感受。说不说，仍然是模型的事。

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface SelfState {
  /** 近 30 分钟我的发言占比（我的条数 / 该群总条数）。 */
  share30m: number;
  /** 我最近的发言条数（30 分钟窗）。 */
  myRecentCount: number;
  /** 连续多少条发言没有任何人接（ignored 或至今 unknown 且已过观察窗）。 */
  unansweredStreak: number;
  /** 我最近的发言里，有人接的比例（用于回声的本地读数）。 */
  recentEcho: number;
}

const WINDOW_SEC = 30 * 60;

/** 读不到就返回 null——调用方据此不加这一行，绝不用默认值假装知道。 */
export function readSelfState(chatId: number): SelfState | null {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
  try {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const from = now - WINDOW_SEC;

    // 我的发言（self_replies 已是"bot 说过什么"的唯一账本）
    const mine = db
      .prepare(`SELECT bot_message_id, outcome FROM self_replies WHERE chat_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 20`)
      .all(chatId, from) as Array<{ bot_message_id: number | null; outcome: string }>;

    // 该群总消息量（认知账本的 message_received 是最全的入站记录）
    const totalRow = db
      .prepare(`SELECT COUNT(*) n FROM cognitive_events WHERE type='message_received' AND chat_id=? AND occurred_at >= ?`)
      .get(chatId, from) as { n: number };
    const total = (totalRow?.n ?? 0) + mine.length;

    const myRecentCount = mine.length;
    // 这半小时我什么都没说 → 没有"关于我"的事实可报。
    // 返回 null 而不是一堆 0：零和"不知道"不是一回事。
    if (myRecentCount === 0) return null;
    const share30m = total > 0 ? myRecentCount / total : 0;

    // 连续未被接住：从最新往回数，遇到有人接就停。
    //
    // **只数已结算为 ignored 的。** 第一版把 unknown 也数进去，实测直接造假：
    // 98.6% 的 outcome 是 unknown（Echo 还没把它们结掉），于是 streak 一路虚涨到
    // 14——那不是"没人理我"，是"我们根本没去问过有没有人理"。
    // 读数的铁律：不知道就不能装作知道。
    let unansweredStreak = 0;
    for (const row of mine) {
      const o = String(row.outcome ?? 'unknown');
      if (o === 'ignored') { unansweredStreak += 1; continue; }
      break;
    }

    // 近期回声：最近 20 条里有人接的占比（unknown 不计入分母——没结算的没有发言权）
    const decided = mine.filter((r) => String(r.outcome ?? 'unknown') !== 'unknown');
    const heard = decided.filter((r) => ['replied', 'reacted', 'mentioned', 'corrected'].includes(String(r.outcome))).length;
    const recentEcho = decided.length >= 3 ? heard / decided.length : -1; // -1 = 样本不足，别下结论

    return { share30m, myRecentCount, unansweredStreak, recentEcho };
  } catch (err) {
    logger.debug({ err, chatId }, 'self state read failed');
    return null;
  }
}

/**
 * 渲染成 Frame 事实行。
 *
 * 刻意全部做成"它自己的体感"，不是仪表盘：不说"占比 0.31"，说"这半小时你说了
 * 挺多"。因为 Phase 2.3 的教训是**数字本身劝不动模型**，能动它的是"这说的是我"。
 */
export function renderSelfState(s: SelfState): string {
  const parts: string[] = [];

  if (s.myRecentCount === 0) return '';

  if (s.share30m >= 0.5) parts.push('这半个小时内几乎都是你在说');
  else if (s.share30m >= 0.3) parts.push('这半小时你说得不少');

  if (s.unansweredStreak >= 3) {
    parts.push(`而且你连着 ${s.unansweredStreak} 条都没人接`);
  } else if (s.unansweredStreak === 2) {
    parts.push('上两条也没什么动静');
  }

  if (parts.length === 0) return '';
  return `[你自已] ${parts.join('，')}。`;
}
