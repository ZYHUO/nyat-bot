// ────────────────────────────────────────
// Feedback Tracker — AGI Level 4 P3 signal
//
// 收录用户对 bot 消息的即时反应 (reaction emoji / reply sentiment)，
// 供 aggregate cron 聚合后更新 self_model_notes。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { getActiveTopics } from './topic-registry.js';
import { recordReward } from './topic-bandit.js';
import { getForwardSource } from '../pipeline/rhythm/taste.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

// reaction emoji → 情绪 [-1, +1]
const EMOJI_SENTIMENT: Record<string, number> = {
  '👍': 0.6, '❤': 0.9, '🔥': 0.8, '😂': 0.7, '😍': 0.9, '🎉': 0.8,
  '👏': 0.7, '💯': 0.8, '🙏': 0.5, '😮': 0.3, '👀': 0.1,
  '👎': -0.6, '💩': -0.7, '😡': -0.9, '🤮': -0.9, '😢': -0.5,
  '🖕': -0.9, '😠': -0.7, '🤨': -0.3, '😒': -0.4,
};

// 用户回复消息里的情绪词 → 粗略 [-1, +1]
// 注：\b 对 CJK 无效（中文两侧都是词字符），所以中文词不加 \b；英文词保留 \b 防子串误杀。
const POSITIVE_RE = /(哈哈|好笑|不错|棒|赞|喜欢|爱了|666|厉害|笑死|可爱|乖|还行|可以|\bgood\b|\bgoh\b|\bnice\b|\bok\b)/i;
const NEGATIVE_RE = /(垃圾|傻|滚|烦|恶心|烂|差|傻逼|弱智|不要|别烦|\bcrap\b|\bstupid\b|\bno\b)/i;

function emojiSentiment(e: string): number {
  return EMOJI_SENTIMENT[e] ?? 0;
}

function textSentiment(text: string): number {
  const lower = text.toLowerCase();
  if (POSITIVE_RE.test(lower)) return 0.7;
  if (NEGATIVE_RE.test(lower)) return -0.7;
  return 0;
}

export interface FeedbackRow {
  id: number;
  kind: string;
  user_id: number;
  bot_message_id: number | null;
  chat_id: number;
  emoji: string | null;
  sentiment: number;
  raw_text: string | null;
  created_at: number;
}

// reaction: 用户给 bot 消息点 emoji
export function recordReaction(params: {
  userId: number;
  botMessageId: number;
  chatId: number;
  emoji: string;
}): void {
  const s = emojiSentiment(params.emoji);
  if (s === 0) return; // 中性表情不用记
  try {
    getDb()
      .prepare(
        `INSERT INTO feedback_events (kind, user_id, bot_message_id, chat_id, emoji, sentiment, created_at)
         VALUES ('reaction', ?, ?, ?, ?, ?, ?)`,
      )
      .run(params.userId, params.botMessageId, params.chatId, params.emoji, s, nowSec());
    logger.debug({ userId: params.userId, emoji: params.emoji, s }, 'feedback: reaction');
    // H4.2 reaction→bandit 回流：跟 recordReplySentiment 同口径——本群 live
    // topics 均分 reward（保守，避免错归因放大）。
    // taste 闭环：如果这条是转发的落点（目标群），reward 回给*源群*的 live topics。
    try {
      const src = getForwardSource(params.chatId, params.botMessageId);
      const targetChat = src ? src.fromChatId : params.chatId;
      const live = getActiveTopics(targetChat, 4);
      if (live.length > 0) {
        const share = s / live.length;
        for (const t of live) recordReward(targetChat, t.label, share);
      }
    } catch { /* non-critical */ }
  } catch (err) {
    logger.debug({ err }, 'recordReaction failed (non-critical)');
  }
}

// replier: 用户直接回复 bot 消息（文字/情绪）
// plan 口径：被 quote 追问本身就是强正信号（+1），跟文本情绪分开算——
// 用户肯花力气打字追问，哪怕骂两句也是 engagement，不该被情绪负分吃掉。
export const QUOTE_FOLLOWUP_BONUS = 1.0;

export function recordReplySentiment(params: {
  userId: number;
  botMessageId: number;
  chatId: number;
  userText: string;
}): void {
  const s = textSentiment(params.userText);
  const total = s + QUOTE_FOLLOWUP_BONUS;
  try {
    getDb()
      .prepare(
        `INSERT INTO feedback_events (kind, user_id, bot_message_id, chat_id, sentiment, raw_text, created_at)
         VALUES ('replier_sentiment', ?, ?, ?, ?, ?, ?)`,
      )
      .run(params.userId, params.botMessageId, params.chatId, total, params.userText.slice(0, 300), nowSec());
    logger.debug({ userId: params.userId, s, total, text: params.userText.slice(0, 50) }, 'feedback: reply');
    // H4 bandit 回流：这次回复是对 bot 跟进某话题的反馈 → 折成 reward。
    // 话题归因：本群当前 live 话题（topic-registry getActiveTopics），命中多个
    // 时均分 reward（保守，避免错归因放大）。同步调用（registry 是纯 SQLite）。
    try {
      const live = getActiveTopics(params.chatId, 4);
      if (live.length > 0) {
        const share = total / live.length;
        for (const t of live) recordReward(params.chatId, t.label, share);
      }
    } catch { /* non-critical */ }
  } catch (err) {
    logger.debug({ err }, 'recordReplySentiment failed (non-critical)');
  }
}

// 某个用户最近 N 条 feedback（aggregate 用）
export function getUserRecentFeedback(userId: number, limit = 20): FeedbackRow[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT * FROM feedback_events
         WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      kind: r.kind as string,
      user_id: r.user_id as number,
      bot_message_id: (r.bot_message_id as number | null) ?? null,
      chat_id: r.chat_id as number,
      emoji: (r.emoji as string | null) ?? null,
      sentiment: r.sentiment as number,
      raw_text: (r.raw_text as string | null) ?? null,
      created_at: r.created_at as number,
    }));
  } catch {
    return [];
  }
}

// 某用户近期 sentiment 均值（-1 ~ +1）
export function getUserFeedbackSentiment(userId: number, windowSec = 86400): number {
  try {
    const since = nowSec() - windowSec;
    const r = getDb()
      .prepare(
        `SELECT AVG(sentiment) AS avg FROM feedback_events
         WHERE user_id = ? AND created_at >= ?`,
      )
      .get(userId, since) as { avg: number | null };
    return r.avg ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Phase B: 同群 bot 消息近期 sentiment 均值(-1..1, 7 天窗口)。
 * 给 verifier 当 feedbackBias: 群友最近越买账 bot 的发言, 候选分上浮;
 * 最近被怼/冷场, 下压。无数据返回 0(中性, 加权后行为接近纯 LLM 分)。
 */
export function getChatFeedbackBias(chatId: number, windowSec = 7 * 86400): number {
  try {
    const since = nowSec() - windowSec;
    const r = getDb()
      .prepare(
        `SELECT AVG(sentiment) AS avg FROM feedback_events
         WHERE chat_id = ? AND created_at >= ?`,
      )
      .get(chatId, since) as { avg: number | null };
    return r.avg ?? 0;
  } catch {
    return 0;
  }
}
