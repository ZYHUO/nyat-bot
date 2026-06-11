// ────────────────────────────────────────
// 缘分签 — DM handler
// 用户说"缘分签"或"抽签" → 基于历史对话 + 用户 data 生成今日运势
// 每人每天一次，不查询其他用户 data
// ────────────────────────────────────────

import { getDb } from '../../../db/sqlite.js';
import { logger } from '../../../shared/logger.js';
import { StreamingSender } from '../../../bot/sender/streaming.js';
import { callWithFallback } from '../../../ai/fallback.js';
import { getUserGroups } from '../../context/manager.js';

const log = logger.child({ mod: 'dm:fate' });

const FATE_EMOJIS = ['🎐', '🎋', '🎑', '🏮', '🪷', '🌸', '🦋', '🌙', '⭐', '🔮'];
const FATE_CATEGORIES = [
  '事业运', '桃花运', '财运', '健康运', '学业运',
  '友情运', '家庭运', '旅行运', '美食运', '灵感运',
];

/**
 * Handle "缘分签" or "抽签" commands.
 */
export async function handleFate(
  ctx: { uid: number; chatId: number; messageId: number },
  sender: StreamingSender,
): Promise<boolean> {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

  const db = getDb();
  const existing = db.prepare(
    'SELECT card1, card2, interpretation, blessing FROM fate_history WHERE user_id = ? AND drawn_at = ?',
  ).get(String(ctx.uid), today) as { card1: string; card2: string; interpretation: string; blessing: string } | undefined;

  if (existing) {
    await sender.sendDirect(ctx.chatId,
      `🎋 你今天已经抽过缘分签啦~\n\n` +
      `${existing.interpretation}\n\n` +
      `${existing.blessing}`,
    );
    return true;
  }

  const emoji1 = FATE_EMOJIS[Math.floor(Math.random() * FATE_EMOJIS.length)]!;
  const emoji2 = FATE_EMOJIS[Math.floor(Math.random() * FATE_EMOJIS.length)]!;
  const cat1 = FATE_CATEGORIES[Math.floor(Math.random() * FATE_CATEGORIES.length)]!;
  const cat2 = FATE_CATEGORIES[Math.floor(Math.random() * FATE_CATEGORIES.length)]!;

  const userContext = await gatherUserContext(ctx.uid);

  const prompt = `你是啾咪囝,群里那只偶尔摆摊算命的猫娘。有人来抽今日缘分签,给 TA 起一支。

关于 TA:
${userContext}

要起的内容:
1. 签文:2-3 句,围绕"${cat1}"和"${cat2}"——要有签文那种半真半假的诗意,也要有点俏皮,最好能蹭到 TA 的信息(让 TA 觉得这签是给 TA 一个人起的)
2. 祝福:一句,落在实处的温暖,不要"万事如意"式套话

规则:
- 猫腔可以有,但别靠"喵"凑数;不提"猫娘""AI"这些词
- 只输出 JSON:{"interpretation": "签文", "blessing": "祝福"}`;

  let interpretation: string;
  let blessing: string;

  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: '你是啾咪囝,会起签的猫娘:签文半真半假有诗意,落点温暖。只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.9,
    });

    const parsed = JSON.parse(result.content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, ''));
    interpretation = parsed.interpretation || '今日运势平稳，一切顺其自然~';
    blessing = parsed.blessing || '愿你每天都开开心心的喵~';
  } catch (err) {
    log.warn({ err }, 'fate AI failed, using fallback');
    interpretation = `${emoji1} ${cat1}方面会有小惊喜，${emoji2} ${cat2}需要多留意~`;
    blessing = '愿好运常伴你左右，喵~';
  }

  // Record which group this user belongs to (first known), for analytics
  let groupId: string | null = null;
  try {
    const groups = await getUserGroups(ctx.uid);
    if (groups.length > 0) groupId = String(groups[0]);
  } catch { /* group_id stays null */ }

  try {
    db.prepare(
      'INSERT INTO fate_history (user_id, group_id, card1, card2, interpretation, blessing, drawn_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(String(ctx.uid), groupId, cat1, cat2, interpretation, blessing, today);
  } catch (err) {
    // UNIQUE constraint race — another request just inserted; re-read and show that
    const raced = db.prepare(
      'SELECT card1, card2, interpretation, blessing FROM fate_history WHERE user_id = ? AND drawn_at = ?',
    ).get(String(ctx.uid), today) as { card1: string; card2: string; interpretation: string; blessing: string } | undefined;
    if (raced) {
      await sender.sendDirect(ctx.chatId,
        `🎋 你今天已经抽过缘分签啦~\n\n${raced.interpretation}\n\n${raced.blessing}`,
      );
      return true;
    }
    log.warn({ err }, 'fate save failed');
    await sender.sendDirect(ctx.chatId, '🎋 抽签出了点小问题，再试一次吧~');
    return true;
  }

  const response = [
    `🎋 今日缘分签 ${emoji1}${emoji2}`,
    ``,
    interpretation,
    ``,
    blessing,
  ].join('\n');

  await sender.sendDirect(ctx.chatId, response);
  return true;
}

/**
 * Gather user context from database for fortune generation.
 */
async function gatherUserContext(uid: number): Promise<string> {
  const db = getDb();
  const parts: string[] = [];

  // user_profiles schema: chat_id, uid, username, full_name, sender_tag, profile_prompt
  const profile = db.prepare(
    'SELECT full_name, username, profile_prompt FROM user_profiles WHERE uid = ?',
  ).get(uid) as { full_name?: string; username?: string; profile_prompt?: string } | undefined;

  if (profile?.full_name) parts.push(`昵称：${profile.full_name}`);
  if (profile?.username) parts.push(`用户名：@${profile.username}`);
  if (profile?.profile_prompt) parts.push(`个性签名：${profile.profile_prompt}`);

  // 最近发言:读 user_profiles.pending_messages(滚动 JSON 数组,每条入站
  // 消息都在写,跨群按 updated_at 取最活跃的几个)。旧的 messages 表自上下文
  // 迁去 Redis 后零写入,从它 SELECT 永远为空 —— "最近发言"静默缺失。
  const profileRows = db.prepare(
    'SELECT pending_messages FROM user_profiles WHERE uid = ? ORDER BY updated_at DESC LIMIT 3',
  ).all(uid) as Array<{ pending_messages: string }>;
  const recentTexts: string[] = [];
  for (const row of profileRows) {
    try {
      const arr = (JSON.parse(row.pending_messages) as unknown[])
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '');
      // 数组内旧→新;新的在前展示(对齐旧 ORDER BY created_at DESC)
      for (const t of arr.reverse()) {
        recentTexts.push(t);
        if (recentTexts.length >= 5) break;
      }
    } catch { /* 单行坏 JSON 不拖累其余 */ }
    if (recentTexts.length >= 5) break;
  }
  if (recentTexts.length > 0) {
    parts.push(`最近发言：${recentTexts.join('；')}`);
  }

  // member_profiles schema: owner_id, target_id, notes, tags
  const notes = db.prepare(
    "SELECT notes, tags FROM member_profiles WHERE target_id = ? ORDER BY updated_at DESC LIMIT 3",
  ).all(uid) as Array<{ notes: string; tags: string }>;

  if (notes.length > 0) {
    const noteTexts = notes
      .map(n => n.notes)
      .filter(Boolean);
    if (noteTexts.length > 0) {
      parts.push(`他人备注：${noteTexts.join('；')}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : '暂无更多信息';
}
