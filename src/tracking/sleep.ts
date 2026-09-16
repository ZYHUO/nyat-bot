// ────────────────────────────────────────
// Sleep Schedule — 硬作息门(到点睡觉/到点起床)v2
// ────────────────────────────────────────
//
// life-state(#5)是"软"作息:睡觉只调速+prompt 迷糊暗示。这里是行为级:
// **睡着了就真的不闲聊**,但消息没有白看 —— judge 有预算地照常工作,
// 值得回的攒进 sleep-queue,半夜醒补一点,大头早上起床后补。
//
// 语义:
//   - 指令不受限:slash / NL 命令 / remember 等功能拦截照常(豁免集)。
//   - 点名(@bot / 回 bot / 私聊)走**升级式吵醒**:第一次大概率睡死,
//     同一 chat 越 ping 越容易醒;主人必醒;午睡(浅)吵醒概率翻倍。
//     被吵醒后有迷糊窗口继续接话;没吵醒的点名 → 入队,醒后补。
//   - 闲聊:Stage A 有预算地放 judge(L1/heart)判"值不值得回",REPLY
//     → 入队;预算外静默(不烧 LLM)。对话热度类 L0 规则不烧 judge,
//     直接入队候补。
//   - 作息表:life-state 的 date-seeded daySchedule + 动态就寝(话多早
//     睡,sleep-cycle cron 每分钟把 speech-meter 计数折算成 shift 写进
//     life-state)+ 午睡窗。软硬两层共用同一张有效表。
//   - 运行时 RuntimeOverride.sleep_schedule 可强制 awake/asleep(只改门
//     输入,不动种子)。状态全在 Redis/纯函数,重启零丢失。

import { getRedis } from '../db/redis.js';
import { getLifeState } from './life-state.js';
import { bjDateStr } from './speech-meter.js';
import { loadOverrideCached } from '../admin/runtime-config.js';
import { isMaster } from '../admin/auth.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

// tunables
const DISTURB_WINDOW_SEC = 600;             // 吵醒计数窗口(同 chat)
const WAKE_PROBABILITIES = [0.15, 0.5, 1];  // 夜睡:第 1/2/≥3 次点名的吵醒概率
const NAP_WAKE_FACTOR = 2;                  // 午睡浅,吵醒概率翻倍
const GROGGY_WINDOW_SEC = 300;              // 被吵醒后的迷糊清醒窗口
const NIGHT_JUDGE_COOLDOWN_SEC = 180;       // 闲聊烧 judge 的每 chat 最小间隔
const NIGHT_JUDGE_BUDGET = 30;              // 每 chat 每晚 judge 调用上限

const DISTURB_KEY = (chatId: number): string => `xxb:sleep:disturb:${chatId}`;
const GROGGY_KEY = (chatId: number): string => `xxb:sleep:groggy:${chatId}`;
// DM↔群联动:全局临时唤醒(私聊唤醒后群里也醒)。TTL 即唤醒窗口,每条 DM 续期。
const GLOBAL_WAKE_KEY = 'xxb:sleep:global_wake';

/**
 * 私聊唤醒:睡着时收到 DM → 设一个全局临时唤醒键(TTL=窗口),令 getSleepPhase 在睡眠时段
 * 也返回 awake(群里、私聊、cron 都按醒处理)。每次调用刷新 TTL(滑动窗口)→ 聊着不睡,
 * 静默满一个窗口后键过期 → 自动继续睡。flag SLEEP_WAKE_ON_DM_ENABLED 关 → no-op。
 */
export async function pokeGlobalWake(reason = 'dm'): Promise<void> {
  if (!env().SLEEP_WAKE_ON_DM_ENABLED) return;
  try {
    await getRedis().set(GLOBAL_WAKE_KEY, reason, 'EX', env().SLEEP_WAKE_WINDOW_MIN * 60);
  } catch (err) {
    logger.debug({ err, reason }, 'pokeGlobalWake failed (non-critical)');
  }
}
const JUDGE_COOL_KEY = (chatId: number): string => `xxb:sleep:jcool:${chatId}`;
const JUDGE_BUDGET_KEY = (chatId: number, nightDate: string): string =>
  `xxb:sleep:jbudget:${chatId}:${nightDate}`;

export type SleepPhase = 'awake' | 'night' | 'nap';

/**
 * 当前睡眠相位。flag 关 → 永远 awake;运行时 override 的 force 优先于
 * 作息表(force asleep 按夜睡处理);override 读取失败 fail-soft 按表走。
 */
