// ────────────────────────────────────────
// Sleep Cycle cron — 作息 v2 的心跳(每分钟)
// ────────────────────────────────────────
//
// 四件事:
//   1. 动态就寝:把 speech-meter 计数折算成 bedtime shift 写进 life-state
//      (话多早睡、话少晚睡;今天+昨天两个日期键,凌晨段判定用昨天的)
//   2. 边沿检测(只看夜睡相位,午睡不触发):睡着 → 晚安;醒来 → 早安
//      + 设起床补回标记。问候**每群单独生成**(persona 管线,带群上下文,
//      失败回落固定短句池),每群每种每北京日去重
//   3. 半夜醒:seeded 每晚 ~50% 在有效睡眠段 40-60% 处醒一次,队列非空
//      才"起来刷手机"(补 ≤2 条);队列空就翻个身继续睡(不发哈欠)
//   4. 补回排水:有标记时每分钟回放**一个** chat 的最欠回条目(跨群串行,
//      防 TG rate limit),回放走 wait-resume 通道,写手可 silent 反悔
//
// laststate / nightwake / drain 标记全在 Redis:重启不重复发、不丢欠账。

import { getRedis } from '../db/redis.js';
import { getRecent, addAssistant } from '../pipeline/context/manager.js';
import { sendMessage } from '../bot/sender/telegram.js';
import { markBotSpoke } from '../tracking/social-needs.js';
import { getSleepPhase, nightDateStr } from '../tracking/sleep.js';
import { setBedtimeShift, effectiveSleepMin, daySchedule } from '../tracking/life-state.js';
import { getSpeechCounts, bedtimeShiftFromCount, bjDateStr } from '../tracking/speech-meter.js';
import { peekSleepQueues, takeSleepPending, clearSleepPending } from '../tracking/sleep-queue.js';
import { appendPending } from '../pipeline/turn/buffer.js';
import { scheduleTurn } from '../queue/turn-scheduler.js';
import { isTurnActorChat } from '../pipeline/turn/flags.js';
import { generatePersonaProactiveText } from '../pipeline/turn/proactive-turn.js';
import { getBotUid } from '../bot/bot.js';
import { isGroupAllowed } from '../allowlist/allowlist.js';
import type { AllowlistConfig } from '../allowlist/types.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

const LAST_STATE_KEY = 'xxb:sleep:laststate';
const NIGHT_WAKE_KEY = (nightDate: string): string => `xxb:sleep:nightwake:${nightDate}`;
const DRAIN_KEY = 'xxb:sleep:drain'; // 剩余补回额度(int);存在 = 排水中
const GREETED_KEY = (chatId: number, kind: string, date: string): string =>
  `xxb:sleep:greeted:${chatId}:${kind}:${date}`;

const MAX_ANNOUNCE_CHATS = 3;            // tunable — 一次最多向几个群道晚安/早安
const GOODNIGHT_ACTIVITY_SEC = 90 * 60;  // 晚安:90 分钟内还有人说话的群
const MORNING_ACTIVITY_SEC = 8 * 3600;   // 早安:夜里有动静的群(8h 窗)
const MORNING_DRAIN_BUDGET = 5;          // 起床后最多补几个 chat(每分钟 1 个)
const NIGHT_DRAIN_BUDGET = 2;            // 半夜醒最多补几个("一次不能太多")
const NIGHT_WAKE_PROBABILITY = 0.5;      // 每晚有没有半夜醒(seeded)

// 固定短句池 —— persona 生成失败时的回落
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

// ── seeded 半夜醒时刻(夜归属日期轴上的绝对分钟;null = 今晚不醒) ──
// 与 life-state 同款 hash+PRNG,但用独立盐,不动作息表的 seed 序列。
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function nightWakeAbsMin(nightDate: string): number | null {
  const rand = mulberry32(hashString(`${nightDate}#nightwake`));
  if (rand() >= NIGHT_WAKE_PROBABILITY) return null;
  const start = effectiveSleepMin(nightDate);
  const nextDate = bjDateStr(new Date(Date.parse(`${nightDate}T12:00:00Z`) + 86400_000));
  const end = daySchedule(nextDate).wakeMin + 1440;
  if (end <= start) return null; // 防御:表异常
  // 睡眠段 40%-60% 处(评审:比纯随机更像人的浅睡期)
  return Math.floor(start + (end - start) * (0.4 + rand() * 0.2));
}

