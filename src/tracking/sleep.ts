// ────────────────────────────────────────
// Sleep Schedule — 硬作息门(到点睡觉/到点起床)
// ────────────────────────────────────────
//
// life-state(#5)是"软"作息:睡觉只调速+prompt 迷糊暗示,行为上仍然
// 24h 有问必答。这里把它升级成行为级:**睡着了就真的不闲聊**。
//
// 语义(与 mute gate 同级的确定性门,无 LLM):
//   - 指令不受限:slash 命令 / NL 命令(帮我签到)/ remember 等功能拦截
//     照常工作 —— 豁免规则集直接放行。
//   - 直接交互(@bot / 回 bot / 私聊)走**升级式吵醒**:第一次大概率
//     睡死,同一 chat 越 ping 越容易被吵醒;主人(MASTER_UID)必醒。
//   - 被吵醒后有一段"迷糊窗口":这段时间内的直接交互继续接话(回复
//     本身的迷糊语气由 self-state 的 sleeping 叙述注入),窗口过了睡回去。
//   - 其余(群聊闲聊、将进 L1/L2/heart 的消息)直接静默,不烧 LLM。
//
// 作息表来源:沿用 life-state 的 date-seeded daySchedule(每天不同,
// 像人)。运行时可经 RuntimeOverride.sleep_schedule 强制起床/快去睡
// (只改门的输入,不动作息表种子 —— 软层的暗示语保持自洽)。
// 状态全在 Redis/纯函数里,重启零丢失。

import { getRedis } from '../db/redis.js';
import { getLifeState } from './life-state.js';
import { loadOverrideCached } from '../admin/runtime-config.js';
import { isMaster } from '../admin/auth.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

// tunables
const DISTURB_WINDOW_SEC = 600;             // 吵醒计数窗口(同 chat)
const WAKE_PROBABILITIES = [0.15, 0.5, 1];  // 第 1/2/≥3 次直接交互的吵醒概率
const GROGGY_WINDOW_SEC = 300;              // 被吵醒后的迷糊清醒窗口

const DISTURB_KEY = (chatId: number): string => `xxb:sleep:disturb:${chatId}`;
const GROGGY_KEY = (chatId: number): string => `xxb:sleep:groggy:${chatId}`;

/**
 * 现在是否处于"硬睡眠"。flag 关 → 永远 false;运行时 override 的
 * force 优先于作息表;override 读取失败 fail-soft 按表走。
 */
export async function isAsleep(now: Date = new Date()): Promise<boolean> {
  if (!env().SLEEP_SCHEDULE_ENABLED) return false;
  try {
    const ov = await loadOverrideCached(getRedis());
    const ss = ov?.sleep_schedule;
    if (ss?.enabled === false) return false; // 运行时临时关门(不动 env)
    if (ss?.force === 'awake') return false;
    if (ss?.force === 'asleep') return true;
  } catch (err) {
    logger.debug({ err }, 'sleep: override read failed, falling back to schedule');
  }
  return getLifeState(now).state === 'sleeping';
}

// ── Stage A(judge 之前)──────────────────────────────────────────────
// 睡着时,这些 L0 结果直接静默:null(将烧 L1/L2/heart 的闲聊)和
// "对话热度"类自动接话规则。指令/直接交互/功能规则放行 —— 由命令分发
// 与 Stage B 接手。IGNORE/REJECT 不拦(judge 重跑 L0 零成本,语义不变)。
const STAGE_A_SILENT_RULES = new Set([
  'followup_to_bot',
  'active_conv_engage',
  'bot_mentions_self', // 别的 bot @我 —— 睡着就睡着
]);

export function sleepSilencesAtStageA(
  l0: { action: string; rule?: string } | null,
): boolean {
  if (!l0) return true; // 没命中确定性规则 → 本要进 L1/L2,睡眠中不烧
  if (l0.action !== 'REPLY') return false;
  return STAGE_A_SILENT_RULES.has(l0.rule ?? '');
}

// ── Stage B(命令分发之后、timing gate 之前)─────────────────────────
// 走到这里的 REPLY:slash/NL 命令已被拦截层消化(已 return),剩下的是
// 直接交互与功能规则。功能规则豁免(post-mute 拦截还要处理它们;
// whitelisted_command 中 /checkin /stats 由回复 LLM 渲染,必须流到生成层)。
const STAGE_B_EXEMPT_RULES = new Set([
  'whitelisted_command',
  'self_mute_request',
  'self_unmute_request',
  'mute_hard_request',
  'mute_soft_request',
  'mute_timed_request',
  'unmute_request',
  'remember_request',
  'view_prefs_request',
  'forget_request',
  'sticker_dislike',
]);

export type SleepWakeVerdict = 'pass' | 'wake' | 'silent';

/**
 * 升级式吵醒判定。主人必醒;迷糊窗口内继续接话;其他人按 ping 次数
 * 升级概率掷骰。判 wake 时刷新迷糊窗口。Redis 故障 fail-open(放行,
 * 宁可睡不着也别把指令吞了)。
 */
export async function sleepWakeDecision(
  chatId: number,
  uid: number,
  rule: string | undefined,
): Promise<SleepWakeVerdict> {
  if (STAGE_B_EXEMPT_RULES.has(rule ?? '')) return 'pass';

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
    const p = WAKE_PROBABILITIES[Math.min(count, WAKE_PROBABILITIES.length) - 1]!;
    if (Math.random() < p) {
      await redis.set(GROGGY_KEY(chatId), '1', 'EX', GROGGY_WINDOW_SEC).catch(() => {});
      logger.info({ chatId, uid, count }, 'Sleep: woken up by direct interaction');
      return 'wake';
    }
    logger.info({ chatId, uid, count, rule }, 'Sleep: direct interaction, stayed asleep');
    return 'silent';
  } catch (err) {
    logger.debug({ err, chatId }, 'sleep: wake decision redis failed, fail-open');
    return 'pass';
  }
}
