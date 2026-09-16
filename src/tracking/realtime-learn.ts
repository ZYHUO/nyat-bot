// ─────────────────────────────────────────────────────────────────────────────
// 实时学习 — 每条回复后异步抽"这轮聊了啥"+ 刷新关系叙事
// ─────────────────────────────────────────────────────────────────────────────
//
// 替代部分批量 cron(group-episodes 2h、relationship-summarize 每天),让记忆更
// 鲜活:bot 刚回完一句,异步问 LLM"这一来一回里有没有值得日后回忆的具体事件",
// 有就写进 group_episodes;同时如果该 (chat,uid) 关系叙事超过 6h 没更新,顺带
// 刷新 last_summary。fire-and-forget,不阻塞回复,失败静默。

import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

const RELATIONSHIP_REFRESH_AFTER_SEC = 6 * 3600;
const MAX_EPISODES_PER_CHAT = 60;
/** L2:trigger+reply 合计短于此长度视为琐碎寒暄,跳过 episode 抽取(省一次 LLM)。 */
const MIN_EXCHANGE_CHARS = 16;
/** L3:自评分 EMA。alpha = 最新样本权重。 */
const SELFSCORE_ALPHA = 0.3;
const SELFSCORE_KEY_PREFIX = 'xxb:reply:selfscore:';
const SELFSCORE_EXPIRE_SEC = 30 * 86400;

export interface RealtimeLearnInput {
  chatId: number;
  /** 对方(uid)——用于关系叙事刷新 */
  userId: number;
  /** 触发回复的对方那条话 */
  triggerText: string;
  /** bot 这次的回复 */
  replyText: string;
}

/**
 * 回复后异步学习。永不 throw(调用方 fire-and-forget)。
 * @returns 写入的 episode 条数(0 表示这轮没什么可记)。
 */
