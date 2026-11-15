import { createHash } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { applyMoodEvent } from './mood.js';
import { applyRelationshipEvent } from './relationship.js';
import { NEGATIVE_PATTERNS, REPAIR_PATTERNS, POSITIVE_PATTERNS, countMatches } from './behavior-patterns.js';
import { persistReplyOutcomeScores, ASI_ENABLED, ASI_SAMPLE_RATE } from './asi-scoring.js';
import { recordCognitiveRouteFeedback } from '../agent/cognitive-route-observations.js';
import { actOutcomeFromSignal, closeSelfActOutcome } from './self-history.js';

export interface FeedbackMessage {
  messageId?: number;
  uid?: number;
  isBot?: boolean;
  replyTo?: { messageId: number };
  textContent?: string;
}

interface PendingReply {
  bot_message_id: number;
  trigger_message_id: number;
  trigger_user_id: number;
  trigger_text: string;
  reply_text: string;
  action: string;
  timestamp: number;
  chat_id: number;
  scope_key: string;
  msgs_after: number;
  route_observation_id?: number;
}
type Attribution = 'reply_to_bot_message' | 'explicit_mention_single_candidate' | 'no_followup_observed';
type EffectKind = 'self_history' | 'route' | 'asi' | 'echo';
interface EffectPayload {
  botMessageId: number;
  triggerMessageId: number;
  rowId: number;
  triggerText: string;
  replyText: string;
  signal: string;
  outcome: 'positive' | 'negative';
  routeId?: number;
  echo: number;
}

const COMPARE_PENDING = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
if ARGV[3] == '' then return redis.call('HDEL', KEYS[1], ARGV[1]) end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1`;

/** The host's configured account and durable identity mapping supply authority. */
export function feedbackScopeKey(chatId: number): string | null {
  const scope = resolveConversationScope(chatId);
  return scope?.accountId ? JSON.stringify([scope.platform, scope.accountId, scope.chatId]) : null;
}

function parsePending(raw: string, field: string, chatId: number, scopeKey: string): PendingReply | null {
  try {
    const p = JSON.parse(raw) as PendingReply;
    if (p?.scope_key !== scopeKey || p.chat_id !== chatId || String(p.bot_message_id) !== field
      || !Number.isSafeInteger(p.bot_message_id) || p.bot_message_id <= 0
      || !Number.isSafeInteger(p.trigger_user_id) || p.trigger_user_id < 0
      || !Number.isSafeInteger(p.trigger_message_id) || p.trigger_message_id < 0
      || !Number.isSafeInteger(p.timestamp) || p.timestamp <= 0
      || !['trigger_text', 'reply_text', 'action'].every(k => typeof (p as unknown as Record<string, unknown>)[k] === 'string')) return null;
    return p;
  } catch { return null; }
}

function enqueueEffect(eventId: string, chatId: number, kind: EffectKind, payload: EffectPayload, at: number): void {
  getDb().prepare(`INSERT OR IGNORE INTO reply_feedback_effects
    (event_id, kind, chat_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(eventId, kind, chatId, JSON.stringify(payload), at);
}

