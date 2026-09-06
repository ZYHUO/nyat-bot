// ────────────────────────────────────────
// Core Belief View — 矛盾检测 (Phase 0 Task 0.2)
//
// 两条路：
//  1. 显式反驳（host，热路径可用）：contradict() — 外部证据直接打脸某条
//     belief → refute_count++、status=contradicted。调用点只有 host。
//  2. 语义冲突（离线 cron，不进热路径）：detectSemanticConflicts() —
//     用便宜 judge usage 批量比对同 predicate 的信念对，只产出"疑似冲突"
//     报告，由 host 决断（保留新 / 旧条标 contradicted）。
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { logger } from '../../shared/logger.js';
import { callWithFallback } from '../../ai/fallback.js';
import { getActiveBeliefs } from './store.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface SemanticConflict {
  beliefA: number;
  beliefB: number;
  reason: string;
}

/**
 * 显式反驳（host 调用）：某条 belief 被外部证据证伪。
 * refute_count++、status=contradicted、反驳证据追加进 evidence。
 * getActiveBeliefs() 自动排除 contradicted（旧知识不再注入 prompt）。
 */
export function contradict(beliefId: number, evidence: string[], note: string): void {
  if (!evidence || evidence.length === 0) {
    throw new Error('contradict requires non-empty evidence');
  }
  const db = getDb();
  const row = db
    .prepare(`SELECT refute_count, evidence FROM core_beliefs WHERE id = ?`)
    .get(beliefId) as { refute_count: number; evidence: string } | undefined;
  if (!row) {
    logger.debug({ beliefId }, 'contradict: belief not found');
    return;
  }
  let old: string[] = [];
  try {
    old = JSON.parse(row.evidence) as string[];
  } catch {
    old = [];
  }
  const merged = [...old];
  for (const e of evidence) {
    if (!merged.includes(e)) merged.push(e);
  }
  db.prepare(
    `UPDATE core_beliefs SET refute_count = ?, status = 'contradicted',
       evidence = ?, updated_at = ? WHERE id = ?`,
  ).run(row.refute_count + 1, JSON.stringify(merged), nowSec(), beliefId);
  logger.debug({ beliefId, note: note.slice(0, 100) }, 'belief contradicted by host evidence');
}

function parseConflictOutput(text: string): Array<{ a: number; b: number; reason: string }> {
  // 宽容解析：找 {"a":id,"b":id,"reason":"..."} 对象数组（jsonMode 输出）。
  try {
    const arr = JSON.parse(text) as Array<{ a: number; b: number; reason: string }>;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => typeof x.a === 'number' && typeof x.b === 'number');
  } catch {
    return [];
  }
}

/**
 * 离线语义冲突检测（cron 调用，不进热路径）：
 * 取某 predicate 下活跃信念两两（截断到前 20 条防 token 爆炸），
 * 让便宜 judge usage 判定冲突对。返回疑似冲突，由 host 决断。
 * LLM 不可用/解析失败 → 返回 []（fail-soft，不拦任何东西）。
 */
export async function detectSemanticConflicts(
  predicate: string,
  opts: { usage?: string; limit?: number } = {},
): Promise<SemanticConflict[]> {
  const beliefs = getActiveBeliefs(predicate).slice(0, opts.limit ?? 20);
  if (beliefs.length < 2) return [];
  const lines = beliefs.map((b) => `[${b.id}] ${b.summary}`).join('\n');
  const prompt = `下面是关于 ${predicate} 的多条信念，找出语义上互相矛盾的对。只输出JSON数组，每个元素{"a":id,"b":id,"reason":"一句话原因"}。无矛盾输出[]。\n${lines}`;
  try {
    const res = await callWithFallback({
      usage: opts.usage ?? 'judge',
      messages: [{ role: 'user', content: prompt }],
      jsonMode: true,
    });
    const found = parseConflictOutput(res.content);
    const ids = new Set(beliefs.map((b) => b.id));
    return found
      .filter((f) => ids.has(f.a) && ids.has(f.b) && f.a !== f.b)
      .map((f) => ({ beliefA: f.a, beliefB: f.b, reason: f.reason ?? '' }));
  } catch (err) {
    logger.debug({ err, predicate }, 'detectSemanticConflicts failed (non-critical)');
    return [];
  }
}
