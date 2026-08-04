// ────────────────────────────────────────
// Idle proactive messaging cron
// 群聊沉默超过 60 分钟时，随机主动发一句
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { getRecent } from '../pipeline/context/manager.js';
import { runRewardGate } from '../pipeline/reward/reward-model.js';
import { proactiveWillingness, markBotSpoke } from '../tracking/social-needs.js';
import { StreamingSender } from '../bot/sender/streaming.js';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { isGroupAllowed } from '../allowlist/allowlist.js';
import type { AllowlistConfig } from '../allowlist/types.js';
import { getChatState } from '../pipeline/timing/chat-runtime.js';
import { isTurnActorChat } from '../pipeline/turn/flags.js';
import { generatePersonaProactiveText } from '../pipeline/turn/proactive-turn.js';
import { getBotUid } from '../bot/bot.js';
import { isAsleep } from '../tracking/sleep.js';
import { tryAcquireProactiveSlot, markProactiveSent } from './proactive-coordinator.js';

const ACTIVE_GROUPS_MAX_AGE = 30 * 86400; // prune groups unseen for 30 days
const LAST_POKE_PREFIX = 'xxb:last_poke:';

const sender = new StreamingSender();

function isWithinActiveHours(): boolean {
  const e = env();
  const now = new Date();
  const hour = parseInt(
    now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }),
    10,
  );
  return hour >= e.IDLE_HOUR_START && hour < e.IDLE_HOUR_END;
}

/** Discover active group chat IDs from the xxb:active_groups sorted set. */
async function discoverActiveGroupChats(): Promise<number[]> {
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);
  // Prune stale groups (unseen >30 days)
  await redis.zremrangebyscore('xxb:active_groups', '-inf', now - ACTIVE_GROUPS_MAX_AGE).catch(() => {});
  const raw = await redis.zrange('xxb:active_groups', 0, -1);
  return raw.map(Number).filter((n) => !Number.isNaN(n) && n < 0);
}

