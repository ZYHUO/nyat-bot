// ────────────────────────────────────────
// ReplyOutcomeTracker — Redis (pending) + SQLite (outcomes)
// Port of PHP ReplyOutcomeTracker
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import type { ReplyOutcome } from './types.js';
import { applyMoodEvent } from './mood.js';
import { applyRelationshipEvent } from './relationship.js';
import { NEGATIVE_PATTERNS, REPAIR_PATTERNS, POSITIVE_PATTERNS, countMatches } from './behavior-patterns.js';
import { scoreReplyQuality, ASI_ENABLED, ASI_SAMPLE_RATE } from './asi-scoring.js';

const PENDING_KEY_PREFIX = 'xxb:reply_outcome:pending:';
const OUTCOME_CHECK_WINDOW = 5;
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
): Promise<void> {
  const redis = getRedis();
  const key = PENDING_KEY_PREFIX + chatId;

  const data = {
    bot_message_id: botMessageId,
    trigger_message_id: triggerMessageId,
    trigger_user_id: triggerUserId,
    trigger_text: triggerText.slice(0, 200),
    reply_text: replyText.slice(0, 200),
    action,
    timestamp: now(),
    chat_id: chatId,
    msgs_after: 0,
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
  currentMessage: { isBot?: boolean; replyTo?: { messageId: number }; textContent?: string },
  botUsername: string,
): Promise<{ needsReflection: boolean }> {
  const redis = getRedis();
  const key = PENDING_KEY_PREFIX + chatId;

  try {
    const pending = await redis.hgetall(key);
    if (!Object.keys(pending).length) return { needsReflection: false };
    // Allow bot-to-bot interactions to affect outcome tracking
    // (previously we skipped all bot messages here)

    const currentReplyTo = currentMessage.replyTo?.messageId ?? 0;
    const currentText = currentMessage.textContent ?? '';
    const mentionsBot =
      botUsername !== '' && currentText.toLowerCase().includes(botUsername.toLowerCase());

    // Per-chat lock to prevent concurrent checkOutcome from duplicating records
    const lockKey = `xxb:outcome_lock:${chatId}`;
    const lockAcquired = await redis.set(lockKey, '1', 'EX', 10, 'NX');
    if (!lockAcquired) return { needsReflection: false };

    try {
      // Re-read after acquiring lock to avoid stale data
      const lockedPending = await redis.hgetall(key);
      if (!Object.keys(lockedPending).length) return { needsReflection: false };

      // Find most recent pending for mention attribution
      let mentionCandidate: string | null = null;
      if (mentionsBot) {
        let highest = -1;
        for (const [field, json] of Object.entries(lockedPending)) {
          const entry = JSON.parse(json) as Record<string, unknown>;
          if ((entry.bot_message_id as number) > highest) {
            highest = entry.bot_message_id as number;
            mentionCandidate = field;
          }
        }
      }
      if (!Object.keys(lockedPending).length) return { needsReflection: false };

      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO reply_outcomes (chat_id, ts, trigger_text, reply_text, outcome, signal, action)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      let resolvedCount = 0;
      // Collect all inserts to run atomically; Redis deletes are best-effort outside the tx
      const toInsert: Parameters<typeof insert.run>[] = [];
      const toDelete: string[] = [];
      // Rows that received an explicit followup — eligible for async ASI scoring.
      // Captured after the insert transaction so we have stable rowids.
      const scoreCandidates: Array<{
        insertIdx: number;
        triggerText: string;
        replyText: string;
        signal: string;
      }> = [];

      // ── #1 Deterministic explicit-reaction scan (runs before the window logic) ──
      // If the current message replies to a pending bot reply (or directly follows
      // one) and contains an explicit negative/repair/positive cue, finalize that
      // pending reply immediately with a stronger signal + larger delta.
      const negHits = countMatches(currentText, NEGATIVE_PATTERNS);
      const repairHits = countMatches(currentText, REPAIR_PATTERNS);
      const posHits = countMatches(currentText, POSITIVE_PATTERNS);
      let explicitField: string | null = null;
      if (negHits > 0 || repairHits > 0 || posHits > 0) {
        // Prefer the directly-replied-to pending reply; else attribute to the
        // most recent pending bot reply (message directly follows it).
        if (currentReplyTo > 0) {
          for (const [field, json] of Object.entries(lockedPending)) {
            const entry = JSON.parse(json) as Record<string, unknown>;
            if ((entry.bot_message_id as number) === currentReplyTo) {
              explicitField = field;
              break;
            }
          }
        }
        if (explicitField === null) {
          let highest = -1;
          for (const [field, json] of Object.entries(lockedPending)) {
            const entry = JSON.parse(json) as Record<string, unknown>;
            if ((entry.bot_message_id as number) > highest) {
              highest = entry.bot_message_id as number;
              explicitField = field;
            }
          }
        }
      }

      const explicitResolved = new Set<string>();
      if (explicitField !== null) {
        const json = lockedPending[explicitField];
        if (json) {
          const entry = JSON.parse(json) as Record<string, unknown>;
          // Repair takes precedence over a bare negative; positive only when no negative cue.
          let outcome: 'positive' | 'negative';
          let signal: string;
          let moodDelta: number;
          let relDelta: number;
          if (repairHits > 0) {
            outcome = 'negative';
            signal = 'repair_loop';
            moodDelta = -8;
            relDelta = -1.5;
          } else if (negHits > 0) {
            outcome = 'negative';
            signal = 'explicit_negative';
            moodDelta = -8;
            relDelta = -1.5;
          } else {
            outcome = 'positive';
            signal = 'explicit_positive';
            moodDelta = 5;
            relDelta = 1;
          }

          const insertIdx = toInsert.length;
          toInsert.push([chatId, now(), entry.trigger_text, entry.reply_text, outcome, signal, entry.action]);
          toDelete.push(explicitField);
          explicitResolved.add(explicitField);
          resolvedCount++;
          // An explicit reaction is a followup — score it.
          scoreCandidates.push({
            insertIdx,
            triggerText: String(entry.trigger_text ?? ''),
            replyText: String(entry.reply_text ?? ''),
            signal,
          });
          if (!currentMessage.isBot) {
            try { applyMoodEvent(chatId, moodDelta, `outcome_${signal}`); } catch { /* non-critical */ }
            try {
              const triggerUid = entry.trigger_user_id as number | undefined;
              if (typeof triggerUid === 'number' && triggerUid > 0) {
                applyRelationshipEvent(chatId, triggerUid, relDelta, `${outcome}:${signal}`);
              }
            } catch { /* non-critical */ }
          }
        }
      }

      for (const [field, json] of Object.entries(lockedPending)) {
        // Already finalized by the explicit-reaction scan above.
        if (explicitResolved.has(field)) continue;

        const entry = JSON.parse(json) as Record<string, unknown>;
        const botMsgId = entry.bot_message_id as number;

        const isReplyToBot = currentReplyTo === botMsgId;
        const isMentionTarget = field === mentionCandidate;

        if (isReplyToBot || isMentionTarget) {
          const outcome = 'positive';
          const signal = isReplyToBot ? 'user_replied' : 'user_mentioned_bot';
          const insertIdx = toInsert.length;
          toInsert.push([chatId, now(), entry.trigger_text, entry.reply_text, outcome, signal, entry.action]);
          toDelete.push(field);
          resolvedCount++;
          // A reply/mention is a followup — score it.
          scoreCandidates.push({
            insertIdx,
            triggerText: String(entry.trigger_text ?? ''),
            replyText: String(entry.reply_text ?? ''),
            signal,
          });
          // Stage E/F: only apply mood/relationship effects for human interactions, not bot-to-bot
          if (!currentMessage.isBot) {
            try { applyMoodEvent(chatId, 5, `outcome_positive_${signal}`); } catch { /* non-critical */ }
            try {
              const triggerUid = entry.trigger_user_id as number | undefined;
              if (typeof triggerUid === 'number' && triggerUid > 0) {
                applyRelationshipEvent(chatId, triggerUid, 1, `positive:${signal}`);
              }
            } catch { /* non-critical */ }
          }
          continue;
        }

        const msgsAfter = ((entry.msgs_after as number) ?? 0) + 1;
        entry.msgs_after = msgsAfter;

        if (msgsAfter >= OUTCOME_CHECK_WINDOW) {
          const outcome = 'negative';
          const signal = `ignored_${OUTCOME_CHECK_WINDOW}_msgs`;
          toInsert.push([chatId, now(), entry.trigger_text, entry.reply_text, outcome, signal, entry.action]);
          toDelete.push(field);
          resolvedCount++;
          // Stage E/F: only apply mood/relationship effects for human interactions, not bot-to-bot
          if (!currentMessage.isBot) {
            try { applyMoodEvent(chatId, -3, 'outcome_ignored'); } catch { /* non-critical */ }
            try {
              const triggerUid = entry.trigger_user_id as number | undefined;
              if (typeof triggerUid === 'number' && triggerUid > 0) {
                applyRelationshipEvent(chatId, triggerUid, -0.5, 'negative:ignored');
              }
            } catch { /* non-critical */ }
          }
        } else {
          await redis.hset(key, field, JSON.stringify(entry));
          await redis.expire(key, PENDING_TTL);
        }
      }

      // Run all SQLite inserts in a single transaction, capturing rowids in order.
      const insertedRowIds: number[] = [];
      if (toInsert.length > 0) {
        db.transaction(() => {
          for (const args of toInsert) {
            const info = insert.run(...args);
            insertedRowIds.push(Number(info.lastInsertRowid));
          }
        })();
      }

      // #2: fire-and-forget ASI scoring for rows that got a followup.
      if (ASI_ENABLED) {
        for (const c of scoreCandidates) {
          const rowId = insertedRowIds[c.insertIdx];
          if (rowId === undefined) continue;
          if (Math.random() > ASI_SAMPLE_RATE) continue;
          void scoreReplyQuality({
            chatId,
            rowId,
            triggerText: c.triggerText,
            replyText: c.replyText,
            signal: c.signal,
          }).catch((err) => {
            logger.debug({ err, chatId, rowId }, 'ASI scoreReplyQuality failed (non-critical)');
          });
        }
      }

      // Redis deletes are cross-store — best-effort outside the transaction
      for (const field of toDelete) {
        await redis.hdel(key, field);
      }

    if (resolvedCount > 0) {
      incrementOutcomeCount(chatId, resolvedCount);
    }

    return { needsReflection: needsReflection(chatId) };
    } finally {
      await redis.del(lockKey);
    }
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

function incrementOutcomeCount(chatId: number, count: number): void {
  getDb()
    .prepare(
      `INSERT INTO outcome_meta (chat_id, outcomes_since_reflection, total_outcomes)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         outcomes_since_reflection = outcomes_since_reflection + ?,
         total_outcomes = total_outcomes + ?`,
    )
    .run(chatId, count, count, count, count);
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
