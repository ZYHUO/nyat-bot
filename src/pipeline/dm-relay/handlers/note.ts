// ────────────────────────────────
// Anonymous Notes Handler — 匿名小纸条
// ────────────────────────────────

import { getDb } from '../../../db/sqlite.js';
import { getRedis } from '../../../db/redis.js';
import { sendMessage, sendChatAction } from '../../../bot/sender/telegram.js';
import { StreamingSender } from '../../../bot/sender/streaming.js';
import { logger } from '../../../shared/logger.js';
import { resolveGroup, savePendingGroupSelection, clearPendingGroupSelection, getPendingGroupSelection } from '../group-resolver.js';
import { resolveTarget } from '../target-resolver.js';
import { runSafetyChecks } from '../safety.js';
import { checkFeatureGate } from '../feature-gate.js';
import { callWithFallback } from '../../../ai/fallback.js';
import type { ResolvedGroup } from '../group-resolver.js';
import type { FormattedMessage } from '../../../shared/types.js';

const sender = new StreamingSender();

// ── Constants ──────────────────────────

const DAILY_NOTE_LIMIT = 3;
const GUESS_WINDOW_SEC = 86400; // 24h to guess who wrote a note

interface GuessEntry { uid: number; guessed_uid: number; correct: 0 | 1; ts: number }

/** Build the group publish message including a guess invitation. */
function buildNoteGroupMessage(noteId: number, targetMention: string, content: string): string {
  const head = targetMention
    ? `📜 有只害羞的小猫让本喵转交给 ${targetMention}：「${content}」`
    : `📜 有只害羞的小猫让本喵递张纸条：「${content}」`;
  return `${head}\n\n🔍 想猜是谁写的？私聊本喵「猜纸条 #${noteId} @某人」(24h内有效)`;
}

/** Generate 3 progressive content-based hints via AI. Never reveals identity. */
async function generateHints(content: string): Promise<string[]> {
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        {
          role: 'system',
          content: `根据一张匿名纸条的内容，生成3条循序渐进的"猜作者"提示（由弱到强）。
严格规则：
- 只能基于纸条的语气、用词、话题、情绪来推测，绝不能编造或提及具体姓名、用户名、昵称、性别、长相等身份信息
- 每条提示一句话，简短有趣
- 不要重复纸条原文
仅输出JSON数组：["提示1","提示2","提示3"]`,
        },
        { role: 'user', content: `纸条内容：${content}` },
      ],
      maxTokens: 150,
      temperature: 0.7,
    });
    const cleaned = result.content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((h): h is string => typeof h === 'string').slice(0, 3);
    }
  } catch (err) {
    logger.debug({ err }, 'Note hint generation failed');
  }
  return [];
}

/** Fire-and-forget: generate + persist hints for a freshly published note. */
function scheduleHintGeneration(noteId: number, content: string): void {
  void generateHints(content).then((hints) => {
    if (hints.length === 0) return;
    try {
      getDb().prepare('UPDATE anonymous_notes SET hints = ? WHERE id = ?')
        .run(JSON.stringify(hints), noteId);
    } catch (err) {
      logger.debug({ err, noteId }, 'Failed to persist note hints');
    }
  });
}

// ── Rate limit helpers ──────────────────────────

/** Get today's start timestamp (Asia/Shanghai midnight, unix seconds) */
function todayStartUnix(): number {
  const now = new Date();
  const sh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  sh.setHours(0, 0, 0, 0);
  return Math.floor(sh.getTime() / 1000);
}

/**
 * Get comprehensive note stats for a user.
 */
