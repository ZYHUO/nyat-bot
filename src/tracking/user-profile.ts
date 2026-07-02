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

// Structured profile sections (#3) — canonical order also drives legacy-prompt derivation.
const PROFILE_SECTION_NAMES = [
  'identity',
  'relationships',
  'stable_facts',
  'interaction_prefs',
  'topics',
  'recent',
  'uncertain',
  'maintenance',
] as const;
type ProfileSectionName = (typeof PROFILE_SECTION_NAMES)[number];

// buildProfileInjection caps // tunable
const INJECTION_TOTAL_CHAR_CAP = 600;   // ~600 char total budget for the composed block
const INJECTION_RECENT_BULLET_CAP = 2;  // 'recent' section is volatile — keep it short
const INJECTION_DEFAULT_BULLET_CAP = 4; // other sections
const INJECTION_BULLET_CHARS = 80;      // per-bullet trim
// Sections that feed the legacy single profile_prompt fallback (joined for back-compat).
const LEGACY_PROMPT_SECTIONS: ProfileSectionName[] = [
  'identity',
  'stable_facts',
  'interaction_prefs',
  'recent',
];

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

// ── Structured profile sections (#3) ───────────────────

export interface ProfileSection {
  section_name: string;
  bullets: string[];
}

/** Read all non-empty structured profile sections for a user, in canonical order. */
export function getProfileSections(chatId: number, uid: number): ProfileSection[] {
  const rows = getDb().prepare(
    'SELECT section_name, bullets FROM user_profile_sections WHERE chat_id = ? AND uid = ?',
  ).all(chatId, uid) as Array<{ section_name: string; bullets: string }>;

  const byName = new Map<string, string[]>();
  for (const r of rows) {
    let bullets: string[];
    try {
      const parsed = JSON.parse(r.bullets) as unknown;
      bullets = Array.isArray(parsed)
        ? parsed.filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
        : [];
    } catch {
      bullets = [];
    }
    if (bullets.length > 0) byName.set(r.section_name, bullets);
  }

  // Emit in canonical order, then any unknown sections (defensive) at the end.
  const out: ProfileSection[] = [];
  for (const name of PROFILE_SECTION_NAMES) {
    const bullets = byName.get(name);
    if (bullets) {
      out.push({ section_name: name, bullets });
      byName.delete(name);
    }
  }
  for (const [section_name, bullets] of byName) out.push({ section_name, bullets });
  return out;
}

const SECTION_LABELS: Record<string, string> = {
  identity: '身份',
  relationships: '关系',
  stable_facts: '稳定事实',
  interaction_prefs: '互动偏好',
  topics: '常聊话题',
  recent: '近况',
  uncertain: '待确认',
  maintenance: '维护',
};

/**
 * Compose a compact, char-capped injection block from non-empty sections.
 * 'recent' is capped to {@link INJECTION_RECENT_BULLET_CAP} bullets; 'uncertain'
 * is dropped unless it is the only section with content. Total ~{@link INJECTION_TOTAL_CHAR_CAP} chars.
 * Returns null when there is nothing to inject.
 */
export function buildProfileInjection(chatId: number, uid: number): string | null {
  const sections = getProfileSections(chatId, uid);
  if (sections.length === 0) return null;

  const hasNonUncertain = sections.some((s) => s.section_name !== 'uncertain');
  const lines: string[] = [];
  let total = 0;

  for (const sec of sections) {
    // Drop 'uncertain' unless every other section is empty.
    if (sec.section_name === 'uncertain' && hasNonUncertain) continue;

    const cap = sec.section_name === 'recent'
      ? INJECTION_RECENT_BULLET_CAP
      : INJECTION_DEFAULT_BULLET_CAP;
    const bullets = sec.bullets
      .slice(0, cap)
      .map((b) => b.trim().slice(0, INJECTION_BULLET_CHARS))
      .filter(Boolean);
    if (bullets.length === 0) continue;

    const label = SECTION_LABELS[sec.section_name] ?? sec.section_name;
    const line = `${label}: ${bullets.join('；')}`;
    if (total + line.length + 1 > INJECTION_TOTAL_CHAR_CAP) break;
    lines.push(line);
    total += line.length + 1;
  }

  if (lines.length === 0) return null;
  return lines.join('\n');
}

export function getUserTag(chatId: number, uid: number): string | null {
  const row = getDb().prepare(
    'SELECT sender_tag FROM user_profiles WHERE chat_id = ? AND uid = ?',
  ).get(chatId, uid) as { sender_tag: string | null } | undefined;
  return row?.sender_tag ?? null;
}

/**
 * 跨群外号(功能 B):sender_tag 是 TG 全局身份,不因群而异。DM 场景取该 uid
 * 在所有群里最新的非空 sender_tag,避免叫错某个群的外号。fail-soft 返回 null。
 */
