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
import { incrCounter } from '../metrics/registry.js';

const MIN_MSGS = 20; // 太冷的群不值得反思
const FAIL_PREFIX = 'xxb:reflect:fail:';
// 链全灭的群冷却 30min 再试 —— 不退避则每个死群每 tick 白烧整条链 ×12s
// (2026-08-07 两连 tick 12/12 全灭;dsv4flash flaky + stepfun 订阅失效期间每 tick 照烧)。
const FAIL_COOLDOWN_SEC = 1800;

const SYSTEM_PROMPT =
  '你是群聊的长期记忆整理器。下面是一个群最近的聊天记录。请提炼一份**给 bot 看的**"本群近况"' +
  '简报,帮它像老群友一样了解这个群此刻的状态。涵盖(有则写、无则略,总共 ≤180 字):' +
  '① 最近在聊的话题/热点;② 群里的氛围与调性;③ 新诞生的梗/内部黑话;④ 谁最近很活跃/发生了什么值得记的事;' +
  '⑤ 有没有悬而未决、日后可以自然接回的话头。用自然中文,分点或短段都行,不要复述原话、不要 JSON、不要客套。';

/** 反思单个群:大窗口历史 → 近况摘要,写回 chat_reflection。返回本次输入的近似 token。 */
export async function reflectChat(chatId: number): Promise<{ tokens: number; reason: ReflectReason }> {
  const e = env();
  const redis = getRedis();
  if (await redis.get(FAIL_PREFIX + chatId).catch(() => null)) {
    incrCounter('bgllm_cooldown_total', { task: 'reflect', event: 'skip' });
    return { tokens: 0, reason: 'cooling' }; // 失败冷却中
  }
  const recent = await getRecent(chatId, Math.min(e.REFLECTION_WINDOW_MSGS, 80));
  const msgs = recent.filter((m) => !m.isBot && (m.textContent || m.captionContent || '').trim());
  if (msgs.length < MIN_MSGS) {
    // 记账：2026-09-21 `deep-reflection tick STARVED` 72 次，而 0 产出有三条
    // 完全不同的路（冷却中 / 消息不够 / LLM 失败）。不分开记，STARVED 就看不出
    // 该改哪儿——是群太冷，还是链挂了。
    incrCounter('bgllm_cooldown_total', { task: 'reflect', event: 'too_few_msgs' });
    return { tokens: 0, reason: 'too_few_msgs' };
  }

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
      maxTokens: 1200,
      temperature: 0.4,
      // 蒸馏是后台批任务,不该为单群烧满 provider 超时(22s)再串行降级 ×4 跳 ——
      // 一次 tick 12 群能把整条链的熔断计数全刷爆(2026-08-07 事故)。每跳 12s 封顶。
      maxTimeoutMs: 12000,
      allowHedge: false,
    });
    digest = result.content.trim().slice(0, 600);
    // Phase 14.3: 连接率进复盘 —— digest 尾部拼一行 best/worst(确定性,不烧 token)。
    // 无数据/flag 关时原样返回;写手在 [本群近况] 里看到,知道哪类话把群聊活/聊死。
    try {
      const { appendConnectivityLine } = await import('../agent/reverse-valve.js');
      digest = appendConnectivityLine(digest, chatId);
    } catch { /* non-critical */ }
    await redis.del(FAIL_PREFIX + chatId).catch(() => {});
    incrCounter('bgllm_cooldown_total', { task: 'reflect', event: 'clear' });
  } catch (err) {
    await redis.set(FAIL_PREFIX + chatId, '1', 'EX', FAIL_COOLDOWN_SEC).catch(() => {});
    incrCounter('bgllm_cooldown_total', { task: 'reflect', event: 'enter' });
    // warn 级:蒸馏失败 = AGI 记忆链断供,不能埋在 info 里无声烂掉(2026-08-07 12群全灭无人知)。
    const em = err instanceof Error ? err.message : String(err);
    logger.warn({ chatId, msgs: msgs.length, err: em.slice(0, 120) }, 'deep-reflection: LLM failed');
    return { tokens: 0, reason: 'llm_failed' };
  }
  if (digest.length < 10) {
    logger.info({ chatId, msgs: msgs.length, digestLen: digest.length }, 'deep-reflection: digest too short, skipped');
    return { tokens: 0, reason: 'llm_failed' };
  }

  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    `INSERT INTO chat_reflection (chat_id, digest, msg_count, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET digest = excluded.digest, msg_count = excluded.msg_count, updated_at = excluded.updated_at`,
  ).run(chatId, digest, msgs.length, now);

  return { tokens: Math.ceil(lines.length / 3), reason: 'ok' as const }; // 近似输入 token(中文 ~3 字符/token)
}

/** cron 入口:反思一批活跃群。 */
/** reflectChat 没产出的原因。STARVED 日志按这个分，三种病因三个数。 */
export type ReflectReason = 'ok' | 'cooling' | 'too_few_msgs' | 'llm_failed';

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
  // 这一 tick 里每个群的落空原因（reflected=0 时才知道该看哪儿）。
  // reflectChat 直接把它返回，别再单独探测一遍——那会让每群多读一次 getRecent。
  const reasons: Record<ReflectReason, number> = { ok: 0, cooling: 0, too_few_msgs: 0, llm_failed: 0 };
  for (const chatId of chatIds) {
    const r = await reflectChat(chatId).catch(() => ({ tokens: 0, reason: 'llm_failed' as ReflectReason }));
    if (r.tokens > 0) { reflected++; approxInputTokens += r.tokens; }
    else reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  }
  // 估算日 token,便于手调旋钮到目标(输入+输出粗算 ×1.15)。
  const ticksPerDay = Math.max(1, Math.round(1440 / e.REFLECTION_INTERVAL_MIN));
  const estPerDay = Math.round(approxInputTokens * 1.15 * ticksPerDay);
  const summary = { reflected, chats: chatIds.length, approxInputTokens, estTokensPerDay: estPerDay, ticksPerDay };
  // 全灭要亮红灯:蒸馏链静默断供是最难察觉的 AGI 退化(2026-08-07 两连 tick 12/12 全灭,
  // info 级日志没人看,直到排查才发现)。有产出时维持 info 不刷屏。
  if (reflected === 0) {
    // 把这一 tick 里各群为什么没产出也带上：冷却 / 消息不够 / LLM 失败分开数。
    // 原来只有一句 `reflected=0, chats=N`，三种病因一个形状。
    logger.warn(
      { ...summary, ...reasons },
      'deep-reflection tick STARVED — 0 chats reflected',
    );
  } else {
    logger.info(summary, 'deep-reflection tick complete');
  }
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
