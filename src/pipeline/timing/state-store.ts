// ────────────────────────────────────────
// Phase 2: Per-chat timing state store (Redis-backed)
// ────────────────────────────────────────
//
// 每个被 timing 模块"碰过"的 chatId 在 Redis 里持有一个 Hash：
//
//   xxb:timing:state:{chatId} = {
//     state:            'RUNNING' | 'WAIT' | 'STOP',
//     waitUntil:        epoch_ms (when state=WAIT),
//     waitJobId:        BullMQ job id of the resume job (when state=WAIT),
//     waitAnchorMid:    last messageId at time of wait (for ingestion on resume),
//     lastBotReplyAt:   epoch_ms,
//     lastUserMsgAt:    epoch_ms,
//     lastGateAt:       epoch_ms,
//     lastGateAction:   'continue' | 'wait' | 'no_action',
//   }
//
// TTL 默认 24 小时，长时间无消息的 chat 自然清掉，重启时按"未知 → 默认 RUNNING"处理。
//
// 注意：所有写入用 ioredis 直接 HMSET / HSET 操作；并发由 acquireChatLock 协调。
// 这里不再加细粒度锁，依赖 chat-runtime.ts 的调用约束 + chat-lock。

import { getRedis } from '../../db/redis.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export type RuntimeState = 'RUNNING' | 'WAIT' | 'STOP';

export interface ChatTimingState {
  state: RuntimeState;
  waitUntil?: number;
  waitJobId?: string;
  waitAnchorMid?: number;
  lastBotReplyAt?: number;
  lastUserMsgAt?: number;
  lastGateAt?: number;
  lastGateAction?: 'continue' | 'wait' | 'no_action';
}

const KEY_PREFIX = 'xxb:timing:state:';

function key(chatId: number): string {
  return `${KEY_PREFIX}${chatId}`;
}

function parseState(raw: Record<string, string>): ChatTimingState {
  const stateStr = raw['state'];
  const state: RuntimeState =
    stateStr === 'WAIT' || stateStr === 'STOP' ? stateStr : 'RUNNING';

  const out: ChatTimingState = { state };
  if (raw['waitUntil']) {
    const n = Number(raw['waitUntil']);
    if (Number.isFinite(n)) out.waitUntil = n;
  }
  if (raw['waitJobId']) out.waitJobId = raw['waitJobId'];
  if (raw['waitAnchorMid']) {
    const n = Number(raw['waitAnchorMid']);
    if (Number.isFinite(n)) out.waitAnchorMid = n;
  }
  if (raw['lastBotReplyAt']) {
    const n = Number(raw['lastBotReplyAt']);
    if (Number.isFinite(n)) out.lastBotReplyAt = n;
  }
  if (raw['lastUserMsgAt']) {
    const n = Number(raw['lastUserMsgAt']);
    if (Number.isFinite(n)) out.lastUserMsgAt = n;
  }
  if (raw['lastGateAt']) {
    const n = Number(raw['lastGateAt']);
    if (Number.isFinite(n)) out.lastGateAt = n;
  }
  const gateAction = raw['lastGateAction'];
  if (
    gateAction === 'continue' ||
    gateAction === 'wait' ||
    gateAction === 'no_action'
  ) {
    out.lastGateAction = gateAction;
  }
  return out;
}

/**
 * Read the current timing state for a chat.
 * Returns RUNNING by default if the chat has no record yet.
 *
 * Side effect: if state=WAIT but waitUntil already in the past, returns RUNNING
 * (does NOT auto-write the cleanup; caller may use `enterRunning` if needed).
 */
export async function getChatState(chatId: number): Promise<ChatTimingState> {
  const redis = getRedis();
  let raw: Record<string, string>;
  try {
    raw = await redis.hgetall(key(chatId));
  } catch (err) {
    logger.warn({ err, chatId }, 'getChatState read failed, defaulting to RUNNING');
    return { state: 'RUNNING' };
  }

  if (!raw || Object.keys(raw).length === 0) {
    return { state: 'RUNNING' };
  }

  const parsed = parseState(raw);

  // Auto-expire WAIT if waitUntil already passed (lazy cleanup).
  if (parsed.state === 'WAIT' && parsed.waitUntil && parsed.waitUntil <= Date.now()) {
    return { ...parsed, state: 'RUNNING' };
  }

  return parsed;
}

async function persist(
  chatId: number,
  patch: Record<string, string | number | undefined>,
  remove: string[] = [],
): Promise<void> {
  const redis = getRedis();
  const ttl = env().TIMING_STATE_TTL_SEC;
  const flat: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    flat.push(k, typeof v === 'number' ? String(v) : v);
  }
  const k = key(chatId);
  try {
    const pipeline = redis.pipeline();
    if (flat.length > 0) pipeline.hset(k, ...flat);
    if (remove.length > 0) pipeline.hdel(k, ...remove);
    if (ttl > 0) pipeline.expire(k, ttl);
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, chatId }, 'persist timing state failed');
  }
}

export async function enterRunning(chatId: number): Promise<void> {
  await persist(
    chatId,
    { state: 'RUNNING' },
    ['waitUntil', 'waitJobId', 'waitAnchorMid'],
  );
}

export async function enterStop(chatId: number): Promise<void> {
  await persist(
    chatId,
    {
      state: 'STOP',
      lastGateAt: Date.now(),
      lastGateAction: 'no_action',
    },
    ['waitUntil', 'waitJobId', 'waitAnchorMid'],
  );
}

export async function enterWait(
  chatId: number,
  waitSec: number,
  anchorMessageId?: number,
  waitJobId?: string,
): Promise<void> {
  const patch: Record<string, string | number> = {
    state: 'WAIT',
    waitUntil: Date.now() + waitSec * 1000,
    lastGateAt: Date.now(),
    lastGateAction: 'wait',
  };
  if (anchorMessageId !== undefined) patch['waitAnchorMid'] = anchorMessageId;
  if (waitJobId) patch['waitJobId'] = waitJobId;
  await persist(chatId, patch);
}

export async function recordContinue(chatId: number): Promise<void> {
  await persist(chatId, {
    lastGateAt: Date.now(),
    lastGateAction: 'continue',
  });
}

export async function recordBotReply(chatId: number): Promise<void> {
  await persist(chatId, { lastBotReplyAt: Date.now() });
}

export async function recordUserMessage(chatId: number): Promise<void> {
  await persist(chatId, { lastUserMsgAt: Date.now() });
}

/** Forcibly clear all timing state (e.g., test reset). */
export async function clearChatState(chatId: number): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(key(chatId));
  } catch (err) {
    logger.debug({ err, chatId }, 'clearChatState failed (non-critical)');
  }
}

// ── exposed for testing ──
export const _internal = { key, parseState };

/**
 * 记录一次 gate no_action 决策(冷却用)但**不**进入 STOP。
 * actor 模式语义:no_action = "这条不接",人还在场 —— 旧的 enterStop 会把
 * chat 锁死到有人 @ 才醒,这正是"说几下就跑了"的根源。
 */
export async function recordGateNoAction(chatId: number): Promise<void> {
  await persist(chatId, {
    lastGateAt: Date.now(),
    lastGateAction: 'no_action',
  });
}
