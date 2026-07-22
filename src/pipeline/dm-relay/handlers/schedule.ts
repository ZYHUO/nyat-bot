// ────────────────────────────────
// Schedule Handler — 定时提醒
// ────────────────────────────────

import { getDb } from '../../../db/sqlite.js';
import { getRedis } from '../../../db/redis.js';
import { sendMessage, sendChatAction } from '../../../bot/sender/telegram.js';
import { StreamingSender } from '../../../bot/sender/streaming.js';
import { logger } from '../../../shared/logger.js';
import { env } from '../../../env.js';
import type { FormattedMessage } from '../../../shared/types.js';

const sender = new StreamingSender();

// ── Timezone helpers (Asia/Shanghai) ──────────────────────────

const TZ = 'Asia/Shanghai';

/** Get current date parts in Asia/Shanghai */
function nowInTZ(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

/** Create a Date at specific hour:minute in Asia/Shanghai, offset by days */
function dateAtTZ(hour: number, minute: number, daysOffset: number): Date {
  const base = nowInTZ();
  base.setDate(base.getDate() + daysOffset);
  base.setHours(hour, minute, 0, 0);
  return base;
}

// ── Chinese weekday mapping ──────────────────────────

const WEEKDAY_MAP: Record<string, number> = {
  '日': 0, '天': 0, '星期天': 0, '星期日': 0, '周天': 0, '周日': 0,
  '一': 1, '星期一': 1, '周一': 1,
  '二': 2, '星期二': 2, '周二': 2,
  '三': 3, '星期三': 3, '周三': 3,
  '四': 4, '星期四': 4, '周四': 4,
  '五': 5, '星期五': 5, '周五': 5,
  '六': 6, '星期六': 6, '周六': 6,
};

// ── Time parsing ──────────────────────────

export interface ParsedSchedule {
  /** Absolute timestamp (unix seconds) for next_run_at */
  nextRunAt: number;
  /** Cron expression if recurring, null for one-time */
  cronExpr: string | null;
  /** Human-readable description of the schedule */
  description: string;
  /** The message content (time expression stripped) */
  content: string;
}

/**
 * Parse Chinese time expressions from user text.
 *
 * Supported patterns:
 * - 明天9点 / 后天下午3点半 → one-time
 * - 每天9点 / 每天上午10点 → recurring daily
 * - 每周一9点 / 每周五下午2点 → recurring weekly
 * - 30分钟后 / 2小时后 → one-time
 */
export function parseScheduleTime(text: string): ParsedSchedule | null {
  const trimmed = text.trim();

  // ── Relative: N分钟后 / N小时后 ──
  const minMatch = trimmed.match(/^(\d+)\s*分钟后(?:[，,\s]*)([\s\S]+)$/);
  if (minMatch) {
    const mins = parseInt(minMatch[1]!, 10);
    const content = minMatch[2]!.trim();
    if (!content) return null;
    const target = new Date(Date.now() + mins * 60_000);
    return {
      nextRunAt: Math.floor(target.getTime() / 1000),
      cronExpr: null,
      description: `${mins}分钟后`,
      content,
    };
  }

  const hourMatch = trimmed.match(/^(\d+)\s*小时后(?:[，,\s]*)([\s\S]+)$/);
  if (hourMatch) {
    const hours = parseInt(hourMatch[1]!, 10);
    const content = hourMatch[2]!.trim();
    if (!content) return null;
    const target = new Date(Date.now() + hours * 3600_000);
    return {
      nextRunAt: Math.floor(target.getTime() / 1000),
      cronExpr: null,
      description: `${hours}小时后`,
      content,
    };
  }

  // ── Recurring: 每天X点 ──
  const dailyMatch = trimmed.match(
    /^每天(?:上午|早上|早|下午|晚上|晚间|晚)?(\d{1,2})[点时](?:(\d{1,2})分?)?(半)?(?:[，,\s]*)([\s\S]+)$/,
  );
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1]!, 10);
    let minute = dailyMatch[2] ? parseInt(dailyMatch[2]!, 10) : 0;
    if (dailyMatch[3]) minute = 30; // explicit 半
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    // AM/PM hints
    if (/下午|晚上|晚间|晚/.test(trimmed) && hour < 12) hour += 12;
    if (/上午|早上|早/.test(trimmed) && hour === 12) hour = 0;
    const content = dailyMatch[4]!.trim();
    if (!content) return null;

    const next = dateAtTZ(hour, minute, 0);
    // If the time has already passed today, move to tomorrow
    if (next.getTime() <= Date.now()) {
      next.setDate(next.getDate() + 1);
    }

    return {
      nextRunAt: Math.floor(next.getTime() / 1000),
      cronExpr: `${minute} ${hour} * * *`,
      description: `每天${formatTimeCN(hour, minute)}`,
      content,
    };
  }

  // ── Recurring: 每周X Y点 ──
  const weeklyMatch = trimmed.match(
    /^每(?:周|星期)([一二三四五六日天])(?:上午|早上|早|下午|晚上|晚间|晚)?(\d{1,2})[点时](?:(\d{1,2})分?)?(半)?(?:[，,\s]*)([\s\S]+)$/,
  );
  if (weeklyMatch) {
    const dayChar = weeklyMatch[1]!;
    const cronDow = WEEKDAY_MAP[dayChar];
    if (cronDow === undefined) return null;

    let hour = parseInt(weeklyMatch[2]!, 10);
    let minute = weeklyMatch[3] ? parseInt(weeklyMatch[3]!, 10) : 0;
    if (weeklyMatch[4]) minute = 30;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    if (/下午|晚上|晚间|晚/.test(trimmed) && hour < 12) hour += 12;
    if (/上午|早上|早/.test(trimmed) && hour === 12) hour = 0;
    const content = weeklyMatch[5]!.trim();
    if (!content) return null;

    // Calculate next occurrence of this weekday
    const now = nowInTZ();
    const currentDow = now.getDay();
    let daysUntil = cronDow - currentDow;
    if (daysUntil < 0) daysUntil += 7;
    const candidate = dateAtTZ(hour, minute, daysUntil);
    if (candidate.getTime() <= Date.now()) {
      daysUntil += 7;
    }
    const next = dateAtTZ(hour, minute, daysUntil);

    const dayName = dayChar === '日' || dayChar === '天' ? '周日' : `周${dayChar}`;
    return {
      nextRunAt: Math.floor(next.getTime() / 1000),
      cronExpr: `${minute} ${hour} * * ${cronDow}`,
      description: `每${dayName}${formatTimeCN(hour, minute)}`,
      content,
    };
  }

  // ── One-time: 明天/后天 Y点 ──
  const dayOffsetMap: Record<string, number> = { '明天': 1, '后天': 2 };
  const oneTimeMatch = trimmed.match(
    /^(明天|后天)(?:上午|早上|早|下午|晚上|晚间|晚)?(\d{1,2})[点时](?:(\d{1,2})分?)?(半)?(?:[，,\s]*)([\s\S]+)$/,
  );
  if (oneTimeMatch) {
    const dayWord = oneTimeMatch[1]!;
    const offset = dayOffsetMap[dayWord] ?? 1;
    let hour = parseInt(oneTimeMatch[2]!, 10);
    let minute = oneTimeMatch[3] ? parseInt(oneTimeMatch[3]!, 10) : 0;
    if (oneTimeMatch[4]) minute = 30;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    if (/下午|晚上|晚间|晚/.test(trimmed) && hour < 12) hour += 12;
    if (/上午|早上|早/.test(trimmed) && hour === 12) hour = 0;
    const content = oneTimeMatch[5]!.trim();
    if (!content) return null;

    const next = dateAtTZ(hour, minute, offset);
    return {
      nextRunAt: Math.floor(next.getTime() / 1000),
      cronExpr: null,
      description: `${dayWord}${formatTimeCN(hour, minute)}`,
      content,
    };
  }

  // ── One-time: Y点 (today, if still in future) ──
  const todayMatch = trimmed.match(
    /^(?:今天)?(?:上午|早上|早|下午|晚上|晚间|晚)?(\d{1,2})[点时](?:(\d{1,2})分?)?(半)?(?:[，,\s]*)([\s\S]+)$/,
  );
  if (todayMatch) {
    let hour = parseInt(todayMatch[1]!, 10);
    let minute = todayMatch[2] ? parseInt(todayMatch[2]!, 10) : 0;
    if (todayMatch[3]) minute = 30;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    if (/下午|晚上|晚间|晚/.test(trimmed) && hour < 12) hour += 12;
    if (/上午|早上|早/.test(trimmed) && hour === 12) hour = 0;
    const content = todayMatch[4]!.trim();
    if (!content) return null;

    const next = dateAtTZ(hour, minute, 0);
    if (next.getTime() <= Date.now()) return null; // already passed
    return {
      nextRunAt: Math.floor(next.getTime() / 1000),
      cronExpr: null,
      description: `今天${formatTimeCN(hour, minute)}`,
      content,
    };
  }

  return null; // can't parse
}

