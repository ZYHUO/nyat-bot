// ────────────────────────────────────────
// Debt Sweep — 认知债务后台扫描 (CSR Phase B)
//
// 周期性：
//   1. 过期 open 债务置 expired（TTL 语义：没偿还的猜测/传闻自动失效）
//   2. 收集到期待处理的债务（仅记录，不自动发消息——是否主动偿还由
//      unified-tick 的模型结合 WorldState 自己决定）
//   3. 输出 prediction error 摘要（per-chat 均值，供观察行动预测质量）
// fail-soft：任何一步失败只记日志，不影响其它 cron。
// ────────────────────────────────────────

import { logger } from '../shared/logger.js';

export interface DebtSweepResult {
  expired: number;
  dueCount: number;
  predictionChats: number;
}

export async function runDebtSweep(): Promise<DebtSweepResult> {
  const result: DebtSweepResult = { expired: 0, dueCount: 0, predictionChats: 0 };
  try {
    const { expireStaleDebts, listDueDebts } = await import('../agent/cognitive-debts.js');
    result.expired = expireStaleDebts();
    const due = listDueDebts(10);
    result.dueCount = due.length;
    if (due.length > 0) {
      logger.info(
        { due: due.map((d) => ({ id: d.id, kind: d.kind, statement: d.statement.slice(0, 60) })) },
        'debt-sweep: due debts pending repayment',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'debt-sweep: debt scan failed');
  }
  try {
    const { recentResolvedPredictions } = await import('../agent/predictions.js');
    const rows = recentResolvedPredictions(300);
    const byChat = new Map<number, { sum: number; n: number }>();
    for (const r of rows) {
      if (r.predictionError === null) continue;
      const cur = byChat.get(r.chatId) ?? { sum: 0, n: 0 };
      cur.sum += r.predictionError;
      cur.n += 1;
      byChat.set(r.chatId, cur);
    }
    result.predictionChats = byChat.size;
    for (const [chatId, { sum, n }] of byChat) {
      const mean = sum / n;
      // 只有偏差明显时才打日志，避免噪声
      if (Math.abs(mean) > 0.25 && n >= 5) {
        logger.info({ chatId, meanError: Number(mean.toFixed(3)), samples: n }, 'debt-sweep: prediction error biased');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'debt-sweep: prediction summary failed');
  }
  if (result.expired > 0) {
    logger.info({ expired: result.expired }, 'debt-sweep: stale debts expired');
  }
  return result;
}
