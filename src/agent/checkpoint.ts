// 长时间 Agent 循环：checkpoint 持久化（Redis）。
//
// 每个任务每段结束时把 {history, 进度摘要, 产出清单} 存到 Redis。
// 续跑时据此恢复，崩溃/重启/换机都能接着干 —— 这是"长时间 agent"
// 与"一次性 CodeAct"的本质区别。

import { getRedis } from '../db/redis.js';
import type { DispatchTask } from '../meta/types.js';
import { logger } from '../shared/logger.js';

const CHECKPOINT_PREFIX = 'xxb:agent:checkpoint:';
const CHECKPOINT_TTL_SEC = 86_400; // 24h —— 足够跨天续跑，又不会无限堆积

export interface AgentCheckpoint {
  taskId: string;
  /** 任务原始 direction（幂等恢复时校验用）。 */
  contentDirection: string;
  /** 已执行的完整 history（跨段累积，超阈值会被 compaction 压缩）。 */
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /** 上一段的 LLM 总结：目标/已完成/发现/下一步/教训。 */
  progressSummary: string;
  /** 已产出的文件/消息等（用户可查进度）。 */
  artifacts: string[];
  segment: number;
  totalTurns: number;
  updatedAt: number;
}

export function checkpointKey(taskId: string): string {
  return `${CHECKPOINT_PREFIX}${taskId}`;
}

export async function saveCheckpoint(
  task: DispatchTask,
  cp: Omit<AgentCheckpoint, 'taskId' | 'contentDirection' | 'updatedAt'>,
): Promise<string> {
  const key = checkpointKey(task.id);
  const full: AgentCheckpoint = {
    taskId: task.id,
    contentDirection: task.contentDirection,
    ...cp,
    updatedAt: Date.now(),
  };
  try {
    await getRedis().set(key, JSON.stringify(full), 'EX', CHECKPOINT_TTL_SEC);
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'agent checkpoint save failed');
  }
  return key;
}

export async function loadCheckpoint(key: string): Promise<AgentCheckpoint | null> {
  try {
    const raw = await getRedis().get(key);
    if (!raw) return null;
    return JSON.parse(raw) as AgentCheckpoint;
  } catch {
    return null;
  }
}

export async function clearCheckpoint(key: string): Promise<void> {
  try {
    await getRedis().del(key);
  } catch {
    /* ignore */
  }
}

// ---- 长任务 → chat 索引 -------------------------------------------------
// active lock 只有 180s TTL，任务等待下一段的窗口期会查不到；这个索引
// 24h 持久，供消息入口判断「该 chat 是否有长任务在跑，消息应走 interrupt」。

const CHAT_TASK_KEY = (chatId: number) => `xxb:agent:active-chat:${chatId}`;
const CHAT_TASK_TTL_SEC = 86_400;

export async function registerAgentChat(chatId: number, taskId: string): Promise<void> {
  try {
    await getRedis().set(CHAT_TASK_KEY(chatId), taskId, 'EX', CHAT_TASK_TTL_SEC);
  } catch {
    /* ignore */
  }
}

export async function unregisterAgentChat(chatId: number, taskId: string): Promise<void> {
  try {
    const redis = getRedis();
    const cur = await redis.get(CHAT_TASK_KEY(chatId));
    if (cur === taskId || !cur) await redis.del(CHAT_TASK_KEY(chatId));
  } catch {
    /* ignore */
  }
}

export async function getAgentTaskIdForChat(chatId: number): Promise<string | null> {
  try {
    return await getRedis().get(CHAT_TASK_KEY(chatId));
  } catch {
    return null;
  }
}
