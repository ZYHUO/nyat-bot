import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import type { LearnerScanResult, JargonEntry } from './types.js';

/**
 * Inference threshold tiers. A jargon is (re-)inferred each time its count
 * crosses the next tier beyond the count at which it was last inferred. Higher
 * tiers re-run inference with more samples to refine the previously stored
 * meaning, instead of re-inferring repeatedly at the same tier.
 */
export const JARGON_INFERENCE_THRESHOLDS = [4, 8, 25, 100]; // tunable

/**
 * The highest tier in `thresholds` that `count` has reached, or 0 if none.
 */
function highestCrossedThreshold(count: number, thresholds: number[]): number {
  let crossed = 0;
  for (const t of thresholds) {
    if (count >= t && t > crossed) crossed = t;
  }
  return crossed;
}

/** JargonEntry as stored, including the inference-tier bookkeeping column. */
type JargonRow = JargonEntry & { last_inference_count: number };

/**
 * Upsert jargon candidates into DB. Increments count and appends samples on conflict.
 */
export function upsertJargons(
  chatId: number,
  items: LearnerScanResult['jargons'],
  contextSnippet?: string,
): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // raw_samples 必须始终是合法 JSON 数组:历史 bug 是插入裸文本,
  // ON CONFLICT 的 json_array_length() 一碰就抛 'malformed JSON' 炸掉
  // 整个事务(6/6 起线上 SqliteError 的真身)。插入即 json_array(?),
  // 冲突路径从 excluded 里取第一个元素续插。
  const insertStmt = db.prepare(`
    INSERT INTO jargons (chat_id, content, raw_samples, count, status, created_at, updated_at)
    VALUES (?, ?, json_array(?), 1, 'pending', ?, ?)
    ON CONFLICT(chat_id, content) DO UPDATE SET
      count = count + 1,
      raw_samples = CASE
        WHEN json_valid(jargons.raw_samples) AND json_array_length(jargons.raw_samples) < 10
        THEN json_insert(jargons.raw_samples, '$[#]', json_extract(excluded.raw_samples, '$[0]'))
        ELSE jargons.raw_samples
      END,
      updated_at = excluded.updated_at
  `);

  let inserted = 0;
  const run = db.transaction(() => {
    for (const item of items) {
      if (!item.content.trim()) continue;
      const sample = contextSnippet ? contextSnippet.slice(0, 200) : '';
      insertStmt.run(chatId, item.content.trim(), sample, now, now);
      inserted++;
    }
  });
  run();
  logger.debug({ chatId, inserted }, 'Upserted jargons');
  return inserted;
}

/**
 * Get jargons whose count has crossed the NEXT inference tier beyond the count
 * at which they were last inferred (`last_inference_count`). This avoids
 * re-inferring the same jargon repeatedly at the same tier: a jargon is only
 * returned once it climbs into a higher threshold band, at which point the
 * inference is re-run to refine the previously stored meaning.
 *
 * If no `thresholds` are supplied the module-level tiers are used.
 */
export function getJargonsForInference(
  chatId: number,
  thresholds: number[] = JARGON_INFERENCE_THRESHOLDS,
): JargonEntry[] {
  const db = getDb();
  const tiers = thresholds.filter((t) => t > 0).sort((a, b) => a - b);
  if (tiers.length === 0) return [];
  const minThreshold = tiers[0]!;

  // 'confirmed' jargons are manually locked and never re-inferred. We do allow
  // already-'inferred' jargons back through, so higher tiers can refine them.
  const rows = db.prepare(
    `SELECT * FROM jargons
       WHERE chat_id = ? AND status != 'confirmed' AND count >= ?
       ORDER BY count DESC LIMIT 30`,
  ).all(chatId, minThreshold) as JargonRow[];

  return rows.filter(
    (r) => highestCrossedThreshold(r.count, tiers) > (r.last_inference_count ?? 0),
  );
}

/**
 * Mark a jargon as inferred with its meaning. Also records the count at which
 * inference ran (`last_inference_count`) so the next tier-crossing — not the
 * same tier — is what re-triggers inference.
 */