export function getAggregatedUserTag(uid: number): string | null {
  try {
    const row = getDb().prepare(
      `SELECT sender_tag FROM user_profiles
        WHERE uid = ? AND sender_tag IS NOT NULL AND sender_tag != ''
        ORDER BY updated_at DESC LIMIT 1`,
    ).get(uid) as { sender_tag: string | null } | undefined;
    return row?.sender_tag ?? null;
  } catch {
    return null;
  }
}

// ── bot 对用户本人的称呼(bot_tag)──────────────────────────
// 优先级:主人(见 dm-proactive) > bot_tag > 群里外号(sender_tag)。
// per-(chat,user);DM 行(chat_id=uid)作跨群默认,群行可覆盖。
// 读取:当前 chat 的 bot_tag → 回退 DM 默认行。fail-soft 返回 null。

/**
 * 取 bot 对 (chatId,uid) 的称呼。先看当前 chat 的 bot_tag,没有则回退到
 * DM 默认行 (uid,uid) 的 bot_tag(私聊里"叫我X"设的就是这行,跨群生效)。
 */
export function getBotTagForAddressing(chatId: number, uid: number): string | null {
  try {
    const db = getDb();
    const cur = db.prepare(
      'SELECT bot_tag FROM user_profiles WHERE chat_id = ? AND uid = ?',
    ).get(chatId, uid) as { bot_tag: string | null } | undefined;
    if (cur?.bot_tag && cur.bot_tag.trim()) return cur.bot_tag.trim();
    if (chatId !== uid) {
      const dm = db.prepare(
        'SELECT bot_tag FROM user_profiles WHERE chat_id = ? AND uid = ?',
      ).get(uid, uid) as { bot_tag: string | null } | undefined;
      if (dm?.bot_tag && dm.bot_tag.trim()) return dm.bot_tag.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/** 设置 bot 对 (chatId,uid) 的称呼(纠正/起名)。tag 去空白截 32 字。 */
export function setBotTag(chatId: number, uid: number, tag: string): void {
  const clean = tag.trim().slice(0, 32);
  if (!clean) return;
  const db = getDb();
  db.prepare(`
    INSERT INTO user_profiles (chat_id, uid, bot_tag, pending_messages, updated_at)
    VALUES (?, ?, ?, '[]', unixepoch())
    ON CONFLICT(chat_id, uid) DO UPDATE SET bot_tag = excluded.bot_tag, updated_at = unixepoch()
  `).run(chatId, uid, clean);
}

/** 清掉 bot 对 (chatId,uid) 的称呼(回退到群里外号)。 */
export function clearBotTag(chatId: number, uid: number): void {
  const db = getDb();
  db.prepare('UPDATE user_profiles SET bot_tag = NULL WHERE chat_id = ? AND uid = ?')
    .run(chatId, uid);
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

// ── Default group (DM relay) ──────────────────────────
// Stored in user_preferences under chat_id=0 sentinel, pref_key='default_group'.

const DEFAULT_GROUP_PREF_KEY = 'default_group';
const DEFAULT_GROUP_SENTINEL_CHAT = 0;

/** Set the user's preferred default group for DM relay features. */
export function setDefaultGroup(uid: number, groupChatId: number): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO user_preferences (chat_id, uid, pref_key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, uid, pref_key) WHERE pref_key = 'default_group'
    DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(DEFAULT_GROUP_SENTINEL_CHAT, uid, DEFAULT_GROUP_PREF_KEY, String(groupChatId), now, now);
}

/** Get the user's preferred default group chat id, or null if unset. */
export function getDefaultGroup(uid: number): number | null {
  const row = getDb().prepare(
    "SELECT value FROM user_preferences WHERE chat_id = ? AND uid = ? AND pref_key = 'default_group' LIMIT 1",
  ).get(DEFAULT_GROUP_SENTINEL_CHAT, uid) as { value: string } | undefined;
  if (!row) return null;
  const n = parseInt(row.value, 10);
  return isNaN(n) ? null : n;
}

/** Clear the user's default group. */
export function clearDefaultGroup(uid: number): void {
  getDb().prepare(
    "DELETE FROM user_preferences WHERE chat_id = ? AND uid = ? AND pref_key = 'default_group'",
  ).run(DEFAULT_GROUP_SENTINEL_CHAT, uid);
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

type ParsedSections = Record<ProfileSectionName, string[]>;

/**
 * Parse the LLM's structured-section JSON output into a normalized
 * {section -> string[]} map. Tolerates code fences and surrounding prose.
 * Returns null when no JSON object can be recovered.
 */
function parseProfileSections(raw: string): ParsedSections | null {
  const text = raw.trim();
  if (!text) return null;

  // Strip ```json ... ``` fences if present, else grab the first {...} blob.
  let jsonStr = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    jsonStr = fenced[1].trim();
  } else if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    jsonStr = text.slice(start, end + 1);
  }

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const out = {} as ParsedSections;
  for (const name of PROFILE_SECTION_NAMES) {
    const v = obj[name];
    const arr = Array.isArray(v)
      ? v
          .filter((b): b is string => typeof b === 'string')
          .map((b) => b.trim())
          .filter(Boolean)
      : [];
    out[name] = arr;
  }
  return out;
}

/** Join the key sections into the legacy single-line prompt for back-compat. */
function deriveLegacyPrompt(sections: ParsedSections): string {
  const parts: string[] = [];
  for (const name of LEGACY_PROMPT_SECTIONS) {
    const bullets = sections[name];
    if (bullets.length > 0) parts.push(bullets.join('；'));
  }
  return parts.join('；').trim();
}

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
      const existingSections = getProfileSections(row.chat_id, row.uid);
      const tagLine = row.sender_tag ? `用户标签(Tag): ${row.sender_tag}\n` : '';
      const messagesBlock = pending.map((m, i) => `${i + 1}. ${m}`).join('\n');
      const existingBlock = existingSections.length > 0
        ? `现有画像(分区):\n${existingSections.map((s) => `- ${s.section_name}: ${s.bullets.join('；')}`).join('\n')}\n\n`
        : (existingPrompt ? `现有画像:\n${existingPrompt}\n\n` : '');

      const systemPrompt = `你是一个群聊用户画像分析师。根据用户最近的发言，更新对该用户的结构化画像。
画像用于帮助群聊 bot 更好地理解和回应这个用户。
输出必须是一个 JSON 对象，包含以下 8 个键，每个键的值都是「短句字符串数组」（每条不超过 30 字，中文）：
- identity: 用户是谁、可推断的身份/角色（仅凭发言可确认的）
- relationships: 与群友或 bot 的关系线索
- stable_facts: 稳定不变的事实（长期兴趣、职业、所在地等）
- interaction_prefs: 互动与说话风格偏好（语气、节奏、喜欢/讨厌的话题）
- topics: 经常聊的话题/领域标签（如 VPS/机场/二次元/编程/显卡，每个 2-6 字，最多 5 个）
- recent: 最近的近况、情绪或正在聊的事（易变，最多 2 条）
- uncertain: 证据不足、仅作猜测、需进一步确认的点
- maintenance: 与该用户互动时 bot 应注意的事项
要求：
- 如果某个分区没有可靠内容，给出空数组 []
- 如果有现有画像，在其基础上增量更新而非完全推翻
- 证据不足时只做保守描述，不要脑补背景、身份、关系设定或稳定人格；不确定的放进 uncertain
- 只根据提供的发言内容总结；不要从用户名、昵称或 Tag 过度推断人格
- Tag 只能当作用户自定义标签参考，不能单独作为画像结论依据
- 只输出 JSON 对象，不要有任何前缀、解释或代码块标记`;

      const userContent = `用户: ${row.full_name}(@${row.username})
${tagLine}${existingBlock}最新发言(${pending.length}条):\n${messagesBlock}`;

      const result = await callWithFallback({
        usage: 'summarize',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        maxTokens: 500,
        temperature: 0.3,
      });

      const sections = parseProfileSections(result.content);
      if (!sections) {
        logger.warn({ chatId: row.chat_id, uid: row.uid }, 'User profile: unparseable section JSON, skipping');
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      db.transaction(() => {
        // Upsert one row per non-empty section.
        for (const name of PROFILE_SECTION_NAMES) {
          const bullets = sections[name];
          if (bullets.length === 0) continue;
          db.prepare(`
            INSERT INTO user_profile_sections (chat_id, uid, section_name, bullets, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(chat_id, uid, section_name) DO UPDATE SET
              bullets = excluded.bullets,
              updated_at = excluded.updated_at
          `).run(row.chat_id, row.uid, name, JSON.stringify(bullets), now);
        }

        // Keep legacy single profile_prompt for back-compat (join key sections).
        const legacyPrompt = deriveLegacyPrompt(sections).slice(0, MAX_PROMPT_CHARS);
        db.prepare(`
          UPDATE user_profiles
          SET profile_prompt = ?, pending_messages = '[]', updated_at = unixepoch()
          WHERE chat_id = ? AND uid = ?
        `).run(legacyPrompt || existingPrompt || null, row.chat_id, row.uid);
      })();

      logger.debug({ chatId: row.chat_id, uid: row.uid }, 'User profile updated');
    } catch (err) {
      logger.warn({ err, chatId: row.chat_id, uid: row.uid }, 'User profile sync failed for user');
    }

    // 每个用户之间稍作间隔，避免并发过多
    await new Promise((r) => setTimeout(r, 500));
  }

  logger.info({ count: rows.length }, 'User profile sync: done');
}