async function buildAllowlistConfig(): Promise<AllowlistConfig | null> {
  const e = env();
  if (e.ALLOWLIST_ENABLED === false) return null;
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

/** 最近 windowSec 内有人说话的群(过 allowlist),按活跃降序 */
async function pickActiveChats(windowSec: number, extra: number[] = []): Promise<number[]> {
  const redis = getRedis();
  const raw = await redis.zrange('xxb:active_groups', 0, -1);
  const groupIds = new Set(raw.map(Number).filter((n) => !Number.isNaN(n) && n < 0));
  for (const c of extra) if (c < 0) groupIds.add(c);
  const allowlistConfig = await buildAllowlistConfig();
  const now = Math.floor(Date.now() / 1000);

  const candidates: { chatId: number; lastTs: number }[] = [];
  for (const chatId of groupIds) {
    try {
      if (allowlistConfig && !(await isGroupAllowed(redis, allowlistConfig, chatId))) continue;
      const recent = await getRecent(chatId, 5);
      const lastTs = recent.at(-1)?.timestamp ?? 0;
      // 欠着回复的群(extra)即使超窗也保留 —— 问候是补回的开场
      if (now - lastTs > windowSec && !extra.includes(chatId)) continue;
      candidates.push({ chatId, lastTs });
    } catch (err) {
      logger.debug({ err, chatId }, 'Sleep cycle: candidate check failed');
    }
  }
  candidates.sort((a, b) => b.lastTs - a.lastTs);
  return candidates.slice(0, MAX_ANNOUNCE_CHATS).map((c) => c.chatId);
}

/** 给一个群生成问候:persona 管线优先(每群不一样),失败回落固定池 */
async function greetingText(chatId: number, kind: 'goodnight' | 'morning'): Promise<string> {
  const e = env();
  if (e.TURN_PROACTIVE_ENABLED && isTurnActorChat(chatId)) {
    const intent = kind === 'goodnight'
      ? '[到点睡觉] 你困了,准备去睡了。跟群里道个晚安——可以顺着最近聊的话题随口带一句,也可以就打个哈欠说去睡了。'
      : '[刚睡醒] 你刚起床,睡眼惺忪地冒个泡说早安——可以提一嘴睡得怎么样,或者顺着昨晚群里聊的话题接半句。';
    const text = await generatePersonaProactiveText(chatId, getBotUid(), intent);
    if (text) return text;
  }
  return pick(kind === 'goodnight' ? GOODNIGHT_POOL : MORNING_POOL);
}

async function announce(chatIds: number[], kind: 'goodnight' | 'morning'): Promise<void> {
  const redis = getRedis();
  const date = bjDateStr();
  for (const chatId of chatIds) {
    try {
      // 每群每种问候每个北京日一次(NX 抢占,边沿抖动/重启都安全)
      const ok = await redis.set(GREETED_KEY(chatId, kind, date), '1', 'EX', 36 * 3600, 'NX');
      if (ok === null) continue;
      const text = await greetingText(chatId, kind);
      const messageId = await sendMessage(chatId, text);
      if (messageId) {
        await addAssistant(chatId, { textContent: text, messageId });
        await markBotSpoke(chatId).catch(() => {});
      }
      logger.info({ chatId, kind, text }, 'Sleep cycle: greeting sent');
    } catch (err) {
      logger.warn({ err, chatId, kind }, 'Sleep cycle: greeting failed');
    }
  }
}

/** 回放一个 chat 的最欠回条目(wait-resume 通道);返回是否还有下一个 */
async function drainOneChat(): Promise<boolean> {
  const queues = await peekSleepQueues(); // 点名优先,其次最新
  if (queues.length === 0) return false;
  const { chatId } = queues[0]!;
  // 防御:补回只能走 turn actor 的 wait-resume 通道。非 actor 群理论上
  // 在 pushSleepPending 就被拦了入不了队;万一灰度名单中途变更让它残留,
  // 这里**先清掉再跳过**(clear 而非 take —— 不假装回放),避免被反复挑中。
  if (!isTurnActorChat(chatId)) {
    await clearSleepPending(chatId);
    logger.info({ chatId }, 'Sleep cycle: chat not on turn actor, queue dropped');
    return queues.length > 1;
  }
  const item = await takeSleepPending(chatId); // 取最欠回的一条并清空该 chat
  if (!item) return queues.length > 1;
  try {
    await appendPending({ ...item.entry, waitReplay: true, sleepCatchup: true });
    await scheduleTurn(chatId, {
      trigger: 'wait_timeout',
      delayMsOverride: 0,
      anchorMessageId: item.entry.messageId,
    });
    logger.info({ chatId, messageId: item.entry.messageId, rule: item.rule }, 'Sleep cycle: catch-up replayed');
  } catch (err) {
    logger.warn({ err, chatId }, 'Sleep cycle: catch-up replay failed');
  }
  return queues.length > 1;
}

export async function runSleepCycle(): Promise<void> {
  const e = env();
  if (!e.SLEEP_SCHEDULE_ENABLED) return;
  const redis = getRedis();
  const now = new Date();

  // 1. 动态就寝 shift(今天+昨天;凌晨段判定用昨天的键)
  try {
    const counts = await getSpeechCounts(now);
    setBedtimeShift(counts.todayDate, bedtimeShiftFromCount(counts.today));
    setBedtimeShift(counts.prevDate, bedtimeShiftFromCount(counts.prev));
  } catch (err) {
    logger.debug({ err }, 'Sleep cycle: shift update failed');
  }

  // 2. 边沿检测(午睡不算:nap 不说晚安/早安、不触发补回)
  const phase = await getSleepPhase(now);
  const cur = phase === 'night' ? 'asleep' : 'awake';
  const prev = await redis.get(LAST_STATE_KEY);
  if (prev !== cur) {
    await redis.set(LAST_STATE_KEY, cur);
    if (prev === null) {
      logger.info({ cur }, 'Sleep cycle: state initialized silently');
    } else if (cur === 'asleep') {
      if (e.SLEEP_ANNOUNCE_ENABLED) {
        await announce(await pickActiveChats(GOODNIGHT_ACTIVITY_SEC), 'goodnight');
      }
      // 功能 B1:睡前给已私聊的高好感用户发悄悄话(SLEEP_DM_ENABLED 内部门控)
      if (e.SLEEP_DM_ENABLED) {
        const { announceDmGreetings } = await import('../pipeline/dm-proactive.js');
        await announceDmGreetings('goodnight');
      }
    } else {
      // 起床:先问候(欠回复的群优先),下一分钟起逐 chat 补回
      const oweChats = (await peekSleepQueues()).map((q) => q.chatId);
      if (e.SLEEP_ANNOUNCE_ENABLED) {
        await announce(await pickActiveChats(MORNING_ACTIVITY_SEC, oweChats), 'morning');
      }
      if (e.SLEEP_DM_ENABLED) {
        const { announceDmGreetings } = await import('../pipeline/dm-proactive.js');
        await announceDmGreetings('morning');
      }
      if (oweChats.length > 0) {
        await redis.set(DRAIN_KEY, String(MORNING_DRAIN_BUDGET), 'EX', 3600);
        logger.info({ oweChats: oweChats.length }, 'Sleep cycle: morning catch-up scheduled');
      }
    }
  }

  // 3. 半夜醒(seeded):睡着 + 到点 + 没醒过 + 有欠账 → 起来刷两条
  if (cur === 'asleep') {
    const nightDate = nightDateStr(now);
    const wakeAbs = nightWakeAbsMin(nightDate);
    if (wakeAbs !== null) {
      const bj = new Date(now.getTime() + 8 * 3600_000);
      const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
      const curAbs = bjDateStr(now) === nightDate ? minutes : minutes + 1440;
      if (curAbs >= wakeAbs && curAbs <= wakeAbs + 4) {
        const first = await redis.set(NIGHT_WAKE_KEY(nightDate), '1', 'EX', 36 * 3600, 'NX');
        if (first !== null) {
          const owed = await peekSleepQueues();
          if (owed.length > 0) {
            await redis.set(DRAIN_KEY, String(Math.min(NIGHT_DRAIN_BUDGET, owed.length)), 'EX', 1800);
            logger.info({ owed: owed.length }, 'Sleep cycle: night stir, draining a little');
          } else {
            logger.debug('Sleep cycle: night stir, nothing owed, back to sleep');
          }
        }
      }
    }
  }

  // 4. 补回排水:每 tick 一个 chat(跨群串行,防 rate limit)
  const drainRaw = await redis.get(DRAIN_KEY);
  if (drainRaw !== null) {
    const left = parseInt(drainRaw, 10);
    if (left <= 0) {
      await redis.del(DRAIN_KEY);
    } else {
      const more = await drainOneChat();
      if (more && left - 1 > 0) {
        await redis.set(DRAIN_KEY, String(left - 1), 'EX', 3600);
      } else {
        await redis.del(DRAIN_KEY);
      }
    }
  }
}
