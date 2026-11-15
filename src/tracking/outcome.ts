// ────────────────────────────────────────
// ReplyOutcomeTracker — Redis (pending) + SQLite (outcomes)
// Port of PHP ReplyOutcomeTracker
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import type { ReplyOutcome } from './types.js';
import { feedbackScopeKey, resolveReplyFeedback } from './reply-feedback.js';
import type { FeedbackMessage } from './reply-feedback.js';

const PENDING_KEY_PREFIX = 'xxb:reply_outcome:pending:';
const PENDING_TTL = 3600;
const REFLECTION_THRESHOLD = 15;
const REFLECTION_INTERVAL = 86400;
const MAX_OUTCOMES = 100;
const REFLECTION_MAX_CHARS = 500;
const REFLECTION_RESET_EVERY = 5;

export async function recordReply(
  chatId: number,
  botMessageId: number,
  triggerMessageId: number,
  triggerUserId: number,
  triggerText: string,
  replyText: string,
  action: string,
  routeObservationId?: number,
): Promise<void> {
  const scopeKey = feedbackScopeKey(chatId);
  if (!scopeKey || !Number.isSafeInteger(botMessageId) || botMessageId <= 0) return;
  const redis = getRedis();
  const key = PENDING_KEY_PREFIX + chatId;

  const data = {
    scope_key: scopeKey,
    bot_message_id: botMessageId,
    trigger_message_id: triggerMessageId,
    trigger_user_id: triggerUserId,
    trigger_text: triggerText.slice(0, 200),
    reply_text: replyText.slice(0, 200),
    action,
    timestamp: now(),
    chat_id: chatId,
    msgs_after: 0,
    ...(Number.isSafeInteger(routeObservationId) && (routeObservationId ?? 0) > 0
      ? { route_observation_id: routeObservationId }
      : {}),
  };

  try {
    await redis.hset(key, String(botMessageId), JSON.stringify(data));
    await redis.expire(key, PENDING_TTL);
  } catch (err) {
    logger.warn({ err, chatId }, 'ReplyOutcomeTracker: recordReply failed');
  }
}

export async function checkOutcome(
  chatId: number,
  currentMessage: FeedbackMessage,
  botUsername: string,
): Promise<{ needsReflection: boolean }> {
  try {
    await resolveReplyFeedback(chatId, currentMessage, botUsername);
    return { needsReflection: needsReflection(chatId) };
  } catch (err) {
    logger.warn({ err, chatId }, 'ReplyOutcomeTracker: checkOutcome failed');
    return { needsReflection: false };
  }
}

export function needsReflection(chatId: number): boolean {
  const meta = loadOutcomeMeta(chatId);
  if (meta.outcomesSinceReflection >= REFLECTION_THRESHOLD) return true;
  if (meta.outcomesSinceReflection > 0 && now() - meta.lastReflectionTime >= REFLECTION_INTERVAL)
    return true;
  return false;
}

export async function generateReflection(
  chatId: number,
  aiCall: (prompt: string) => Promise<string | null>,
): Promise<void> {
  const redis = getRedis();
  const lockKey = `xxb:reflection_lock:${chatId}`;
  const acquired = await redis.set(lockKey, '1', 'EX', 120, 'NX');
  if (!acquired) return;

  try {
    const db = getDb();
    const outcomes = db
      .prepare('SELECT * FROM reply_outcomes WHERE chat_id = ? ORDER BY id DESC LIMIT ?')
      .all(chatId, MAX_OUTCOMES) as ReplyOutcome[];

    if (outcomes.length === 0) return;

    const meta = loadOutcomeMeta(chatId);
    const isReset =
      meta.totalReflections > 0 && meta.totalReflections % REFLECTION_RESET_EVERY === 0;

    let existingSection = '';
    if (!isReset) {
      const existing = db
        .prepare('SELECT reflection FROM reply_reflections WHERE chat_id = ?')
        .get(chatId) as { reflection: string } | undefined;
      if (existing?.reflection) {
        existingSection = `你现有的自我反思：\n${existing.reflection}`;
      }
    }

    const outcomeRecords = outcomes.map((o) => JSON.stringify(o)).join('\n');
    const prompt = buildReflectionPrompt(outcomeRecords, existingSection);

    const reflection = await aiCall(prompt);
    if (!reflection?.trim()) return;

    const trimmed = reflection.trim().slice(0, REFLECTION_MAX_CHARS);

    db.prepare(
      `INSERT OR REPLACE INTO reply_reflections (chat_id, reflection, updated_at)
       VALUES (?, ?, ?)`,
    ).run(chatId, trimmed, now());

    updateReflectionMeta(chatId);
  } finally {
    await redis.del(lockKey);
  }
}

function loadOutcomeMeta(chatId: number) {
  const row = getDb()
    .prepare(
      'SELECT outcomes_since_reflection, last_reflection_time, total_reflections, total_outcomes FROM outcome_meta WHERE chat_id = ?',
    )
    .get(chatId) as Record<string, number> | undefined;
  return {
    outcomesSinceReflection: row?.outcomes_since_reflection ?? 0,
    lastReflectionTime: row?.last_reflection_time ?? 0,
    totalReflections: row?.total_reflections ?? 0,
    totalOutcomes: row?.total_outcomes ?? 0,
  };
}

function updateReflectionMeta(chatId: number): void {
  getDb()
    .prepare(
      `UPDATE outcome_meta SET
         outcomes_since_reflection = 0,
         last_reflection_time = ?,
         total_reflections = total_reflections + 1
       WHERE chat_id = ?`,
    )
    .run(now(), chatId);
}

function buildReflectionPrompt(outcomes: string, existing: string): string {
  return `你是一个 Telegram 群聊 bot 的自我分析模块。

以下是你最近在一个群的回复效果记录（JSON 格式）：
${outcomes}

${existing}

请分析你的回复模式，找出规律：
- 哪些类型的消息你不该回复但回了？（outcome 为 negative 的记录）
- 哪些情况下你的回复受欢迎？（outcome 为 positive 的记录）

输出格式：用 3-5 条简短的规则描述你学到的经验教训。
不要列举具体消息内容，只总结抽象规律。
保持规则简短，每条不超过 30 字。
只输出规则列表（每条以 - 开头），不要输出其他内容。`;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function getReflection(chatId: number): string | null {
  const row = getDb()
    .prepare("SELECT reflection FROM reply_reflections WHERE chat_id = ?")
    .get(chatId) as { reflection: string } | undefined;
  return row?.reflection ?? null;
}
