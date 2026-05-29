// ────────────────────────────────────────
// Post-Reply Action Hook
// 检测猫娘回复中是否承诺了动作（设提醒、写纸条等）
// 如果是，真正执行该动作
// ────────────────────────────────────────

import { createHash } from 'node:crypto';
import { callWithFallback } from '../../ai/fallback.js';
import { logger } from '../../shared/logger.js';
import { getDb } from '../../db/sqlite.js';
import { getRedis } from '../../db/redis.js';
import { sendMessage } from '../../bot/sender/telegram.js';
import { parseScheduleTime } from './handlers/schedule.js';
import { resolveGroup } from './group-resolver.js';
import { resolveTarget } from './target-resolver.js';
import { runSafetyChecks } from './safety.js';
import { checkFeatureGate } from './feature-gate.js';

const log = logger.child({ mod: 'dm:post-action' });

const POST_ACTION_DEDUP_PREFIX = 'xxb:dm:post_action:';
const POST_ACTION_DEDUP_TTL = 300; // 5 min
const INTENT_HANDLED_PREFIX = 'xxb:dm:intent_handled:';

/** sha1 of a user message — used for dedup keys */
function hashMessage(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** Mark that a DM intent handler already processed this user message — prevents post-action re-trigger */
export async function markIntentHandled(uid: number, userMessage: string): Promise<void> {
  const key = INTENT_HANDLED_PREFIX + uid + ':' + hashMessage(userMessage);
  await getRedis().set(key, '1', 'EX', 60);
}

interface DetectedAction {
  type: 'schedule' | 'note' | 'confide' | 'none';
  /** For schedule: the time description + content */
  time?: string;
  /** For note/confide: the content to send */
  content?: string;
  /** For note: target person name */
  target?: string;
}

/**
 * Analyze a bot reply to detect if it promised an action.
 */
async function detectAction(userMessage: string, botReply: string): Promise<DetectedAction> {
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        {
          role: 'system',
          content: `分析猫娘的回复，判断它是否承诺了某个动作。

规则：
- 只有明确承诺"会做某事"才算，模糊表达不算
- 常见承诺：设提醒、定闹钟、写纸条、记下来、匿名发、树洞分享

输出JSON：
{"type": "schedule", "time": "时间描述", "content": "提醒内容"}
或 {"type": "note", "target": "目标人名或null", "content": "纸条内容"}
或 {"type": "confide", "content": "倾诉内容"}
或 {"type": "none"}

注意：
- time 要包含完整时间信息（如"明天早上6点"、"每天下午3点"）
- 如果时间或内容不明确，输出 {"type": "none"}
- 只输出JSON，不要多余文字`,
        },
        {
          role: 'user',
          content: `用户说：${userMessage}\n\n猫娘回复：${botReply}`,
        },
      ],
      maxTokens: 150,
      temperature: 0,
    });

    const cleaned = result.content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned) as DetectedAction;

    if (parsed.type === 'schedule' && parsed.time && parsed.content) {
      return { type: 'schedule', time: parsed.time, content: parsed.content };
    }
    if (parsed.type === 'note' && parsed.content) {
      return { type: 'note', target: parsed.target, content: parsed.content };
    }
    if (parsed.type === 'confide' && parsed.content) {
      return { type: 'confide', content: parsed.content };
    }
    return { type: 'none' };
  } catch {
    return { type: 'none' };
  }
}

/**
 * Execute a detected action.
 * Returns a confirmation message to send, or null if no action needed.
 */
export async function executePostAction(
  chatId: number,
  uid: number,
  userMessage: string,
  botReply: string,
): Promise<string | null> {
  // Only check DMs
  if (chatId <= 0) return null;

  // Only check if reply looks like it contains a commitment
  const commitmentSignals = /记[一下下]|提醒|闹钟|纸条|匿名|定[一下下]|喊|叫|通知|定时|树洞|秘密|倾诉/;
  if (!commitmentSignals.test(botReply)) return null;

  // Dedup: if a DM intent handler already processed this user message, skip
  const redis = getRedis();
  const msgHash = hashMessage(userMessage);
  const intentHandled = await redis.exists(INTENT_HANDLED_PREFIX + uid + ':' + msgHash);
  if (intentHandled) {
    log.debug({ uid }, 'Post-action skipped: explicit intent already handled this turn');
    return null;
  }

  // Dedup: don't re-trigger same action within window
  const dedupKey = POST_ACTION_DEDUP_PREFIX + uid + ':' + msgHash;
  const setResult = await redis.set(dedupKey, '1', 'EX', POST_ACTION_DEDUP_TTL, 'NX');
  if (setResult === null) {
    log.debug({ uid }, 'Post-action dedup: skip duplicate');
    return null;
  }

  const action = await detectAction(userMessage, botReply);
  if (action.type === 'none') return null;

  log.info({ uid, action }, 'Post-reply action detected');

  if (action.type === 'schedule') {
    return await executeSchedule(uid, chatId, action.time!, action.content!);
  }

  if (action.type === 'note') {
    return await executeNote(uid, chatId, action.content!, action.target);
  }

  if (action.type === 'confide') {
    return await executeConfide(uid, chatId, action.content!);
  }

  return null;
}

// ── Schedule action ──────────────────────────