/** Format hour/minute as Chinese, e.g. "下午3点30分" */
function formatTimeCN(hour: number, minute: number): string {
  let prefix = '';
  if (hour < 6) prefix = '凌晨';
  else if (hour < 12) prefix = '上午';
  else if (hour === 12) prefix = '中午';
  else if (hour < 18) { prefix = '下午'; hour -= 12; }
  else { prefix = '晚上'; hour -= 12; }

  if (minute === 0) return `${prefix}${hour}点`;
  return `${prefix}${hour}点${minute}分`;
}

/** Format unix timestamp as human-readable Asia/Shanghai time string */
function formatTimestamp(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleString('zh-CN', { timeZone: TZ, hour12: false });
}

// ── Main handler: set up a scheduled message ──────────────────────────

export async function handleScheduleMessage(
  dmChatId: number,
  formatted: FormattedMessage,
  content: string,
  _groupName?: string,
): Promise<void> {
  void _groupName;
  await sendChatAction(dmChatId, 'typing');

  // 1. Parse time from content
  const parsed = parseScheduleTime(content);
  if (!parsed) {
    await sender.sendDirect(
      dmChatId,
      '本喵没看懂时间喵😅 试试这样：\n\n' +
      '• 明天9点 提醒大家开会\n' +
      '• 每天上午10点 打卡签到\n' +
      '• 每周五下午2点 周报总结\n' +
      '• 30分钟后 该喝水了\n' +
      '• 2小时后 休息一下',
      formatted.messageId,
    );
    return;
  }

  // 2. Resolve group — use DM chatId as default (reminder sent to user directly)
  // Only use group if user explicitly wants it in a group
  const groupId = dmChatId; // default: send reminder via DM

  // 3. Insert into scheduled_messages
  const now = Math.floor(Date.now() / 1000);
  try {
    // Rate limit: max 5 active scheduled messages per user
    const activeCount = getDb().prepare(
      'SELECT COUNT(*) as cnt FROM scheduled_messages WHERE owner_id = ? AND active = 1'
    ).get(formatted.uid) as { cnt: number };
    if (activeCount.cnt >= 5) {
      await sender.sendDirect(dmChatId, '你已经有5个定时提醒了喵~ 先取消一些再设新的吧！', formatted.messageId);
      return;
    }

    const stmt = getDb().prepare(`
      INSERT INTO scheduled_messages (owner_id, group_id, content, next_run_at, cron_expr, timezone, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `);
    const info = stmt.run(
      formatted.uid,
      groupId,
      parsed.content,
      parsed.nextRunAt,
      parsed.cronExpr,
      TZ,
      now,
    );

    const scheduleType = parsed.cronExpr ? '🔄 循环' : '⏰ 一次性';
    await sender.sendDirect(
      dmChatId,
      `✅ 已设置定时提醒喵~\n\n` +
      `📋 内容：${parsed.content}\n` +
      `📅 时间：${parsed.description}（${formatTimestamp(parsed.nextRunAt)}）\n` +
      `📍 提醒方式：私聊\n` +
      `🔁 类型：${scheduleType}\n` +
      `🆔 编号：${info.lastInsertRowid}\n\n` +
      `取消请说 "取消提醒 ${info.lastInsertRowid}"`,
      formatted.messageId,
    );

    logger.info({
      id: info.lastInsertRowid,
      ownerUid: formatted.uid,
      groupId: groupId,
      nextRunAt: parsed.nextRunAt,
      cronExpr: parsed.cronExpr,
    }, 'Scheduled message created');
  } catch (err) {
    logger.error({ err, ownerUid: formatted.uid, groupId: groupId }, 'Failed to create scheduled message');
    await sender.sendDirect(dmChatId, '创建定时提醒失败了喵，稍后再试试~', formatted.messageId);
  }
}

