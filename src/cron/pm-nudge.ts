// ────────────────────────────────────────
// 功能 B3:@催pm — 高好感但从没私聊过 bot 的用户,在群里@TA喊来私聊
// ────────────────────────────────────────
//
// TG 不能冷启动 DM,所以「想私聊高好感用户但对方没开 DM」唯一可行路径就是群里@。
// 这是最大封号风险面,因此(三家定稿):默认关灰度、好感高门槛、≤3 次递增间隔、
// 全局每日上限、复用 allowlist/mute/membership/isAsleep 安全门、催满未果扣好感+
// 怨气+长冷却、没 @handle 不催。每次@同时攒一条话,等对方私聊时 flush。

import { getRedis } from '../db/redis.js';
import { getDb } from '../db/sqlite.js';
import { getBotUid } from '../bot/bot.js';
import { sendMessage } from '../bot/sender/telegram.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { isAsleep } from '../tracking/sleep.js';
import { isGroupAllowed } from '../allowlist/allowlist.js';
import type { AllowlistConfig } from '../allowlist/types.js';
import { getMuteLevel } from '../tracking/user-profile.js';
import { recheckDeliverySafety } from '../pipeline/dm-relay/safety.js';
import { getAggregatedAffinity } from '../tracking/user-affinity.js';
import { getPmNudge, upsertPmNudge, hasDmEver } from '../tracking/dm-state.js';
import { enqueueDmPending } from '../tracking/dm-pending.js';
import { applyRelationshipEvent } from '../tracking/relationship.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

function getLatestUsername(uid: number): string | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT username FROM user_profiles WHERE uid = ? AND username IS NOT NULL AND username != ''
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(uid) as { username: string } | undefined;
    return row?.username ?? null;
  } catch {
    return null;
  }
}

function allowlistConfigFromEnv(e: ReturnType<typeof env>): AllowlistConfig {
  return {
    enabled: true,
    redisPrefix: e.ALLOWLIST_REDIS_PREFIX,
    defaultEnabledAfterApproval: e.ALLOWLIST_DEFAULT_ENABLE_AFTER_APPROVE,
    maxSubmissionsPerUserPerDay: e.ALLOWLIST_MAX_SUBMISSIONS_PER_DAY,
    autoAiReviewOnSubmit: e.ALLOWLIST_AUTO_AI_REVIEW,
    autoAiReviewMessageLimit: e.ALLOWLIST_AI_MESSAGE_LIMIT,
    aiReviewContextMaxChars: e.ALLOWLIST_AI_CONTEXT_MAX_CHARS,
    aiApproveAutoEnable: e.ALLOWLIST_AI_AUTO_ENABLE,
    aiApproveConfidenceThreshold: e.ALLOWLIST_AI_CONFIDENCE_THRESHOLD,
  };
}