export async function runIdleCheck(): Promise<void> {
  if (!isWithinActiveHours()) {
    logger.debug('Idle check: outside active hours, skipping');
    return;
  }
  // 硬作息:睡着了不会主动搭话(活跃时段门之外的兜底 —— 强制睡/seeded 表都盖住)
  if (await isAsleep()) {
    logger.debug('Idle check: asleep, skipping');
    return;
  }

  let chatIds: number[];
  try {
    chatIds = await discoverActiveGroupChats();
  } catch (err) {
    logger.warn({ err }, 'Idle check: failed to discover chats');
    return;
  }

  if (chatIds.length === 0) {
    logger.debug('Idle check: no active group chats found');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const e = env();
  const redis = getRedis();

  // Jitter: only check a subset of groups each run to avoid thundering herd.
  // Use minute-of-hour XOR chatId to spread checks evenly across runs.
  const minute = new Date().getMinutes();
  const jitteredChats = chatIds.filter((id) => (Math.abs(id) + minute) % 3 === 0);

  for (const chatId of jitteredChats) {
    try {
      // Skip chats explicitly in WAIT/STOP — bot decided to stay silent.
      // Phase 4: idle proactive messages must not violate the chat-runtime contract.
      try {
        const ts = await getChatState(chatId);
        if (ts.state === 'WAIT' || ts.state === 'STOP') {
          logger.debug({ chatId, timingState: ts.state }, 'Idle check: chat in WAIT/STOP, skipping');
          continue;
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'getChatState in idle failed, proceeding (non-critical)');
      }

      // Skip chats not in allowlist
      if (e.ALLOWLIST_ENABLED !== false) {
        const allowlistConfig: AllowlistConfig = {
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
        const allowed = await isGroupAllowed(redis, allowlistConfig, chatId);
        if (!allowed) continue;
      }

      // Check if we sent a proactive message recently in this chat (Redis-persisted)
      const lastPokeRaw = await redis.get(LAST_POKE_PREFIX + chatId);
      const lastPoke = lastPokeRaw ? parseInt(lastPokeRaw, 10) : 0;
      if (now - lastPoke < e.IDLE_PROACTIVE_INTERVAL_SEC) continue;

      // Get recent messages to check silence
      const recent = await getRecent(chatId, 20);
      if (recent.length === 0) continue;

      const lastMsg = recent[recent.length - 1]!;
      const silenceSec = now - lastMsg.timestamp;

      if (silenceSec < e.IDLE_THRESHOLD_SEC) continue;

      // Roll the dice — base probability scaled by state-conditioned willingness
      // (mood × crowd closeness; loneliness is already high after a long silence).
      // A2:上课压低主动意愿
      const { getSchoolAttentionFactor } = await import('../tracking/school-state.js');
      const willingness = (await proactiveWillingness(chatId, recent)) * getSchoolAttentionFactor();
      if (Math.random() > e.IDLE_TRIGGER_PROBABILITY * willingness) continue;

      logger.info({ chatId, silenceSec }, 'Idle check: generating proactive message');

      let text: string;
      if (e.TURN_PROACTIVE_ENABLED && isTurnActorChat(chatId)) {
        // G11: 主动开口走与 reactive 回复同一条 5 层人格管线,
        // 模型可以拒绝(silent)——"自己想不想说"也是人格的一部分。
        const personaText = await generatePersonaProactiveText(
          chatId,
          getBotUid(),
          `[主动开口·冷场] 群里已经沉默${Math.floor(silenceSec / 60)}分钟了。你可以自然地发起一个话题、接着之前聊的随口说一句、或分享点有意思的。禁止自我介绍、禁止"大家好"式开场。`,
        );
        if (!personaText) {
          logger.debug({ chatId }, 'Idle proactive: persona generation declined/empty');
          continue;
        }
        text = personaText;
      } else {
        // Legacy: throwaway-prompt generation
        const contextLines = recent.slice(-8).map((m) => {
          const name = m.fullName || m.username || (m.role === 'assistant' ? e.BOT_USERNAME : '?');
          const t = m.textContent || m.captionContent || '[sticker/media]';
          return `${name}: ${t.slice(0, 100)}`;
        }).join('\n');

        const result = await callWithFallback({
          usage: 'reply',
          messages: [
            {
              role: 'system',
              content: `你是${e.BOT_USERNAME},群里住了很久的猫娘群友,嘴上带点猫腔但不腻。群里冷场有一阵了,你随口说点什么——可以接着之前的话题往下说一句,可以分享个刚想到的小事,也可以就吐个槽。
要求:
- 一句话,30 字以内,像随手发的微信
- 接旧话题比硬开新话题自然;没得接就说点自己的事
- 禁止自我介绍、禁止"大家好"式开场、禁止以"喵~"开头、禁止"有人吗"
- 只输出要发的那句话,不要解释不要引号`,
            },
            {
              role: 'user',
              content: `最近的聊天记录:\n${contextLines}\n\n群里已经安静${Math.floor(silenceSec / 60)}分钟了,你随口说一句:`,
            },
          ],
          maxTokens: 60,
          temperature: 1.1,
        });

        text = result.content.trim().replace(/^["「『]|["」』]$/g, '');
        if (!text || text.length < 2) continue;
      }

      // Reward gate — skip the poke if it doesn't fit the moment
      const reward = await runRewardGate(chatId, recent, text, 'idle');
      if (!reward.accept) {
        logger.info({ chatId, reasoning: reward.reasoning }, 'Idle proactive: reward gate rejected');
        continue;
      }

      // P2-A: 统一调度 — 防止和 proactive-scan 同窗口双发
      if (!(await tryAcquireProactiveSlot(chatId, 'idle'))) continue;

      await sender.sendDirect(chatId, text);
      await markProactiveSent(chatId, 'idle');
      await markBotSpoke(chatId);
      // G9: 主动开口同样拉升 focus(bumpFocus 在 flag off 时自身 no-op)
      import('../pipeline/turn/focus.js').then(({ bumpFocus }) => bumpFocus(chatId, 'bot_spoke')).catch(() => {});
      await redis.set(LAST_POKE_PREFIX + chatId, String(now), 'EX', e.IDLE_PROACTIVE_INTERVAL_SEC * 2);

      logger.info({ chatId, text, silenceSec }, 'Idle proactive message sent');
    } catch (err) {
      logger.warn({ err, chatId }, 'Idle check: failed for chat');
    }
  }
}
