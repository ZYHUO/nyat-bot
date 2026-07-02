import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, Record<string, string>>();
const stringStore = new Map<string, string>();

const redisMock = {
  hgetall: vi.fn(async (k: string) => store.get(k) ?? {}),
  hset: vi.fn(async (k: string, ...args: string[]) => {
    const h = store.get(k) ?? {};
    for (let i = 0; i < args.length; i += 2) h[args[i]!] = args[i + 1]!;
    store.set(k, h);
    return 'OK';
  }),
  hdel: vi.fn(async (k: string, ...fields: string[]) => {
    const h = store.get(k) ?? {};
    let n = 0;
    for (const f of fields) if (delete h[f]) n++;
    store.set(k, h);
    return n;
  }),
  expire: vi.fn(async () => 1),
  get: vi.fn(async (k: string) => stringStore.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { stringStore.set(k, v); return 'OK'; }),
  del: vi.fn(async (k: string) => { stringStore.delete(k); return 1; }),
  getdel: vi.fn(async (k: string) => { const v = stringStore.get(k) ?? null; stringStore.delete(k); return v; }),
  pipeline: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const p: Record<string, unknown> = {
      hset: (...args: string[]) => { ops.push(() => redisMock.hset(args[0]!, ...args.slice(1))); return p; },
      hdel: (...args: string[]) => { ops.push(() => redisMock.hdel(args[0]!, ...args.slice(1))); return p; },
      expire: (k: string, ttl: number) => { ops.push(() => redisMock.expire(k, ttl)); return p; },
      exec: async () => { for (const op of ops) await op(); return []; },
    };
    return p;
  },
};

vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const enqueueWaitResumeMock = vi.fn(async () => 'wait-job-id');
vi.mock('../../../../src/queue/producer.js', () => ({ enqueueWaitResume: (...args: unknown[]) => enqueueWaitResumeMock(...args) }));
const scheduleTurnMock = vi.fn(async () => {});
const appendPendingMock = vi.fn(async () => ({ count: 1, firstPendingAt: 0 }));
const takeWaitAnchorMock = vi.fn(async () => ({ update: {}, chatId: -100, messageId: 42, enqueuedAt: Date.now(), obligationId: 'obl-1' }));
vi.mock('../../../../src/queue/turn-scheduler.js', () => ({ scheduleTurn: (...args: unknown[]) => scheduleTurnMock(...args) }));
vi.mock('../../../../src/pipeline/turn/buffer.js', () => ({ appendPending: (...args: unknown[]) => appendPendingMock(...args), takeWaitAnchor: (...args: unknown[]) => takeWaitAnchorMock(...args) }));
vi.mock('../../../../src/pipeline/turn/flags.js', () => ({ isTurnActorChat: () => true }));
const envValues: Record<string, unknown> = { TIMING_GATE_ENABLED: true, TIMING_STATE_TTL_SEC: 86400, TIMING_GATE_COOLDOWN_SEC: 15, TIMING_WAIT_MIN_SEC: 5, TIMING_WAIT_MAX_SEC: 120, TURN_WAIT_RESUME_ENABLED: true, NO_ACTION_BACKOFF_START_COUNT: 2, NO_ACTION_BACKOFF_CAP_SEC: 300 };
vi.mock('../../../../src/env.js', () => ({ env: () => envValues }));

import * as runtime from '../../../../src/pipeline/timing/chat-runtime.js';

describe('wait resume obligation propagation', () => {
  beforeEach(() => {
    store.clear();
    stringStore.clear();
    enqueueWaitResumeMock.mockClear();
    scheduleTurnMock.mockClear();
    appendPendingMock.mockClear();
  });

  it('passes obligationId into wait resume scheduling and replay', async () => {
    await runtime.transitionToWait(-100, 10, 42, 7, 'obl-1');
    expect(enqueueWaitResumeMock).toHaveBeenCalledWith(-100, 10, 42, 'obl-1');

    await runtime.handleWaitResume({
      chatId: -100,
      waitResume: { scheduledAt: Date.now(), waitSec: 10, anchorMessageId: 42, obligationId: 'obl-1' },
    });
    expect(scheduleTurnMock).toHaveBeenCalled();
  });
});
