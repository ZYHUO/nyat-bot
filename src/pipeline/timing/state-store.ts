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
// 普通统计写入沿用 ioredis pipeline；WAIT 的安装、领取、取消使用原子 Lua，
// 以独立代次保护跨进程队列回调，不依赖回调持有 chat-lock。

import { getRedis } from '../../db/redis.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export type RuntimeState = 'RUNNING' | 'WAIT' | 'STOP';

export interface ChatTimingState {
  state: RuntimeState;
  /** Opaque wait identity, retained after claim until cancellation/new work. */
  waitGeneration?: string;
  waitThreadId?: number;
  waitUntil?: number;
  waitJobId?: string;
  waitAnchorMid?: number;
  lastBotReplyAt?: number;
  lastUserMsgAt?: number;
  lastGateAt?: number;
  lastGateAction?: 'continue' | 'wait' | 'no_action';
  lastGateUid?: number;
  /** 连续 no_action 次数(指数退避用;continue/回复后清零)。MaiBot 借鉴。 */
  noActionCount?: number;
  /** 触发 WAIT 的发送者 uid 集合(per-person 抑制用;TURN_WAIT_PER_PERSON)。
   *  同一回合多锚点可能多人同时触发 wait → 用集合而非单值,所有人都被抑制。 */
  waitTriggerUids?: number[];
  /** WAIT 关联的话题 key(per-person 抑制的话题细化;actor 读,当前无写入方,
   *  缺失时按 legacy 整人抑制)。补类型修 actor.ts 的既有 TS2339。 */
  waitTopicKey?: string;
  /** P1-C:自上次 gate 真实评估/bot 回复以来攒下的用户消息数(talk_value 阈值用)。 */
  gatePendingCount?: number;
  /** P1-C:开始攒这批消息的时刻(epoch_ms;空闲补偿的基准点)。 */
  gatePendingSince?: number;
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
  if (raw['waitGeneration']) out.waitGeneration = raw['waitGeneration'];
  if (raw['waitThreadId']) out.waitThreadId = Number(raw['waitThreadId']);
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
  if (raw['lastGateUid']) {
    const n = Number(raw['lastGateUid']);
    if (Number.isFinite(n)) out.lastGateUid = n;
  }
  if (raw['noActionCount']) {
    const n = Number(raw['noActionCount']);
    if (Number.isFinite(n) && n > 0) out.noActionCount = n;
  }
  if (raw['waitTriggerUids']) {
    out.waitTriggerUids = parseUidList(raw['waitTriggerUids']);
  }
  if (raw['waitTopicKey']) out.waitTopicKey = raw['waitTopicKey'];
  if (raw['gatePendingCount']) {
    const n = Number(raw['gatePendingCount']);
    if (Number.isFinite(n) && n > 0) out.gatePendingCount = n;
  }
  if (raw['gatePendingSince']) {
    const n = Number(raw['gatePendingSince']);
    if (Number.isFinite(n)) out.gatePendingSince = n;
  }
  return out;
}

/** P1-C:gate 真实评估/对话推进时清零攒数(折进各写入点的 persist patch)。 */
const GATE_PENDING_RESET = { gatePendingCount: '0' } as const;

