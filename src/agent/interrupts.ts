// 长时间 Agent 循环：用户消息注入（interrupts）。
//
// 任务 active 期间用户发消息，不重复 dispatch 新 CodeAct（避免同 chat 并发），
// 而是写进该任务的 interrupt 列表。下一段续跑时注入 history 顶部，
// 模型自然响应：主人问进度 / 让停 / 补充需求。

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

const INTERRUPT_KEY = (taskId: string) => `xxb:agent:interrupt:${taskId}`;
const MAX_INTERRUPTS = 20; // 单任务最多积累多少条，防刷屏
const TTL_SEC = 86_400; // 24h

export interface AgentInterrupt {
  text: string;
  from: string;
  messageId?: number;
  at: number;
  // round 177（计划 (b) 的观测半边）：这条 interrupt 是不是**冲着 bot 来**的。
  //
  // 现场（2026-09-23 15:05）：3 条人类消息被推进同一个正在跑的任务，
  // 其中 "你看看在那个 状态检测那边" / "能不能重启 waro" / "warp*"
  // **没有 @ 也没回复 bot**，只是群里闲聊——任务照样每条都回，
  // 于是一个任务 51 秒发了 4 次。
  //
  // k3 round 173 建议的治法（(b) interrupt 分级）：只让**寻址**的 interrupt
  // 要求回应，其余只作背景注入。但那是 prompt 语义改动，而我现在没有
  // taskId 生产数据能验它——所以先只**打标 + 计数**，拿到分桶数据再定。
  //
  // 缺省 undefined = 旧数据/未判定，消费方按"未知"处理，不当成寻址。
  addressed?: boolean;
}

export async function pushInterrupt(
  taskId: string,
  interrupt: Omit<AgentInterrupt, 'at'>,
): Promise<void> {
  try {
    const redis = getRedis();
    const key = INTERRUPT_KEY(taskId);
    const len = await redis.rpush(key, JSON.stringify({ ...interrupt, at: Date.now() }));
    if (len > MAX_INTERRUPTS) {
      // 只留最新的 MAX_INTERRUPTS 条（裁掉最旧的）。
      await redis.ltrim(key, -MAX_INTERRUPTS, -1);
    }
    await redis.expire(key, TTL_SEC);
  } catch (err) {
    logger.warn({ err, taskId }, 'agent interrupt push failed');
  }
}

export async function drainInterrupts(taskId: string): Promise<AgentInterrupt[]> {
  try {
    const redis = getRedis();
    const key = INTERRUPT_KEY(taskId);
    const raw = await redis.lrange(key, 0, -1);
    if (raw.length > 0) await redis.del(key);
    return raw
      .map((s) => {
        try {
          return JSON.parse(s) as AgentInterrupt;
        } catch {
          return null;
        }
      })
      .filter((x): x is AgentInterrupt => x !== null);
  } catch {
    return [];
  }
}

export async function hasActiveInterrupts(taskId: string): Promise<boolean> {
  try {
    const len = await getRedis().llen(INTERRUPT_KEY(taskId));
    return len > 0;
  } catch {
    return false;
  }
}

// ── 硬停词:用户明确喊停 → 立即终止任务,不等模型自觉 ──
// 只匹配**短消息**(≤12 字):长句里的"停"多半是内容不是指令
// ("停更公告""别停下来"都不是喊停)。任务进行中收到"算了/别做了"，
// 语义上就是取消当前任务。
const HARD_STOP_ZH = /^(停|停下|停下来|停止|停一下|打住|住手|算了|取消|不用了|别弄了|别做了|别搞了|别画了|别写了|别发了|别说了|先别做|先停|停停停)[!！~。.吧吗啊呀呢]*$/;
const HARD_STOP_EN = /^(stop|cancel|halt|quit)( it| this)?[!.]*$/i;

export function isHardStop(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 12) return false;
  return HARD_STOP_ZH.test(t) || HARD_STOP_EN.test(t);
}