export function getNoteStats(senderId: number): {
  sent_today: number;
  limit: number;
  sent_total: number;
  received_total: number;
  received_today: number;
  top_targets: Array<{ target_id: number; count: number }>;
  guesses_made: number;
  guesses_correct: number;
  times_guessed_correctly: number;
} {
  const db = getDb();
  const since = todayStartUnix();

  const sentToday = db.prepare(
    'SELECT COUNT(*) as cnt FROM anonymous_notes WHERE sender_id = ? AND created_at >= ?',
  ).get(senderId, since) as { cnt: number };

  const sentTotal = db.prepare(
    'SELECT COUNT(*) as cnt FROM anonymous_notes WHERE sender_id = ?',
  ).get(senderId) as { cnt: number };

  const receivedTotal = db.prepare(
    'SELECT COUNT(*) as cnt FROM anonymous_notes WHERE target_id = ?',
  ).get(senderId) as { cnt: number };

  const receivedToday = db.prepare(
    'SELECT COUNT(*) as cnt FROM anonymous_notes WHERE target_id = ? AND created_at >= ?',
  ).get(senderId, since) as { cnt: number };

  const topTargets = db.prepare(
    'SELECT target_id, COUNT(*) as cnt FROM anonymous_notes WHERE sender_id = ? AND target_id IS NOT NULL GROUP BY target_id ORDER BY cnt DESC LIMIT 3',
  ).all(senderId) as Array<{ target_id: number; cnt: number }>;

  // Guess stats (correct stored as 1/0 in guesses JSON)
  const guessAgg = db.prepare(`
    SELECT
      COUNT(*) AS made,
      COALESCE(SUM(CASE WHEN json_extract(g.value,'$.correct') = 1 THEN 1 ELSE 0 END), 0) AS correct
    FROM anonymous_notes n, json_each(n.guesses) g
    WHERE n.guesses IS NOT NULL AND json_valid(n.guesses) = 1
      AND json_extract(g.value,'$.uid') = ?
  `).get(senderId) as { made: number; correct: number };

  const guessedCorrectly = db.prepare(`
    SELECT COUNT(DISTINCT n.id) AS cnt
    FROM anonymous_notes n, json_each(n.guesses) g
    WHERE n.sender_id = ? AND n.guesses IS NOT NULL AND json_valid(n.guesses) = 1
      AND json_extract(g.value,'$.correct') = 1
  `).get(senderId) as { cnt: number };

  return {
    sent_today: sentToday.cnt,
    limit: DAILY_NOTE_LIMIT,
    sent_total: sentTotal.cnt,
    received_total: receivedTotal.cnt,
    received_today: receivedToday.cnt,
    top_targets: topTargets.map(t => ({ target_id: t.target_id, count: t.cnt })),
    guesses_made: guessAgg.made,
    guesses_correct: guessAgg.correct,
    times_guessed_correctly: guessedCorrectly.cnt,
  };
}

/** Check if user has hit daily limit; return true if over limit */
function isOverLimit(senderId: number): boolean {
  const stats = getNoteStats(senderId);
  return stats.sent_today >= stats.limit;
}

// ── Main handler: create an anonymous note ──────────────────────────

