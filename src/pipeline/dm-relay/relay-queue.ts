// ────────────────────────────────────────
// Relay Queue (捎话) 管理
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { getRedis } from '../../db/redis.js';
import { getUserGroups, getGroupMembers } from '../context/manager.js';
import { sendMessage } from '../../bot/sender/telegram.js';
import { recheckDeliverySafety } from './safety.js';
import { logger } from '../../shared/logger.js';

// ── Types ───────────────────────────────

export interface RelayQueueItem {
  id: number;
  sender_id: number;
  target_id: number;
  group_id: number;
  content: string;
  trigger_mode: string;         // 'immediate' | 'on_speak' | 'scheduled'
  scheduled_at: number | null;
  expires_at: number;
  status: string;               // 'pending' | 'delivered' | 'cancelled' | 'expired'
  created_at: number;
  delivered_at: number | null;
}

interface EnqueueParams {
  sender_id: number;
  target_id: number;
  group_id: number;
  content: string;
  trigger_mode: 'immediate' | 'on_speak' | 'scheduled';
  scheduled_at?: number | null;
  expires_at: number;
}

interface CommonGroup {
  chatId: number;
  title: string;
}

// ── Queue Operations ────────────────────

/**
 * Enqueue a pending relay message.
 * Returns the inserted row id, or -1 if rate limited.
 */
export function enqueueRelay(params: EnqueueParams): number {
  const db = getDb();

  // Rate limit: max 10 pending relays per user
  const pendingCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM relay_queue WHERE sender_id = ? AND status = 'pending'"
  ).get(params.sender_id) as { cnt: number };
  if (pendingCount.cnt >= 10) return -1;

  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO relay_queue (sender_id, target_id, group_id, content, trigger_mode, scheduled_at, expires_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const result = stmt.run(
    params.sender_id,
    params.target_id,
    params.group_id,
    params.content,
    params.trigger_mode,
    params.scheduled_at ?? null,
    params.expires_at,
    now,
  );
  return Number(result.lastInsertRowid);
}

/**
 * Get pending on_speak relays for a target in a specific group.
 * Used when the target speaks (on_speak trigger). Excludes scheduled relays —
 * those fire on time via the cron executor, not when the target speaks.
 */
export function getPendingRelayForTarget(target_id: number, group_id: number): RelayQueueItem[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM relay_queue
    WHERE target_id = ? AND group_id = ? AND status = 'pending' AND trigger_mode = 'on_speak'
    ORDER BY created_at ASC
  `);
  return stmt.all(target_id, group_id) as RelayQueueItem[];
}

/**
 * Get all scheduled relays whose fire time has passed and are still pending.
 * Used by the scheduled-relay cron executor.
 */
export function getDueScheduledRelays(now: number): RelayQueueItem[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM relay_queue
    WHERE status = 'pending' AND trigger_mode = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
    ORDER BY scheduled_at ASC
  `);
  return stmt.all(now) as RelayQueueItem[];
}

/**
 * List all pending relays from a sender.
 * Used for /relay list command.
 */
export function getPendingRelayForSender(sender_id: number): RelayQueueItem[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM relay_queue
    WHERE sender_id = ? AND status = 'pending'
    ORDER BY created_at ASC
  `);
  return stmt.all(sender_id) as RelayQueueItem[];
}

/**
 * Get a single relay by id.
 */
export function getRelayById(id: number): RelayQueueItem | undefined {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM relay_queue WHERE id = ?');
  return stmt.get(id) as RelayQueueItem | undefined;
}

/**
 * Mark a relay as delivered. Uses conditional UPDATE to prevent duplicate delivery.
 * Returns true if this call actually delivered (was still pending).
 */
export function deliverRelay(id: number): boolean {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    UPDATE relay_queue SET status = 'delivered', delivered_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const result = stmt.run(now, id);
  return result.changes > 0;
}

/** Force-set a relay's status by id (used to drop relays that fail delivery-time safety). */
export function setRelayStatus(id: number, status: 'cancelled' | 'expired' | 'delivered'): void {
  getDb().prepare('UPDATE relay_queue SET status = ? WHERE id = ?').run(status, id);
}

/**
 * Cancel a relay. Only succeeds if sender_id matches and status is pending.
 * Returns true if a row was updated (cancelled), false otherwise.
 */
export function cancelRelay(id: number, sender_id: number): boolean {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE relay_queue SET status = 'cancelled' WHERE id = ? AND sender_id = ? AND status = 'pending'
  `);
  const result = stmt.run(id, sender_id);
  return result.changes > 0;
}

/**
 * Expire all relays whose expires_at has passed and status is still pending.
 * Returns the count of expired relays.
 */
export function expireOldRelays(): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    UPDATE relay_queue SET status = 'expired' WHERE expires_at < ? AND status = 'pending'
  `);
  const result = stmt.run(now);
  return result.changes;
}

/**
 * Cron executor: deliver scheduled relays whose fire time has passed.
 * Returns the number delivered.
 */
export async function executeDueScheduledRelays(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const due = getDueScheduledRelays(now);
  if (due.length === 0) return 0;

  let delivered = 0;
  for (const relay of due) {
    try {
      // Atomic claim — only proceed if still pending (prevents double-send)
      if (!deliverRelay(relay.id)) continue;

      // Re-check safety: sender may have been banned or left the group during the hold
      if (!(await recheckDeliverySafety(relay.sender_id, relay.group_id))) {
        setRelayStatus(relay.id, 'cancelled');
        logger.info({ relayId: relay.id, senderUid: relay.sender_id }, 'Scheduled relay dropped: sender no longer eligible');
        continue;
      }

      // Resolve target display name for a friendly mention
      let mention = `用户`;
      try {
        const members = await getGroupMembers(relay.group_id);
        const m = members.find((x) => x.uid === relay.target_id);
        if (m) mention = m.username ? `@${m.username}` : m.fullName;
      } catch { /* fall back to generic */ }

      await sendMessage(relay.group_id, `${mention} 有人之前让本喵到点转告你：${relay.content}`);
      // Notify sender
      try {
        await sendMessage(relay.sender_id, `✅ 你预约的捎话 #${relay.id} 已按时送达喵~`);
      } catch { /* sender may have blocked bot */ }
      delivered++;
      logger.info({ relayId: relay.id, targetUid: relay.target_id, groupId: relay.group_id }, 'Scheduled relay delivered');
    } catch (err) {
      logger.error({ err, relayId: relay.id }, 'Failed to deliver scheduled relay');
    }
  }
  return delivered;
}

/**
 * Find groups where both users are members.
 * Uses Redis member hashes and getUserGroups reverse index.
 * Returns array of {chatId, title}.
 */
export async function getCommonGroups(userId_a: number, userId_b: number): Promise<CommonGroup[]> {
  const redis = getRedis();
  const groupsA = await getUserGroups(userId_a);
  const common: CommonGroup[] = [];

  for (const chatId of groupsA) {
    try {
      const memberKey = `xxb:members:${chatId}`;
      const isMember = await redis.hexists(memberKey, String(userId_b));
      if (isMember) {
        // Try to get group title from Redis cache
        let title: string;
        try {
          const cached = await redis.get(`xxb:group:title:${chatId}`);
          title = cached ?? String(chatId);
        } catch {
          title = String(chatId);
        }
        common.push({ chatId, title });
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'getCommonGroups: failed checking group');
    }
  }

  return common;
}
