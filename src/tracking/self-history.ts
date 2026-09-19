// ────────────────────────────────────────
// Stage F: Self-narrative — bot remembers what it said
// ────────────────────────────────────────
//
// 两个互补的读法，同一个表：
//
// 1. 对某个人说过什么（原用途）→ 生成下一条前注入，避免前后矛盾。
// 2. 我最近在这个群的整体表现（2026-09 新增）→ 让模型看见"我说了 4 次，
//    2 次有人接、1 次没人理、1 次被纠正"。它自己判断要不要收着点。
//
// 第 2 条针对一个真实事故（src/pipeline/heart/heart.ts:66-76）：
//   "bot 说一句 → 后续消息命中跟进规则 → 自动回 → 永远'刚说过话'
//    → 69 次回复里只有 12 次经过心流"
// 根因是模型看不见自己刚做过什么。给它事实，它自己会收敛——不需要新规则。
//
// 注意与 outcome.ts 的分工：那边产出【抽象规则】（3-5 条，日更，门槛 15 条）；
// 这里产出【具体行为史】（即时，带结果）。两者互补，谁都不替代谁。
//
// 数据：self_replies(id, chat_id, trigger_uid, trigger_msg_id, reply_text, ts,
//                    bot_message_id, outcome, outcome_at)
//   - 每发一条 reply 就 INSERT 一条
//   - 查询：(chat_id, uid) 过滤 + ts 倒序 limit N，且 ts 在 windowDays 内
//   - cleanup: pruneOldSelfReplies(60) 删 60 天以上的
//
// 默认 SELF_HISTORY_ENABLED=false 时所有公开函数 no-op，保证零开销。

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

export interface SelfReply {
  ts: number;
  text: string;
}

/** How a sent message landed, as observed by the host (never self-reported). */
export type ActOutcome =
  | 'ignored'    // nobody engaged within the observation window
  | 'replied'    // someone replied to it
  | 'reacted'    // someone reacted / explicitly approved
  | 'mentioned'  // someone mentioned the bot afterwards
  | 'corrected'  // a human pushed back on it
  | 'unknown';   // window not closed yet

/** A sent message plus what happened to it. */
export interface SelfAct {
  ts: number;
  botMessageId: number;
  text: string;
  outcome: ActOutcome;
}

/** Bounded view of the bot's own recent behaviour in one chat. */
export interface SelfActSummary {
  chatId: number;
  windowSec: number;
  total: number;
  byOutcome: Record<ActOutcome, number>;
  recent: SelfAct[];
  sinceLastSpokeSec?: number;
  /**
   * How much of the window's conversation was the bot's.
   *
   * A raw count ("you said 14 things") gives no sense of scale — 14 is a lot in
   * a quiet group and nothing in a busy one. A person's sense of talking too
   * much is relative: "am I dominating this room?" This is that ratio, computed
   * from data already stored, so the model can judge for itself instead of
   * having a host-side gate stop it after the fact.
   */
  shareOfConversation?: number;
}

/** Preview length; long previews push the rendered block past its budget. */
const ACT_PREVIEW_CHARS = 48;
/** Cap on records rendered into the prompt. */
const ACT_MAX_RECENT = 6;

/** Map an existing reply-outcome signal onto an act outcome. */
export function actOutcomeFromSignal(signal: string): ActOutcome {
  switch (signal) {
    case 'user_replied':
      return 'replied';
    case 'user_mentioned_bot':
      return 'mentioned';
    case 'explicit_positive':
      return 'reacted';
    case 'explicit_negative':
    case 'repair_loop':
      return 'corrected';
    case 'ignored_5_msgs':
      return 'ignored';
    // 时间感知的 ignored：等太久（≥OUTCOME_MAX_WAIT_SEC）且期间确有人说过话。
    // 形如 ignored_660s_no_reply；前缀匹配而不是逐个秒数枚举。
    default:
      return signal.startsWith('ignored_') ? 'ignored' : 'unknown';
  }
}

