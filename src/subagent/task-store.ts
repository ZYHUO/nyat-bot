// Redis helpers for durable CodeAct task state / per-chat busy lock.

import { getRedis } from '../db/redis.js';
import type { DispatchTask } from '../meta/types.js';

const ACTIVE_KEY = (chatId: number) => `xxb:codeact:active:${chatId}`;
const QUOTE_CLAIM_KEY = (chatId: number, messageId: number) =>
  `xxb:meta:quote_claim:${chatId}:${messageId}`;
const TASK_HASH = 'xxb:codeact:tasks';
const ACTIVE_TTL_SEC = 180;
const QUOTE_CLAIM_TTL_SEC = 600;

export async function tryMarkCodeActActive(chatId: number, taskId: string): Promise<boolean> {
  const redis = getRedis();
  const key = ACTIVE_KEY(chatId);
  const cur = await redis.get(key);
  if (cur === taskId) {
    await redis.expire(key, ACTIVE_TTL_SEC);
    return true; // same task already claimed at enqueue
  }
  if (cur) return false;
  const ok = await redis.set(key, taskId, 'EX', ACTIVE_TTL_SEC, 'NX');
  return ok === 'OK';
}

/** Claim a specific user message so Meta cannot double-dispatch the same quote. */
export async function tryClaimQuote(
  chatId: number,
  messageId: number,
  taskId: string,
): Promise<boolean> {
  if (!Number.isFinite(messageId) || messageId <= 0) return true;
  try {
    const redis = getRedis();
    const key = QUOTE_CLAIM_KEY(chatId, messageId);
    const cur = await redis.get(key);
    if (cur === taskId) return true;
    if (cur) return false;
    const ok = await redis.set(key, taskId, 'EX', QUOTE_CLAIM_TTL_SEC, 'NX');
    return ok === 'OK';
  } catch {
    return true; // fail-open
  }
}

export async function clearCodeActActive(chatId: number, taskId: string): Promise<void> {
  try {
    const redis = getRedis();
    const cur = await redis.get(ACTIVE_KEY(chatId));
    if (cur === taskId || !cur) await redis.del(ACTIVE_KEY(chatId));
  } catch {
    /* ignore */
  }
}

export async function isCodeActBusy(chatId: number): Promise<boolean> {
  try {
    const v = await getRedis().get(ACTIVE_KEY(chatId));
    return !!v;
  } catch {
    return false;
  }
}

export async function persistCodeActTask(task: DispatchTask): Promise<void> {
  try {
    const redis = getRedis();
    await redis.hset(TASK_HASH, task.id, JSON.stringify(task));
    // Keep hash from growing forever: opportunistic trim of old done/failed
    if (task.status === 'done' || task.status === 'failed') {
      await redis.expire(TASK_HASH, 86400);
    }
  } catch {
    /* ignore */
  }
}

export async function loadCodeActTask(taskId: string): Promise<DispatchTask | null> {
  try {
    const raw = await getRedis().hget(TASK_HASH, taskId);
    if (!raw) return null;
    return JSON.parse(raw) as DispatchTask;
  } catch {
    return null;
  }
}