/** 逗号分隔的 uid 列表 → number[](非数字段被忽略)。 */
function parseUidList(raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const n = Number(part);
    if (Number.isFinite(n)) out.push(Math.trunc(n));
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
export async function getChatState(chatId: number, strict = false): Promise<ChatTimingState> {
  const redis = getRedis();
  let raw: Record<string, string>;
  try {
    raw = await redis.hgetall(key(chatId));
  } catch (err) {
    if (strict) throw err;
    logger.warn({ err, chatId }, 'getChatState read failed, defaulting to RUNNING');
    return { state: 'RUNNING' };
  }

  if (!raw || Object.keys(raw).length === 0) {
    return { state: 'RUNNING' };
  }

  if (strict && raw['state'] !== undefined && !['RUNNING', 'STOP', 'WAIT'].includes(raw['state'])) {
    throw new Error('timing_state_invalid');
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
  ttlOverride?: number,
): Promise<void> {
  const redis = getRedis();
  const ttl = ttlOverride ?? env().TIMING_STATE_TTL_SEC;
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
    if (persistFailStreak > 0) {
      persistFailStreak = 0;
      logger.info('timing state persist recovered');
    }
  } catch (err) {
    // P1 fix(2026-08-22 审查): persist 连续失败说明 Redis 偏态故障——状态机在"失忆运行"
    // (退避/攒批/WAIT 抑制全部失效)。升 error 让报警能抓到, 并暴露 degraded 标志。
    persistFailStreak += 1;
    const level = persistFailStreak >= PERSIST_FAIL_ERROR_THRESHOLD ? 'error' : 'warn';
    logger[level]({ err, chatId, streak: persistFailStreak }, 'persist timing state failed');
  }
}

/** 连续 persist 失败计数与降级阈值。>0 即表示当前 timing 状态不可信(写不进 Redis)。 */
let persistFailStreak = 0;
const PERSIST_FAIL_ERROR_THRESHOLD = 3;

/** timing 状态是否处于写入退化(Redis 写失败中)。消费方可据此跳过依赖陈旧状态的短路层。 */
export function isTimingDegraded(): boolean {
  return persistFailStreak >= PERSIST_FAIL_ERROR_THRESHOLD;
}

export async function enterRunning(chatId: number): Promise<void> {
  await persist(
    chatId,
    { state: 'RUNNING' },
    ['waitUntil', 'waitJobId', 'waitAnchorMid', 'waitTriggerUids', 'waitGeneration', 'waitScheduledAt', 'waitThreadId'],
  );
}

export async function enterStop(chatId: number, triggerUid?: number, ttlSec?: number): Promise<void> {
  await persist(
    chatId,
    {
      state: 'STOP',
      lastGateAt: Date.now(),
      lastGateAction: 'no_action',
      ...(triggerUid !== undefined ? { lastGateUid: triggerUid } : {}),
      ...GATE_PENDING_RESET,
      gatePendingSince: Date.now(),
    },
    ['waitUntil', 'waitJobId', 'waitAnchorMid', 'waitTriggerUids', 'waitGeneration', 'waitScheduledAt', 'waitThreadId'],
    ttlSec,
  );
}

export async function enterWait(
  chatId: number,
  waitSec: number,
  anchorMessageId?: number,
  waitJobId?: string,
  triggerUid?: number,
  waitUntilOverrideMs?: number,
): Promise<void> {
  const patch: Record<string, string | number> = {
    state: 'WAIT',
    waitUntil: waitUntilOverrideMs ?? Date.now() + waitSec * 1000,
    lastGateAt: Date.now(),
    lastGateAction: 'wait',
    ...GATE_PENDING_RESET,
    gatePendingSince: Date.now(),
  };
  if (anchorMessageId !== undefined) patch['waitAnchorMid'] = anchorMessageId;
  if (waitJobId) patch['waitJobId'] = waitJobId;
  if (triggerUid !== undefined) {
    patch['lastGateUid'] = triggerUid;
    // 集合化(L1):同一回合多锚点可能多人触发 wait,append 到现有集合(去重),
    // 而非覆盖。read-modify-write —— wait 不高频,多一次 HGET 可接受。
    let existing: number[] = [];
    try {
      const raw = await getRedis().hget(key(chatId), 'waitTriggerUids');
      if (typeof raw === 'string') existing = parseUidList(raw);
    } catch (err) {
      logger.debug({ err, chatId }, 'read waitTriggerUids for append failed (non-critical)');
    }
    const set = new Set(existing);
    set.add(triggerUid);
    patch['waitTriggerUids'] = [...set].join(',');
  }
  await persist(chatId, patch);
}

// A wait's durable identity is installed before queue I/O. Every follow-up
// mutation compares this identity, so a slow enqueue cannot restore cancelled
// work or overwrite a newer wait. These operations must propagate Redis errors.
export const WAIT_BEGIN_SCRIPT = `-- timing-wait-begin-v1
local previousUids = redis.call('HGET', KEYS[1], 'waitTriggerUids') or ''
if redis.call('HGET', KEYS[1], 'state') ~= 'WAIT'
  or (redis.call('HGET', KEYS[1], 'waitThreadId') or '0') ~= ARGV[7] then previousUids = '' end
redis.call('HDEL', KEYS[1], 'waitJobId', 'waitAnchorMid', 'waitTriggerUids', 'waitTopicKey')
redis.call('HSET', KEYS[1], 'state', 'WAIT', 'waitGeneration', ARGV[1],
  'waitScheduledAt', ARGV[2], 'waitUntil', ARGV[3], 'lastGateAt', ARGV[2],
  'lastGateAction', 'wait', 'gatePendingCount', '0', 'gatePendingSince', ARGV[2], 'waitThreadId', ARGV[7])
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'waitAnchorMid', ARGV[4]) end
if ARGV[5] ~= '' then
  local uids = previousUids
  if not string.find(',' .. uids .. ',', ',' .. ARGV[5] .. ',', 1, true) then
    uids = uids == '' and ARGV[5] or uids .. ',' .. ARGV[5]
  end
  redis.call('HSET', KEYS[1], 'lastGateUid', ARGV[5], 'waitTriggerUids', uids)
end
redis.call('EXPIRE', KEYS[1], ARGV[6])
return 1`;

export const WAIT_ATTACH_SCRIPT = `-- timing-wait-attach-v1
if redis.call('HGET', KEYS[1], 'state') ~= 'WAIT'
  or redis.call('HGET', KEYS[1], 'waitGeneration') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'waitJobId', ARGV[2])
return 1`;

export const WAIT_CANCEL_SCRIPT = `-- timing-wait-cancel-v1
if redis.call('HGET', KEYS[1], 'waitGeneration') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', 'RUNNING')
redis.call('HDEL', KEYS[1], 'waitGeneration', 'waitScheduledAt', 'waitUntil', 'waitJobId', 'waitAnchorMid', 'waitTriggerUids', 'waitTopicKey', 'waitThreadId')
return 1`;

export const WAIT_CANCEL_SCOPE_SCRIPT = `-- timing-wait-cancel-scope-v1
if not redis.call('HGET', KEYS[1], 'state') then return 0 end
if (redis.call('HGET', KEYS[1], 'waitThreadId') or '0') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', 'RUNNING')
redis.call('HDEL', KEYS[1], 'waitGeneration', 'waitScheduledAt', 'waitUntil', 'waitJobId', 'waitAnchorMid', 'waitTriggerUids', 'waitTopicKey', 'waitThreadId')
return 1`;

export const WAIT_CLAIM_SCRIPT = `-- timing-wait-claim-v1
if redis.call('HGET', KEYS[1], 'state') ~= 'WAIT' then return {'stale', '0'} end
local generation = redis.call('HGET', KEYS[1], 'waitGeneration')
local deadline = tonumber(redis.call('HGET', KEYS[1], 'waitUntil'))
if not deadline then return {'invalid', '0'} end
if generation then
  if generation ~= ARGV[1] or deadline ~= tonumber(ARGV[2]) then return {'stale', '0'} end
  local job = redis.call('HGET', KEYS[1], 'waitJobId')
  if job and ARGV[3] ~= '' and job ~= ARGV[3] then return {'stale', '0'} end
else
  local job = redis.call('HGET', KEYS[1], 'waitJobId')
  if ARGV[1] ~= '' or ARGV[3] == '' or not job or job ~= ARGV[3] then return {'stale', '0'} end
end
local anchor = redis.call('HGET', KEYS[1], 'waitAnchorMid') or ''
if anchor ~= ARGV[4] then return {'stale', '0'} end
if tonumber(ARGV[5]) < deadline then return {'early', tostring(deadline)} end
redis.call('HSET', KEYS[1], 'state', 'RUNNING')
redis.call('HDEL', KEYS[1], 'waitScheduledAt', 'waitUntil', 'waitJobId', 'waitAnchorMid', 'waitTriggerUids', 'waitTopicKey')
return {'claimed', tostring(deadline)}`;

export async function beginScheduledWait(chatId: number, input: {
  waitGeneration: string; scheduledAt: number; waitUntil: number;
  anchorMessageId?: number; triggerUid?: number; messageThreadId?: number;
}): Promise<void> {
  await getRedis().eval(WAIT_BEGIN_SCRIPT, 1, key(chatId), input.waitGeneration,
    String(input.scheduledAt), String(input.waitUntil), String(input.anchorMessageId ?? ''),
    String(input.triggerUid ?? ''), String(env().TIMING_STATE_TTL_SEC), String(normalizedWaitThread(input.messageThreadId)));
}

export async function attachWaitJob(chatId: number, generation: string, jobId: string): Promise<boolean> {
  return Number(await getRedis().eval(WAIT_ATTACH_SCRIPT, 1, key(chatId), generation, jobId)) === 1;
}

export async function cancelWaitGeneration(chatId: number, generation: string): Promise<void> {
  await getRedis().eval(WAIT_CANCEL_SCRIPT, 1, key(chatId), generation);
}

/** Telegram General topic 1 and an omitted thread share the context scope 0. */
function normalizedWaitThread(messageThreadId = 0): number {
  return messageThreadId > 1 ? messageThreadId : 0;
}

export async function cancelWaitForScope(chatId: number, messageThreadId = 0): Promise<void> {
  await getRedis().eval(WAIT_CANCEL_SCOPE_SCRIPT, 1, key(chatId), String(normalizedWaitThread(messageThreadId)));
}

export type WaitClaim = { status: 'claimed' | 'early'; waitUntil: number } | { status: 'stale' | 'invalid' };

/** Recovery reads raw state atomically, never the lazy-expired suppression view. */
export async function claimWaitResume(chatId: number, input: {
  waitGeneration?: string; waitUntil?: number; jobId?: string; anchorMessageId?: number;
}, now = Date.now()): Promise<WaitClaim> {
  const raw = await getRedis().eval(WAIT_CLAIM_SCRIPT, 1, key(chatId), input.waitGeneration ?? '',
    String(input.waitUntil ?? ''), input.jobId ?? '', String(input.anchorMessageId ?? ''), String(now));
  if (!Array.isArray(raw)) throw new Error('invalid_wait_claim_receipt');
  const status = String(raw[0]);
  if (status === 'stale' || status === 'invalid') return { status };
  const waitUntil = Number(raw[1]);
  if ((status !== 'claimed' && status !== 'early') || !Number.isSafeInteger(waitUntil)) {
    throw new Error('invalid_wait_claim_receipt');
  }
  return { status, waitUntil };
}

export async function recordContinue(chatId: number): Promise<void> {
  await persist(chatId, {
    lastGateAt: Date.now(),
    lastGateAction: 'continue',
    ...GATE_PENDING_RESET,
    gatePendingSince: Date.now(),
  }, ['noActionCount', 'lastGateUid']);
}

export async function recordBotReply(chatId: number): Promise<void> {
  await persist(chatId, {
    lastBotReplyAt: Date.now(),
    ...GATE_PENDING_RESET,
    gatePendingSince: Date.now(),
  }, ['noActionCount']);
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
 * 同时 HINCRBY noActionCount(指数退避;MaiBot base*2^(n-start) 语义),
 * continue/真实回复时清零。
 */
export async function recordGateNoAction(chatId: number, triggerUid?: number): Promise<void> {
  await persist(chatId, {
    lastGateAt: Date.now(),
    lastGateAction: 'no_action',
    ...(triggerUid !== undefined ? { lastGateUid: triggerUid } : {}),
    ...GATE_PENDING_RESET,
    gatePendingSince: Date.now(),
  });
  try {
    await getRedis().hincrby(key(chatId), 'noActionCount', 1);
  } catch (err) {
    logger.debug({ err, chatId }, 'noActionCount incr failed (non-critical)');
  }
}

/**
 * P1-C:每条真实处理的用户消息 +1(HINCRBY 原子,非 read-modify-write)。
 * gatePendingSince 只在缺失时补(HSETNX 语义):它是"这批消息开始攒"的时刻。
 */
export async function bumpGatePendingCount(chatId: number): Promise<void> {
  const redis = getRedis();
  const k = key(chatId);
  const ttl = env().TIMING_STATE_TTL_SEC;
  try {
    const pipeline = redis.pipeline();
    pipeline.hincrby(k, 'gatePendingCount', 1);
    pipeline.hsetnx(k, 'gatePendingSince', String(Date.now()));
    if (ttl > 0) pipeline.expire(k, ttl);
    await pipeline.exec();
  } catch (err) {
    logger.debug({ err, chatId }, 'bumpGatePendingCount failed (non-critical)');
  }
}
