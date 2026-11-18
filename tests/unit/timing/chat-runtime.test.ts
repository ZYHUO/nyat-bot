import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { timingWaitEval } from '../../helpers/timing-wait-redis.js';

// Mock Redis with an in-memory hash store
const store = new Map<string, Record<string, string>>();

const redisMock = {
  eval: vi.fn(timingWaitEval(store)),
  hgetall: vi.fn(async (k: string) => store.get(k) ?? {}),
  hset: vi.fn(async (k: string, ...args: string[]) => {
    const h = store.get(k) ?? {};
    for (let i = 0; i < args.length; i += 2) {
      h[args[i]!] = args[i + 1]!;
    }
    store.set(k, h);
    return 'OK';
  }),
  hdel: vi.fn(async (k: string, ...fields: string[]) => {
    const h = store.get(k);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (delete h[f]) n++;
    return n;
  }),
  expire: vi.fn(async () => 1),
  hincrby: vi.fn(async (k: string, field: string, by: number) => {
    const h = store.get(k) ?? {};
    const next = (Number(h[field]) || 0) + by;
    h[field] = String(next);
    store.set(k, h);
    return next;
  }),
  del: vi.fn(async (k: string) => {
    return store.delete(k) ? 1 : 0;
  }),
  pipeline: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const p: Record<string, unknown> = {
      hset: (...args: string[]) => {
        ops.push(() => redisMock.hset(args[0]!, ...args.slice(1)));
        return p;
      },
      hdel: (...args: string[]) => {
        ops.push(() => redisMock.hdel(args[0]!, ...args.slice(1)));
        return p;
      },
      expire: (k: string, ttl: number) => {
        ops.push(() => redisMock.expire(k, ttl));
        return p;
      },
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return p;
  },
};

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => redisMock,
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const enqueueWaitResumeMock = vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'wait-job-id');

vi.mock('../../../src/queue/producer.js', () => ({
  enqueue: vi.fn(),
  enqueueWaitResume: (...args: unknown[]) => enqueueWaitResumeMock(...args),
}));