export async function handleNoteStart(
  dmChatId: number,
  formatted: FormattedMessage,
  content?: string,
  targetHandle?: string,
): Promise<void> {
  await sendChatAction(dmChatId, 'typing');

  // 0. Strip command prefix from content
  if (content) {
    content = content.replace(/^(?:纸条|小纸条|匿名|note)\s*/i, '').trim();
    // Extract @handle if present at the start
    const atMatch = content.match(/^@(\S+)\s+([\s\S]+)/);
    if (atMatch && !targetHandle) {
      targetHandle = atMatch[1];
      content = atMatch[2]!.trim();
    }
  }

  // 1. If no content provided, ask user what to write
  if (!content) {
    await sender.sendDirect(
      dmChatId,
      '想写什么匿名小纸条喵？✏️\n\n' +
      '格式：`纸条 内容`\n' +
      '也可以指定收纸条的人：`纸条 @某人 内容`',
      formatted.messageId,
    );
    return;
  }

  // 2. Rate limit check
  if (isOverLimit(formatted.uid)) {
    const stats = getNoteStats(formatted.uid);
    await sender.sendDirect(
      dmChatId,
      `你今天已经送了 ${stats.sent_today} 张纸条了喵，每天最多 ${stats.limit} 张哦~ 明天再来吧！🐱`,
      formatted.messageId,
    );
    return;
  }

  // 3. Resolve group
  let group: ResolvedGroup;
  const result = await resolveGroup(formatted.uid);
  if (!result.ok) {
    if (result.reason === 'multiple_groups') {
      await savePendingGroupSelection(formatted.uid, {
        intent: 'note',
        groups: result.groups,
        content,
        targetHandle,
      });
    }
    await sender.sendDirect(dmChatId, result.reply, formatted.messageId);
    return;
  }
  group = result.group;

  const gate = await checkFeatureGate(group.chatId, 'note');
  if (gate) {
    await sender.sendDirect(dmChatId, gate, formatted.messageId);
    return;
  }

  // 4. If targetHandle provided, resolve target user in the group
  let targetId: number | null = null;
  let targetMention = '';
  if (targetHandle) {
    const target = await resolveTarget(group.chatId, targetHandle);
    if (!target) {
      await sender.sendDirect(
        dmChatId,
        `在「${group.title}」里没找到这个人喵~ 确认一下用户名？`,
        formatted.messageId,
      );
      return;
    }
    targetId = target.uid;
    targetMention = target.username ? `@${target.username}` : target.fullName;
  }

  // 5. Safety check
  const safety = await runSafetyChecks(formatted.uid, group.chatId, targetId ?? 0, content);
  if (!safety.ok) {
    await sender.sendDirect(dmChatId, safety.reply, formatted.messageId);
    return;
  }

  // 6. Insert into anonymous_notes
  const now = Math.floor(Date.now() / 1000);
  try {
    const info = getDb().prepare(`
      INSERT INTO anonymous_notes (sender_id, target_id, group_id, content, guessable, status, published_at, created_at)
      VALUES (?, ?, ?, ?, 1, 'published', ?, ?)
    `).run(
      formatted.uid,
      targetId,
      group.chatId,
      content,
      now,
      now,
    );

    // 7. Publish to group (with guess invitation)
    const noteId = Number(info.lastInsertRowid);
    await sendMessage(group.chatId, buildNoteGroupMessage(noteId, targetMention, content));

    // Generate guess hints in the background
    scheduleHintGeneration(noteId, content);

    // 8. Confirm to sender with rich stats
    const stats = getNoteStats(formatted.uid);
    const topStr = stats.top_targets.length > 0
      ? '\n💌 最常送纸条的人：' + stats.top_targets.map(t => `uid:${t.target_id}(${t.count}次)`).join('、')
      : '';
    await sender.sendDirect(
      dmChatId,
      `纸条已送达「${group.title}」喵~ 🎉\n\n` +
      `📜 内容：${content}\n` +
      (targetMention ? `🎯 收件人：${targetMention}\n` : '') +
      `\n📊 纸条统计\n` +
      `├ 今日已用：${stats.sent_today}/${stats.limit}\n` +
      `├ 累计发送：${stats.sent_total} 张\n` +
      `├ 累计收到：${stats.received_total} 张` +
      topStr,
      formatted.messageId,
    );

    logger.info({
      noteId: info.lastInsertRowid,
      senderUid: formatted.uid,
      targetId,
      groupId: group.chatId,
    }, 'Anonymous note published');
  } catch (err) {
    logger.error({ err, senderUid: formatted.uid, groupId: group.chatId }, 'Failed to publish anonymous note');
    await sender.sendDirect(dmChatId, '纸条发送失败了喵，稍后再试试~', formatted.messageId);
  }
}

// ── Pending group selection follow-up ──────────────────────────