/** Strip newlines/control chars so one record cannot forge extra prompt lines. */
function inline(value: string, max: number): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * Attach an observed outcome to the specific message the bot sent.
 *
 * Matching on `bot_message_id` keeps the pairing exact; picking "most recent
 * unknown" would mis-attribute when several bubbles went out in one turn.
 * Reuses the signal outcome.ts already computed rather than observing twice.
 */
export function closeSelfActOutcome(input: {
  chatId: number;
  botMessageId: number;
  outcome: ActOutcome;
  at?: number;
}): boolean {
  if (!env().SELF_HISTORY_ENABLED) return false;
  if (input.outcome === 'unknown') return false;
  if (!Number.isSafeInteger(input.chatId) || input.chatId === 0) return false;
  if (!Number.isSafeInteger(input.botMessageId) || input.botMessageId <= 0) return false;
  const at = Number.isSafeInteger(input.at) && (input.at ?? 0) > 0
    ? Number(input.at)
    : Math.floor(Date.now() / 1000);
  try {
    const result = getDb().prepare(
      `UPDATE self_replies SET outcome = ?, outcome_at = ?
       WHERE chat_id = ? AND bot_message_id = ? AND outcome = 'unknown'`,
    ).run(input.outcome, at, input.chatId, input.botMessageId) as { changes?: number };
    if (result.changes !== 1) return false;
    // Mirror the observation into the event ledger as `own_action_result`, so the
    // cognitive clock (agent/cognitive-clock.ts) can render "what I just did" from
    // the append-only stream. Both paths (pipeline and Meta) reach this function,
    // so wiring here covers them without touching either call site.
    // Dynamic import keeps this module free of a hard dependency on the ledger.
    if (env().COGNITIVE_CLOCK_ENABLED) {
      void import('../agent/cognitive-clock.js')
        .then(({ recordOwnActionResult }) => {
          recordOwnActionResult({
            scope: { visibility: 'chat', chatId: input.chatId },
            botMessageId: input.botMessageId,
            outcome: input.outcome,
            occurredAt: at,
          });
        })
        .catch(() => { /* clock is an aid; the durable row above is the source of truth */ });
    }
    return true;
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'closeSelfActOutcome failed (non-critical)');
    return false;
  }
}

/**
 * Read the bot's own recent behaviour in one chat, with outcomes.
 * Returns null when disabled or there is nothing to show.
 */
export function getSelfActSummary(
  chatId: number,
  windowSec: number,
): SelfActSummary | null {
  if (!env().SELF_HISTORY_ENABLED) return null;
  if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
  const window = Math.max(60, Math.trunc(windowSec));
  const since = Math.floor(Date.now() / 1000) - window;
  try {
    const rows = getDb().prepare(
      `SELECT bot_message_id, ts, reply_text, outcome FROM self_replies
       WHERE chat_id = ? AND ts >= ?
       ORDER BY ts DESC, id DESC LIMIT 50`,
    ).all(chatId, since) as Array<{
      bot_message_id: number | null;
      ts: number;
      reply_text: string;
      outcome: string;
    }>;
    if (rows.length === 0) return null;

    const byOutcome: Record<ActOutcome, number> = {
      ignored: 0, replied: 0, reacted: 0, mentioned: 0, corrected: 0, unknown: 0,
    };
    for (const row of rows) {
      const key = (row.outcome as ActOutcome) in byOutcome
        ? (row.outcome as ActOutcome)
        : 'unknown';
      byOutcome[key] += 1;
    }
    const newest = rows[0]!;
    // How busy was the room? Same window, human messages only.
    let shareOfConversation: number | undefined;
    try {
      const human = getDb().prepare(
        `SELECT COUNT(*) AS c FROM cognitive_events
         WHERE type = 'message_received' AND chat_id = ? AND occurred_at >= ?`,
      ).get(chatId, since) as { c: number } | undefined;
      const humanCount = human?.c ?? 0;
      if (humanCount > 0) {
        shareOfConversation = Math.min(1, rows.length / humanCount);
      }
    } catch { /* optional context; never block the summary */ }
    return {
      chatId,
      windowSec: window,
      total: rows.length,
      byOutcome,
      ...(shareOfConversation === undefined ? {} : { shareOfConversation }),
      recent: rows.slice(0, ACT_MAX_RECENT).map((row) => ({
        ts: row.ts,
        botMessageId: row.bot_message_id ?? 0,
        text: row.reply_text,
        outcome: (row.outcome as ActOutcome) in byOutcome
          ? (row.outcome as ActOutcome)
          : 'unknown',
      })),
      sinceLastSpokeSec: Math.max(0, Math.floor(Date.now() / 1000) - newest.ts),
    };
  } catch (err) {
    logger.debug({ err, chatId }, 'getSelfActSummary failed (non-critical)');
    return null;
  }
}

