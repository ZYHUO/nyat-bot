// ────────────────────────────────────────
// Behavioral roles / 群友角色
//
// Periodically tags the most active users in a group with a behavioral archetype
// (龙王 / 技术专家 / 夜猫子 / 表情包军火库 / 潜水员 …) + a one-line rationale, derived
// from message-pattern stats (volume, length, emoji/sticker ratio, night ratio,
// reply ratio). Injected as a compact "群友角色" hint so the bot relates to people
// by their group persona. Ported from astrbot_plugin_qq_group_daily_analysis.
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import { getRecent } from '../pipeline/context/manager.js';
import { callWithFallback } from '../ai/fallback.js';
import { logger } from '../shared/logger.js';

const ROLE_ANALYSIS_BATCH_SIZE = 8;   // tunable — users tagged per call
const ROLE_ANALYSIS_MIN_MSGS = 5;     // tunable — min messages to be eligible
const ROLE_ANALYSIS_WINDOW = 250;     // tunable — recent messages scanned for stats
const ROLE_HINT_LIMIT = 8;            // tunable — roles injected into a prompt
const ROLE_HINT_CHARS = 400;          // tunable — char budget for the injected hint
const EMOJI_RE = /\p{Extended_Pictographic}/u;

const log = logger.child({ mod: 'behavioral-roles' });

interface UserStat {
  uid: number;
  name: string;
  msgs: number;
  avgChars: number;
  emojiRatio: number;
  nightRatio: number;   // share of msgs sent 0:00–6:00
  replyRatio: number;   // share of msgs that reply to someone
}

/** Aggregate per-user message-pattern stats from the recent window. */
export async function collectUserStats(chatId: number): Promise<UserStat[]> {
  const recent = await getRecent(chatId, ROLE_ANALYSIS_WINDOW);
  const acc = new Map<number, { name: string; msgs: number; chars: number; emoji: number; night: number; reply: number }>();
  for (const m of recent) {
    if (m.isBot || m.role === 'assistant' || !m.uid) continue;
    const text = m.textContent || m.captionContent || '';
    const a = acc.get(m.uid) ?? { name: m.fullName || m.username || `uid:${m.uid}`, msgs: 0, chars: 0, emoji: 0, night: 0, reply: 0 };
    a.name = m.fullName || m.username || a.name;
    a.msgs += 1;
    a.chars += text.length;
    if (EMOJI_RE.test(text) || m.sticker) a.emoji += 1;
    const hour = new Date(m.timestamp * 1000).getHours();
    if (hour < 6) a.night += 1;
    if (m.replyTo) a.reply += 1;
    acc.set(m.uid, a);
  }
  return [...acc.entries()]
    .map(([uid, a]) => ({
      uid, name: a.name, msgs: a.msgs,
      avgChars: Math.round(a.chars / a.msgs),
      emojiRatio: +(a.emoji / a.msgs).toFixed(2),
      nightRatio: +(a.night / a.msgs).toFixed(2),
      replyRatio: +(a.reply / a.msgs).toFixed(2),
    }))
    .filter((s) => s.msgs >= ROLE_ANALYSIS_MIN_MSGS)
    .sort((a, b) => b.msgs - a.msgs)
    .slice(0, ROLE_ANALYSIS_BATCH_SIZE);
}

interface RoleAssignment { uid: number; role: string; mbti?: string; reason?: string }

/** Parse the LLM role-assignment JSON array. Robust to fences/prose. */
export function parseRoleAssignments(raw: string): RoleAssignment[] {
  try {
    const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = cleaned.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : cleaned) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => x as Record<string, unknown>)
      .filter((x) => typeof x.uid === 'number' && typeof x.role === 'string' && (x.role as string).trim())
      .map((x) => ({
        uid: x.uid as number,
        role: (x.role as string).trim().slice(0, 20),
        mbti: typeof x.mbti === 'string' ? x.mbti.trim().slice(0, 8) : '',
        reason: typeof x.reason === 'string' ? x.reason.trim().slice(0, 60) : '',
      }));
  } catch {
    return [];
  }
}

