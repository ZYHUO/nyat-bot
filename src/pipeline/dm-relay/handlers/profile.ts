// ────────────────────────────────────────
// Member Profiles (群友小档案) — private notes about other users
// ────────────────────────────────────────

import { getDb } from '../../../db/sqlite.js';
import { getRedis } from '../../../db/redis.js';
import { sendMessage, sendChatAction } from '../../../bot/sender/telegram.js';
import { StreamingSender } from '../../../bot/sender/streaming.js';
import { logger } from '../../../shared/logger.js';
import { resolveTarget } from '../target-resolver.js';
import { getUserGroups } from '../../context/manager.js';
import type { FormattedMessage } from '../../../shared/types.js';
import type { ResolvedTarget } from '../target-resolver.js';

/** Safe JSON.parse for tags array — returns comma-separated string */
function safeParseTags(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(t => typeof t === 'string').join(', ');
    return String(parsed);
  } catch {
    return raw; // return raw string as fallback
  }
}

const sender = new StreamingSender();

// ── helpers ──────────────────────────────

/** Resolve a target handle across the owner's common groups */
async function resolveTargetInContext(
  ownerUid: number,
  targetHandle: string,
): Promise<ResolvedTarget | null> {
  const ownerGroups = await getUserGroups(ownerUid);
  for (const chatId of ownerGroups) {
    const target = await resolveTarget(chatId, targetHandle);
    if (target) return target;
  }
  return null;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ── exported handlers ────────────────────

/** Set or update a profile for a target user */
export async function handleSetProfile(
  dmChatId: number,
  formatted: FormattedMessage,
  targetHandle: string,
  notes: string,
): Promise<void> {
  const senderUid = formatted.uid;
  const target = await resolveTargetInContext(senderUid, targetHandle);
  if (!target) {
    await sender.sendDirect(dmChatId, '找不到这个人喵… 确认一下名字或 @ 呀~', formatted.messageId);
    return;
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO member_profiles (owner_id, target_id, notes, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(owner_id, target_id) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at
  `).run(senderUid, target.uid, notes, now());

  const displayName = target.username ? `@${target.username}` : target.fullName;
  await sender.sendDirect(dmChatId, `📝 已记录关于 ${displayName} 的小档案喵~`, formatted.messageId);
}

/** Set/replace tags for a target user's profile */
export async function handleSetProfileTags(
  dmChatId: number,
  formatted: FormattedMessage,
  targetHandle: string,
  tagsRaw: string,
): Promise<void> {
  const senderUid = formatted.uid;
  const target = await resolveTargetInContext(senderUid, targetHandle);
  if (!target) {
    await sender.sendDirect(dmChatId, '找不到这个人喵… 确认一下名字或 @ 呀~', formatted.messageId);
    return;
  }

  // Split on comma / fullwidth comma / whitespace; dedupe; cap length
  const tags = [...new Set(
    tagsRaw.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean),
  )].slice(0, 10);

  if (tags.length === 0) {
    await sender.sendDirect(dmChatId, '要打什么标签喵？例如：给张三打标签 程序员,北京', formatted.messageId);
    return;
  }

  const db = getDb();
  // Upsert: create the profile row if it doesn't exist yet
  db.prepare(`
    INSERT INTO member_profiles (owner_id, target_id, notes, tags, updated_at)
    VALUES (?, ?, '', ?, ?)
    ON CONFLICT(owner_id, target_id) DO UPDATE SET tags = excluded.tags, updated_at = excluded.updated_at
  `).run(senderUid, target.uid, JSON.stringify(tags), now());

  const displayName = target.username ? `@${target.username}` : target.fullName;
  await sender.sendDirect(dmChatId, `🏷️ 已给 ${displayName} 打上标签：${tags.join('、')}`, formatted.messageId);
}

/** View a profile for a target user */
export async function handleViewProfile(
  dmChatId: number,
  formatted: FormattedMessage,
  targetHandle: string,
): Promise<void> {
  const senderUid = formatted.uid;
  const target = await resolveTargetInContext(senderUid, targetHandle);
  if (!target) {
    await sender.sendDirect(dmChatId, '找不到这个人喵… 确认一下名字或 @ 呀~', formatted.messageId);
    return;
  }

  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM member_profiles WHERE owner_id = ? AND target_id = ?',
  ).get(senderUid, target.uid) as {
    notes: string; tags: string | null; notify_on_speak: number;
    created_at: number; updated_at: number;
  } | undefined;

  const displayName = target.username ? `@${target.username}` : target.fullName;

  if (!row) {
    await sender.sendDirect(dmChatId, `你还没给 ${displayName} 写过小档案喵~`, formatted.messageId);
    return;
  }

  const tags = row.tags ? safeParseTags(row.tags) : '无';
  const notify = row.notify_on_speak ? '✅ 开启' : '❌ 关闭';
  const text = [
    `📋 **${displayName}** 的小档案`,
    '',
    `📝 备注：${row.notes || '(空)'}`,
    `🏷️ 标签：${tags}`,
    `🔔 发言提醒：${notify}`,
    `🕐 更新时间：${new Date(row.updated_at * 1000).toLocaleString('zh-CN')}`,
  ].join('\n');
  await sender.sendDirect(dmChatId, text, formatted.messageId);
}

/** List all profiles the user has created */
export async function handleListProfiles(
  dmChatId: number,
  formatted: FormattedMessage,
): Promise<void> {
  const senderUid = formatted.uid;
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM member_profiles WHERE owner_id = ? ORDER BY updated_at DESC',
  ).all(senderUid) as {
    target_id: number; notes: string; tags: string | null; notify_on_speak: number;
  }[];

  if (rows.length === 0) {
    await sender.sendDirect(dmChatId, '你还没有写过任何小档案喵~', formatted.messageId);
    return;
  }

  const lines = rows.map((r, i) => {
    const firstLine = (r.notes.split('\n')[0] ?? '').slice(0, 40);
    const tags = r.tags ? safeParseTags(r.tags) : '';
    const tagStr = tags ? ` [${tags}]` : '';
    const notify = r.notify_on_speak ? ' 🔔' : '';
    return `${i + 1}. uid:${r.target_id} — ${firstLine}${tagStr}${notify}`;
  });

  await sender.sendDirect(dmChatId, `📂 你的小档案列表（${rows.length} 条）：\n\n${lines.join('\n')}`, formatted.messageId);
}

/** Toggle notification when a target speaks */
export async function handleProfileNotify(
  dmChatId: number,
  formatted: FormattedMessage,
  targetHandle: string,
  enabled: boolean,
): Promise<void> {
  const senderUid = formatted.uid;
  const target = await resolveTargetInContext(senderUid, targetHandle);
  if (!target) {
    await sender.sendDirect(dmChatId, '找不到这个人喵… 确认一下名字或 @ 呀~', formatted.messageId);
    return;
  }

  const db = getDb();
  const result = db.prepare(
    'UPDATE member_profiles SET notify_on_speak = ? WHERE owner_id = ? AND target_id = ?',
  ).run(enabled ? 1 : 0, senderUid, target.uid);

  const displayName = target.username ? `@${target.username}` : target.fullName;

  if (result.changes === 0) {
    await sender.sendDirect(dmChatId, `你还没给 ${displayName} 写过小档案喵~ 先用 /profile set 写一条吧~`, formatted.messageId);
    return;
  }

  const status = enabled ? '✅ 已开启' : '❌ 已关闭';
  await sender.sendDirect(dmChatId, `${status} ${displayName} 的发言提醒喵~`, formatted.messageId);
}

/**
 * Check and send profile notifications.
 * Called from pipeline when a non-bot user speaks in a group.
 */
export async function checkProfileNotifications(
  _chatId: number,
  formatted: FormattedMessage,
): Promise<void> {
  const speakerUid = formatted.uid;
  if (!speakerUid) return;

  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM member_profiles WHERE target_id = ? AND notify_on_speak = 1',
  ).all(speakerUid) as { owner_id: number; target_id: number; notes: string }[];

  if (rows.length === 0) return;

  const redis = getRedis();
  const speakerName = formatted.fullName ?? `uid:${speakerUid}`;

  for (const row of rows) {
    if (row.owner_id === row.target_id) continue; // don't self-notify

    const rateKey = `xxb:profile:notify:${row.owner_id}:${row.target_id}`;
    const already = await redis.exists(rateKey);
    if (already) continue;

    try {
      await sendChatAction(row.owner_id, 'typing');
      await sendMessage(
        row.owner_id,
        `🔔 你关注的 ${speakerName} 刚刚在群里发言了喵~`,
      );
      await redis.set(rateKey, '1', 'EX', 300);
    } catch (err) {
      logger.warn({ err, ownerId: row.owner_id }, 'Failed to send profile notification');
    }
  }
}
