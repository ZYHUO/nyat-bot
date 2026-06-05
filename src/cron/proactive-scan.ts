// ────────────────────────────────────────
// Stage C: Proactive Scan — periodic chat-aware engagement
// 周期扫描活跃群，主动判断"现在是不是该插一句"
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
import { runTimingGate } from '../pipeline/timing/gate.js';
import { getBotUid } from '../bot/bot.js';
import { loadCachedPrompt } from '../shared/config.js';
import type { FormattedMessage } from '../shared/types.js';

const PROACTIVE_LAST_PREFIX = 'xxb:proactive:last:';
const ACTIVE_GROUPS_MAX_AGE = 30 * 86400;

const sender = new StreamingSender();

export function isWithinActiveHours(start: number, end: number): boolean {
  const hour = parseInt(
    new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }),
    10,
  );
  return hour >= start && hour < end;
}

async function discoverActiveGroupChats(): Promise<number[]> {
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);
  await redis.zremrangebyscore('xxb:active_groups', '-inf', now - ACTIVE_GROUPS_MAX_AGE).catch(() => {});
  const raw = await redis.zrange('xxb:active_groups', 0, -1);
  return raw.map(Number).filter((n) => !Number.isNaN(n) && n < 0);
}

export function pickCandidates(chatIds: number[], max: number): number[] {
  if (chatIds.length <= max) return [...chatIds];
  // Fisher-Yates partial shuffle
  const arr = [...chatIds];
  for (let i = 0; i < max; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, max);
}

interface ChimeVerdict {
  join: boolean;
  topic: string;
  reason: string;
}

export async function shouldChimeIn(
  chatId: number,
  recent: FormattedMessage[],
  e: ReturnType<typeof env>,
): Promise<ChimeVerdict> {
  const botName = e.BOT_USERNAME;
  let systemPrompt: string;
  try {
    systemPrompt = loadCachedPrompt('task/proactive-scan.md');
    systemPrompt = systemPrompt.replace(/\{bot_name\}/g, botName);
  } catch {
    return { join: false, topic: '', reason: 'prompt_load_failed' };
  }

  const contextLines = recent.map((m) => {
    const name = m.fullName || m.username || (m.role === 'assistant' ? botName : '?');
    const text = m.textContent || m.captionContent || '[media]';
    return `${name}: ${text.slice(0, 120)}`;
  }).join('\n');

  try {
    const result = await Promise.race([
      callWithFallback({
        usage: e.PROACTIVE_SCAN_USAGE,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: contextLines },
        ],
        maxTokens: 150,
        temperature: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('chime_timeout')), e.PROACTIVE_SCAN_CHIME_TIMEOUT_MS),
      ),
    ]);

    const raw = result.content.trim();
    let obj: Record<string, unknown> | null = null;
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) obj = JSON.parse(m[0]) as Record<string, unknown>;
    } catch { /* parse failed */ }

    if (!obj) return { join: false, topic: '', reason: 'parse_failed' };

    return {
      join: obj['join'] === true,
      topic: typeof obj['topic'] === 'string' ? (obj['topic'] as string).slice(0, 100) : '',
      reason: typeof obj['reason'] === 'string' ? (obj['reason'] as string).slice(0, 100) : '',
    };
  } catch (err) {
    logger.debug({ err, chatId }, 'shouldChimeIn failed (fail-closed)');
    return { join: false, topic: '', reason: 'llm_failed' };
  }
}

async function generateProactiveReply(
  chatId: number,
  recent: FormattedMessage[],
  topic: string,
  e: ReturnType<typeof env>,
): Promise<string | null> {
  // G11: 人格化主动发言 — 与 reactive 回复同一条 5 层人格管线
  if (e.TURN_PROACTIVE_ENABLED && isTurnActorChat(chatId)) {
    const { generatePersonaProactiveText } = await import('../pipeline/turn/proactive-turn.js');
    const { getBotUid } = await import('../bot/bot.js');
    return generatePersonaProactiveText(
      chatId,
      getBotUid(),
      `[主动插话] 你看到群里在聊：${topic}。你是群里的普通成员,想加入就自然地接一句,像真群友冒出来的话。`,
    );
  }
  const contextLines = recent.slice(-8).map((m) => {
    const name = m.fullName || m.username || (m.role === 'assistant' ? e.BOT_USERNAME : '?');
    const text = m.textContent || m.captionContent || '[media]';
    return `${name}: ${text.slice(0, 100)}`;
  }).join('\n');

  try {
    const result = await callWithFallback({
      usage: 'reply',
      messages: [
        {
          role: 'system',
          content: `你是${e.BOT_USERNAME}，群聊里的活跃成员。请简短回应一句（不超过50字，不要客套不要废话）。`,
        },
        {
          role: 'user',
          content: `[主动评估] 我看到群里在聊：${topic}\n\n最近消息：\n${contextLines}\n\n请简短回应一句（不超过50字，不要客套不要废话）：`,
        },
      ],
      maxTokens: 80,
      temperature: 1.0,
    });

    const text = result.content.trim().replace(/^["「『]|["」』]$/g, '');
    return text.length >= 2 ? text : null;
  } catch (err) {
    logger.debug({ err, chatId }, 'generateProactiveReply failed');
    return null;
  }
}

