// ────────────────────────────────────────
// Dreaming — 经验语义整合 (AGI Level 5 Phase 2)
//
// MindMemOS 理念: 记忆不能只增不整合。每周一次把全部经验条目交给
// LLM 复盘: 合并重复、消解冲突、淘汰过时 → 库质量持续收敛。
// 失败静默(下次周期再试),不阻塞主流程。
// ────────────────────────────────────────

import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { loadCachedPrompt } from '../shared/config.js';
import { getDb } from '../db/sqlite.js';
import type Database from 'better-sqlite3';

export interface DreamResult {
  /** keep_id → 合并后的新内容。 */
  merges: { keepId: number; removeIds: number[]; mergedContent: string }[];
  /** 冲突消解: 更新其中一条, 附带消解说明。 */
  conflicts: { idA: number; idB: number; resolution: string; winnerId: number }[];
  /** 淘汰的经验 id(低价值/过时)。 */
  drops: number[];
}

export interface DreamInput {
  entries: {
    id: number;
    kind: string;
    content: string;
    verified: number;
    successCount: number;
    failureCount: number;
    useCount: number;
  }[];
}

/** 解析 LLM 输出为 DreamResult; 垃圾输出返回 null(不重试)。 */
export function parseDreamOutput(raw: string): DreamResult | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const numArr = (v: unknown): number[] =>
      Array.isArray(v) ? (v as unknown[]).filter((x): x is number => typeof x === 'number').map((x) => Math.floor(x)) : [];
    const merges = Array.isArray(obj['merges'])
      ? (obj['merges'] as unknown[])
          .map((e) => {
            if (typeof e !== 'object' || e === null) return null;
            const eo = e as Record<string, unknown>;
            const keepId = typeof eo['keep_id'] === 'number' ? eo['keep_id'] : null;
            const mergedContent = typeof eo['merged_content'] === 'string' ? eo['merged_content'].trim().slice(0, 500) : '';
            if (keepId === null || !mergedContent) return null;
            return { keepId, removeIds: numArr(eo['remove_ids']), mergedContent };
          })
          .filter((e): e is { keepId: number; removeIds: number[]; mergedContent: string } => e !== null)
      : [];
    const conflicts = Array.isArray(obj['conflicts'])
      ? (obj['conflicts'] as unknown[])
          .map((e) => {
            if (typeof e !== 'object' || e === null) return null;
            const eo = e as Record<string, unknown>;
            const idA = typeof eo['id_a'] === 'number' ? eo['id_a'] : null;
            const idB = typeof eo['id_b'] === 'number' ? eo['id_b'] : null;
            const winnerId = typeof eo['winner_id'] === 'number' ? eo['winner_id'] : null;
            const resolution = typeof eo['resolution'] === 'string' ? eo['resolution'].trim().slice(0, 300) : '';
            if (idA === null || idB === null || winnerId === null || !resolution) return null;
            return { idA, idB, resolution, winnerId };
          })
          .filter((e): e is { idA: number; idB: number; resolution: string; winnerId: number } => e !== null)
      : [];
    const drops = numArr(obj['drops']);
    return { merges, conflicts, drops };
  } catch {
    return null;
  }
}

/** 读取全部经验条目供 dreaming 输入。 */
export function listAllExperience(db: Database.Database = getDb()): DreamInput['entries'] {
  try {
    return (
      db
        .prepare(
          `SELECT id, kind, content, verified, success_count AS successCount,
                  failure_count AS failureCount, use_count AS useCount
           FROM experience_entries ORDER BY id`,
        )
        .all() as DreamInput['entries']
    );
  } catch (err) {
    logger.warn({ err }, 'listAllExperience failed');
    return [];
  }
}

/** 应用 dreaming 结果到库。返回生效的操作数。 */
export function applyDream(db: Database.Database = getDb(), result: DreamResult): number {
  let ops = 0;
  try {
    const ts = Math.floor(Date.now() / 1000);
    for (const m of result.merges) {
      // 只更新存在的 keep_id; 合并内容带合并标记
      const existing = db.prepare('SELECT id FROM experience_entries WHERE id = ?').get(m.keepId) as { id: number } | undefined;
      if (!existing) continue;
      db.prepare(`UPDATE experience_entries SET content = ?, updated_at = ? WHERE id = ?`).run(
        `${m.mergedContent} (dreaming 合并 #${m.removeIds.join(',')})`,
        ts,
        m.keepId,
      );
      for (const rid of m.removeIds) {
        if (rid === m.keepId) continue;
        db.prepare('DELETE FROM experience_entries WHERE id = ?').run(rid);
        ops++;
      }
      ops++;
    }
    for (const c of result.conflicts) {
      const winner = db.prepare('SELECT id FROM experience_entries WHERE id = ?').get(c.winnerId) as { id: number } | undefined;
      if (!winner) continue;
      const row = db.prepare('SELECT content FROM experience_entries WHERE id = ?').get(c.winnerId) as { content: string } | undefined;
      if (!row) continue;
      db.prepare(`UPDATE experience_entries SET content = ?, updated_at = ? WHERE id = ?`).run(
        `${row.content} (dreaming 冲突消解: ${c.resolution})`,
        ts,
        c.winnerId,
      );
      // 输家删除(内容已并入 winner 的消解说明)
      const loserId = c.winnerId === c.idA ? c.idB : c.idA;
      if (loserId !== c.winnerId) {
        db.prepare('DELETE FROM experience_entries WHERE id = ?').run(loserId);
      }
      ops++;
    }
    for (const id of result.drops) {
      const existing = db.prepare('SELECT id FROM experience_entries WHERE id = ?').get(id) as { id: number } | undefined;
      if (!existing) continue;
      db.prepare('DELETE FROM experience_entries WHERE id = ?').run(id);
      ops++;
    }
    return ops;
  } catch (err) {
    logger.warn({ err }, 'applyDream failed');
    return ops;
  }
}

/** 执行一次 dreaming(读取 → LLM → 应用)。返回结果或 null。 */
export async function runDreamOnce(db: Database.Database = getDb()): Promise<DreamResult | null> {
  const entries = listAllExperience(db);
  if (entries.length < 5) {
    logger.info({ count: entries.length }, 'dreaming skipped — too few entries');
    return null;
  }
  try {
    const system = loadCachedPrompt('task/dream.md');
    const user = entries
      .map(
        (e) =>
          `#${e.id} [${e.kind}]${e.verified === 1 ? ' (已证实)' : e.verified === 2 ? ' (可疑)' : ''} use=${e.useCount} succ=${e.successCount} fail=${e.failureCount}: ${e.content}`,
      )
      .join('\n');
    const res = await callWithFallback({
      usage: env().DREAM_CONSOLIDATE_USAGE,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user.slice(0, 12000) },
      ],
      maxTokens: 2000,
      temperature: 0.2,
      allowHedge: false,
    });
    const parsed = parseDreamOutput(res.content ?? '');
    if (!parsed) {
      logger.warn('dreaming output unparseable — skipped');
      return null;
    }
    const ops = applyDream(db, parsed);
    logger.info({ merges: parsed.merges.length, conflicts: parsed.conflicts.length, drops: parsed.drops.length, ops }, 'dreaming consolidated');
    return parsed;
  } catch (err) {
    logger.warn({ err }, 'dreaming failed');
    return null;
  }
}
