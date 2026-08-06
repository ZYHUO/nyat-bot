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
