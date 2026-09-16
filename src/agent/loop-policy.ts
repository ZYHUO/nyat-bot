// ────────────────────────────────────────
// Loop Policies — 任务循环策略资产 (AGI Level 5 Phase 4)
//
// OpenLoopEvolve 理念(轻量版): executor 的任务循环策略
// (验证/重试/停止/交付规则)从静态写死升级为可进化的资产:
// - 注入: 开工时按成功率排序取 enabled 的前 N 条进 prompt
// - 计数: 注入后任务成功 → success_count++; 失败 → failure_count++
// - 进化: 成功率 < 0.3 的自动 disable(坏策略退出)
// 不做完整版本谱系(YAGNI)。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface LoopPolicy {
  id: number;
  name: string;
  description: string | null;
  rule: string;
  enabled: number;
  triggerCount: number;
  successCount: number;
  failureCount: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 创建策略(同名去重,更新已存在)。 */
export function upsertLoopPolicy(name: string, rule: string, description?: string): number | null {
  try {
    const db = getDb();
    const ts = nowSec();
    const existing = db.prepare('SELECT id FROM loop_policies WHERE name = ?').get(name) as { id: number } | undefined;
    if (existing) {
      db.prepare(`UPDATE loop_policies SET rule = ?, description = ?, updated_at = ? WHERE id = ?`).run(rule, description ?? null, ts, existing.id);
      return existing.id;
    }
    const r = db
      .prepare(
        `INSERT INTO loop_policies (name, description, rule, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(name, description ?? null, rule, ts, ts);
    return Number(r.lastInsertRowid);
  } catch (err) {
    logger.warn({ err, name }, 'upsertLoopPolicy failed');
    return null;
  }
}

/** 取 enabled 策略,按成功率降序,最多 N 条。 */
export function listActivePolicies(limit = 5): LoopPolicy[] {
  try {
    return getDb()
      .prepare(
        `SELECT * FROM loop_policies WHERE enabled = 1
         ORDER BY (success_count * 1.0 / MAX(1, success_count + failure_count)) DESC, success_count DESC
         LIMIT ?`,
      )
      .all(limit) as LoopPolicy[];
  } catch (err) {
    logger.warn({ err }, 'listActivePolicies failed');
    return [];
  }
}

/** 记录一次注入 + 任务结果。失败率高 → 自动 disable(进化)。 */
export function recordPolicyOutcome(policyIds: number[], taskSucceeded: boolean): void {
  if (!policyIds.length) return;
  try {
    const db = getDb();
    const ts = nowSec();
    const stmt = db.prepare(
      `UPDATE loop_policies SET trigger_count = trigger_count + 1,
         success_count = success_count + ?, failure_count = failure_count + ?, updated_at = ? WHERE id = ?`,
    );
    const disable = db.prepare(
      `UPDATE loop_policies SET enabled = 0, updated_at = ?
       WHERE id = ? AND success_count + failure_count >= 3
         AND failure_count * 1.0 / (success_count + failure_count) > 0.7`,
    );
    for (const id of policyIds) {
      stmt.run(taskSucceeded ? 1 : 0, taskSucceeded ? 0 : 1, ts, id);
      disable.run(ts, id);
    }
  } catch (err) {
    logger.warn({ err }, 'recordPolicyOutcome failed');
  }
}

/** 构建注入 executor prompt 的 [循环策略] 块。 */
export function buildPolicyBlock(limit = 5): string {
  const policies = listActivePolicies(limit);
  if (!policies.length) return '';
  return (
    '\n\n[循环策略]\n' +
    policies.map((p) => `- ${p.rule}`).join('\n') +
    '\n以上是过往任务中沉淀的循环策略,适用就用。'
  );
}