/**
 * Render the summary as a compact fact block.
 *
 * Deliberately factual: it reports what happened and lets the model judge.
 * No thresholds, no "you should speak less", no quota — the host draws no
 * behavioural conclusion, because that decision belongs to the model.
 */
export function renderSelfActSummary(summary: SelfActSummary | null): string {
  if (!summary || summary.total === 0) return '';
  const label: Record<ActOutcome, string> = {
    ignored: '没人接',
    replied: '有人回',
    reacted: '有人应',
    mentioned: '有人提到你',
    corrected: '被纠正',
    unknown: '还没结果',
  };
  const minutes = Math.max(1, Math.round(summary.windowSec / 60));
  const parts: string[] = [];
  for (const key of ['replied', 'reacted', 'mentioned', 'ignored', 'corrected', 'unknown'] as ActOutcome[]) {
    const n = summary.byOutcome[key];
    if (n > 0) parts.push(`${label[key]} ${n}`);
  }
  const since = summary.sinceLastSpokeSec;
  const sinceText = since === undefined
    ? ''
    : since < 90
      ? '，最近一次就在刚刚'
      : `，最近一次 ${Math.round(since / 60)} 分钟前`;

  // A raw count means nothing without scale. "你说了 14 条" is a lot in a quiet
  // group and nothing in a busy one — what a person actually notices is whether
  // they are dominating the room. Rendered as a felt sense, not a statistic.
  const share = summary.shareOfConversation;
  const shareText = share === undefined
    ? ''
    : share >= 0.5
      ? `，这一波基本是你一个人在说`
      : share >= 0.3
        ? `，这一波你说得有点多`
        : share >= 0.15
          ? `，这一波你插了几句`
          : '';

  const lines = [
    `[你自己的近况] 最近 ${minutes} 分钟里你在这个群说了 ${summary.total} 次（${parts.join(' · ')}）${sinceText}${shareText}。`,
  ];
  // Concrete lines let the model recognise its own repetition instead of only
  // seeing counts.
  const nowSec = Math.floor(Date.now() / 1000);
  for (const act of summary.recent.slice(0, 4)) {
    const ago = Math.max(1, Math.round((nowSec - act.ts) / 60));
    lines.push(`  ${ago}分钟前 你说「${inline(act.text, ACT_PREVIEW_CHARS)}」→ ${label[act.outcome]}`);
  }
  return lines.join('\n');
}

/** Persist a single reply made by the bot. No-op when disabled. */
export function recordSelfReply(
  chatId: number,
  triggerUid: number,
  triggerMsgId: number | null,
  replyText: string,
  botMessageId?: number,
): void {
  if (!env().SELF_HISTORY_ENABLED) return;
  const text = (replyText ?? '').trim();
  if (!text) return;
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO self_replies
         (chat_id, trigger_uid, trigger_msg_id, reply_text, ts, bot_message_id, outcome)
       VALUES (?, ?, ?, ?, ?, ?, 'unknown')`,
    ).run(
      chatId,
      triggerUid,
      triggerMsgId,
      text.slice(0, 500),
      Math.floor(Date.now() / 1000),
      Number.isSafeInteger(botMessageId) && (botMessageId ?? 0) > 0 ? Number(botMessageId) : null,
    );
  } catch (err) {
    logger.debug({ err, chatId, triggerUid }, 'recordSelfReply failed (non-critical)');
  }
}

/**
 * Get up to `limit` recent self replies to a specific user within `withinDays` days.
 * Returns [] when disabled.
 */
export function getRecentSelfReplies(
  chatId: number,
  uid: number,
  limit = 5,
  withinDays = 30,
): SelfReply[] {
  if (!env().SELF_HISTORY_ENABLED) return [];
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - withinDays * 86400;
    const rows = db
      .prepare(
        `SELECT reply_text AS text, ts FROM self_replies
         WHERE chat_id = ? AND trigger_uid = ? AND ts >= ?
         ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(chatId, uid, cutoff, limit) as { text: string; ts: number }[];
    return rows;
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'getRecentSelfReplies failed (non-critical)');
    return [];
  }
}