export async function getSleepPhase(now: Date = new Date(), respectGlobalWake = true): Promise<SleepPhase> {
  if (!env().SLEEP_SCHEDULE_ENABLED) return 'awake';
  try {
    const ov = await loadOverrideCached(getRedis());
    const ss = ov?.sleep_schedule;
    if (ss?.enabled === false) return 'awake'; // 运行时临时关门(不动 env)
    if (ss?.force === 'awake') return 'awake';
    if (ss?.force === 'asleep') return 'night';
  } catch (err) {
    logger.debug({ err }, 'sleep: override read failed, falling back to schedule');
  }
  const ls = getLifeState(now);
  if (ls.state !== 'sleeping') return 'awake';
  // 排程说该睡了 —— 此时(且仅此时)才查各临时唤醒键,避免给白天每次调用加 redis 往返。
  // respectGlobalWake=false(走 isAsleep 的调用,即各主动 cron)忽略临时唤醒:DM 唤醒只让 bot
  // **回应群里来消息**,不应让半夜的 DM 触发 idle/proactive/pm-nudge 等主动外联(评审 Finding 1)。
  if (respectGlobalWake) {
    // 就寝推迟 hold(对话进行中晚安守卫):hold 生效期内消息路径当醒。
    // **必须**独立于 SLEEP_WAKE_ON_DM_ENABLED(默认 false)—— 嵌进那个分支
    // 会变成"扣住晚安但照样静音",对话中 bot 无声消失还没有道别。
    try {
      if (await getRedis().get(BEDTIME_HOLD_KEY)) return 'awake';
    } catch (err) {
      logger.debug({ err }, 'sleep: bedtime-hold read failed, falling back to schedule');
    }
    if (env().SLEEP_WAKE_ON_DM_ENABLED) {
      try {
        if (await getRedis().get(GLOBAL_WAKE_KEY)) return 'awake'; // DM 唤醒窗口内 → 收消息路径当醒
      } catch (err) {
        logger.debug({ err }, 'sleep: global-wake read failed, falling back to schedule');
      }
    }
  }
  return ls.nap ? 'nap' : 'night';
}

// ── 就寝推迟 hold(晚安时机守卫,sleep-cycle 写/查)─────────────────
const BEDTIME_HOLD_KEY = 'xxb:sleep:bedtime_hold';

/** 推迟就寝 N 分钟:hold 生效期内消息路径按醒处理、sleep-cycle 不做入睡转换。 */
export async function holdBedtime(minutes: number): Promise<void> {
  await getRedis().set(BEDTIME_HOLD_KEY, '1', 'EX', Math.max(60, Math.round(minutes * 60)));
}

/** hold 是否生效中(sleep-cycle 边沿检测用;读失败按未 hold 处理)。 */
export async function isBedtimeHeld(): Promise<boolean> {
  try {
    return (await getRedis().get(BEDTIME_HOLD_KEY)) !== null;
  } catch {
    return false;
  }
}

/**
 * 是否在睡(排程口径,**不含** DM 临时唤醒)。主动 cron(idle/proactive-scan/pm-nudge/
 * network-burst/reactions/self-continue 等)用这个 → 半夜被 DM 唤醒时也不会去主动外联。
 * 「回应群里来消息」的睡眠门走 pipeline 的 getSleepPhase()(默认 respectGlobalWake=true)。
 */
export async function isAsleep(now: Date = new Date()): Promise<boolean> {
  return (await getSleepPhase(now, false)) !== 'awake';
}

/** "这一晚"归属的北京日期:中午 12 点前算昨晚(与 prevSched 投影一致) */
export function nightDateStr(now: Date = new Date()): string {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return minutes < 12 * 60 ? bjDateStr(new Date(now.getTime() - 86400_000)) : bjDateStr(now);
}

// ── Stage A(judge 之前)──────────────────────────────────────────────
// 指令/点名/功能规则 → continue(命令分发与 Stage B 接手);
// 对话热度类 L0 自动接话 → 不烧 judge,直接入队候补(queue);
// L0 null(将进 L1/heart 的闲聊)→ 夜睡时有预算地放行,预算外静默;
// 午睡太短,闲聊不烧 judge 也不攒。IGNORE/REJECT 不拦(judge 重跑 L0 零成本)。
const STAGE_A_QUEUE_RULES = new Set(['followup_to_bot', 'active_conv_engage']);

export type SleepStageAVerdict = 'continue' | 'silent' | 'queue';

