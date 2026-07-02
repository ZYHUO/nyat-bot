import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Redis with an in-memory hash store
const store = new Map<string, Record<string, string>>();

const redisMock = {
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

const enqueueWaitResumeMock = vi.fn(async () => 'wait-job-id');

vi.mock('../../../src/queue/producer.js', () => ({
  enqueue: vi.fn(),
  enqueueWaitResume: (chatId: number, sec: number, anchor?: number) =>
    enqueueWaitResumeMock(chatId, sec, anchor),
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
    expect(enqueueWaitResumeMock).toHaveBeenCalledWith(-100, 5, 555);
  });

  it('transitionToWait clamps above WAIT_MAX_SEC', async () => {
    await runtime.transitionToWait(-100, 99999);
    expect(enqueueWaitResumeMock).toHaveBeenCalledWith(-100, 120, undefined);
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

  it('isInGateCooldown does not suppress a different user', async () => {
    const ss = await import('../../../src/pipeline/timing/state-store.js');
    await ss.recordGateNoAction(-100, 7);
    expect(await runtime.isInGateCooldown(-100, undefined, 8)).toBe(false);
    expect(await runtime.isInGateCooldown(-100, undefined, 7)).toBe(true);
  });

  it('no_action 指数退避:连续 no_action 拉长冷却窗口,封顶 CAP', async () => {
    // MaiBot 借鉴:window = base * 2^max(0, count - START_COUNT), cap 300s
    const ss = await import('../../../src/pipeline/timing/state-store.js');
    const k = `xxb:timing:state:${-100}`;

    // count=4 → 15 * 2^2 = 60s 窗口;35s 前的 no_action 仍在冷却
    for (let i = 0; i < 4; i++) await ss.recordGateNoAction(-100);
    let h = store.get(k)!;
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
    await runtime.transitionToWait(-100, 5);
    const before = await runtime.getChatState(-100);
    expect(before.state).toBe('WAIT');

    await runtime.handleWaitResume({
      chatId: -100,
      waitResume: { scheduledAt: Date.now(), waitSec: 5, anchorMessageId: 1 },
    });

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
    await runtime.handleWaitResume({
      chatId: -100,
      waitResume: { scheduledAt: Date.now(), waitSec: 5, anchorMessageId: 42 },
    });
    // 复位必须在断言之前:断言一挂,后置复位不执行,旗标泄漏进下一个用例
    envValues['TURN_WAIT_RESUME_ENABLED'] = false;
    envValues['TURN_ACTOR_ENABLED'] = false;

    expect((await runtime.getChatState(-100)).state).toBe('RUNNING');
    // P2-F:回放条目盖上实际等待秒数(写手 [等待结束] 提示用)
    expect(appendPendingMock).toHaveBeenCalledWith({ ...anchor, obligationId: undefined, waitSec: 5 });
    expect(scheduleTurnMock).toHaveBeenCalledWith(-100, {
      trigger: 'wait_timeout',
      delayMsOverride: 0,
      anchorMessageId: 42,
      obligationId: undefined,
    });
  });

  it('G5: legacy path (flag off) only unblocks, no replay', async () => {
    await runtime.transitionToWait(-100, 5, 42);
    await runtime.handleWaitResume({
      chatId: -100,
      waitResume: { scheduledAt: Date.now(), waitSec: 5, anchorMessageId: 42 },
    });

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
    const remaining = await runtime.getGateCooldownRemainingMs(-100, undefined, 7);
    expect(remaining).toBeGreaterThan(13_000);
    expect(remaining).toBeLessThanOrEqual(15_000);
    expect(await runtime.isInGateCooldown(-100, undefined, 7)).toBe(true);
    // 不同触发者不受冷却
    expect(await runtime.getGateCooldownRemainingMs(-100, undefined, 8)).toBe(0);
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