// ── Cron executor: run due scheduled messages ──────────────────────────

interface ScheduledRow {
  id: number;
  owner_id: number;
  group_id: number;
  content: string;
  next_run_at: number;
  cron_expr: string | null;
  timezone: string;
  active: number;
  last_run_at: number | null;
  run_count: number;
}

/** Max consecutive failures before auto-deactivating */
const MAX_CONSECUTIVE_FAILURES = 3;

export async function executeScheduledMessages(): Promise<number> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const rows = db.prepare(`
    SELECT * FROM scheduled_messages WHERE active = 1 AND next_run_at <= ?
  `).all(now) as ScheduledRow[];

  if (rows.length === 0) return 0;

  let executed = 0;

  for (const row of rows) {
    try {
      // Check consecutive failures via Redis counter
      const failKey = `xxb:sched:fail:${row.id}`;
      const failCount = parseInt((await getRedis().get(failKey)) ?? '0', 10);

      if (failCount >= MAX_CONSECUTIVE_FAILURES) {
        // Auto-deactivate
        db.prepare('UPDATE scheduled_messages SET active = 0 WHERE id = ?').run(row.id);
        // Notify owner
        try {
          await sendMessage(
            row.owner_id,
            `⚠️ 定时提醒 #${row.id} 连续发送失败${MAX_CONSECUTIVE_FAILURES}次，已自动停用。\n内容：${row.content}`,
          );
        } catch {
          // Best effort — owner may have blocked the bot
        }
        logger.warn({ id: row.id, failCount }, 'Scheduled message auto-deactivated after consecutive failures');
        continue;
      }

      // B2(借鉴 CGM):到点提醒**唤醒 LLM** 用群里新鲜上下文、用自己的语气说出来,
      // 而非机械念稿「⏰定时提醒:X」。SCHEDULE_LLM_WAKE 关 → 退回固定字符串;生成失败也退回。
      let reminderSent = false;
      if (env().SCHEDULE_LLM_WAKE) {
        try {
          const { generatePersonaProactiveText } = await import('../../turn/proactive-turn.js');
          const { getBotUid } = await import('../../../bot/bot.js');
          const intent = `[到点提醒] 你之前答应到点提醒大家这件事:「${row.content}」。现在到点了,用你自己的语气自然地说出来——别像闹钟念稿、别加"⏰定时提醒"这种前缀,就像突然想起来要提醒大家一样。`;
          const text = await generatePersonaProactiveText(row.group_id, getBotUid(), intent);
          if (text) {
            await sendMessage(row.group_id, text);
            reminderSent = true;
          }
        } catch (err) {
          logger.debug({ err, id: row.id }, 'schedule LLM wake failed, falling back to canned reminder');
        }
      }
      if (!reminderSent) {
        await sendMessage(row.group_id, `⏰ 定时提醒：${row.content}`);
      }

      // Update: success
      db.prepare(`
        UPDATE scheduled_messages
        SET last_run_at = ?, run_count = run_count + 1
        WHERE id = ?
      `).run(now, row.id);

      // Clear failure counter
      await getRedis().del(failKey);

      if (row.cron_expr) {
        // Recurring: calculate next_run_at
        const nextRun = calculateNextCronRun(row.cron_expr, row.timezone);
        if (nextRun) {
          db.prepare('UPDATE scheduled_messages SET next_run_at = ? WHERE id = ?').run(nextRun, row.id);
        } else {
          // Can't calculate next — deactivate
          db.prepare('UPDATE scheduled_messages SET active = 0 WHERE id = ?').run(row.id);
          logger.warn({ id: row.id, cronExpr: row.cron_expr }, 'Could not calculate next cron run, deactivating');
        }
      } else {
        // One-time: deactivate
        db.prepare('UPDATE scheduled_messages SET active = 0 WHERE id = ?').run(row.id);
      }

      executed++;
      logger.info({ id: row.id, groupId: row.group_id, cronExpr: row.cron_expr }, 'Scheduled message executed');
    } catch (err) {
      // Increment failure counter in Redis (expire after 1 hour)
      const failKey = `xxb:sched:fail:${row.id}`;
      const newCount = await getRedis().incr(failKey);
      await getRedis().expire(failKey, 3600);

      logger.error({ err, id: row.id, failCount: newCount }, 'Scheduled message execution failed');
    }
  }

  return executed;
}

