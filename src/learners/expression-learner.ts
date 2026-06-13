import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { isAgreementTail } from './expression-filter.js';
import type { LearnerScanResult, ExpressionEntry } from './types.js';

/** G9 程序级硬过滤:别学 bot 自己的话(回音室)、媒体占位符、附和句尾口癖 */
function isLearnableExpression(situation: string, style: string, botMarkers: string[]): boolean {
  const combined = `${situation} ${style}`;
  if (/\[(?:表情|图片|贴纸|sticker|media|语音|视频)/i.test(combined)) return false;
  // "…是吧/…对吧"这类附和句尾当标点的口癖不学(否则注入即强化,自激循环)
  if (isAgreementTail(style)) return false;
  for (const marker of botMarkers) {
    if (marker && combined.includes(marker)) return false;
  }
  return true;
}

/** G2 简版相似度:bigram Jaccard(与 anti-repeat 同源算法) */
function exprSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const n = s.replace(/\s+/g, '').toLowerCase();
    const out = new Set<string>();
    for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
    return out;
  };
  const sa = grams(a), sb = grams(b);
  if (sa.size === 0 || sb.size === 0) return a === b ? 1 : 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 单批表达入库上限(G9 anti-flood) */
const MAX_EXPRESSIONS_PER_BATCH = 8;
/** G2 模糊合并阈值(对标 MaiBot difflib 0.75) */
const MERGE_SIMILARITY = 0.7;

/**
 * Parse LLM output into expressions and jargons.
 * Handles JSON wrapped in markdown code fences.
 */
export function parseLearnerOutput(raw: string): LearnerScanResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return { expressions: [], jargons: [] };

  let arr: unknown[];
  try {
    arr = JSON.parse(match[0]) as unknown[];
  } catch {
    return { expressions: [], jargons: [] };
  }

  const expressions: LearnerScanResult['expressions'] = [];
  const jargons: LearnerScanResult['jargons'] = [];

  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj['situation'] === 'string' && typeof obj['style'] === 'string') {
      expressions.push({
        situation: obj['situation'].slice(0, 60),
        style: obj['style'].slice(0, 60),
        source_id: typeof obj['source_id'] === 'string' ? obj['source_id'] : undefined,
      });
    } else if (typeof obj['content'] === 'string' && obj['content'].length >= 2) {
      jargons.push({
        content: obj['content'].slice(0, 30),
        source_id: typeof obj['source_id'] === 'string' ? obj['source_id'] : undefined,
      });
    }
  }
  return { expressions, jargons };
}

/**
 * Upsert expressions into DB. Increments count on conflict.
 */
export function upsertExpressions(
  chatId: number,
  items: LearnerScanResult['expressions'],
  sourceMsgId?: number,
): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // G9: SELF/bot名/媒体占位 硬过滤(prompt 叮嘱挡不住时代码挡)
  let botMarkers: string[] = ['SELF'];
  try {
    botMarkers = ['SELF', env().BOT_USERNAME, ...env().BOT_NICKNAMES].filter(Boolean);
  } catch { /* env unavailable in some test contexts */ }

  const cleaned = items
    .filter((it) => it.situation.trim() && it.style.trim())
    .filter((it) => isLearnableExpression(it.situation, it.style, botMarkers))
    .slice(0, MAX_EXPRESSIONS_PER_BATCH);
  if (cleaned.length === 0) return 0;

  // G2: 模糊合并 —— 近似的 situation+style 强化既有行,不再无限堆新行。
  // (精确 ON CONFLICT 要求字节级相同 → 线上 1606 行只有 10 行曾被强化。)
  const existing = db.prepare(
    'SELECT id, situation, style FROM expressions WHERE chat_id = ? ORDER BY count DESC LIMIT 400',
  ).all(chatId) as Array<{ id: number; situation: string; style: string }>;

  const insertStmt = db.prepare(`
    INSERT INTO expressions (chat_id, situation, style, source_msg_id, count, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(chat_id, situation, style) DO UPDATE SET
      count = count + 1,
      updated_at = excluded.updated_at
  `);
  const reinforceStmt = db.prepare('UPDATE expressions SET count = count + 1, updated_at = ? WHERE id = ?');

  let inserted = 0;
  const run = db.transaction(() => {
    for (const item of cleaned) {
      const situation = item.situation.trim();
      const style = item.style.trim();

      let merged = false;
      for (const ex of existing) {
        const sim = (exprSimilarity(situation, ex.situation) + exprSimilarity(style, ex.style)) / 2;
        if (sim >= MERGE_SIMILARITY) {
          reinforceStmt.run(now, ex.id);
          merged = true;
          break;
        }
      }
      if (!merged) {
        const msgId = item.source_id ? Number(item.source_id) || sourceMsgId : sourceMsgId;
        insertStmt.run(chatId, situation, style, msgId ?? null, now, now);
        inserted++;
      }
    }
  });
  run();
  logger.debug({ chatId, inserted, merged: cleaned.length - inserted }, 'Upserted expressions');
  return inserted;
}

