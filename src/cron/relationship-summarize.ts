// ────────────────────────────────────────
// Relationship Summarize cron — #8 关系叙事
// ────────────────────────────────────────
//
// chat_relationships.last_summary 字段建表时就预留了("留接口给 cron"),
// 一直没人写 —— 亲和力只有数字没有故事。这里每天挑互动多、又久未总结的
// (chat,uid) 对,用近期互动让 LLM 写一句"你们之间发生过什么",注入
// prompt 的 [你和TA] 块(reply.ts 已接好读取端)。

import { getDb } from '../db/sqlite.js';
import { getRecent } from '../pipeline/context/manager.js';
import { callWithFallback } from '../ai/fallback.js';
import { logger } from '../shared/logger.js';

const MAX_PAIRS_PER_TICK = 6;
const MIN_INTERACTIONS = 10;
/** 距上次总结至少 5 天才重写(updated_at 复用为总结时间戳的近似) */
const RESUMMARIZE_AFTER_SEC = 5 * 86400;

interface PairRow {
  chat_id: number;
  uid: number;
  interaction_count: number;
  last_summary: string;
  updated_at: number;
}

export async function runRelationshipSummarize(): Promise<void> {
  let pairs: PairRow[];
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - RESUMMARIZE_AFTER_SEC;
    pairs = db.prepare(
      `SELECT chat_id, uid, interaction_count, last_summary, updated_at
         FROM chat_relationships
        WHERE interaction_count >= ?
          AND (last_summary = '' OR updated_at < ?)
        ORDER BY interaction_count DESC
        LIMIT ?`,
    ).all(MIN_INTERACTIONS, cutoff, MAX_PAIRS_PER_TICK) as PairRow[];
  } catch (err) {
    logger.warn({ err }, 'relationship-summarize: query failed');
    return;
  }
  if (pairs.length === 0) return;

  for (const pair of pairs) {
    try {
      const recent = await getRecent(pair.chat_id, 80);
      const lines = recent
        .filter((m) => m.uid === pair.uid || m.role === 'assistant')
        .slice(-24)
        .map((m) => `${m.role === 'assistant' ? '你' : 'TA'}: ${(m.textContent || '').slice(0, 60)}`)
        .join('\n');
      if (lines.length < 60) continue; // 素材太少,这轮跳过

      const result = await callWithFallback({
        usage: 'summarize_deep',
        messages: [
          {
            role: 'system',
            content: '你是群聊 bot 的记忆整理器。根据对话片段,用**一句话**(不超过40字)概括"你"(bot)和"TA"(某位群友)之间的互动印象/共同经历,口语化、具体一点(比如"上次帮TA怼过卖灵车的""TA总半夜来找你聊天")。只输出这一句话,不要引号不要解释。',
          },
          { role: 'user', content: `对话片段:\n${lines}\n\n一句话概括你和TA:` },
        ],
        maxTokens: 16000, // high 推理留足天花板(实测high≤1559,永不截断)
        temperature: 0.6,
      });

      const summary = result.content.trim().replace(/^["「『]|["」』]$/g, '').slice(0, 80);
      if (summary.length < 4) continue;

      getDb().prepare(
        `UPDATE chat_relationships SET last_summary = ?, updated_at = ? WHERE chat_id = ? AND uid = ?`,
      ).run(summary, Math.floor(Date.now() / 1000), pair.chat_id, pair.uid);
      logger.info({ chatId: pair.chat_id, uid: pair.uid, summary }, 'relationship-summarize: updated');
    } catch (err) {
      logger.debug({ err, chatId: pair.chat_id, uid: pair.uid }, 'relationship-summarize: pair failed');
    }
  }
}