export async function handleNotePendingGroup(
  dmChatId: number,
  formatted: FormattedMessage,
  selectedGroup: ResolvedGroup,
): Promise<void> {
  // Retrieve the original data from pending state
  const pending = await getPendingGroupSelection(formatted.uid);
  const content = pending?.content;
  const targetHandle = pending?.targetHandle;

  if (!content) {
    await sender.sendDirect(dmChatId, '之前的纸条信息过期了喵，重新告诉我内容吧~', formatted.messageId);
    return;
  }

  await clearPendingGroupSelection(formatted.uid);

  const gate = await checkFeatureGate(selectedGroup.chatId, 'note');
  if (gate) {
    await sender.sendDirect(dmChatId, gate, formatted.messageId);
    return;
  }

  // Rate limit re-check
  if (isOverLimit(formatted.uid)) {
    const stats = getNoteStats(formatted.uid);
    await sender.sendDirect(
      dmChatId,
      `你今天已经送了 ${stats.sent_today} 张纸条了喵，每天最多 ${stats.limit} 张哦~ 明天再来吧！🐱`,
      formatted.messageId,
    );
    return;
  }

  // Resolve target if needed
  let targetId: number | null = null;
  let targetMention = '';
  if (targetHandle) {
    const target = await resolveTarget(selectedGroup.chatId, targetHandle);
    if (!target) {
      await sender.sendDirect(
        dmChatId,
        `在「${selectedGroup.title}」里没找到这个人喵~ 确认一下用户名？`,
        formatted.messageId,
      );
      return;
    }
    targetId = target.uid;
    targetMention = target.username ? `@${target.username}` : target.fullName;
  }

  // Safety check
  const safety = await runSafetyChecks(formatted.uid, selectedGroup.chatId, targetId ?? 0, content);
  if (!safety.ok) {
    await sender.sendDirect(dmChatId, safety.reply, formatted.messageId);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    const info = getDb().prepare(`
      INSERT INTO anonymous_notes (sender_id, target_id, group_id, content, guessable, status, published_at, created_at)
      VALUES (?, ?, ?, ?, 1, 'published', ?, ?)
    `).run(
      formatted.uid,
      targetId,
      selectedGroup.chatId,
      content,
      now,
      now,
    );

    const noteId = Number(info.lastInsertRowid);
    await sendMessage(selectedGroup.chatId, buildNoteGroupMessage(noteId, targetMention, content));
    scheduleHintGeneration(noteId, content);

    const stats = getNoteStats(formatted.uid);
    await sender.sendDirect(
      dmChatId,
      `纸条已送达「${selectedGroup.title}」喵~ 🎉\n\n` +
      `📜 内容：${content}\n` +
      (targetMention ? `🎯 收件人：${targetMention}\n` : '') +
      `📊 今日已用：${stats.sent_today}/${stats.limit}`,
      formatted.messageId,
    );

    logger.info({
      noteId: info.lastInsertRowid,
      senderUid: formatted.uid,
      targetId,
      groupId: selectedGroup.chatId,
    }, 'Anonymous note published (pending group resolved)');
  } catch (err) {
    logger.error({ err }, 'Failed to publish anonymous note (pending group)');
    await sender.sendDirect(dmChatId, '纸条发送失败了喵，稍后再试试~', formatted.messageId);
  }
}

/** Show detailed note stats */
export async function handleNoteStats(
  dmChatId: number,
  formatted: FormattedMessage,
): Promise<void> {
  const stats = getNoteStats(formatted.uid);

  const topStr = stats.top_targets.length > 0
    ? stats.top_targets.map(t => `  💌 uid:${t.target_id} — ${t.count} 次`).join('\n')
    : '  (还没有送过纸条~)';

  const text = [
    `📊 **纸条统计**`,
    ``,
    `📤 发送`,
    `├ 今日：${stats.sent_today}/${stats.limit} 张`,
    `├ 累计：${stats.sent_total} 张`,
    ``,
    `📥 收到`,
    `├ 今日：${stats.received_today} 张`,
    `├ 累计：${stats.received_total} 张`,
    ``,
    `🎯 最常送纸条的人`,
    topStr,
    ``,
    `🔍 猜谜战绩`,
    `├ 出击：${stats.guesses_made} 次`,
    `├ 命中：${stats.guesses_correct} 次`,
    `└ 你被识破：${stats.times_guessed_correctly} 次`,
  ].join('\n');

  await sender.sendDirect(dmChatId, text, formatted.messageId);
}

// ── Guess game ──────────────────────────