export async function runPmNudge(): Promise<void> {
  const e = env();
  if (!e.PM_NUDGE_ENABLED) return;
  if (await isAsleep()) return; // 睡着不催

  const redis = getRedis();
  const dayKey = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const budgetKey = `xxb:pmnudge:daily:${dayKey}`;
  const used = parseInt((await redis.get(budgetKey)) ?? '0', 10);
  if (used >= e.PM_NUDGE_GLOBAL_DAILY_MAX) return;

  const intervals = e.PM_NUDGE_INTERVAL_DAYS.split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => n > 0);
  if (intervals.length === 0) return;

  // 粗筛候选:互动多、单群好感不低的 uid(精算聚合在下面)
  let rows: { uid: number }[];
  try {
    rows = getDb()
      .prepare(
        `SELECT uid, MAX(affinity) AS maxa, SUM(interaction_count) AS total
           FROM chat_relationships GROUP BY uid
          HAVING maxa >= ? AND total >= ?
          ORDER BY maxa DESC LIMIT 80`,
      )
      .all(e.PM_NUDGE_AFFINITY_MIN * 0.7, e.PM_NUDGE_MIN_INTERACTIONS) as { uid: number }[];
  } catch (err) {
    logger.debug({ err }, 'pm-nudge candidate query failed');
    return;
  }

  const t = nowSec();
  const allowConf = allowlistConfigFromEnv(e);
  let budget = e.PM_NUDGE_GLOBAL_DAILY_MAX - used;

  for (const { uid } of rows) {
    if (budget <= 0) break;

    // 已私聊过 → 不催,确保状态为 dm_open
    if (hasDmEver(uid)) {
      const st0 = getPmNudge(uid);
      if (st0.state !== 'dm_open') upsertPmNudge(uid, { state: 'dm_open', attempts: 0, nextNudgeAt: null });
      continue;
    }

    const agg = getAggregatedAffinity(uid);
    if (agg.affinity < e.PM_NUDGE_AFFINITY_MIN || agg.interactionTotal < e.PM_NUDGE_MIN_INTERACTIONS) continue;

    const st = getPmNudge(uid);

    // exhausted:冷却中跳过;冷却过 → 重置(再给一次机会,但怨气保留)
    if (st.state === 'exhausted') {
      if (st.exhaustedUntil && t < st.exhaustedUntil) continue;
      upsertPmNudge(uid, { state: 'none', attempts: 0, nextNudgeAt: null });
      continue; // 下一轮再正常评估
    }

    // 催满未果 → 进入 exhausted(扣好感 + 怨气 + 长冷却)
    if (st.attempts >= e.PM_NUDGE_MAX_ATTEMPTS) {
      if (st.nextNudgeAt && t < st.nextNudgeAt) continue; // 末次还没到判定点
      const chat = agg.primaryChatId ?? st.primaryChatId;
      if (chat) applyRelationshipEvent(chat, uid, -e.PM_NUDGE_EXHAUST_PENALTY, 'pm 催多次未回应,有点委屈');
      upsertPmNudge(uid, {
        state: 'exhausted',
        resentment: Math.min(1, st.resentment + 0.3),
        exhaustedUntil: t + Math.round(e.PM_NUDGE_COOLDOWN_DAYS * 86400),
      });
      logger.info({ uid }, 'pm-nudge exhausted (penalty applied)');
      continue;
    }

    // 间隔未到
    if (st.nextNudgeAt && t < st.nextNudgeAt) continue;

    // 选群 + 安全门
    const chat = agg.primaryChatId;
    if (!chat) continue;
    if (e.ALLOWLIST_ENABLED !== false && !(await isGroupAllowed(redis, allowConf, chat))) continue;
    if (getMuteLevel(chat, uid) > 0) continue; // 被禁言/降权的人不去@
    if (!(await recheckDeliverySafety(uid, chat))) continue; // ban + 群成员校验
    const username = getLatestUsername(uid);
    if (!username) continue; // 没 @handle 不催(别 @uid 裸号像 spam)

    let text: string | null;
    try {
      const { generatePersonaProactiveText } = await import('../pipeline/turn/proactive-turn.js');
      text = await generatePersonaProactiveText(
        chat,
        getBotUid(),
        `[想让TA来私聊] 你跟 @${username} 在群里挺熟了但TA从没私聊过你,你有点想跟TA单独说说话。在群里@TA、撒娇喊TA来私聊本喵(像"@xx 来pm本喵嘛"这种),极短一句,别命令、别解释原因`,
      );
    } catch (err) {
      logger.debug({ err, uid, chat }, 'pm-nudge generate failed');
      continue;
    }
    if (!text) continue;

    try {
      await sendMessage(chat, `@${username} ${text}`);
    } catch (err) {
      logger.debug({ err, uid, chat }, 'pm-nudge send failed (likely not in group)');
      continue;
    }

    const attempts = st.attempts + 1;
    const idx = Math.min(attempts - 1, intervals.length - 1);
    upsertPmNudge(uid, {
      state: 'nudging',
      attempts,
      lastNudgeAt: t,
      nextNudgeAt: t + intervals[idx]! * 86400,
      primaryChatId: chat,
    });
    // 攒一条话,等TA私聊时 flush
    enqueueDmPending(uid, '一直想跟TA单独好好聊聊', '在群里@过TA来私聊');

    budget--;
    await redis.set(budgetKey, String(e.PM_NUDGE_GLOBAL_DAILY_MAX - budget), 'EX', 36 * 3600);
    logger.info({ uid, chat, attempts }, 'pm-nudge @ sent');
  }
}
