import { getDb } from "../../db/sqlite.js";
import type { AddresseeVerdict } from "./addressee.js";

export interface FloorDecision {
  chatId: number;
  messageId: number;
  verdict: AddresseeVerdict;
  reason: string;
}

export function recordFloorDecision(d: FloorDecision): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO floor_decisions (chat_id, message_id, verdict, reason)
         VALUES (?, ?, ?, ?)`,
      )
      .run(d.chatId, d.messageId, d.verdict, d.reason);
  } catch {
    // 观测写失败不影响主流程
  }
}

export interface FloorStats {
  total: number;
  to_me: number;
  to_other: number;
  ambient: number;
  not_me: number;
}

export function getFloorStats(chatId: number, days = 7): FloorStats {
  const zero: FloorStats = { total: 0, to_me: 0, to_other: 0, ambient: 0, not_me: 0 };
  try {
    const rows = getDb()
      .prepare(
        `SELECT verdict, COUNT(*) AS n FROM floor_decisions
         WHERE chat_id = ? AND created_at > unixepoch() - ? * 86400
         GROUP BY verdict`,
      )
      .all(chatId, days) as Array<{ verdict: string; n: number }>;
    for (const r of rows) {
      if (r.verdict === "to_me") zero.to_me = r.n;
      else if (r.verdict === "to_other") zero.to_other = r.n;
      else if (r.verdict === "ambient") zero.ambient = r.n;
      else if (r.verdict === "not_me") zero.not_me = r.n;
      zero.total += r.n;
    }
  } catch {
    // 表不存在（迁移未应用）→ 全零
  }
  return zero;
}