interface NoteRow {
  id: number;
  sender_id: number;
  target_id: number | null;
  group_id: number;
  content: string;
  guesses: string | null;
  status: string;
  published_at: number | null;
}

/** Handle "猜纸条 #N @某人" — guess who wrote a note (DM only). */
export async function handleNoteGuess(
  dmChatId: number,
  formatted: FormattedMessage,
  noteId: number,
  guessedHandle: string,
): Promise<void> {
  const db = getDb();
  const note = db.prepare(
    'SELECT id, sender_id, target_id, group_id, content, guesses, status, published_at FROM anonymous_notes WHERE id = ?',
  ).get(noteId) as NoteRow | undefined;

  if (!note || note.status !== 'published') {
    await sender.sendDirect(dmChatId, `找不到编号 #${noteId} 的纸条，或它已经结束猜谜了喵~`, formatted.messageId);
    return;
  }

  // Window check
  const now = Math.floor(Date.now() / 1000);
  if (note.published_at && now - note.published_at > GUESS_WINDOW_SEC) {
    await sender.sendDirect(dmChatId, `纸条 #${noteId} 的猜谜时间已经结束啦喵~`, formatted.messageId);
    return;
  }

  // Can't guess your own note
  if (note.sender_id === formatted.uid) {
    await sender.sendDirect(dmChatId, `这张纸条就是你写的呀喵，不能猜自己~`, formatted.messageId);
    return;
  }

  // Parse existing guesses, enforce one per user
  let guesses: GuessEntry[] = [];
  if (note.guesses) {
    try { guesses = JSON.parse(note.guesses) as GuessEntry[]; } catch { guesses = []; }
  }
  if (guesses.some((g) => g.uid === formatted.uid)) {
    await sender.sendDirect(dmChatId, `你已经猜过纸条 #${noteId} 啦喵，每张只能猜一次~`, formatted.messageId);
    return;
  }

  // Resolve the guessed person within the note's group
  const guessTarget = await resolveTarget(note.group_id, guessedHandle);
  if (!guessTarget) {
    await sender.sendDirect(dmChatId, `在那个群里没找到「${guessedHandle}」喵~ 确认下名字或 @用户名？`, formatted.messageId);
    return;
  }

  const correct = guessTarget.uid === note.sender_id;
  guesses.push({ uid: formatted.uid, guessed_uid: guessTarget.uid, correct: correct ? 1 : 0, ts: now });
  db.prepare('UPDATE anonymous_notes SET guesses = ? WHERE id = ?').run(JSON.stringify(guesses), noteId);

  if (correct) {
    await sender.sendDirect(dmChatId, `🎉 你猜中纸条 #${noteId} 啦~ 但本喵嘴严，不会告诉别人是谁写的喵~`, formatted.messageId);
    // Notify the author (anonymously — don't reveal the guesser)
    try {
      await sendMessage(note.sender_id, `🔍 有人猜中了你的匿名纸条 #${noteId} 喵~（本喵帮你保密了身份）`);
    } catch { /* author may have blocked bot */ }
  } else {
    await sender.sendDirect(dmChatId, `🐱 不对哦~ 不是 TA 啦，再想想？（纸条 #${noteId}）`, formatted.messageId);
  }

  logger.info({ noteId, guesserUid: formatted.uid, correct }, 'Note guess recorded');
}

