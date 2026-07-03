// ────────────────────────────────────────
// 深度反思(A)—— 把 StepFun 配额花在"让 bot 记住群里发生过什么"
// ────────────────────────────────────────
// group-episodes 只挑 0-2 条"事件"、每 2h 只吃 6 个群,吞吐极小。这里对一批活跃群
// 喂**大窗口**历史,产出一份**每群滚动近况摘要**(在聊什么/氛围/最近的梗和事/
// 谁在活跃/有什么待跟进),存 chat_reflection,注入回复的 [本群近况] 块。
//
// 吞吐是旋钮:token/天 ≈ CHATS_PER_TICK × (WINDOW×~15) × (1440/INTERVAL_MIN)。
// 每 tick 打点估算 token,便于手调到目标(如 ~100M/天)。仅 REFLECTION_ENABLED 生效。

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { callWithFallback } from '../ai/fallback.js';
import { getRecent } from '../pipeline/context/manager.js';
import { getRedis } from '../db/redis.js';

const MIN_MSGS = 20; // 太冷的群不值得反思

const SYSTEM_PROMPT =
  '你是群聊的长期记忆整理器。下面是一个群最近的聊天记录。请提炼一份**给 bot 看的**"本群近况"' +
  '简报,帮它像老群友一样了解这个群此刻的状态。涵盖(有则写、无则略,总共 ≤180 字):' +
  '① 最近在聊的话题/热点;② 群里的氛围与调性;③ 新诞生的梗/内部黑话;④ 谁最近很活跃/发生了什么值得记的事;' +
  '⑤ 有没有悬而未决、日后可以自然接回的话头。用自然中文,分点或短段都行,不要复述原话、不要 JSON、不要客套。';

/** 反思单个群:大窗口历史 → 近况摘要,写回 chat_reflection。返回本次输入的近似 token。 */
export async function reflectChat(chatId: number): Promise<number> {
  const e = env();
  const recent = await getRecent(chatId, e.REFLECTION_WINDOW_MSGS);
  const msgs = recent.filter((m) => !m.isBot && (m.textContent || m.captionContent || '').trim());
  if (msgs.length < MIN_MSGS) return 0;

  const lines = msgs
    .map((m) => `${m.fullName || m.username || '?'}: ${(m.textContent || m.captionContent || '').slice(0, 120)}`)
    .join('\n');

  let digest = '';
  try {
    const result = await callWithFallback({
      usage: e.REFLECTION_USAGE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `群最近 ${msgs.length} 条聊天:\n${lines}\n\n输出「本群近况」简报:` },
      ],
      maxTokens: 16000, // high 推理留足天花板(实测high≤1559,永不截断)
      temperature: 0.4,
    });
    digest = result.content.trim().slice(0, 600);
  } catch (err) {
    // info 级(只在失败时打,不刷屏):灰度排障要能看见 LLM 到底为啥没产出。
    const em = err instanceof Error ? err.message : String(err);
    logger.info({ chatId, msgs: msgs.length, err: em.slice(0, 120) }, 'deep-reflection: LLM failed');
    return 0;
  }
  if (digest.length < 10) {
    logger.info({ chatId, msgs: msgs.length, digestLen: digest.length }, 'deep-reflection: digest too short, skipped');
    return 0;
  }

  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    `INSERT INTO chat_reflection (chat_id, digest, msg_count, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET digest = excluded.digest, msg_count = excluded.msg_count, updated_at = excluded.updated_at`,
  ).run(chatId, digest, msgs.length, now);

  return Math.ceil(lines.length / 3); // 近似输入 token(中文 ~3 字符/token)
}

/** cron 入口:反思一批活跃群。 */
export async function runDeepReflection(): Promise<void> {
  const e = env();
  if (!e.REFLECTION_ENABLED) return;

  let chatIds: number[] = [];
  try {
    // 最近活跃的群(zset score=最后活跃),取最多 CHATS_PER_TICK 个。
    const raw = await getRedis().zrange('xxb:active_groups', -e.REFLECTION_CHATS_PER_TICK, -1);
    chatIds = raw.map(Number).filter((n) => n < 0);
  } catch (err) {
    logger.warn({ err }, 'deep-reflection: active-group query failed');
    return;
  }
  if (chatIds.length === 0) return;

  let reflected = 0;
  let approxInputTokens = 0;
  for (const chatId of chatIds) {
    const t = await reflectChat(chatId).catch(() => 0);
    if (t > 0) { reflected++; approxInputTokens += t; }
  }
  // 估算日 token,便于手调旋钮到目标(输入+输出粗算 ×1.15)。
  const ticksPerDay = Math.max(1, Math.round(1440 / e.REFLECTION_INTERVAL_MIN));
  const estPerDay = Math.round(approxInputTokens * 1.15 * ticksPerDay);
  logger.info(
    { reflected, chats: chatIds.length, approxInputTokens, estTokensPerDay: estPerDay, ticksPerDay },
    'deep-reflection tick complete',
  );
}

/** 回复注入用:该群的近况摘要(无则 null)。 */
export function getChatReflection(chatId: number): string | null {
  try {
    const row = getDb().prepare('SELECT digest FROM chat_reflection WHERE chat_id = ?').get(chatId) as { digest: string } | undefined;
    return row?.digest?.trim() || null;
  } catch {
    return null;
  }
}
