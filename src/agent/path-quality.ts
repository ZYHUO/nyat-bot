// ────────────────────────────────────────
// Path Quality — 任务执行路径质量统计 (AGI Level 5 Phase 1, D)
//
// QuoteBench 理念: 只看「结果对不对」会掩盖「执行路径失败」——
// agent 可能最后答案对了,但中间全是无效工具调用/无意义重试。
// 路径质量喂给经验验证器: 结果好但路径差的任务,不算「经验被证实」。
// ────────────────────────────────────────

import { logger } from '../shared/logger.js';

export interface PathQualityInput {
  /** 总工具调用次数(含无效)。 */
  totalCalls: number;
  /** 无效调用次数(工具不存在 / 参数错误 / 返回不可解析)。 */
  invalidCalls: number;
  /** 重试次数(同一动作的重复尝试,非计划内)。 */
  retryCount: number;
  /** 端到端轮次。 */
  turns: number;
}

export interface PathQualityResult {
  /** 0-1,越高越好。无效调用/重试多 → 低分。 */
  score: number;
  invalidCalls: number;
  retryCount: number;
}

/**
 * 计算路径质量。
 * score = 1 - (invalidCalls + retryCount) / max(1, totalCalls)
 * 无调用记录 → 0,缺少观测不能作为成功证据。
 */
export function computePathQuality(input: PathQualityInput): PathQualityResult {
  const { totalCalls, invalidCalls, retryCount } = input;
  if (totalCalls <= 0) {
    return { score: 0, invalidCalls: 0, retryCount: 0 };
  }
  const penalty = (invalidCalls + retryCount) / totalCalls;
  const score = Math.max(0, Math.min(1, 1 - penalty));
  return { score, invalidCalls, retryCount };
}

/**
 * 路径质量是否「合格」(够格作为经验证实的证据)。
 * 结果好 + 路径干净(≥0.7) → 证实;路径脏 → 不算。
 */
export function isPathQualityGood(score: number): boolean {
  return score >= 0.7;
}

/** 给 episodes 落库路径质量。 */
export function savePathQuality(
  db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => unknown;
    };
  },
  episodeTaskId: string,
  quality: PathQualityResult,
): void {
  try {
    db.prepare(
      `UPDATE episodes SET invalid_tool_calls = ?, retry_count = ?, path_quality = ?
       WHERE task_id = ?`,
    ).run(quality.invalidCalls, quality.retryCount, quality.score, episodeTaskId);
  } catch (err) {
    logger.debug({ err, episodeTaskId }, 'savePathQuality failed (non-critical)');
  }
}

// ── executor 侧统计辅助 ─────────────────

/** 从工具调用历史里统计无效调用/重试(executor 终态时调用)。 */
export function summarizeToolCalls(
  calls: { name?: string; ok?: boolean; error?: string; createdAt?: number }[],
): { totalCalls: number; invalidCalls: number; retryCount: number } {
  if (!calls.length) return { totalCalls: 0, invalidCalls: 0, retryCount: 0 };
  let invalidCalls = 0;
  let retryCount = 0;
  // 同工具名连续失败 ≥2 次 = 重试
  let lastOk: boolean | null = null;
  let consecutiveFails = 0;
  for (const c of calls) {
    const ok = c.ok !== false && !c.error;
    if (!ok) {
      invalidCalls++;
      consecutiveFails = lastOk === false ? consecutiveFails + 1 : 1;
      if (consecutiveFails >= 2) retryCount++;
    } else {
      consecutiveFails = 0;
    }
    lastOk = ok;
  }
  return { totalCalls: calls.length, invalidCalls, retryCount };
}