/** Handle "公布纸条 #N" — author opts to reveal themselves (DM only). */
export async function handleNoteReveal(
  dmChatId: number,
  formatted: FormattedMessage,
  noteId: number,
): Promise<void> {
  const db = getDb();
  const note = db.prepare(
    'SELECT id, sender_id, group_id, content, status FROM anonymous_notes WHERE id = ?',
  ).get(noteId) as { id: number; sender_id: number; group_id: number; content: string; status: string } | undefined;

  if (!note) {
    await sender.sendDirect(dmChatId, `找不到编号 #${noteId} 的纸条喵~`, formatted.messageId);
    return;
  }
  if (note.sender_id !== formatted.uid) {
    await sender.sendDirect(dmChatId, `只有纸条的作者才能公布身份喵~`, formatted.messageId);
    return;
  }

  const who = formatted.username ? `@${formatted.username}` : formatted.fullName;
  try {
    await sendMessage(note.group_id, `🐱 纸条 #${noteId} 的作者愿意现身啦：是 ${who} 写的~\n「${note.content}」`);
    await sender.sendDirect(dmChatId, `✅ 已在群里公布你是纸条 #${noteId} 的作者喵~`, formatted.messageId);
    logger.info({ noteId, senderUid: formatted.uid }, 'Note author revealed');
  } catch (err) {
    logger.warn({ err, noteId }, 'Note reveal send failed');
    await sender.sendDirect(dmChatId, '公布失败了喵，群组可能不可用~', formatted.messageId);
  }
}

// ── Cron: hint drip + 24h close ──────────────────────────

/**
 * Reveal the next progressive hint for published notes (H2 at 6h, H3 at 18h),
 * using Redis setnx to avoid double-posting. Returns count of hints revealed.
 */
export async function revealDueHints(): Promise<number> {
  const db = getDb();
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);

  // Notes still in the guessing window with hints generated
  const rows = db.prepare(`
    SELECT id, group_id, hints, published_at FROM anonymous_notes
    WHERE status = 'published' AND hints IS NOT NULL AND published_at IS NOT NULL
      AND published_at > ?
  `).all(now - GUESS_WINDOW_SEC) as Array<{ id: number; group_id: number; hints: string; published_at: number }>;

  let revealed = 0;
  for (const row of rows) {
    let hints: string[];
    try { hints = JSON.parse(row.hints) as string[]; } catch { continue; }
    if (!Array.isArray(hints) || hints.length === 0) continue;

    const age = now - row.published_at;
    // level 2 at >=6h, level 3 at >=18h (hints[1], hints[2])
    const due: number[] = [];
    if (age >= 6 * 3600 && hints[1]) due.push(2);
    if (age >= 18 * 3600 && hints[2]) due.push(3);

    for (const level of due) {
      const key = `xxb:note:hint:${row.id}:${level}`;
      try {
        const set = await redis.set(key, '1', 'EX', GUESS_WINDOW_SEC, 'NX');
        if (set === null) continue; // already revealed
        await sendMessage(row.group_id, `🔍 纸条 #${row.id} 的新提示：${hints[level - 1]}`);
        revealed++;
      } catch (err) {
        logger.debug({ err, noteId: row.id, level }, 'Hint reveal failed');
      }
    }
  }
  return revealed;
}

/**
 * Close notes past the 24h guess window: post a summary and mark status='closed'.
 * Returns count of notes closed.
 */
export async function closeExpiredNotes(): Promise<number> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const rows = db.prepare(`
    SELECT id, group_id, guesses FROM anonymous_notes
    WHERE status = 'published' AND published_at IS NOT NULL AND published_at <= ?
  `).all(now - GUESS_WINDOW_SEC) as Array<{ id: number; group_id: number; guesses: string | null }>;

  let closed = 0;
  for (const row of rows) {
    let guesses: GuessEntry[] = [];
    if (row.guesses) {
      try { guesses = JSON.parse(row.guesses) as GuessEntry[]; } catch { guesses = []; }
    }
    const total = guesses.length;
    const correct = guesses.filter((g) => g.correct).length;

    try {
      if (total > 0) {
        await sendMessage(row.group_id, `📜 纸条 #${row.id} 猜谜结束：${total} 人参与，${correct} 人猜中~ 作者依旧是个谜喵~`);
      }
      db.prepare("UPDATE anonymous_notes SET status = 'closed' WHERE id = ?").run(row.id);
      closed++;
    } catch (err) {
      logger.debug({ err, noteId: row.id }, 'Note close failed');
      // Still mark closed to avoid retry storm
      db.prepare("UPDATE anonymous_notes SET status = 'closed' WHERE id = ?").run(row.id);
    }
  }
  return closed;
}