const envValues: Record<string, unknown> = {
  TIMING_GATE_ENABLED: true,
  TIMING_STATE_TTL_SEC: 86400,
  TIMING_GATE_COOLDOWN_SEC: 15,
  TIMING_WAIT_MIN_SEC: 5,
  TIMING_WAIT_MAX_SEC: 120,
  TURN_WAIT_RESUME_ENABLED: false,
  TURN_ACTOR_ENABLED: false,
  TURN_ACTOR_CHAT_IDS: [] as number[],
  NO_ACTION_BACKOFF_START_COUNT: 2,
  NO_ACTION_BACKOFF_CAP_SEC: 300,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

// G5 wait-resume replay collaborators
const { scheduleTurnMock, appendPendingMock, takeWaitAnchorMock } = vi.hoisted(() => ({
  scheduleTurnMock: vi.fn(async () => {}),
  appendPendingMock: vi.fn(async () => ({ count: 1, firstPendingAt: 0 })),
  takeWaitAnchorMock: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('../../../src/queue/turn-scheduler.js', () => ({ scheduleTurn: scheduleTurnMock }));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({
  appendPending: appendPendingMock,
  takeWaitAnchor: takeWaitAnchorMock,
}));

afterEach(() => vi.restoreAllMocks());

function queuedWait() {
  const args = enqueueWaitResumeMock.mock.calls.at(-1)!;
  return { ...(args[4] as { waitGeneration: string; scheduledAt: number; waitUntil: number }),
    waitSec: args[1] as number, anchorMessageId: args[2] as number | undefined,
    obligationId: args[3] as string | undefined };
}

describe('chat-runtime state machine', () => {
  let runtime: typeof import('../../../src/pipeline/timing/chat-runtime.js');

  beforeEach(async () => {
    store.clear();
    vi.resetModules();
    enqueueWaitResumeMock.mockClear();
    scheduleTurnMock.mockClear();
    appendPendingMock.mockClear();
    takeWaitAnchorMock.mockClear();
    envValues['TIMING_GATE_ENABLED'] = true;
    runtime = await import('../../../src/pipeline/timing/chat-runtime.js');
  });

  it('default state for unknown chat is RUNNING', async () => {
    const s = await runtime.getChatState(-100);
    expect(s.state).toBe('RUNNING');
  });

  it('feature flag off → always RUNNING and no Redis writes', async () => {
    envValues['TIMING_GATE_ENABLED'] = false;
    const s = await runtime.getChatState(-100);
    expect(s.state).toBe('RUNNING');

    await runtime.transitionToWait(-100, 30);
    expect(store.size).toBe(0);
    expect(enqueueWaitResumeMock).not.toHaveBeenCalled();
  });

  it('transitionToStop persists STOP', async () => {
    await runtime.transitionToStop(-100);
    const s = await runtime.getChatState(-100);
    expect(s.state).toBe('STOP');
    expect(s.lastGateAction).toBe('no_action');
  });

  it('transitionToWait clamps below WAIT_MIN_SEC', async () => {
    await runtime.transitionToWait(-100, 1, 555);
    const s = await runtime.getChatState(-100);
    expect(s.state).toBe('WAIT');
    expect(s.waitAnchorMid).toBe(555);
    // Wait timer scheduled with min sec
    expect(enqueueWaitResumeMock).toHaveBeenCalledWith(-100, 5, 555, undefined, expect.objectContaining({ waitUntil: expect.any(Number) }));
  });

  it('transitionToWait clamps above WAIT_MAX_SEC', async () => {
    await runtime.transitionToWait(-100, 99999);
    expect(enqueueWaitResumeMock).toHaveBeenCalledWith(-100, 120, undefined, undefined, expect.objectContaining({ waitGeneration: expect.any(String) }));
  });

  it('expired WAIT auto-resolves to RUNNING on read', async () => {
    await runtime.transitionToWait(-100, 5);
    // Manually fast-forward waitUntil into the past
    const k = `xxb:timing:state:${-100}`;
    const h = store.get(k)!;
    h['waitUntil'] = String(Date.now() - 1000);
    const s = await runtime.getChatState(-100);
    expect(s.state).toBe('RUNNING');
  });

  it('transitionToRunning clears WAIT fields', async () => {
    await runtime.transitionToWait(-100, 30, 1);
    await runtime.transitionToRunning(-100);
    const s = await runtime.getChatState(-100);
    expect(s.state).toBe('RUNNING');
    expect(s.waitUntil).toBeUndefined();
    expect(s.waitAnchorMid).toBeUndefined();
  });

  it('isInGateCooldown after wait/no_action within window', async () => {
    await runtime.transitionToStop(-100);
    expect(await runtime.isInGateCooldown(-100)).toBe(true);
  });

  it('isInGateCooldown false outside window', async () => {
    await runtime.transitionToStop(-100);
    const k = `xxb:timing:state:${-100}`;
    const h = store.get(k)!;
    h['lastGateAt'] = String(Date.now() - 30_000); // 30s ago, > 15s cooldown
    expect(await runtime.isInGateCooldown(-100)).toBe(false);
  });

  it('isInGateCooldown false after continue', async () => {
    await runtime.recordGateContinue(-100);
    expect(await runtime.isInGateCooldown(-100)).toBe(false);
  });

  it('冷却是 per-chat 的:换个发言者也不豁免(review #5,防多人群退避失效)', async () => {
    const ss = await import('../../../src/pipeline/timing/state-store.js');
    await ss.recordGateNoAction(-100, 7);
    // 旧行为曾按 lastGateUid 豁免其他用户 → 多人交替发言时退避形同虚设
    expect(await runtime.isInGateCooldown(-100)).toBe(true);
  });

  it('no_action 指数退避:连续 no_action 拉长冷却窗口,封顶 CAP', async () => {
    // MaiBot 借鉴:window = base * 2^max(0, count - START_COUNT), cap 300s
    const ss = await import('../../../src/pipeline/timing/state-store.js');
    const k = `xxb:timing:state:${-100}`;

    // count=4 → 15 * 2^2 = 60s 窗口;35s 前的 no_action 仍在冷却
    for (let i = 0; i < 4; i++) await ss.recordGateNoAction(-100);
    const h = store.get(k)!;
    expect(h['noActionCount']).toBe('4');
    h['lastGateAt'] = String(Date.now() - 35_000);
    expect(await runtime.isInGateCooldown(-100)).toBe(true);

    // count=2 → 2^0 → 基础 15s 窗口;35s 前已出窗
    h['noActionCount'] = '2';
    expect(await runtime.isInGateCooldown(-100)).toBe(false);

    // count=20 → 理论 15*2^18 但封顶 300s;299s 前仍在冷却,301s 前出窗
    h['noActionCount'] = '20';
    h['lastGateAt'] = String(Date.now() - 299_000);
    expect(await runtime.isInGateCooldown(-100)).toBe(true);
    h['lastGateAt'] = String(Date.now() - 301_000);
    expect(await runtime.isInGateCooldown(-100)).toBe(false);
  });

  it('continue/真实回复清零 noActionCount', async () => {
    const ss = await import('../../../src/pipeline/timing/state-store.js');
    const k = `xxb:timing:state:${-100}`;
    await ss.recordGateNoAction(-100);
    await ss.recordGateNoAction(-100);
    expect(store.get(k)!['noActionCount']).toBe('2');

    await ss.recordContinue(-100);
    expect(store.get(k)!['noActionCount']).toBeUndefined();

    await ss.recordGateNoAction(-100);
    await ss.recordBotReply(-100);
    expect(store.get(k)!['noActionCount']).toBeUndefined();
  });

  it('handleWaitResume transitions WAIT → RUNNING', async () => {
    await runtime.transitionToWait(-100, 5, 1);
    const before = await runtime.getChatState(-100);
    expect(before.state).toBe('WAIT');

    const waitResume = queuedWait();
    vi.spyOn(Date, 'now').mockReturnValue(waitResume.waitUntil);
    await runtime.handleWaitResume({ chatId: -100, waitResume });

    const after = await runtime.getChatState(-100);
    expect(after.state).toBe('RUNNING');
  });

  it('handleWaitResume drops stale resume when state already RUNNING', async () => {
    await runtime.transitionToRunning(-100);
    await runtime.handleWaitResume({
      chatId: -100,
      waitResume: { scheduledAt: Date.now(), waitSec: 5 },
    });
    const s = await runtime.getChatState(-100);
    expect(s.state).toBe('RUNNING');
  });

  it('G5: wait-resume re-injects the stashed anchor and schedules a wait_timeout turn', async () => {
    envValues['TURN_WAIT_RESUME_ENABLED'] = true;
    envValues['TURN_ACTOR_ENABLED'] = true;
    const anchor = { update: {}, chatId: -100, messageId: 42, enqueuedAt: 1, waitReplay: true };
    takeWaitAnchorMock.mockResolvedValueOnce(anchor);

    await runtime.transitionToWait(-100, 5, 42);
    const waitResume = queuedWait();
    const scheduledAt = waitResume.scheduledAt;
    vi.spyOn(Date, 'now').mockReturnValue(waitResume.waitUntil);
    await runtime.handleWaitResume({ chatId: -100, waitResume });
    // 复位必须在断言之前:断言一挂,后置复位不执行,旗标泄漏进下一个用例
    envValues['TURN_WAIT_RESUME_ENABLED'] = false;
    envValues['TURN_ACTOR_ENABLED'] = false;

    expect((await runtime.getChatState(-100)).state).toBe('RUNNING');
    // P2-F:回放条目盖上实际等待秒数 + 开始时刻(写手 [等待结束] 提示 +
    // actor 对照 activity 判断窗口期有无新消息)
    expect(appendPendingMock).toHaveBeenCalledWith({
      ...anchor, waitGeneration: waitResume.waitGeneration, obligationId: undefined, waitSec: 5, waitStartedAt: scheduledAt,
    });
    expect(scheduleTurnMock).toHaveBeenCalledWith(-100, {
      trigger: 'wait_timeout',
      delayMsOverride: 0,
      anchorMessageId: 42,
      obligationId: undefined,
    });
  });

  it('G5: legacy path (flag off) only unblocks, no replay', async () => {
    await runtime.transitionToWait(-100, 5, 42);
    const waitResume = queuedWait();
    vi.spyOn(Date, 'now').mockReturnValue(waitResume.waitUntil);
    await runtime.handleWaitResume({ chatId: -100, waitResume });

    expect((await runtime.getChatState(-100)).state).toBe('RUNNING');
    expect(scheduleTurnMock).not.toHaveBeenCalled();
    expect(appendPendingMock).not.toHaveBeenCalled();
  });

  it('isChatSuppressed returns true for WAIT and STOP', async () => {
    await runtime.transitionToWait(-100, 30);
    expect(await runtime.isChatSuppressed(-100)).toBe(true);
    await runtime.transitionToStop(-100);
    expect(await runtime.isChatSuppressed(-100)).toBe(true);
    await runtime.transitionToRunning(-100);
    expect(await runtime.isChatSuppressed(-100)).toBe(false);
  });

  it('P0-B: getGateCooldownRemainingMs 返回剩余毫秒且与布尔壳一致', async () => {
    const ss = await import('../../../src/pipeline/timing/state-store.js');
    await ss.recordGateNoAction(-100, 7);
    const remaining = await runtime.getGateCooldownRemainingMs(-100);
    expect(remaining).toBeGreaterThan(13_000);
    expect(remaining).toBeLessThanOrEqual(15_000);
    expect(await runtime.isInGateCooldown(-100)).toBe(true);
  });
});

describe('P0-A isInContinuation 真值表', () => {
  const NOW = 1_000_000_000_000;
  const WINDOW = 180_000;
  let runtime: typeof import('../../../src/pipeline/timing/chat-runtime.js');

  beforeEach(async () => {
    envValues['TURN_GATE_CONTINUATION'] = true;
    envValues['TIMING_CONTINUATION_WINDOW_SEC'] = 180;
    runtime = await import('../../../src/pipeline/timing/chat-runtime.js');
  });

  it('flag 关 → 永远 false', async () => {
    envValues['TURN_GATE_CONTINUATION'] = false;
    expect(runtime.isInContinuation({ state: 'RUNNING', lastBotReplyAt: NOW - 1000 }, NOW)).toBe(false);
  });

  it('bot 刚回复(窗口内)→ true', () => {
    expect(runtime.isInContinuation({ state: 'RUNNING', lastBotReplyAt: NOW - 10_000 }, NOW)).toBe(true);
  });

  it('gate 刚 continue(窗口内)→ true', () => {
    expect(runtime.isInContinuation(
      { state: 'RUNNING', lastGateAt: NOW - 10_000, lastGateAction: 'continue' }, NOW,
    )).toBe(true);
  });

  it('窗口过期 → false', () => {
    expect(runtime.isInContinuation({ state: 'RUNNING', lastBotReplyAt: NOW - WINDOW }, NOW)).toBe(false);
  });

  it('更新的 no_action/wait 负向决策杀免检', () => {
    expect(runtime.isInContinuation({
      state: 'RUNNING',
      lastBotReplyAt: NOW - 60_000,
      lastGateAt: NOW - 5_000,
      lastGateAction: 'no_action',
    }, NOW)).toBe(false);
    expect(runtime.isInContinuation({
      state: 'RUNNING',
      lastBotReplyAt: NOW - 60_000,
      lastGateAt: NOW - 5_000,
      lastGateAction: 'wait',
    }, NOW)).toBe(false);
  });

  it('bot 回复比负向决策新 → 免检恢复', () => {
    expect(runtime.isInContinuation({
      state: 'RUNNING',
      lastBotReplyAt: NOW - 5_000,
      lastGateAt: NOW - 60_000,
      lastGateAction: 'no_action',
    }, NOW)).toBe(true);
  });

  it('无任何信号 → false', () => {
    expect(runtime.isInContinuation({ state: 'RUNNING' }, NOW)).toBe(false);
  });
});

describe('fenced wait recovery', () => {
  const start = 1_800_000_000_000;
  let now = start;
  let runtime: typeof import('../../../src/pipeline/timing/chat-runtime.js');
  beforeEach(async () => {
    store.clear(); vi.resetModules(); vi.clearAllMocks(); now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    envValues['TIMING_GATE_ENABLED'] = true;
    envValues['TURN_WAIT_RESUME_ENABLED'] = true;
    envValues['TURN_ACTOR_ENABLED'] = true;
    enqueueWaitResumeMock.mockReset().mockResolvedValue('wait-job-id');
    redisMock.eval.mockReset().mockImplementation(timingWaitEval(store));
    takeWaitAnchorMock.mockReset().mockResolvedValue({ update: {}, chatId: -100, messageId: 42, enqueuedAt: start, waitReplay: true });
    runtime = await import('../../../src/pipeline/timing/chat-runtime.js');
  });
  afterEach(() => {
    envValues['TURN_WAIT_RESUME_ENABLED'] = false;
    envValues['TURN_ACTOR_ENABLED'] = false;
  });

  it.each([5000, 6000])('claims raw WAIT at +%i ms despite the expired suppression view', async offset => {
    await runtime.transitionToWait(-100, 5, 42);
    const waitResume = queuedWait(); now += offset;
    expect((await runtime.getChatState(-100)).state).toBe('RUNNING');
    expect(store.get('xxb:timing:state:-100')?.state).toBe('WAIT');
    await runtime.handleWaitResume({ chatId: -100, waitResume });
    expect(appendPendingMock).toHaveBeenCalledOnce();
    expect(scheduleTurnMock).toHaveBeenCalledOnce();
    expect(store.get('xxb:timing:state:-100')).toMatchObject({ state: 'RUNNING', waitGeneration: waitResume.waitGeneration });
  });

  it('returns the exact deadline for an early job without consuming it', async () => {
    await runtime.transitionToWait(-100, 5, 42);
    const waitResume = queuedWait(); now += 4999;
    expect(await runtime.handleWaitResume({ chatId: -100, waitResume })).toEqual({ status: 'early', waitUntil: start + 5000 });
    expect(takeWaitAnchorMock).not.toHaveBeenCalled();
    now++;
    await runtime.handleWaitResume({ chatId: -100, waitResume });
    expect(appendPendingMock).toHaveBeenCalledOnce();
  });

  it('two workers and repeated delivery can claim only once', async () => {
    await runtime.transitionToWait(-100, 5, 42);
    const waitResume = queuedWait(); now += 5000;
    await Promise.all([runtime.handleWaitResume({ chatId: -100, waitResume }), runtime.handleWaitResume({ chatId: -100, waitResume })]);
    await runtime.handleWaitResume({ chatId: -100, waitResume });
    expect(appendPendingMock).toHaveBeenCalledOnce();
    expect(takeWaitAnchorMock).toHaveBeenCalledWith(-100, waitResume.waitGeneration);
  });

  it('a new wait with the same anchor and deadline fences the old generation', async () => {
    await runtime.transitionToWait(-100, 5, 42); const older = queuedWait();
    await runtime.transitionToWait(-100, 5, 42); const newer = queuedWait();
    expect(newer.waitGeneration).not.toBe(older.waitGeneration); now += 5000;
    await runtime.handleWaitResume({ chatId: -100, waitResume: older });
    expect(appendPendingMock).not.toHaveBeenCalled();
    await runtime.handleWaitResume({ chatId: -100, waitResume: newer });
    expect(appendPendingMock).toHaveBeenCalledOnce();
  });

  it('a copied generation with the wrong job identity or deadline cannot claim', async () => {
    await runtime.transitionToWait(-100, 5, 42); const waitResume = queuedWait(); now += 5000;
    await runtime.handleWaitResume({ chatId: -100, jobId: 'wrong-job', waitResume });
    await runtime.handleWaitResume({ chatId: -100, waitResume: { ...waitResume, waitUntil: waitResume.waitUntil + 1 } });
    expect(appendPendingMock).not.toHaveBeenCalled();
    await runtime.handleWaitResume({ chatId: -100, jobId: 'wait-job-id', waitResume });
    expect(appendPendingMock).toHaveBeenCalledOnce();
  });

  it('cancels an expired raw wait only within its topic', async () => {
    await runtime.transitionToWait(-100, 5, 42, 7, undefined, { messageThreadId: 19 });
    const waitResume = queuedWait(); now += 5000;
    await runtime.cancelWaitForScope(-100, 20);
    expect(store.get('xxb:timing:state:-100')?.waitGeneration).toBe(waitResume.waitGeneration);
    await runtime.cancelWaitForScope(-100, 19);
    await runtime.handleWaitResume({ chatId: -100, waitResume });
    expect(appendPendingMock).not.toHaveBeenCalled();
  });

  it('normalizes General topic and omitted thread to the same cancellation scope', async () => {
    await runtime.transitionToWait(-100, 5, 42, 7, undefined,
      { waitGeneration: 'general-topic', messageThreadId: 1 });
    expect((await runtime.getChatState(-100)).waitThreadId).toBe(0);
    await runtime.cancelWaitForScope(-100);
    expect((await runtime.getChatState(-100)).waitGeneration).toBeUndefined();
    await runtime.transitionToWait(-100, 5, 42, 7, undefined,
      { waitGeneration: 'omitted-thread' });
    await runtime.cancelWaitForScope(-100, 1);
    expect((await runtime.getChatState(-100)).waitGeneration).toBeUndefined();
  });

  it('scope cancellation also invalidates a generation already claimed by a worker', async () => {
    await runtime.transitionToWait(-100, 5, 42, 7, undefined,
      { waitGeneration: 'claimed-generation', messageThreadId: 19 });
    now += 5000;
    await runtime.handleWaitResume({ chatId: -100, waitResume: queuedWait() });
    await runtime.cancelWaitForScope(-100, 20);
    expect((await runtime.getChatState(-100)).waitGeneration).toBe('claimed-generation');
    await runtime.cancelWaitForScope(-100, 19);
    expect((await runtime.getChatState(-100)).waitGeneration).toBeUndefined();
  });

  it('late queue acknowledgement cannot restore a cancelled generation', async () => {
    enqueueWaitResumeMock.mockImplementation(async () => {
      await runtime.cancelWaitForScope(-100);
      return 'late-job';
    });
    await runtime.transitionToWait(-100, 5, 42);
    now += 5000;
    await runtime.handleWaitResume({ chatId: -100, waitResume: queuedWait() });
    expect(appendPendingMock).not.toHaveBeenCalled();
    expect(store.get('xxb:timing:state:-100')).not.toHaveProperty('waitGeneration');
  });

  it('retries scheduling with one identity and cancels only that identity on failure', async () => {
    enqueueWaitResumeMock.mockRejectedValue(new Error('synthetic queue unavailable'));
    await expect(runtime.transitionToWait(-100, 5, 42)).rejects.toThrow('synthetic queue unavailable');
    expect(enqueueWaitResumeMock).toHaveBeenCalledTimes(2);
    expect(enqueueWaitResumeMock.mock.calls[0]![4]).toEqual(enqueueWaitResumeMock.mock.calls[1]![4]);
    expect(store.get('xxb:timing:state:-100')).toMatchObject({ state: 'RUNNING' });
    expect(store.get('xxb:timing:state:-100')).not.toHaveProperty('waitGeneration');
  });

  it('Redis claim failure propagates without replaying or consuming the wait', async () => {
    await runtime.transitionToWait(-100, 5, 42); const waitResume = queuedWait(); now += 5000;
    redisMock.eval.mockRejectedValueOnce(new Error('synthetic redis unavailable'));
    await expect(runtime.handleWaitResume({ chatId: -100, waitResume })).rejects.toThrow('synthetic redis unavailable');
    expect(appendPendingMock).not.toHaveBeenCalled();
    await runtime.handleWaitResume({ chatId: -100, waitResume });
    expect(appendPendingMock).toHaveBeenCalledOnce();
  });

  it('new work during anchor retrieval prevents the claimed replay', async () => {
    await runtime.transitionToWait(-100, 5, 42); const waitResume = queuedWait(); now += 5000;
    takeWaitAnchorMock.mockImplementationOnce(async () => {
      await runtime.cancelWaitForScope(-100);
      return { update: {}, chatId: -100, messageId: 42, enqueuedAt: start, waitReplay: true };
    });
    await runtime.handleWaitResume({ chatId: -100, waitResume });
    expect(appendPendingMock).not.toHaveBeenCalled();
  });

  it('safely concludes only the exact old job without replaying an unversioned anchor', async () => {
    store.set('xxb:timing:state:-100', { state: 'WAIT', waitUntil: String(start), waitJobId: 'old-job', waitAnchorMid: '42' });
    const waitResume = { scheduledAt: start - 5000, waitSec: 5, anchorMessageId: 42 };
    await runtime.handleWaitResume({ chatId: -100, jobId: 'other-job', waitResume });
    expect(store.get('xxb:timing:state:-100')?.state).toBe('WAIT');
    await runtime.handleWaitResume({ chatId: -100, jobId: 'old-job', waitResume });
    expect(store.get('xxb:timing:state:-100')?.state).toBe('RUNNING');
    expect(takeWaitAnchorMock).not.toHaveBeenCalled();
  });
});
