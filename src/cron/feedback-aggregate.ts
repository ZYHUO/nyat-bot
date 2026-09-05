// ────────────────────────────────────────
// Feedback Aggregate — AGI Level 4 P3-C
//
// Hourly cron: 聚合近期 feedback_events → 写入 self_model_notes
// 如果 sentiment 均值明显偏负，生成一条可操作的自我认知。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { saveSelfNotes } from '../tracking/self-model.js';

const WINDOW_SEC = 3 * 86400; // 看最近 3 天
const EXTREME_NEGATIVE = -0.35;
const NEGATIVE_THRESHOLD = -0.15;

/** 全局平均 sentiment（最近 windowSec 秒）。 */
function globalSentiment(windowSec: number): number {
  try {
    const since = Math.floor(Date.now() / 1000) - windowSec;
    const r = getDb()
      .prepare(
        `SELECT AVG(sentiment) AS avg FROM feedback_events WHERE created_at >= ?`,
      )
      .get(since) as { avg: number | null };
    return r.avg ?? 0;
  } catch {
    return 0;
  }
}

export async function runFeedbackAggregate(): Promise<void> {
  try {
    const avg = globalSentiment(WINDOW_SEC);
    if (!avg || avg === 0) return;

    const notes: { note: string; evidence?: string }[] = [];

    if (avg < EXTREME_NEGATIVE) {
      notes.push({
        note: '近期用户负面反馈偏多，请反思回复是否过于强势、敷衍或冒犯。少点卖萌，多倾听。',
        evidence: `全局 sentiment=${avg.toFixed(2)}（窗口=${WINDOW_SEC}s）`,
      });
    } else if (avg < NEGATIVE_THRESHOLD) {
      notes.push({
        note: '用户回复情绪略偏负，试试更简短、更少表情，语气更接地气。',
        evidence: `全局 sentiment=${avg.toFixed(2)}`,
      });
    }

    if (notes.length > 0) saveSelfNotes(notes);
  } catch {
    // 非关键路径，静默
  }
}
