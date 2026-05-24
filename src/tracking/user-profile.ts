// ────────────────────────────────────────
// User Profile Tracker
// 每条消息更新用户 tag，积累消息日志
// 每小时 cron 用 Qwen3.6+ 生成用户画像 prompt
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { callWithFallback } from '../ai/fallback.js';
import { logger } from '../shared/logger.js';

const PROFILE_SYNC_BATCH_SIZE = 20;
const MAX_PENDING = 50;      // 积累多少条消息再总结
const MIN_PENDING_TO_SUMMARIZE = 8;
const MAX_PROMPT_CHARS = 600;
const BUFFER_FLUSH_SIZE = 10;   // flush after this many messages per user
const BUFFER_FLUSH_MS = 30_000; // or after 30 seconds

interface BufferEntry { chatId: number; uid: number; username: string; fullName: string; senderTag?: string; texts: string[]; timer: ReturnType<typeof setTimeout> }
const _writeBuffer = new Map<string, BufferEntry>();

function flushBuffer(key: string): void {
  const entry = _writeBuffer.get(key);
  if (!entry) return;
  _writeBuffer.delete(key);
  clearTimeout(entry.timer);
  const db = getDb();
  for (const text of entry.texts) {
    db.prepare(`
      INSERT INTO user_profiles (chat_id, uid, username, full_name, sender_tag, pending_messages, updated_at)
      VALUES (?, ?, ?, ?, ?, json_array(?), unixepoch())
      ON CONFLICT(chat_id, uid) DO UPDATE SET
        username     = excluded.username,
        full_name    = excluded.full_name,
        sender_tag   = COALESCE(excluded.sender_tag, sender_tag),
        pending_messages = CASE
          WHEN json_array_length(pending_messages) >= ${MAX_PENDING}
          THEN json_insert(json_remove(pending_messages, '$[0]'), '$[#]', ?)
          ELSE json_insert(pending_messages, '$[#]', ?)
        END,
        updated_at   = unixepoch()
    `).run(entry.chatId, entry.uid, entry.username, entry.fullName, entry.senderTag ?? null, text, text, text);
  }
}

interface ProfileRow {
  chat_id: number;
  uid: number;
  username: string;
  full_name: string;
  sender_tag: string | null;
  profile_prompt: string | null;
  pending_messages: string;
  updated_at: number;
}

// ── 写入侧（每条消息调用，同步，极快）────────────────────

/** @internal test helper — flush all pending write buffers immediately */
export function _flushAllBuffers(): void {
  for (const key of [..._writeBuffer.keys()]) flushBuffer(key);
}

export function recordUserMessage(
  chatId: number,
  uid: number,
  username: string,
  fullName: string,
  senderTag: string | undefined,
  text: string,
): void {
  if (!text.trim()) return;
  const key = `${chatId}:${uid}`;
  let entry = _writeBuffer.get(key);
  if (!entry) {
    entry = {
      chatId, uid, username, fullName, senderTag,
      texts: [],
      timer: setTimeout(() => flushBuffer(key), BUFFER_FLUSH_MS),
    };
    entry.timer.unref?.();
    _writeBuffer.set(key, entry);
  } else {
    entry.username = username;
    entry.fullName = fullName;
    if (senderTag) entry.senderTag = senderTag;
  }
  entry.texts.push(text);
  if (entry.texts.length >= BUFFER_FLUSH_SIZE) flushBuffer(key);
}

// ── 读取侧（reply 时注入，同步，极快）────────────────────

export function getUserProfilePrompt(chatId: number, uid: number): string | null {
  const row = getDb().prepare(
    'SELECT profile_prompt FROM user_profiles WHERE chat_id = ? AND uid = ?',
  ).get(chatId, uid) as { profile_prompt: string | null } | undefined;
  return row?.profile_prompt ?? null;
}

export function getUserTag(chatId: number, uid: number): string | null {
  const row = getDb().prepare(
    'SELECT sender_tag FROM user_profiles WHERE chat_id = ? AND uid = ?',
  ).get(chatId, uid) as { sender_tag: string | null } | undefined;
  return row?.sender_tag ?? null;
}

// ── 用户偏好 CRUD ──────────────────────────────────────

const MAX_PREFS_PER_USER = 20; // 每人最多保留多少条偏好
const MAX_PREF_VALUE_CHARS = 500;
const TEMP_MUTE_VALUE = 'muted_temp';
const PERSISTENT_MUTE_VALUE = 'muted';