export async function runProactiveScan(): Promise<void> {
  const e = env();
  if (!e.PROACTIVE_SCAN_ENABLED) return;
  if (!isWithinActiveHours(e.PROACTIVE_SCAN_HOUR_START, e.PROACTIVE_SCAN_HOUR_END)) {
    logger.debug('Proactive scan: outside active hours, skipping');
    return;
  }

  let allChats: number[];
  try {
    allChats = await discoverActiveGroupChats();
  } catch (err) {
    logger.warn({ err }, 'Proactive scan: failed to discover chats');
    return;
  }

  if (allChats.length === 0) {
    logger.info('Proactive scan: no active group chats found');
    return;
  }

  const candidates = pickCandidates(allChats, e.PROACTIVE_SCAN_MAX_CHATS_PER_TICK);
  logger.info(
    { totalChats: allChats.length, candidates },
    'Proactive scan: tick start',
  );
  const now = Math.floor(Date.now() / 1000);
  const redis = getRedis();

  for (const chatId of candidates) {
    try {
      // 1. allowlist
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
        if (!allowed) {
          logger.info({ chatId }, 'Proactive scan: skip — not allowlisted');
          continue;
        }
      }

      // 2. timing state — must be RUNNING
      const ts = await getChatState(chatId);
      if (ts.state !== 'RUNNING') {
        logger.info({ chatId, state: ts.state }, 'Proactive scan: skip — chat not RUNNING');
        continue;
      }

      // 3. throttle: last proactive or last bot reply
      const lastProactiveAt = await redis.get(PROACTIVE_LAST_PREFIX + chatId);
      if (lastProactiveAt && now - parseInt(lastProactiveAt, 10) < e.PROACTIVE_SCAN_MIN_INTERVAL_SEC) {
        logger.info({ chatId, lastProactiveAgo: now - parseInt(lastProactiveAt, 10) }, 'Proactive scan: skip — proactive throttle');
        continue;
      }
      if (ts.lastBotReplyAt && Date.now() - ts.lastBotReplyAt < e.PROACTIVE_SCAN_MIN_INTERVAL_SEC * 1000) {
        logger.info({ chatId, lastReplyAgoMs: Date.now() - ts.lastBotReplyAt }, 'Proactive scan: skip — recent bot reply');
        continue;
      }

      // 4. recent messages + human count filter
      const recent = await getRecent(chatId, e.PROACTIVE_SCAN_RECENT_MSG_COUNT);
      const humanCount = recent.filter((m) => !m.isBot && m.role !== 'assistant').length;
      if (humanCount < e.PROACTIVE_SCAN_MIN_HUMAN_MSGS) {
        logger.info({ chatId, humanCount, min: e.PROACTIVE_SCAN_MIN_HUMAN_MSGS }, 'Proactive scan: skip — not enough humans');
        continue;
      }

      // 4b. State-conditioned willingness (loneliness × mood × crowd closeness) —
      // chime in more when it's been quiet + people are friendly, less right after
      // talking / in a bad mood / among a chilly crowd. Cheap pre-filter before the LLM.
      const willingness = await proactiveWillingness(chatId, recent);
      if (Math.random() > willingness) {
        logger.info({ chatId, willingness: +willingness.toFixed(2) }, 'Proactive scan: low willingness, skip');
        continue;
      }

      // 5. LLM: should I chime in?
      const verdict = await shouldChimeIn(chatId, recent, e);
      logger.info({ chatId, verdict }, 'Proactive scan: chime verdict');
      if (!verdict.join) continue;

      // 6. timing gate (isDirectInteraction=false → gate truly evaluates)
      const lastUser = recent.findLast((m) => !m.isBot && m.role !== 'assistant');
      if (!lastUser) {
        logger.info({ chatId }, 'Proactive scan: skip — no last user message');
        continue;
      }

      const gateDecision = await runTimingGate({
        chatId,
        message: lastUser,
        recentMessages: recent,
        judgeResult: { action: 'REPLY', replyPath: 'direct', replyTier: 'normal', level: 'L0_RULE', latencyMs: 0 },
        botUid: getBotUid(),
        botName: e.BOT_USERNAME,
        botPersona: loadCachedPrompt('identity/persona.md').slice(0, 800),
        isDirectInteraction: false,
        proactiveMode: true,
      });

      if (gateDecision.action !== 'continue') {
        logger.info({ chatId, action: gateDecision.action, reason: gateDecision.reason }, 'Proactive scan: gate suppressed');
        continue;
      }

      // 7. generate
      const text = await generateProactiveReply(chatId, recent, verdict.topic, e);
      if (!text) {
        logger.info({ chatId }, 'Proactive scan: skip — empty reply');
        continue;
      }

      // 7b. reward gate — content-aware "does this actually fit right now?" check
      const reward = await runRewardGate(chatId, recent, text, 'proactive');
      if (!reward.accept) {
        logger.info({ chatId, reasoning: reward.reasoning }, 'Proactive scan: reward gate rejected');
        continue;
      }

      // 8. send
      await sender.sendDirect(chatId, text);
      await markBotSpoke(chatId);
      // G9: 主动插话同样拉升 focus(bumpFocus 在 flag off 时自身 no-op)
      import('../pipeline/turn/focus.js').then(({ bumpFocus }) => bumpFocus(chatId, 'bot_spoke')).catch(() => {});
      await redis.set(PROACTIVE_LAST_PREFIX + chatId, String(now), 'EX', e.PROACTIVE_SCAN_MIN_INTERVAL_SEC * 2);
      logger.info({ chatId, text: text.slice(0, 80) }, 'Proactive message sent');
    } catch (err) {
      logger.warn({ err, chatId }, 'Proactive scan: chat failed');
    }
  }
}
