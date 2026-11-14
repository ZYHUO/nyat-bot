// 长时间 Agent 循环：checkpoint 持久化（Redis）。
//
// 每个任务每段结束时把 {history, 进度摘要, 产出清单} 存到 Redis。
// 续跑时据此恢复，崩溃/重启/换机都能接着干 —— 这是"长时间 agent"
// 与"一次性 CodeAct"的本质区别。

import { getRedis } from '../db/redis.js';
import { createHash } from 'node:crypto';
import type { DispatchTask } from '../meta/types.js';
import { logger } from '../shared/logger.js';
import { matchesContextScope, resolveContextScope } from '../context-engine/scope.js';
import type { ContextScope } from '../context-engine/scope.js';

const CHECKPOINT_PREFIX = 'xxb:agent:checkpoint:';
const CHECKPOINT_TTL_SEC = 86_400; // 24h —— 足够跨天续跑，又不会无限堆积

export interface AgentCheckpoint {
  version: 2;
  source: ContextScope;
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
  /**
   * 该任务累计已发出的消息数（跨段）。见 DispatchTask.sendsUsed —— 发送预算
   * 必须跨段累计才算得准，否则每段重建 host 就归零，限额形同虚设。
   */
  sendsUsed?: number;
  updatedAt: number;
}

export function checkpointKey(taskId: string): string {
  return `${CHECKPOINT_PREFIX}${taskId}`;
}

export async function saveCheckpoint(
  task: DispatchTask,
  cp: Omit<AgentCheckpoint, 'version' | 'source' | 'taskId' | 'contentDirection' | 'updatedAt'>,
): Promise<string> {
  const key = checkpointKey(task.id);
  const source = resolveContextScope(task.chatId, task.messageThreadId);
  if (!source) throw new Error('checkpoint_scope_unavailable');
  const full: AgentCheckpoint = {
    ...cp,
    version: 2,
    source,
    taskId: task.id,
    contentDirection: task.contentDirection,
    updatedAt: Date.now(),
  };
  try {
    await getRedis().set(key, JSON.stringify(full), 'EX', CHECKPOINT_TTL_SEC);
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'agent checkpoint save failed');
  }
  return key;
}

export type CheckpointRejectionReason = 'checkpoint_missing' | 'checkpoint_invalid' | 'checkpoint_unavailable';

const RETIRE_HELD_CHECKPOINT_LUA = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
local agent = redis.call('GET', KEYS[3])
local active = redis.call('GET', KEYS[4])
redis.call('HSETNX', KEYS[2], ARGV[4], ARGV[5])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
if agent == ARGV[1] then redis.call('DEL', KEYS[3]) end
if active == ARGV[1] then redis.call('DEL', KEYS[4]) end
return 1
`;

/** Archive first at the caller; only an exact durable task snapshot may be retired.
 * Pre-commit failures/races leave the original task and indexes for a later retry.
 * Never throw into the queue's generic failure cleanup for unverified queue data.
 */
export async function retireHeldCheckpointTask(
  task: DispatchTask, reason: CheckpointRejectionReason,
): Promise<DispatchTask | null> {
  try {
    const redis = getRedis();
    const raw = await redis.hget('xxb:codeact:tasks', task.id);
    if (!raw) return null;
    const stored = JSON.parse(raw) as DispatchTask;
    if (!stored || stored.id !== task.id || stored.chatId !== task.chatId
      || stored.createdAt !== task.createdAt || stored.checkpointKey !== task.checkpointKey
      || (stored.messageThreadId ?? 0) !== (task.messageThreadId ?? 0)
      || !['running', 'queued', 'waiting_user'].includes(stored.status)) return null;
    const retired: DispatchTask = {
      ...stored, status: 'failed', waitingForUser: false, waitingReason: undefined,
      resultSummary: `held_${reason}`,
    };
    const version = createHash('sha256').update(raw).digest('hex');
    const archived = JSON.stringify({ heldAt: Date.now(), reason, taskRaw: raw });
    const changed = await redis.eval(RETIRE_HELD_CHECKPOINT_LUA, 4,
      'xxb:codeact:tasks', 'xxb:codeact:checkpoint-held',
      `xxb:agent:active-chat:${task.chatId}`, `xxb:codeact:active:${task.chatId}`,
      task.id, raw, JSON.stringify(retired), `${task.id}:${version}`, archived);
    return changed === 1 ? retired : null;
  } catch {
    logger.warn({ taskId: task.id, chatId: task.chatId }, 'Held checkpoint cleanup unconfirmed; inspect durable state before retry');
    return null;
  }
}

export async function loadCheckpoint(
  key: string, task?: DispatchTask, onReject?: (reason: CheckpointRejectionReason) => void,
): Promise<AgentCheckpoint | null> {
  const reject = (reason: CheckpointRejectionReason): null => { onReject?.(reason); return null; };
  try {
    if (!key.startsWith(CHECKPOINT_PREFIX) || (task && key !== checkpointKey(task.id))) return reject('checkpoint_invalid');
    const raw = await getRedis().get(key);
    if (raw === null) return reject('checkpoint_missing');
    let cp: AgentCheckpoint;
    try { cp = JSON.parse(raw) as AgentCheckpoint; } catch { return reject('checkpoint_invalid'); }
    if (!cp || cp.version !== 2 || typeof cp.taskId !== 'string' || key !== checkpointKey(cp.taskId)
      || typeof cp.contentDirection !== 'string' || typeof cp.progressSummary !== 'string'
      || !Array.isArray(cp.history) || !cp.history.every(m => m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string')
      || !Array.isArray(cp.artifacts) || !cp.artifacts.every(a => typeof a === 'string')
      || ![cp.segment, cp.totalTurns, cp.updatedAt].every(n => Number.isSafeInteger(n) && n >= 0)
      || (cp.sendsUsed !== undefined && (!Number.isSafeInteger(cp.sendsUsed) || cp.sendsUsed < 0))) return reject('checkpoint_invalid');
    const scope = task ? resolveContextScope(task.chatId, task.messageThreadId)
      : resolveContextScope(cp.source?.chatId, cp.source?.threadId);
    // No provenance, wrong account/topic or a foreign task key never becomes trusted history.
    if (!matchesContextScope(cp.source, scope) || (task && cp.taskId !== task.id)) return reject('checkpoint_invalid');
    return cp;
  } catch {
    return reject('checkpoint_unavailable');
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