/** Save a pinned preference note for a user in a chat. */
export function saveUserPreference(
  chatId: number,
  uid: number,
  value: string,
  key = 'note',
): void {
  const trimmed = value.trim().slice(0, MAX_PREF_VALUE_CHARS);
  if (!trimmed) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Evict oldest + insert atomically to avoid race-condition overflow
  db.transaction(() => {
    const cnt = (db.prepare(
      'SELECT COUNT(*) as cnt FROM user_preferences WHERE chat_id = ? AND uid = ?',
    ).get(chatId, uid) as { cnt: number }).cnt;

    if (cnt >= MAX_PREFS_PER_USER) {
      db.prepare(`
        DELETE FROM user_preferences WHERE id IN (
          SELECT id FROM user_preferences WHERE chat_id = ? AND uid = ?
          ORDER BY created_at ASC LIMIT 1
        )
      `).run(chatId, uid);
    }

    db.prepare(`
      INSERT INTO user_preferences (chat_id, uid, pref_key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(chatId, uid, key, trimmed, now, now);
  })();
}

/** Get all preference notes for a user in a chat, formatted as a compact string. */
export function getUserPreferences(chatId: number, uid: number): string | null {
  const rows = getDb().prepare(`
    SELECT value FROM user_preferences
    WHERE chat_id = ? AND uid = ? AND pref_key != 'mute'
    ORDER BY created_at DESC
    LIMIT 10
  `).all(chatId, uid) as Array<{ value: string }>;

  if (rows.length === 0) return null;
  return rows.map((r, i) => `${i + 1}. ${r.value}`).join('\n');
}

/** Delete a user preference by fuzzy keyword match. Returns the deleted value or null. */
export function deleteUserPreference(chatId: number, uid: number, keyword: string): string | null {
  const trimmed = keyword.trim();
  if (!trimmed) return null;
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, value FROM user_preferences
    WHERE chat_id = ? AND uid = ? AND pref_key != 'mute'
    ORDER BY created_at DESC
  `).all(chatId, uid) as Array<{ id: number; value: string }>;

  const match = rows.find(r => r.value.includes(trimmed));
  if (!match) return null;
  db.prepare('DELETE FROM user_preferences WHERE id = ?').run(match.id);
  return match.value;
}

/** Check if bot is muted for a specific user in a chat.
 * Returns 0 = not muted, 1 = proactive only, 2 = full silence */
export interface MuteState {
  level: 0 | 1 | 2;
  temporary: boolean;
  expiresAt?: number; // unix timestamp, only set for timed mutes
}

export function getMuteState(chatId: number, uid: number): MuteState {
  const row = getDb().prepare(`
    SELECT mute_level, value, mute_expires_at FROM user_preferences
    WHERE chat_id = ? AND uid = ? AND pref_key = 'mute'
    LIMIT 1
  `).get(chatId, uid) as { mute_level: number; value: string; mute_expires_at: number | null } | undefined;
  if (!row) return { level: 0, temporary: false };

  // Auto-expire timed mutes without a cron
  if (row.mute_expires_at !== null && Math.floor(Date.now() / 1000) >= row.mute_expires_at) {
    getDb().prepare(
      'DELETE FROM user_preferences WHERE chat_id = ? AND uid = ? AND pref_key = ?',
    ).run(chatId, uid, 'mute');
    return { level: 0, temporary: false };
  }

  return {
    level: (row.mute_level + 1) as 1 | 2,
    temporary: row.value === TEMP_MUTE_VALUE,
    ...(row.mute_expires_at !== null ? { expiresAt: row.mute_expires_at } : {}),
  };
}

export function getMuteLevel(chatId: number, uid: number): 0 | 1 | 2 {
  return getMuteState(chatId, uid).level;
}

/** Upsert mute record for a user. level: 1=proactive only, 2=full silence.
 * Pass durationMs to create a timed mute that auto-expires. */
export function muteUser(chatId: number, uid: number, level: 1 | 2, opts?: { temporary?: boolean; durationMs?: number }): void {
  const now = Math.floor(Date.now() / 1000);
  const value = opts?.temporary ? TEMP_MUTE_VALUE : PERSISTENT_MUTE_VALUE;
  const expiresAt = opts?.durationMs ? now + Math.floor(opts.durationMs / 1000) : null;
  getDb().prepare(`
    INSERT INTO user_preferences (chat_id, uid, pref_key, value, mute_level, mute_expires_at, created_at, updated_at)
    VALUES (?, ?, 'mute', ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, uid, pref_key) WHERE pref_key = 'mute'
    DO UPDATE SET value = excluded.value, mute_level = excluded.mute_level,
                  mute_expires_at = excluded.mute_expires_at, updated_at = excluded.updated_at
  `).run(chatId, uid, value, level - 1, expiresAt, now, now);
}

/** Remove mute for a user (called when user explicitly lifts the ban). */
export function unmuteUser(chatId: number, uid: number): void {
  getDb().prepare(
    'DELETE FROM user_preferences WHERE chat_id = ? AND uid = ? AND pref_key = ?',
  ).run(chatId, uid, 'mute');
}

// ── Cron 侧（每小时，异步，用 Qwen3.6+）─────────────────

export async function runUserProfileSync(): Promise<void> {
  const db = getDb();

  const malformedRows = db.prepare(`
    SELECT chat_id, uid FROM user_profiles
    WHERE json_valid(pending_messages) = 0
  `).all() as Array<{ chat_id: number; uid: number }>;

  for (const row of malformedRows) {
    logger.warn({ chatId: row.chat_id, uid: row.uid }, 'User profile: malformed pending_messages, resetting');
    db.prepare('UPDATE user_profiles SET pending_messages = ? WHERE chat_id = ? AND uid = ?')
      .run('[]', row.chat_id, row.uid);
  }

  // 只处理有 pending 消息的用户
  const rows = db.prepare(`
    SELECT * FROM user_profiles
    WHERE CASE
      WHEN json_valid(pending_messages) = 1
      THEN json_type(pending_messages) = 'array' AND json_array_length(pending_messages) > 0
      ELSE 0
    END
    LIMIT ?
  `).all(PROFILE_SYNC_BATCH_SIZE) as ProfileRow[];

  if (rows.length === 0) {
    logger.debug('User profile sync: no pending messages');
    return;
  }

  logger.info({ count: rows.length }, 'User profile sync: starting');

  for (const row of rows) {
    try {
      let pending: string[];
      try {
        pending = JSON.parse(row.pending_messages) as string[];
      } catch {
        logger.warn({ chatId: row.chat_id, uid: row.uid }, 'User profile: corrupt pending_messages, resetting');
        db.prepare('UPDATE user_profiles SET pending_messages = ? WHERE chat_id = ? AND uid = ?')
          .run('[]', row.chat_id, row.uid);
        continue;
      }
      if (pending.length === 0) continue;
      if (pending.length < MIN_PENDING_TO_SUMMARIZE) {
        logger.debug(
          { chatId: row.chat_id, uid: row.uid, pendingCount: pending.length },
          'User profile sync: pending sample count below threshold, keep accumulating',
        );
        continue;
      }

      const existingPrompt = row.profile_prompt ?? '';
      const tagLine = row.sender_tag ? `用户标签(Tag): ${row.sender_tag}\n` : '';
      const messagesBlock = pending.map((m, i) => `${i + 1}. ${m}`).join('\n');

      const systemPrompt = `你是一个群聊用户画像分析师。根据用户最近的发言，更新对该用户的简短画像描述。
画像用于帮助群聊 bot 更好地理解和回应这个用户。
要求：
- 100字以内，中文
- 描述用户的兴趣、说话风格、情绪倾向、常见话题
- 如果有现有画像，在其基础上更新而非完全替换
- 证据不足时只做保守描述，不要脑补背景、身份、关系设定或稳定人格
- 只根据提供的发言内容总结；不要从用户名、昵称或 Tag 过度推断人格
- Tag 只能当作用户自定义标签参考，不能单独作为画像结论依据
- 只输出画像文本，不要有任何前缀或说明`;

      const userContent = `用户: ${row.full_name}(@${row.username})
${tagLine}${existingPrompt ? `现有画像:\n${existingPrompt}\n\n` : ''}最新发言(${pending.length}条):\n${messagesBlock}`;

      const result = await callWithFallback({
        usage: 'summarize',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        maxTokens: 200,
        temperature: 0.3,
      });

      const newPrompt = result.content.trim().slice(0, MAX_PROMPT_CHARS);
      if (!newPrompt) continue;

      db.prepare(`
        UPDATE user_profiles
        SET profile_prompt = ?, pending_messages = '[]', updated_at = unixepoch()
        WHERE chat_id = ? AND uid = ?
      `).run(newPrompt, row.chat_id, row.uid);

      logger.debug({ chatId: row.chat_id, uid: row.uid }, 'User profile updated');
    } catch (err) {
      logger.warn({ err, chatId: row.chat_id, uid: row.uid }, 'User profile sync failed for user');
    }

    // 每个用户之间稍作间隔，避免并发过多
    await new Promise((r) => setTimeout(r, 500));
  }

  logger.info({ count: rows.length }, 'User profile sync: done');
}
