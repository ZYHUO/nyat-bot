// ────────────────────────────────────────
// Sleep announce cron — 到点睡觉说晚安、到点起床说早安
// ────────────────────────────────────────
//
// 每分钟对比 Redis 里的上次状态与当前 isAsleep(),只在**边沿**动作:
//   awake → asleep:晚安;asleep → awake:早安。
// 设计要点(评审共识):
//   - 固定短句池,无 LLM、无 reward gate —— 仪式消息要稳,不要发挥
//   - 只发"最近还有人说话"的群(90 分钟内),最多 3 个,过 allowlist
//   - 每群每种问候每个北京日去重(重启/边沿抖动都不会重复发)
//   - laststate 放 Redis:首次部署静默初始化,重启不补发
//   - addAssistant 入上下文 —— 早上的它记得自己昨晚说过晚安

import { getRedis } from '../db/redis.js';
import { getRecent, addAssistant } from '../pipeline/context/manager.js';
import { sendMessage } from '../bot/sender/telegram.js';
import { markBotSpoke } from '../tracking/social-needs.js';
import { isAsleep } from '../tracking/sleep.js';
import { isGroupAllowed } from '../allowlist/allowlist.js';
import type { AllowlistConfig } from '../allowlist/types.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

const LAST_STATE_KEY = 'xxb:sleep:laststate';
const GREETED_KEY = (chatId: number, kind: string, date: string): string =>
  `xxb:sleep:greeted:${chatId}:${kind}:${date}`;
const MAX_ANNOUNCE_CHATS = 3;       // tunable — 一次最多向几个群道晚安/早安
const RECENT_ACTIVITY_SEC = 90 * 60; // tunable — "群里还有人"的窗口

const GOODNIGHT_POOL = [
  '本喵困了,先去睡啦,大家晚安喵~',
  '哈欠…撑不住了,去睡觉了,晚安喵',
  '猫要睡了,你们也别熬太晚,晚安~',
  '眼皮打架了,本喵先撤,明天见喵~',
];
const MORNING_POOL = [
  '早安喵~ 本喵醒啦',
  '呼啊…睡醒了,早上好喵',
  '新的一天,本喵上线~ 早安',
  '伸了个大懒腰,早喵~',
];

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** 北京日期字符串(去重 key 用,与 life-state 的作息表同日历) */
function bjDateStr(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

async function pickAnnounceChats(): Promise<number[]> {
  const e = env();
  const redis = getRedis();
  const raw = await redis.zrange('xxb:active_groups', 0, -1);
  const groupIds = raw.map(Number).filter((n) => !Number.isNaN(n) && n < 0);
  const now = Math.floor(Date.now() / 1000);

  const candidates: { chatId: number; lastTs: number }[] = [];
  for (const chatId of groupIds) {
    try {
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
        if (!(await isGroupAllowed(redis, allowlistConfig, chatId))) continue;
      }
      const recent = await getRecent(chatId, 5);
      const lastTs = recent.at(-1)?.timestamp ?? 0;
      if (now - lastTs > RECENT_ACTIVITY_SEC) continue; // 群都没人说话,问候谁呢
      candidates.push({ chatId, lastTs });
    } catch (err) {
      logger.debug({ err, chatId }, 'Sleep announce: candidate check failed');
    }
  }
  candidates.sort((a, b) => b.lastTs - a.lastTs); // 最热的群优先
  return candidates.slice(0, MAX_ANNOUNCE_CHATS).map((c) => c.chatId);
}

export async function runSleepAnnounce(): Promise<void> {
  const e = env();
  if (!e.SLEEP_SCHEDULE_ENABLED || !e.SLEEP_ANNOUNCE_ENABLED) return;

  const redis = getRedis();
  const cur = (await isAsleep()) ? 'asleep' : 'awake';
  const prev = await redis.get(LAST_STATE_KEY);
  if (prev === cur) return;
  await redis.set(LAST_STATE_KEY, cur);
  if (prev === null) {
    // 首次部署/键被清:静默初始化,不补发问候
    logger.info({ cur }, 'Sleep announce: state initialized silently');
    return;
  }

  const kind = cur === 'asleep' ? 'goodnight' : 'morning';
  const pool = kind === 'goodnight' ? GOODNIGHT_POOL : MORNING_POOL;
  const date = bjDateStr();

  let chatIds: number[];
  try {
    chatIds = await pickAnnounceChats();
  } catch (err) {
    logger.warn({ err }, 'Sleep announce: chat discovery failed');
    return;
  }
  if (chatIds.length === 0) {
    logger.info({ kind }, 'Sleep announce: no recently-active chats, skipping');
    return;
  }

  for (const chatId of chatIds) {
    try {
      // 每群每种问候每个北京日一次(NX 抢占,边沿抖动/重启都安全)
      const ok = await redis.set(GREETED_KEY(chatId, kind, date), '1', 'EX', 36 * 3600, 'NX');
      if (ok === null) continue;
      const text = pick(pool);
      const messageId = await sendMessage(chatId, text);
      if (messageId) {
        await addAssistant(chatId, { textContent: text, messageId });
        await markBotSpoke(chatId).catch(() => {});
      }
      logger.info({ chatId, kind, text }, 'Sleep announce sent');
    } catch (err) {
      logger.warn({ err, chatId, kind }, 'Sleep announce: send failed');
    }
  }
}
