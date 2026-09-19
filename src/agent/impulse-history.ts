// ────────────────────────────────────────
// 冲动史 — 单决策点"想说什么"的可读投影
// ────────────────────────────────────────
//
// NyatOS 的影子（src/nyatos/shadow.ts）每观察到一条消息就判一次
// speak / silent / wait，连同理由写进 cognitive_events 的 social_prediction。
// 四天里这个账本攒了 1,013 条 speak、35 条 silent、22 条 wait，**`liveOutcome`
// 永远为 null**——判定写了，从来没有人读它。
//
// 后果（2026-09-19 架构审计的核心发现）：生产决策路径完全不知道"机器人自己
// 想说什么"。它既学不会克制，也学不会被压制的滋味——一个看不到自身冲动史的
// 主体，不可能有"参与感"，只会有"应答反射"。
//
// 本模块只做一件事：把那份账本读出来，变成 Frame 能渲染的事实。
// 不解释、不裁决、不改写模型的理由——它当时怎么想的就怎么给。

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface Impulse {
  /** 判定发生的时间（unix 秒） */
  atSec: number;
  /** speak / silent / wait / failed */
  verdict: string;
  /** 决策点自己说的理由（未加工） */
  why: string;
  /** 对应的消息 id，便于回查 */
  messageId: number;
}

/**
 * 该 scope 最近几次冲动。读不到/表不存在 → 空数组（调用方据此不加这段 Frame）。
 */
export function getRecentImpulses(chatId: number, limit = 4, withinMin = 90): Impulse[] {
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - withinMin * 60;
    const rows = db
      .prepare(
        `SELECT fact_json, occurred_at FROM cognitive_events
         WHERE type = 'social_prediction' AND chat_id = ?
           AND occurred_at >= ?
         ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
      )
      .all(chatId, cutoff, limit * 3) as Array<{ fact_json: string; occurred_at: number }>;

    const out: Impulse[] = [];
    for (const r of rows) {
      let fact: {
        shadowVerdict?: string;
        shadowWhy?: string;
        messageId?: number;
      };
      try {
        fact = JSON.parse(r.fact_json) as typeof fact;
      } catch {
        continue;
      }
      const verdict = fact.shadowVerdict;
      // 'failed' 是这次判定没跑成，不是它想过什么——当成冲动会污染历史
      if (!verdict || verdict === 'null' || verdict === 'failed') continue;
      out.push({
        atSec: r.occurred_at,
        verdict,
        why: String(fact.shadowWhy ?? '').slice(0, 200),
        messageId: Number(fact.messageId ?? 0),
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    // **必须 warn 不是 debug**：2026-09-19 我用错了 Node 跑探针（better-sqlite3
    // 加载失败），这个 catch 静默返回 []，于是我据以判定"[念头] 不工作"——
    // 而真相是探针自己坏了。debug 级在生产等于不可见，一个会静默消失的
    // 冲动史会让上面所有"它没出现"的判断都变成假阴性。
    logger.warn({ err, chatId }, 'getRecentImpulses failed — impulse history SILENTLY empty');
    return [];
  }
}