// ── Cron next-run calculator ──────────────────────────

/**
 * Calculate the next unix timestamp for a cron expression.
 * Supports: minute hour * * dow (5-field format).
 * This is a simple implementation for the common patterns used by schedule.
 */
function calculateNextCronRun(cronExpr: string, _timezone: string): number | null {
  void _timezone;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minute = parseInt(parts[0]!, 10);
  const hour = parseInt(parts[1]!, 10);
  const dowPart = parts[4]!;

  if (isNaN(minute) || isNaN(hour)) return null;

  const now = nowInTZ();

  if (dowPart === '*') {
    // Daily: find next occurrence of hour:minute
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return Math.floor(candidate.getTime() / 1000);
  } else {
    // Weekly: find next matching day-of-week
    const targetDow = parseInt(dowPart, 10);
    if (isNaN(targetDow) || targetDow < 0 || targetDow > 6) return null;

    for (let offset = 0; offset <= 7; offset++) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + offset);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate.getDay() === targetDow && candidate.getTime() > now.getTime()) {
        return Math.floor(candidate.getTime() / 1000);
      }
    }
    return null;
  }
}

// ── List scheduled messages ──────────────────────────

interface ScheduledListRow {
  id: number;
  group_id: number;
  content: string;
  next_run_at: number;
  cron_expr: string | null;
  active: number;
  run_count: number;
}