export async function sleepStageAVerdict(
  chatId: number,
  l0: { action: string; rule?: string } | null,
  phase: SleepPhase,
): Promise<SleepStageAVerdict> {
  if (l0 && l0.action !== 'REPLY') return 'continue';
  if (l0 === null) {
    if (phase === 'nap') return 'silent';
    return (await nightJudgeBudgetOk(chatId)) ? 'continue' : 'silent';
  }
  const rule = l0.rule ?? '';
  if (STAGE_A_QUEUE_RULES.has(rule)) return phase === 'nap' ? 'silent' : 'queue';
  if (rule === 'bot_mentions_self') return 'silent'; // 别的 bot @我 —— 睡着就睡着
  return 'continue';
}

/**
 * 夜间闲聊烧 judge 的预算闸:每 chat 最小间隔 + 每晚总量上限。
 * 评审共识:engagement 预算压的是回复率不是调用次数,热群深夜必须有
 * 自己的闸;Redis 故障 fail-closed(省钱优先,睡觉时闲聊本来就该静默)。
 */
async function nightJudgeBudgetOk(chatId: number): Promise<boolean> {
  try {
    const redis = getRedis();
    const cool = await redis.set(JUDGE_COOL_KEY(chatId), '1', 'EX', NIGHT_JUDGE_COOLDOWN_SEC, 'NX');
    if (cool === null) return false;
    const key = JUDGE_BUDGET_KEY(chatId, nightDateStr());
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 36 * 3600);
    return n <= NIGHT_JUDGE_BUDGET;
  } catch {
    return false;
  }
}

// ── Stage B(命令分发之后、timing gate 之前)─────────────────────────
// 走到这里的 REPLY:slash/NL 命令已被拦截层消化。功能规则豁免(post-mute
// 拦截还要处理;whitelisted_command 中 /checkin /stats 由回复 LLM 渲染,
// 必须流到生成层)。点名规则掷吵醒骰子;其余 REPLY(heart/L1 判的闲聊、
// turn_replan 回访锚点)不掷骰 —— 攒进队列,醒后补。
const STAGE_B_EXEMPT_RULES = new Set([
  'whitelisted_command',
  'self_mute_request',
  'self_unmute_request',
  'sticker_dislike',
]);

/** 真正点名的规则才有资格把猫吵醒 */
const ADDRESSED_WAKE_RULES = new Set([
  'mention_self', 'mention_self_lookup',
  'reply_to_self', 'reply_to_self_lookup', 'reply_to_self_followup_lookup',
  'private_chat',
]);

export type SleepWakeVerdict = 'pass' | 'wake' | 'queue';

/**
 * Stage B 裁决。豁免 → pass;点名 → 升级式吵醒(主人必醒,迷糊窗口内
 * 继续接话,午睡概率翻倍),没醒 → queue;非点名 REPLY → queue。
 * Redis 故障 fail-open(放行,宁可睡不着也别把指令吞了)。
 */
export async function sleepWakeDecision(
  chatId: number,
  uid: number,
  rule: string | undefined,
  phase: SleepPhase = 'night',
): Promise<SleepWakeVerdict> {
  if (STAGE_B_EXEMPT_RULES.has(rule ?? '')) return 'pass';
  if (!ADDRESSED_WAKE_RULES.has(rule ?? '')) return 'queue';

  const redis = getRedis();
  if (isMaster(uid, env().MASTER_UID)) {
    await redis.set(GROGGY_KEY(chatId), '1', 'EX', GROGGY_WINDOW_SEC).catch(() => {});
    return 'wake'; // 主人叫,必须醒
  }

  try {
    // 已被吵醒还没睡回去 → 继续迷糊地接话
    if (await redis.get(GROGGY_KEY(chatId))) return 'wake';

    const count = await redis.incr(DISTURB_KEY(chatId));
    if (count === 1) await redis.expire(DISTURB_KEY(chatId), DISTURB_WINDOW_SEC);
    let p = WAKE_PROBABILITIES[Math.min(count, WAKE_PROBABILITIES.length) - 1]!;
    if (phase === 'nap') p = Math.min(1, p * NAP_WAKE_FACTOR);
    if (Math.random() < p) {
      await redis.set(GROGGY_KEY(chatId), '1', 'EX', GROGGY_WINDOW_SEC).catch(() => {});
      logger.info({ chatId, uid, count, phase }, 'Sleep: woken up by direct interaction');
      return 'wake';
    }
    logger.info({ chatId, uid, count, rule, phase }, 'Sleep: direct interaction, stayed asleep (queued)');
    return 'queue';
  } catch (err) {
    logger.debug({ err, chatId }, 'sleep: wake decision redis failed, fail-open');
    return 'pass';
  }
}