/**
 * bot 在这个群最近发过的话（不分触发者，用于自我统计）。
 *
 * 为什么不复用 getRecentSelfReplies：那个按 trigger_uid 过滤，语义是"我回过这个人的话"；
 * 而"我最近说话是什么样"要按群取，跟触发者无关。2026-09-19 用在 room-awareness 的
 * 自我统计上（喵尾巴率、平均长度）——把自己的行为数据变成模型能看见的事实，
 * 而不是写死规则去摘它的尾巴。
 */
export function getRecentBotTextsInChat(chatId: number, limit = 12, withinMin = 360): string[] {
  if (!env().SELF_HISTORY_ENABLED) return [];
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - withinMin * 60;
    const rows = db
      .prepare(
        `SELECT reply_text AS text FROM self_replies
         WHERE chat_id = ? AND ts >= ?
         ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(chatId, cutoff, limit) as { text: string }[];
    return rows.map((r) => String(r.text ?? '')).filter(Boolean);
  } catch (err) {
    logger.debug({ err, chatId }, 'getRecentBotTextsInChat failed (non-critical)');
    return [];
  }
}

/**
 * 取某群最近 N 条 bot 自己的发言(不按 uid 过滤)——口头禅自动惩罚闭环的数据源。
 * 返回 [] when disabled.
 */
export function getRecentChatReplies(chatId: number, limit = 60, withinHours = 24): SelfReply[] {
  if (!env().SELF_HISTORY_ENABLED) return [];
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - withinHours * 3600;
    const rows = db
      .prepare(
        `SELECT reply_text AS text, ts FROM self_replies
         WHERE chat_id = ? AND ts >= ?
         ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(chatId, cutoff, limit) as { text: string; ts: number }[];
    return rows;
  } catch (err) {
    logger.debug({ err, chatId }, 'getRecentChatReplies failed (non-critical)');
    return [];
  }
}

/**
 * Format recent self replies as a prompt section. Returns empty string when no entries
 * or feature off.
 */
export function selfHistoryPromptSection(replies: SelfReply[]): string {
  if (!replies || replies.length === 0) return '';
  const lines = replies.map((r) => {
    const dt = new Date(r.ts * 1000);
    const stamp = `${dt.getMonth() + 1}/${dt.getDate()}`;
    const text = r.text.length > 80 ? r.text.slice(0, 80) + '…' : r.text;
    return `- ${stamp}: ${text}`;
  });
  return `【你最近对 ta 说过的话】\n${lines.join('\n')}\n注意保持一致，避免前后矛盾。`;
}

/**
 * Delete self_replies entries older than `olderThanDays` days. Returns count deleted.
 * Safe to call with feature off (just no-op).
 */
export function pruneOldSelfReplies(olderThanDays = 60): number {
  if (!env().SELF_HISTORY_ENABLED) return 0;
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
    const result = db.prepare('DELETE FROM self_replies WHERE ts < ?').run(cutoff);
    const deleted = Number(result.changes ?? 0);
    if (deleted > 0) {
      logger.info({ deleted, olderThanDays }, 'pruneOldSelfReplies completed');
    }
    return deleted;
  } catch (err) {
    logger.warn({ err }, 'pruneOldSelfReplies failed');
    return 0;
  }
}