async function executeSchedule(uid: number, chatId: number, timeDesc: string, content: string): Promise<string | null> {
  const fullText = `${timeDesc} ${content}`;
  const parsed = parseScheduleTime(fullText);

  if (!parsed) {
    log.warn({ timeDesc, content }, 'Could not parse schedule time from post-action');
    return null;
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  try {
    const activeCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM scheduled_messages WHERE owner_id = ? AND active = 1',
    ).get(uid) as { cnt: number };

    if (activeCount.cnt >= 5) {
      return '⚠️ 你已经有 5 个定时提醒了，先取消一些再设新的吧~';
    }

    db.prepare(`
      INSERT INTO scheduled_messages (owner_id, group_id, content, next_run_at, cron_expr, timezone, active, created_at)
      VALUES (?, ?, ?, ?, ?, 'Asia/Shanghai', 1, ?)
    `).run(uid, chatId, parsed.content, parsed.nextRunAt, parsed.cronExpr, now);

    log.info({ uid, timeDesc, content, nextRunAt: parsed.nextRunAt }, 'Post-action schedule created');
    return `✅ 已设好定时提醒：${parsed.description}`;
  } catch (err) {
    log.error({ err, uid, timeDesc }, 'Post-action schedule creation failed');
    return null;
  }
}

// ── Note action ──────────────────────────

async function executeNote(uid: number, _dmChatId: number, content: string, target?: string): Promise<string | null> {
  // Resolve which group to send to
  const result = await resolveGroup(uid);
  if (!result.ok) {
    log.warn({ uid, reason: result.reason }, 'Post-action note: no group found');
    return null;
  }

  const groupId = result.group.chatId;
  const groupTitle = result.group.title;

  // Feature gate
  if (await checkFeatureGate(groupId, 'note')) return null;

  // Resolve target user if specified
  let targetId: number | null = null;
  let targetMention = '';
  if (target) {
    const resolved = await resolveTarget(groupId, target);
    if (resolved) {
      targetId = resolved.uid;
      targetMention = resolved.username ? `@${resolved.username}` : resolved.fullName;
    }
  }

  // Rate limit check
  const db = getDb();
  const todayStart = Math.floor(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).setHours(0, 0, 0, 0) / 1000);
  const sentToday = db.prepare(
    'SELECT COUNT(*) as cnt FROM anonymous_notes WHERE sender_id = ? AND created_at >= ?',
  ).get(uid, todayStart) as { cnt: number };

  if (sentToday.cnt >= 3) {
    return '⚠️ 你今天的纸条额度用完了（每天3张），明天再来吧~';
  }

  // Safety check
  const safety = await runSafetyChecks(uid, groupId, targetId ?? 0, content);
  if (!safety.ok) {
    log.info({ uid, reason: safety.reason }, 'Post-action note blocked by safety');
    return safety.reply;
  }

  // Create the note
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(`
      INSERT INTO anonymous_notes (sender_id, target_id, group_id, content, guessable, status, published_at, created_at)
      VALUES (?, ?, ?, ?, 1, 'published', ?, ?)
    `).run(uid, targetId, groupId, content, now, now);

    // Send to group
    let groupMsg: string;
    if (targetId && targetMention) {
      groupMsg = `📜 有只害羞的小猫让本喵转交给 ${targetMention}：「${content}」`;
    } else {
      groupMsg = `📜 有只害羞的小猫让本喵递张纸条：「${content}」`;
    }
    await sendMessage(groupId, groupMsg);

    log.info({ uid, groupId, targetId }, 'Post-action note sent');
    return `✅ 纸条已匿名送到「${groupTitle}」${targetMention ? `给 ${targetMention}` : ''}~`;
  } catch (err) {
    log.error({ err, uid, groupId }, 'Post-action note failed');
    return null;
  }
}

// ── Confide action ──────────────────────────

async function executeConfide(uid: number, _dmChatId: number, content: string): Promise<string | null> {
  const result = await resolveGroup(uid);
  if (!result.ok) {
    log.warn({ uid }, 'Post-action confide: no group found');
    return null;
  }

  const groupId = result.group.chatId;

  // Feature gate
  if (await checkFeatureGate(groupId, 'confide')) return null;

  // Safety check
  const safety = await runSafetyChecks(uid, groupId, 0, content);
  if (!safety.ok) {
    log.info({ uid, reason: safety.reason }, 'Post-action confide blocked by safety');
    return safety.reply;
  }

  const styles = ['安慰型', '调侃型', '共鸣型', '鼓励型', '佛系型'];
  const style = styles[Math.floor(Math.random() * styles.length)]!;

  try {
    const aiResult = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: '你是一个温暖的猫娘，善于倾听和安慰人。' },
        {
          role: 'user',
          content: `用"${style}"风格回应这个秘密，2-4句话，猫娘语气，只输出回复：\n${content}`,
        },
      ],
      temperature: 0.8,
    });

    const response = aiResult.content.trim() || '喵~ 本喵听到了你的心声，会一直陪着你的~';
    await sendMessage(groupId, response);

    log.info({ uid, groupId }, 'Post-action confide sent');
    return '✅ 已匿名分享到群里啦~';
  } catch (err) {
    log.error({ err, uid, groupId }, 'Post-action confide failed');
    return null;
  }
}
