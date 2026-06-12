import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mocks ────────────────────────────────────────────────────────────
vi.mock('../../../src/env.js', () => {
  const envValues: Record<string, unknown> = {
    SLEEP_SCHEDULE_ENABLED: true,
    MASTER_UID: 7777,
    MASTER_UID_EXTRA: [],
  };
  return { env: () => envValues, _testEnvValues: envValues };
});

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// 可控的 runtime override
let overrideValue: Record<string, unknown> | null = null;
vi.mock('../../../src/admin/runtime-config.js', () => ({
  loadOverrideCached: vi.fn(async () => overrideValue),
}));

// in-memory Redis(只实现 sleep.ts 用到的子集)
const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
    return 'OK';
  }),
  incr: vi.fn(async (k: string) => {
    const n = parseInt(store.get(k) ?? '0', 10) + 1;
    store.set(k, String(n));
    return n;
  }),
  expire: vi.fn(async () => 1),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const { _testEnvValues: envValues } = (await import('../../../src/env.js')) as unknown as {
  _testEnvValues: Record<string, unknown>;
};
const { isAsleep, sleepSilencesAtStageA, sleepWakeDecision } = await import(
  '../../../src/tracking/sleep.js'
);

/** 北京时间 HH:MM 对应的 UTC Date(北京=UTC+8) */
function bj(dateStr: string, hh: number, mm = 0): Date {
  const utcMs = Date.parse(`${dateStr}T00:00:00Z`) + ((hh - 8) * 60 + mm) * 60_000;
  return new Date(utcMs);
}

beforeEach(() => {
  store.clear();
  overrideValue = null;
  envValues['SLEEP_SCHEDULE_ENABLED'] = true;
  envValues['MASTER_UID'] = 7777;
  vi.clearAllMocks(); // 只清调用记录;vi.fn(impl) 的实现保留
});

describe('isAsleep (硬作息)', () => {
  it('flag off → 永远清醒(即使凌晨 3 点)', async () => {
    envValues['SLEEP_SCHEDULE_ENABLED'] = false;
    expect(await isAsleep(bj('2026-06-08', 3, 0))).toBe(false);
  });

  it('凌晨 3 点 → 睡着;下午 15:30 → 醒着(沿用 life-state 作息表)', async () => {
    expect(await isAsleep(bj('2026-06-08', 3, 0))).toBe(true);
    expect(await isAsleep(bj('2026-06-08', 15, 30))).toBe(false);
  });

  it('override force=awake 凌晨也醒;force=asleep 下午也睡', async () => {
    overrideValue = { sleep_schedule: { force: 'awake' } };
    expect(await isAsleep(bj('2026-06-08', 3, 0))).toBe(false);
    overrideValue = { sleep_schedule: { force: 'asleep' } };
    expect(await isAsleep(bj('2026-06-08', 15, 30))).toBe(true);
  });

  it('override enabled=false → 运行时关门', async () => {
    overrideValue = { sleep_schedule: { enabled: false } };
    expect(await isAsleep(bj('2026-06-08', 3, 0))).toBe(false);
  });
});

describe('sleepSilencesAtStageA', () => {
  it('null(将进 L1/L2)→ 静默', () => {
    expect(sleepSilencesAtStageA(null)).toBe(true);
  });

  it('对话热度类自动接话规则 → 静默', () => {
    for (const rule of ['followup_to_bot', 'active_conv_engage', 'bot_mentions_self']) {
      expect(sleepSilencesAtStageA({ action: 'REPLY', rule })).toBe(true);
    }
  });

  it('指令与直接交互 → 放行', () => {
    for (const rule of ['whitelisted_command', 'mention_self', 'reply_to_self', 'private_chat', 'remember_request']) {
      expect(sleepSilencesAtStageA({ action: 'REPLY', rule })).toBe(false);
    }
  });

  it('IGNORE/REJECT → 不拦(judge 重跑 L0 零成本,语义不变)', () => {
    expect(sleepSilencesAtStageA({ action: 'IGNORE', rule: 'hot_chat' })).toBe(false);
    expect(sleepSilencesAtStageA({ action: 'REJECT', rule: 'whatever' })).toBe(false);
  });
});

describe('sleepWakeDecision (升级式吵醒)', () => {
  it('豁免规则 → pass,不碰 Redis', async () => {
    for (const rule of ['whitelisted_command', 'remember_request', 'forget_request', 'sticker_dislike', 'unmute_request']) {
      expect(await sleepWakeDecision(-100, 1001, rule)).toBe('pass');
    }
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('主人 → 必醒,且设迷糊窗口', async () => {
    expect(await sleepWakeDecision(-100, 7777, 'mention_self')).toBe('wake');
    expect(store.get('xxb:sleep:groggy:-100')).toBe('1');
  });

  it('第 1 次 ping 骰子不中 → silent;计数=1', async () => {
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.99); // > 0.15
    try {
      expect(await sleepWakeDecision(-100, 1001, 'mention_self')).toBe('silent');
      expect(store.get('xxb:sleep:disturb:-100')).toBe('1');
    } finally {
      rand.mockRestore();
    }
  });

  it('第 2 次 ping 概率升到 0.5;第 3 次必醒', async () => {
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.6);
    try {
      expect(await sleepWakeDecision(-100, 1001, 'mention_self')).toBe('silent'); // 0.6 > 0.15
      expect(await sleepWakeDecision(-100, 1001, 'mention_self')).toBe('silent'); // 0.6 > 0.5
      expect(await sleepWakeDecision(-100, 1001, 'mention_self')).toBe('wake');   // p=1
      rand.mockReturnValue(0.4);
      store.clear();
      expect(await sleepWakeDecision(-100, 1001, 'mention_self')).toBe('silent'); // 0.4 > 0.15
      expect(await sleepWakeDecision(-100, 1001, 'mention_self')).toBe('wake');   // 0.4 < 0.5
    } finally {
      rand.mockRestore();
    }
  });

  it('被吵醒后迷糊窗口内 → 直接 wake,不再掷骰也不涨计数', async () => {
    store.set('xxb:sleep:groggy:-100', '1');
    expect(await sleepWakeDecision(-100, 1001, 'reply_to_self')).toBe('wake');
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('Redis 故障 → fail-open(pass,别吞指令)', async () => {
    redisMock.get.mockRejectedValueOnce(new Error('redis down'));
    expect(await sleepWakeDecision(-100, 1001, 'mention_self')).toBe('pass');
  });
});