export async function handleListScheduled(
  dmChatId: number,
  formatted: FormattedMessage,
): Promise<void> {
  const rows = getDb().prepare(`
    SELECT id, group_id, content, next_run_at, cron_expr, active, run_count
    FROM scheduled_messages
    WHERE owner_id = ? AND active = 1
    ORDER BY next_run_at ASC
  `).all(formatted.uid) as ScheduledListRow[];

  if (rows.length === 0) {
    await sender.sendDirect(dmChatId, '你还没有定时提醒喵~\n\n设置一个试试：\n"明天9点 提醒大家开会"', formatted.messageId);
    return;
  }

  const lines = rows.map((r, i) => {
    const type = r.cron_expr ? '🔄' : '⏰';
    const nextTime = formatTimestamp(r.next_run_at);
    return `${i + 1}. ${type} #${r.id} | ${r.content}\n   📅 ${nextTime} | 已执行${r.run_count}次`;
  });

  await sender.sendDirect(
    dmChatId,
    `📋 你的定时提醒列表：\n\n${lines.join('\n\n')}\n\n取消请说 "取消提醒 #编号"`,
    formatted.messageId,
  );
}

// ── Cancel scheduled message ──────────────────────────

export async function handleCancelScheduled(
  dmChatId: number,
  formatted: FormattedMessage,
  id: number,
): Promise<void> {
  const row = getDb().prepare(`
    SELECT id, content, active FROM scheduled_messages WHERE id = ? AND owner_id = ?
  `).get(id, formatted.uid) as { id: number; content: string; active: number } | undefined;

  if (!row) {
    await sender.sendDirect(dmChatId, `找不到编号 #${id} 的定时提醒喵~\n\n查看你的提醒：说 "我的提醒"`, formatted.messageId);
    return;
  }

  if (!row.active) {
    await sender.sendDirect(dmChatId, `提醒 #${id} 已经停用了喵~`, formatted.messageId);
    return;
  }

  getDb().prepare('UPDATE scheduled_messages SET active = 0 WHERE id = ?').run(id);

  await sender.sendDirect(
    dmChatId,
    `✅ 已取消定时提醒 #${id}\n内容：${row.content}`,
    formatted.messageId,
  );

  logger.info({ id, ownerUid: formatted.uid }, 'Scheduled message cancelled');
}

// ── Alias: handleMySchedules ──────────────────────────

export async function handleMySchedules(
  dmChatId: number,
  formatted: FormattedMessage,
): Promise<void> {
  await handleListScheduled(dmChatId, formatted);
}