export async function learnFromReply(input: RealtimeLearnInput): Promise<number> {
  const e = env();
  if (!e.REALTIME_LEARN_ENABLED) return 0;
  const trigger = (input.triggerText ?? '').trim();
  const reply = (input.replyText ?? '').trim();
  // L2:太短的琐碎寒暄不抽(避免低价值 episode 稀释记忆)。触发+回复合计 < 24 字跳过。
  if (!trigger || !reply) return 0;
  if (trigger.length + reply.length < 24) return 0;
  // L2:极短一来一回(纯寒暄)不抽 episode,省一次 LLM;关系/自评分仍可跑(用各自判断)。
  const trivial = trigger.length + reply.length < MIN_EXCHANGE_CHARS;

  // ── 1. 抽 episode(琐碎跳过)──
  let saved = 0;
  if (!trivial) {
  try {
    const result = await callWithFallback({
      usage: 'summarize',
      messages: [
        {
          role: 'system',
          content:
            '你是群聊记忆整理器。看这一来一回(对方说 + bot 回),判断有没有**值得群友日后回忆**的具体事件' +
            '(翻车/争论出结果/好笑的梗/谁宣布了什么)。有 → 输出一行 JSON:' +
            '{"summary":"一句话,主语用名字,≤40字","keywords":"3-5个空格分隔关键词","salience":0.1-1.0}。' +
            '没有(日常寒暄/闲聊) → 输出 []。只输出 JSON。',
        },
        { role: 'user', content: `对方: ${trigger.slice(0, 200)}\n你: ${reply.slice(0, 200)}` },
      ],
      maxTokens: 160,
      temperature: 0.3,
      maxTimeoutMs: e.REALTIME_LEARN_TIMEOUT_MS,
    });
    const m = (result.content ?? '').match(/\[[\s\S]*\]/);
    if (m) {
      const items = JSON.parse(m[0]) as Array<{ summary?: string; keywords?: string; salience?: number }>;
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      const insert = db.prepare(
        'INSERT INTO group_episodes (chat_id, summary, keywords, salience, created_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const it of items.slice(0, 1)) {
        if (!it.summary || it.summary.length < 6) continue;
        insert.run(input.chatId, it.summary.slice(0, 80), (it.keywords || '').slice(0, 60), Math.min(1, Math.max(0.1, it.salience ?? 0.5)), now);
        saved++;
      }
      if (saved > 0) {
        // 超额清理:保留 salience+recall 最高的 MAX_EPISODES_PER_CHAT 条
        db.prepare(
          `DELETE FROM group_episodes WHERE chat_id = ? AND id NOT IN (
             SELECT id FROM group_episodes WHERE chat_id = ?
             ORDER BY (salience + recall_count * 0.2) DESC, created_at DESC LIMIT ?)`,
        ).run(input.chatId, input.chatId, MAX_EPISODES_PER_CHAT);
      }
    }
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'realtime-learn: episode extract failed (non-critical)');
  }
  } // end if (!trivial)

  // ── 2. 刷新关系叙事(仅当超过 6h 没更新)──
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT updated_at, last_summary FROM chat_relationships WHERE chat_id = ? AND uid = ?',
    ).get(input.chatId, input.userId) as { updated_at: number; last_summary: string } | undefined;
    if (row) {
      const now = Math.floor(Date.now() / 1000);
      if (now - (row.updated_at ?? 0) > RELATIONSHIP_REFRESH_AFTER_SEC) {
        const result = await callWithFallback({
          usage: 'summarize',
          messages: [
            {
              role: 'system',
              content:
                '你是群聊 bot 的记忆整理器。根据这次一来一回,用**一句话**(≤40字)概括"你"(bot)和"TA"之间的互动印象/共同经历,' +
                '口语化、具体。只输出这一句话,不要引号不要解释。',
            },
            { role: 'user', content: `对方: ${trigger.slice(0, 120)}\n你: ${reply.slice(0, 120)}\n\n一句话概括你和TA:` },
          ],
          maxTokens: 80,
          temperature: 0.6,
          maxTimeoutMs: e.REALTIME_LEARN_TIMEOUT_MS,
        });
        const summary = (result.content ?? '').trim().replace(/^["「『]|["」』]$/g, '').slice(0, 80);
        if (summary.length >= 4) {
          db.prepare(
            `UPDATE chat_relationships SET last_summary = ?, updated_at = ? WHERE chat_id = ? AND uid = ?`,
          ).run(summary, now, input.chatId, input.userId);
        }
      }
    }
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'realtime-learn: relationship refresh failed (non-critical)');
  }

  // ── 3. L3:每条回复自评分(真·全量自评,不依赖后续 followup)──
  // LLM 按"贴人设/切题/自然度"给 0-1 分,按 chat 滚动 EMA 存 Redis,供离线分析 bot 表现。
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        {
          role: 'system',
          content:
            '你是回复质量评分器。给定对方的话和 bot 的回复,按"贴人设(可爱猫娘)/切题/自然度"综合打一个 0-1 的分(0=很差,1=很好)。' +
            '只输出一个 JSON:{"score":0.0-1.0}。',
        },
        { role: 'user', content: `对方: ${trigger.slice(0, 160)}\nbot: ${reply.slice(0, 160)}\n\n评分:` },
      ],
      maxTokens: 30,
      temperature: 0,
      maxTimeoutMs: e.REALTIME_LEARN_TIMEOUT_MS,
    });
    const sm = (result.content ?? '').match(/\{[\s\S]*\}/);
    if (sm) {
      const obj = JSON.parse(sm[0]) as { score?: unknown };
      const score = typeof obj['score'] === 'number' ? Math.min(1, Math.max(0, obj['score'] as number)) : null;
      if (score !== null) await rollSelfScoreEma(input.chatId, score);
    }
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'realtime-learn: self-score failed (non-critical)');
  }

  if (saved > 0) logger.info({ chatId: input.chatId, saved }, 'realtime-learn: episode saved');
  return saved;
}

/** L3:per-chat 自评分 EMA(roll forward + 持久化到 Redis)。 */
async function rollSelfScoreEma(chatId: number, sample: number): Promise<void> {
  const key = SELFSCORE_KEY_PREFIX + chatId;
  let prev: number | null = null;
  try {
    const raw = await getRedis().get(key);
    if (raw) {
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed)) prev = parsed;
    }
  } catch { /* non-critical */ }
  const next = prev === null ? sample : prev * (1 - SELFSCORE_ALPHA) + sample * SELFSCORE_ALPHA;
  try {
    await getRedis().set(key, next.toFixed(4), 'EX', SELFSCORE_EXPIRE_SEC);
  } catch { /* non-critical */ }
}