function upsertRole(chatId: number, r: RoleAssignment): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO user_roles (chat_id, uid, role_name, rationale, mbti, assigned_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, uid) DO UPDATE SET role_name = excluded.role_name,
      rationale = excluded.rationale, mbti = excluded.mbti, updated_at = excluded.updated_at
  `).run(chatId, r.uid, r.role, r.reason ?? '', r.mbti ?? '', now, now);
}

/** Analyze a chat's active users and (re)assign behavioral roles. Returns count assigned. */
export async function analyzeUserRoles(chatId: number): Promise<number> {
  const stats = await collectUserStats(chatId);
  if (stats.length === 0) return 0;

  const table = stats.map((s) =>
    `uid=${s.uid} ${s.name}: 消息${s.msgs}条, 平均${s.avgChars}字, 表情率${s.emojiRatio}, 夜间率${s.nightRatio}, 回复率${s.replyRatio}`,
  ).join('\n');

  const system =
    '你是群聊行为分析师。根据每个群友的发言统计，给他们各分配一个有趣的"群角色"称号 + 推测的 MBTI + 一句话理由。' +
    '角色称号要生动口语，例如：龙王(话痨)、技术专家、夜猫子、表情包军火库、潜水员、评论家(长文)、互动达人、阳角、捧哏。' +
    '只输出JSON数组：[{"uid":数字,"role":"称号","mbti":"ENFP","reason":"简短理由"}]，每个 uid 一条。';
  const user = `群友发言统计：\n${table}\n\n给每人分配角色：`;

  try {
    const result = await callWithFallback({
      usage: 'summarize',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      maxTokens: 400,
      temperature: 0.6,
    });
    const assignments = parseRoleAssignments(result.content);
    const validUids = new Set(stats.map((s) => s.uid));
    let n = 0;
    for (const a of assignments) {
      if (!validUids.has(a.uid)) continue; // ignore hallucinated uids
      upsertRole(chatId, a);
      n += 1;
    }
    log.info({ chatId, assigned: n }, 'Behavioral roles assigned');
    return n;
  } catch (err) {
    log.debug({ err, chatId }, 'analyzeUserRoles failed (non-critical)');
    return 0;
  }
}

/** Cron entry: re-assign roles for all recently-active groups. Returns chats processed. */
export async function runRoleAnalysis(): Promise<number> {
  let chatIds: number[] = [];
  try {
    const raw = await getRedis().zrange('xxb:active_groups', 0, -1);
    chatIds = raw.map(Number).filter((n) => !Number.isNaN(n) && n < 0);
  } catch (err) {
    log.debug({ err }, 'runRoleAnalysis: active-group discovery failed');
    return 0;
  }
  let processed = 0;
  for (const chatId of chatIds) {
    try {
      if (await analyzeUserRoles(chatId) > 0) processed += 1;
    } catch (err) {
      log.debug({ err, chatId }, 'runRoleAnalysis: chat failed');
    }
  }
  return processed;
}

interface RoleRow { uid: number; role_name: string }

/** Compact "群友角色" injection block for a chat, or null. */
export function buildRoleHint(chatId: number): string | null {
  let rows: RoleRow[];
  try {
    rows = getDb().prepare(
      'SELECT uid, role_name FROM user_roles WHERE chat_id = ? ORDER BY updated_at DESC LIMIT ?',
    ).all(chatId, ROLE_HINT_LIMIT) as RoleRow[];
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  const parts: string[] = [];
  let total = 0;
  for (const r of rows) {
    const piece = `${r.role_name}(uid:${r.uid})`;
    if (total + piece.length + 1 > ROLE_HINT_CHARS) break;
    parts.push(piece);
    total += piece.length + 1;
  }
  return parts.length > 0 ? parts.join('、') : null;
}
