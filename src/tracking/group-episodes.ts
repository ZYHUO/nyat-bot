// ────────────────────────────────────────
// Group Episodes — 群共同经历记忆(语言生命层 G7)
// ────────────────────────────────────────
//
// per-user 记忆已深,但"上周群里那件事"不存在 → bot 永远无法像老群友
// 那样 callback 共同经历。这里:
//   - cron(每 2h)把活跃群最近一段聊天摘要成 0-2 条"群里发生的事"
//   - 回复时把入站消息与 episode 关键词匹配,命中 → 注入 [群里的往事]
//   - 召回即强化(recall_count++),久不召回的旧事在 prune 时让位

import type { Database, Statement } from 'better-sqlite3';
import { getDb } from '../db/sqlite.js';
import { getRecent } from '../pipeline/context/manager.js';
import { callWithFallback } from '../ai/fallback.js';
import { logger } from '../shared/logger.js';

const MAX_EPISODES_PER_CHAT = 60;
const MIN_MSGS_FOR_SUMMARY = 25;
/** 召回最低分(hits×权重×salience):低于它的偶然重叠一律不注入 */
const MIN_RECALL_SCORE = 0.5;

// recall 是每次回复的热路径 —— prepared statement 提升到模块级缓存,
// 按 db 实例身份失效(测试换 :memory: 库、closeDb 重开都安全)。
let _stmts: { db: Database; select: Statement; bump: Statement } | null = null;
function recallStmts(): { select: Statement; bump: Statement } {
  const db = getDb();
  if (!_stmts || _stmts.db !== db) {
    _stmts = {
      db,
      select: db.prepare('SELECT * FROM group_episodes WHERE chat_id = ? ORDER BY created_at DESC LIMIT 200'),
      bump: db.prepare('UPDATE group_episodes SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?'),
    };
  }
  return _stmts;
}

export interface GroupEpisode {
  id: number;
  chat_id: number;
  summary: string;
  keywords: string;
  salience: number;
  created_at: number;
}

/** cron 入口:为一个群提炼最近的"群事件"(0-2 条) */
export async function summarizeEpisodes(chatId: number): Promise<number> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // 距上次摘要后的新消息(看 created_at 最新一条 episode 的时间)
  const lastRow = db.prepare(
    'SELECT MAX(created_at) AS t FROM group_episodes WHERE chat_id = ?',
  ).get(chatId) as { t: number | null };
  const since = lastRow?.t ?? 0;

  const recent = await getRecent(chatId, 120);
  const fresh = recent.filter((m) => m.timestamp > since && !m.isBot && (m.textContent || '').trim());
  if (fresh.length < MIN_MSGS_FOR_SUMMARY) return 0;

  const lines = fresh.slice(-80).map((m) => `${m.fullName || m.username || '?'}: ${(m.textContent || '').slice(0, 80)}`).join('\n');

  let content: string;
  try {
    const result = await callWithFallback({
      usage: 'summarize',
      messages: [
        {
          role: 'system',
          content:
            '你是群聊记忆整理器。从聊天片段里挑出 0-2 件**值得群友日后回忆**的具体事件(有人翻车/争论结果/好笑的梗诞生/谁宣布了什么/集体做了什么)。' +
            '每件输出一行 JSON:{"summary":"一句话,主语用群友名字,≤40字","keywords":"3-5个空格分隔的关键词","salience":0.1-1.0}。' +
            '日常寒暄/无具体事件 → 输出空数组 []。只输出 JSON 数组。',
        },
        { role: 'user', content: lines },
      ],
      maxTokens: 2000, // 推理模型留足预算(原300被截断成空)
      temperature: 0.3,
    });
    content = result.content;
  } catch (err) {
    logger.debug({ err, chatId }, 'group-episodes: LLM failed');
    return 0;
  }

  let items: Array<{ summary?: string; keywords?: string; salience?: number }> = [];
  try {
    const m = content.match(/\[[\s\S]*\]/);
    if (m) items = JSON.parse(m[0]) as typeof items;
  } catch { return 0; }

  const insert = db.prepare(
    'INSERT INTO group_episodes (chat_id, summary, keywords, salience, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  let saved = 0;
  for (const it of items.slice(0, 2)) {
    if (!it.summary || it.summary.length < 6) continue;
    insert.run(chatId, it.summary.slice(0, 80), (it.keywords || '').slice(0, 60), Math.min(1, Math.max(0.1, it.salience ?? 0.5)), now);
    saved++;
  }

  // 超额清理:保留 salience+recall 最高的 MAX_EPISODES_PER_CHAT 条
  db.prepare(
    `DELETE FROM group_episodes WHERE chat_id = ? AND id NOT IN (
       SELECT id FROM group_episodes WHERE chat_id = ?
       ORDER BY (salience + recall_count * 0.2) DESC, created_at DESC LIMIT ?)`,
  ).run(chatId, chatId, MAX_EPISODES_PER_CHAT);

  if (saved > 0) logger.info({ chatId, saved }, 'group-episodes: saved');
  return saved;
}

/**
 * 回复时:入站文本命中关键词的往事(≤limit 条),召回即强化。
 *
 * 评分制(审计修复):旧逻辑 raw includes + 先到先得,完全无视已存储的
 * salience —— 2 字 CJK 词(今天/这个)的偶然子串重叠让陈旧低价值往事
 * 挤掉真正相关的高价值往事,且 recall_count++ 自我强化使其越错越牢。
 * 现在:
 *   - 统计 DISTINCT 关键词命中数;长词(≥4)权重 ×2(强回调信号)
 *   - 硬门槛:≥2 个不同关键词命中,或单命中但关键词长度 ≥4
 *   - 软门槛:score = Σ权重 × salience ≥ MIN_RECALL_SCORE
 *   - 排序:score 降序,平分按 created_at 新近优先;取 top-limit
 *   - 只有最终注入的才 recall_count++
 */
export function recallEpisodes(chatId: number, messageText: string, limit = 2): GroupEpisode[] {
  if (!messageText || messageText.length < 4) return [];
  const { select, bump } = recallStmts();
  const rows = select.all(chatId) as GroupEpisode[];
  if (rows.length === 0) return [];

  const scored: Array<{ row: GroupEpisode; score: number }> = [];
  for (const row of rows) {
    const kws = [...new Set(row.keywords.split(/\s+/).filter((k) => k.length >= 2))];
    const hitKws = kws.filter((k) => messageText.includes(k));
    if (hitKws.length === 0) continue;
    // 硬门槛:单个 2-3 字命中是噪声,不进入评分
    if (hitKws.length < 2 && hitKws[0]!.length < 4) continue;
    const weight = hitKws.reduce((sum, k) => sum + (k.length >= 4 ? 2 : 1), 0);
    const score = weight * row.salience;
    if (score < MIN_RECALL_SCORE) continue;
    scored.push({ row, score });
  }
  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at);
  const hits = scored.slice(0, limit).map((s) => s.row);

  const now = Math.floor(Date.now() / 1000);
  for (const h of hits) bump.run(now, h.id);
  return hits;
}