/**
 * Get top APPROVED expressions for a chat by count. Only gate-approved patterns
 * inject into the prompt, so a few bad learned samples can't drift the voice.
 */
export function getTopExpressions(chatId: number, limit: number): ExpressionEntry[] {
  const db = getDb();
  // 注入侧双保险:即使 DB 里残留/被 merge 靠拢出的附和句尾,注入前也滤掉
  // (多取一些再过滤,保证滤后仍够 limit 条)。
  const fetch = limit * 3;
  const filter = (rows: ExpressionEntry[]): ExpressionEntry[] =>
    rows.filter((r) => !isAgreementTail(r.style)).slice(0, limit);
  // G10 注入池地板:count>=2 的(真被群里反复用的)够多时只从它们里取,
  // 不让 1500+ 条单次噪音稀释注入池(MaiBot weighted_sample from count>1 同义)。
  const reinforced = filter(db.prepare(
    "SELECT * FROM expressions WHERE chat_id = ? AND status = 'approved' AND count >= 2 ORDER BY count DESC LIMIT ?",
  ).all(chatId, fetch) as ExpressionEntry[]);
  if (reinforced.length >= Math.min(limit, 3)) return reinforced;
  return filter(db.prepare(
    "SELECT * FROM expressions WHERE chat_id = ? AND status = 'approved' ORDER BY count DESC LIMIT ?",
  ).all(chatId, fetch) as ExpressionEntry[]);
}

/**
 * G10 月度清理:90 天未强化的单次表达 + 60 天未复现的单次黑话。
 * 返回删除行数。由 cleanup cron 调用。
 */
export function pruneStaleLearnings(): { expressions: number; jargons: number } {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const exprCutoff = now - 90 * 86400;
  const jargonCutoff = now - 60 * 86400;
  const e = db.prepare(
    'DELETE FROM expressions WHERE count <= 1 AND updated_at < ?',
  ).run(exprCutoff).changes;
  const j = db.prepare(
    "DELETE FROM jargons WHERE count <= 1 AND status = 'pending' AND updated_at < ?",
  ).run(jargonCutoff).changes;
  if (e + j > 0) logger.info({ expressions: e, jargons: j }, 'Pruned stale learnings');
  return { expressions: e, jargons: j };
}

/** Pending (un-reviewed) expressions for the approval gate. */
export function getPendingExpressions(chatId: number, limit: number): Array<{ situation: string; style: string }> {
  return getDb().prepare(
    "SELECT situation, style FROM expressions WHERE chat_id = ? AND status = 'pending' ORDER BY count DESC LIMIT ?",
  ).all(chatId, limit) as Array<{ situation: string; style: string }>;
}

/** Chats that have pending expressions awaiting review. */
export function chatsWithPendingExpressions(): number[] {
  const rows = getDb().prepare(
    "SELECT DISTINCT chat_id FROM expressions WHERE status = 'pending'",
  ).all() as Array<{ chat_id: number }>;
  return rows.map((r) => r.chat_id);
}

/** Set an expression's review status + confidence. */
export function setExpressionStatus(
  chatId: number, situation: string, style: string, status: 'approved' | 'rejected', confidence: number,
): void {
  getDb().prepare(
    'UPDATE expressions SET status = ?, confidence = ? WHERE chat_id = ? AND situation = ? AND style = ?',
  ).run(status, confidence, chatId, situation, style);
}

/** G6 使用强化:表达被注入 prompt 即记一次使用,count++(MaiBot use-based 强化) */
export function reinforceExpressions(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // 封顶 30:注入即强化会正反馈锁死 top-5(P2),封顶后新表达仍有机会爬升。
  // (60→30:口癖自激教训后调低,top 句式不再死锁、洗库更快)
  const stmt = db.prepare('UPDATE expressions SET count = count + 1, updated_at = ? WHERE id = ? AND count < 30');
  const run = db.transaction(() => {
    for (const id of ids) stmt.run(now, id);
  });
  run();
}