/** SQLite owns settlement and observation dedup; Redis is an expiring pending index. */
export async function resolveReplyFeedback(chatId: number, message: FeedbackMessage, botUsername: string): Promise<void> {
  const scopeKey = feedbackScopeKey(chatId);
  if (!scopeKey || !Number.isSafeInteger(message.messageId) || (message.messageId ?? 0) <= 0
    || !Number.isSafeInteger(message.uid) || (message.uid ?? 0) <= 0) return;
  const redis = getRedis();
  const key = `xxb:reply_outcome:pending:${chatId}`;
  // No expiring Redis lock: overlapping ingress must not discard a second
  // human's feedback. SQLite's immediate transaction serializes settlement.
  const pending = Object.entries(await redis.hgetall(key)).flatMap(([field, raw]) => {
    const entry = parsePending(raw, field, chatId, scopeKey);
    return entry ? [{ field, raw, entry }] : [];
  });
  const target = message.replyTo?.messageId;
  // A quote to somebody else is never reinterpreted as feedback on our reply.
  const direct = target === undefined ? undefined : pending.find(p => p.entry.bot_message_id === target);
  const username = botUsername.replace(/^@/, '');
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentioned = target === undefined && username !== ''
    && new RegExp(`(^|[^a-zA-Z0-9_])@${escaped}(?![a-zA-Z0-9_])`, 'i').test(message.textContent ?? '');
  const candidate = direct ?? (mentioned && pending.length === 1 ? pending[0] : undefined);
  const currentText = message.textContent ?? '';
  const repair = countMatches(currentText, REPAIR_PATTERNS) > 0;
  const negative = countMatches(currentText, NEGATIVE_PATTERNS) > 0;
  const positive = countMatches(currentText, POSITIVE_PATTERNS) > 0;
  const now = Math.floor(Date.now() / 1000);
  const changes: Array<{ field: string; raw: string; replacement: string }> = [];
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM reply_feedback_observations WHERE observed_at < ?').run(now - 86400);
    for (const item of pending) {
      const entry = item.entry;
      const eventId = createHash('sha256').update(JSON.stringify(['reply-feedback-v1', scopeKey, entry.bot_message_id])).digest('hex');
      if (db.prepare('SELECT 1 FROM reply_feedback_events WHERE event_id = ?').get(eventId)) {
        changes.push({ ...item, replacement: '' });
        continue;
      }
      if (message.isBot && item !== candidate) continue;
      db.prepare(`INSERT OR IGNORE INTO reply_feedback_observations
        (scope_key, bot_message_id, source_message_id, observed_at) VALUES (?, ?, ?, ?)`)
        .run(scopeKey, entry.bot_message_id, message.messageId!, now);
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM reply_feedback_observations
        WHERE scope_key = ? AND bot_message_id = ?`).get(scopeKey, entry.bot_message_id) as { n: number }).n;
      const age = Math.max(0, now - entry.timestamp);
      const attributed = item === candidate;
      if (!attributed && count < 5 && age < 600) {
        changes.push({ ...item, replacement: JSON.stringify({ ...entry, msgs_after: count }) });
        continue;
      }
      const attribution: Attribution = attributed
        ? direct ? 'reply_to_bot_message' : 'explicit_mention_single_candidate'
        : 'no_followup_observed';
      const signal = attributed
        ? repair ? 'repair_loop' : negative ? 'explicit_negative' : positive ? 'explicit_positive'
          : direct ? 'user_replied' : 'user_mentioned_bot'
        : count >= 5 ? 'ignored_5_msgs' : `ignored_${age}s_no_reply`;
      const outcome = !attributed || repair || negative ? 'negative' : 'positive';
      const row = db.prepare(`INSERT INTO reply_outcomes
        (chat_id, ts, trigger_text, reply_text, outcome, signal, action) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(chatId, now, entry.trigger_text, entry.reply_text, outcome, signal, entry.action);
      const rowId = Number(row.lastInsertRowid);
      db.prepare(`INSERT INTO reply_feedback_events
        (event_id, scope_key, chat_id, bot_message_id, source_message_id, actor_uid, actor_is_bot,
         trigger_uid, attribution, confidence, outcome, signal, outcome_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(eventId, scopeKey, chatId, entry.bot_message_id, message.messageId!, attributed ? message.uid! : 0,
          message.isBot ? 1 : 0, entry.trigger_user_id, attribution, direct && attributed ? 1 : attributed ? 0.7 : 0,
          outcome, signal, rowId, now);
      if (attributed && !message.isBot) {
        applyMoodEvent(chatId, outcome === 'positive' ? 5 : -8, `outcome_${signal}`, { strict: true });
        // A correction describes answer quality, not hostility or debt owed by
        // the original asker. Positive engagement belongs to its actual actor.
        if (outcome === 'positive') applyRelationshipEvent(chatId, message.uid!, 1, `positive:${signal}`, { strict: true });
      }
      db.prepare(`INSERT INTO outcome_meta (chat_id, outcomes_since_reflection, total_outcomes)
        VALUES (?, 1, 1) ON CONFLICT(chat_id) DO UPDATE SET
        outcomes_since_reflection = outcomes_since_reflection + 1, total_outcomes = total_outcomes + 1`).run(chatId);
      db.prepare('DELETE FROM reply_feedback_observations WHERE scope_key = ? AND bot_message_id = ?')
        .run(scopeKey, entry.bot_message_id);
      const payload: EffectPayload = {
        botMessageId: entry.bot_message_id, triggerMessageId: entry.trigger_message_id,
        rowId, triggerText: entry.trigger_text, replyText: entry.reply_text,
        outcome, signal, routeId: entry.route_observation_id,
        echo: !attributed ? 0 : outcome === 'negative' ? -0.5 : signal === 'user_replied' ? 1 : signal === 'explicit_positive' ? 0.5 : 0.25,
      };
      enqueueEffect(eventId, chatId, 'self_history', payload, now);
      if (attributed && Number.isSafeInteger(payload.routeId) && (payload.routeId ?? 0) > 0) enqueueEffect(eventId, chatId, 'route', payload, now);
      if (attributed && ASI_ENABLED && Math.random() < (env().ASI_SAMPLE_RATE ?? ASI_SAMPLE_RATE)) enqueueEffect(eventId, chatId, 'asi', payload, now);
      changes.push({ ...item, replacement: '' });
    }
  }).immediate();
  // Optional work is queued only after the entire primary transaction commits.
  void drainReplyFeedbackEffects(chatId).catch(() => {});
  for (const change of changes) await redis.eval(COMPARE_PENDING, 1, key, change.field, change.raw, change.replacement);
}

const draining = new Set<number>();
/** Pending work is retryable before its claim. Claimed/failed work is retained for
 * review: legacy consumers may have partly applied effects, so no blind replay. */
export async function drainReplyFeedbackEffects(chatId: number): Promise<void> {
  if (draining.has(chatId)) return;
  draining.add(chatId);
  try {
    const scopeKey = feedbackScopeKey(chatId);
    if (!scopeKey) return;
    const db = getDb();
    for (let remaining = 32; remaining > 0; remaining--) {
      const row = db.prepare(`SELECT f.event_id, f.kind, f.payload_json FROM reply_feedback_effects f
        JOIN reply_feedback_events e ON e.event_id = f.event_id
        WHERE f.chat_id = ? AND f.state = 'pending' AND e.scope_key = ?
        ORDER BY CASE f.kind WHEN 'self_history' THEN 0 WHEN 'route' THEN 1 WHEN 'echo' THEN 2 ELSE 3 END,
          f.created_at, f.event_id LIMIT 1`).get(chatId, scopeKey) as
        { event_id: string; kind: EffectKind; payload_json: string } | undefined;
      if (!row) break;
      const claim = db.prepare(`UPDATE reply_feedback_effects SET state = 'claimed', claimed_at = ?
        WHERE event_id = ? AND kind = ? AND state = 'pending'`).run(Date.now(), row.event_id, row.kind);
      if (claim.changes !== 1) continue;
      try {
        const p = JSON.parse(row.payload_json) as EffectPayload;
        if (row.kind === 'self_history') {
          const expected = actOutcomeFromSignal(p.signal);
          const changed = closeSelfActOutcome({ chatId, botMessageId: p.botMessageId, outcome: expected });
          if (env().SELF_HISTORY_ENABLED && !changed) {
            const stored = db.prepare('SELECT outcome FROM self_replies WHERE chat_id = ? AND bot_message_id = ?')
              .all(chatId, p.botMessageId) as Array<{ outcome: string }>;
            if (stored.length === 0 || stored.some(item => item.outcome !== expected)) throw new Error('self_history_unconfirmed');
          }
          if (changed) {
            enqueueEffect(row.event_id, chatId, 'echo', p, Math.floor(Date.now() / 1000));
          }
        } else if (row.kind === 'route') {
          const target = db.prepare('SELECT chat_id, trigger_message_id FROM cognitive_route_observations WHERE id = ?')
            .get(p.routeId!) as { chat_id: number; trigger_message_id: number } | undefined;
          if (target?.chat_id !== chatId || target.trigger_message_id !== p.triggerMessageId) throw new Error('route_source_mismatch');
          if (!recordCognitiveRouteFeedback({ id: p.routeId!, outcome: p.outcome, signal: p.signal })) {
            const stored = db.prepare('SELECT feedback_outcome FROM cognitive_route_observations WHERE id = ?')
              .get(p.routeId!) as { feedback_outcome: string | null } | undefined;
            if (stored?.feedback_outcome !== p.outcome) throw new Error('route_feedback_unconfirmed');
          }
        } else if (row.kind === 'asi') {
          await persistReplyOutcomeScores({ chatId, rowId: p.rowId, triggerText: p.triggerText, replyText: p.replyText, signal: p.signal });
        } else {
          const { settleEcho } = await import('../agent/echo.js');
          await settleEcho(chatId, p.echo);
        }
        db.prepare(`UPDATE reply_feedback_effects SET state = 'completed', completed_at = ?, payload_json = '{}'
          WHERE event_id = ? AND kind = ? AND state = 'claimed'`).run(Date.now(), row.event_id, row.kind);
      } catch {
        db.prepare(`UPDATE reply_feedback_effects SET state = 'failed', last_error = 'consumer_unconfirmed'
          WHERE event_id = ? AND kind = ? AND state = 'claimed'`).run(row.event_id, row.kind);
        logger.warn({ chatId, kind: row.kind, eventId: row.event_id }, 'Optional feedback effect unconfirmed; retained for review');
      }
    }
  } finally { draining.delete(chatId); }
}