export function markJargonInferred(chatId: number, content: string, meaning: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE jargons
       SET meaning = ?, status = 'inferred', last_inference_count = count, updated_at = ?
       WHERE chat_id = ? AND content = ?`,
  ).run(meaning, now, chatId, content);
}

/**
 * Inference produced no usable meaning at this tier. Advance
 * `last_inference_count` to the current count so we don't keep retrying at the
 * same tier, but leave any existing meaning and status untouched.
 */
export function markJargonNoInfo(chatId: number, content: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE jargons
       SET last_inference_count = count, updated_at = ?
       WHERE chat_id = ? AND content = ?`,
  ).run(now, chatId, content);
}

/**
 * Query a jargon by content in a specific chat.
 */
export function queryJargon(chatId: number, term: string): JargonEntry | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM jargons WHERE chat_id = ? AND content = ?',
  ).get(chatId, term) as JargonEntry | undefined;
}

/**
 * Fuzzy search jargons by content prefix.
 */
export function searchJargons(chatId: number, term: string): JargonEntry[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM jargons WHERE chat_id = ? AND content LIKE ? AND meaning != \'\' ORDER BY count DESC LIMIT 5',
  ).all(chatId, `%${term}%`) as JargonEntry[];
}

/**
 * #4 黑话注入:取本群已推断出含义的高频黑话(供 prompt [本群黑话] 块)。
 * 从"被动工具查询"升级为"自然脱口而出"的素材源。
 */
export function getTopJargons(chatId: number, limit = 5): JargonEntry[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM jargons
      WHERE chat_id = ? AND status = 'inferred' AND meaning != ''
      ORDER BY count DESC LIMIT ?`,
  ).all(chatId, limit) as JargonEntry[];
}

/**
 * G1 修复:黑话重检计数(MaiBot LRU cache 的对标)。
 *
 * 根因:learner-scan 只把 messageId>lastMsgId 的新消息喂给抽取 LLM,
 * 同一个词在 scan N 被抽取后,scan N+1 不会再被抽到 → ON CONFLICT 的
 * count+1 永远不触发 → 1057 条全卡在 count=1,推断阈值(4)永不可达,
 * [本群黑话] 注入块从未发火。
 *
 * 修法:每个 learner tick,把**新消息原文**与本群已存黑话词条做子串
 * 匹配 —— 词条再次被群友说出来 = 一次真实复现,count++。这才是
 * "黑话靠重复出现获得地位"的本义,与抽取 LLM 是否再次报它无关。
 */
export function recountJargonsInMessages(
  chatId: number,
  messageTexts: string[],
): number {
  if (messageTexts.length === 0) return 0;
  const db = getDb();
  // 只看 2-12 字的词条(太短误匹配率高,太长不是黑话)
  const rows = db.prepare(
    `SELECT content FROM jargons
      WHERE chat_id = ? AND length(content) BETWEEN 2 AND 12`,
  ).all(chatId) as Array<{ content: string }>;
  if (rows.length === 0) return 0;

  const now = Math.floor(Date.now() / 1000);
  const bump = db.prepare(
    `UPDATE jargons SET count = count + ?, updated_at = ? WHERE chat_id = ? AND content = ?`,
  );

  let bumped = 0;
  const run = db.transaction(() => {
    for (const { content } of rows) {
      let hits = 0;
      for (const text of messageTexts) {
        if (text.includes(content)) hits++;
      }
      if (hits > 0) {
        // 单 tick 同词最多 +3,防一句刷屏直接把词顶过阈值
        bump.run(Math.min(hits, 3), now, chatId, content);
        bumped++;
      }
    }
  });
  run();
  if (bumped > 0) logger.info({ chatId, bumped }, 'Jargon recount: terms reinforced by recurrence');
  return bumped;
}

/**
 * G8 理解侧:入站消息文本中出现的**已推断**黑话(含义注入用)。
 * MaiBot 用 query_jargon 工具让模型按需查;我们一步到位:看到就附上含义。
 */
export function searchJargonsInText(chatId: number, text: string, limit = 3): JargonEntry[] {
  if (!text || text.length < 2) return [];
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM jargons
      WHERE chat_id = ? AND status = 'inferred' AND meaning != ''
        AND length(content) BETWEEN 2 AND 12
      ORDER BY count DESC LIMIT 100`,
  ).all(chatId) as JargonEntry[];
  const hits: JargonEntry[] = [];
  for (const row of rows) {
    if (text.includes(row.content)) {
      hits.push(row);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}
