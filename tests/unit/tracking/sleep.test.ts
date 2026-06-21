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

// in-memory Redis(只实现 sleep.ts 用到的子集;set 支持 NX/EX)
const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
    if (args.includes('NX') && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  }),
  incr: vi.fn(async (k: string) => {
    const n = parseInt(store.get(k) ?? '0', 10) + 1;
    store.set(k, String(n));
    return n;
  }),
  expire: vi.fn(async () => 1),
  mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const { _testEnvValues: envValues } = (await import('../../../src/env.js')) as unknown as {
  _testEnvValues: Record<string, unknown>;
};
const { getSleepPhase, isAsleep, nightDateStr, sleepStageAVerdict, sleepWakeDecision, pokeGlobalWake } = await import(
  '../../../src/tracking/sleep.js'
);
const { daySchedule, _resetBedtimeShifts } = await import('../../../src/tracking/life-state.js');

/** 北京时间 HH:MM 对应的 UTC Date(北京=UTC+8) */
function bj(dateStr: string, hh: number, mm = 0): Date {
  const utcMs = Date.parse(`${dateStr}T00:00:00Z`) + ((hh - 8) * 60 + mm) * 60_000;
  return new Date(utcMs);
}

beforeEach(() => {
  store.clear();
  overrideValue = null;
  envValues['SLEEP_SCHEDULE_ENABLED'] = true;
  envValues['SLEEP_WAKE_ON_DM_ENABLED'] = false;
  envValues['SLEEP_WAKE_WINDOW_MIN'] = 20;
  envValues['MASTER_UID'] = 7777;
  _resetBedtimeShifts();
  vi.clearAllMocks(); // 只清调用记录;vi.fn(impl) 的实现保留
});

describe('getSleepPhase / isAsleep', () => {
  it('flag off → 永远 awake(即使凌晨 3 点)', async () => {
    envValues['SLEEP_SCHEDULE_ENABLED'] = false;
    expect(await getSleepPhase(bj('2026-06-08', 3, 0))).toBe('awake');
  });

  it('凌晨 3 点 → night;下午 17:00 → awake', async () => {
    expect(await getSleepPhase(bj('2026-06-08', 3, 0))).toBe('night');
    expect(await getSleepPhase(bj('2026-06-08', 17, 0))).toBe('awake');
    expect(await isAsleep(bj('2026-06-08', 3, 0))).toBe(true);
  });

  it('午睡窗 → nap(浅睡)', async () => {
    for (let d = 1; d < 28; d++) {
      const dateStr = `2026-06-${String(d).padStart(2, '0')}`;
      const sc = daySchedule(dateStr);
      if (sc.napStart !== null) {
        const phase = await getSleepPhase(bj(dateStr, Math.floor(sc.napStart / 60), (sc.napStart % 60) + 2));
        expect(phase).toBe('nap');
        return;
      }
    }
    throw new Error('no nap day found in range');
  });

  it('override force=awake 凌晨也醒;force=asleep 下午算 night;enabled=false 关门', async () => {
    overrideValue = { sleep_schedule: { force: 'awake' } };
    expect(await getSleepPhase(bj('2026-06-08', 3, 0))).toBe('awake');
    overrideValue = { sleep_schedule: { force: 'asleep' } };
    expect(await getSleepPhase(bj('2026-06-08', 17, 0))).toBe('night');
    overrideValue = { sleep_schedule: { enabled: false } };
    expect(await getSleepPhase(bj('2026-06-08', 3, 0))).toBe('awake');
  });
});

describe('nightDateStr', () => {
  it('凌晨算昨晚,晚上算今晚', () => {
    expect(nightDateStr(bj('2026-06-08', 3, 0))).toBe('2026-06-07');
    expect(nightDateStr(bj('2026-06-08', 23, 50))).toBe('2026-06-08');
  });
});

describe('sleepStageAVerdict', () => {
  it('IGNORE/REJECT → continue(judge 重跑 L0 零成本)', async () => {
    expect(await sleepStageAVerdict(-1, { action: 'IGNORE', rule: 'hot_chat' }, 'night')).toBe('continue');
  });

  it('指令与点名 → continue(命令分发/Stage B 接手)', async () => {
    for (const rule of ['whitelisted_command', 'mention_self', 'reply_to_self', 'private_chat', 'remember_request']) {
      expect(await sleepStageAVerdict(-1, { action: 'REPLY', rule }, 'night')).toBe('continue');
    }
  });

  it('对话热度类 → 夜里入队不烧 judge;午睡直接静默', async () => {
    expect(await sleepStageAVerdict(-1, { action: 'REPLY', rule: 'followup_to_bot' }, 'night')).toBe('queue');
    expect(await sleepStageAVerdict(-1, { action: 'REPLY', rule: 'active_conv_engage' }, 'nap')).toBe('silent');
  });

  it('别的 bot @我 → 静默', async () => {
    expect(await sleepStageAVerdict(-1, { action: 'REPLY', rule: 'bot_mentions_self' }, 'night')).toBe('silent');
  });

  it('L0 null:夜里预算内放 judge,冷却中静默,预算耗尽静默;午睡一律静默', async () => {
    expect(await sleepStageAVerdict(-100, null, 'night')).toBe('continue'); // 第一次:冷却拿到 + 预算 1
    expect(await sleepStageAVerdict(-100, null, 'night')).toBe('silent');   // 冷却中(NX 失败)
    expect(await sleepStageAVerdict(-100, null, 'nap')).toBe('silent');

    // 预算耗尽:连续放行 30 次(每次清掉冷却键模拟时间流逝)
    store.clear();
    for (let i = 0; i < 30; i++) {
      const v = await sleepStageAVerdict(-200, null, 'night');
      expect(v).toBe('continue');
      // 模拟冷却过期
      for (const k of [...store.keys()]) if (k.includes('jcool')) store.delete(k);
    }
    expect(await sleepStageAVerdict(-200, null, 'night')).toBe('silent'); // 第 31 次:预算没了
  });

  it('Redis 故障 → fail-closed(省钱,静默)', async () => {
    redisMock.set.mockRejectedValueOnce(new Error('redis down'));
    expect(await sleepStageAVerdict(-1, null, 'night')).toBe('silent');
  });
});

describe('sleepWakeDecision (升级式吵醒 + 入队)', () => {
  it('豁免规则 → pass,不碰 Redis', async () => {
    // mute/remember/forget/unmute 关键词规则已下线(改 directive.ts);剩余豁免规则:
    for (const rule of ['whitelisted_command', 'self_mute_request', 'self_unmute_request', 'sticker_dislike']) {
      expect(await sleepWakeDecision(-100, 1001, rule, 'night')).toBe('pass');
    }
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('非点名 REPLY(heart 判的闲聊/turn_replan)→ queue,不掷骰', async () => {
    expect(await sleepWakeDecision(-100, 1001, 'turn_replan', 'night')).toBe('queue');
    expect(await sleepWakeDecision(-100, 1001, 'heart', 'night')).toBe('queue');
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('主人点名 → 必醒,且设迷糊窗口', async () => {
    expect(await sleepWakeDecision(-100, 7777, 'mention_self', 'night')).toBe('wake');
    expect(store.get('xxb:sleep:groggy:-100')).toBe('1');
  });

  it('第 1 次点名骰子不中 → queue(攒着醒后补);计数=1', async () => {
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      expect(await sleepWakeDecision(-100, 1001, 'mention_self', 'night')).toBe('queue');
      expect(store.get('xxb:sleep:disturb:-100')).toBe('1');
    } finally {
      rand.mockRestore();
    }
  });

  it('升级:第 2 次 0.5、第 3 次必醒;午睡浅,概率翻倍', async () => {
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.4);
    try {
      expect(await sleepWakeDecision(-100, 1001, 'mention_self', 'night')).toBe('queue'); // 0.4 > 0.15
      expect(await sleepWakeDecision(-100, 1001, 'mention_self', 'night')).toBe('wake');  // 0.4 < 0.5
      store.clear();
      rand.mockReturnValue(0.2);
      // 夜睡第 1 次 0.2 > 0.15 → queue;午睡 0.2 < 0.3(0.15×2)→ wake
      expect(await sleepWakeDecision(-300, 1001, 'mention_self', 'night')).toBe('queue');
      store.clear();
      expect(await sleepWakeDecision(-300, 1001, 'mention_self', 'nap')).toBe('wake');
    } finally {
      rand.mockRestore();
    }
  });

  it('被吵醒后迷糊窗口内 → 直接 wake,不再掷骰', async () => {
    store.set('xxb:sleep:groggy:-100', '1');
    expect(await sleepWakeDecision(-100, 1001, 'reply_to_self', 'night')).toBe('wake');
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('Redis 故障 → fail-open(pass,别吞点名)', async () => {
    redisMock.get.mockRejectedValueOnce(new Error('redis down'));
    expect(await sleepWakeDecision(-100, 1001, 'mention_self', 'night')).toBe('pass');
  });
});

describe('DM↔群联动:全局临时唤醒 (SLEEP_WAKE_ON_DM_ENABLED)', () => {
  it('夜里 poke 一下 → getSleepPhase 翻成 awake(私聊唤醒,群里也醒)', async () => {
    envValues['SLEEP_WAKE_ON_DM_ENABLED'] = true;
    expect(await getSleepPhase(bj('2026-06-08', 3, 0))).toBe('night'); // 排程该睡
    await pokeGlobalWake('dm');
    // 收消息路径(getSleepPhase 默认 respectGlobalWake)→ 醒;但 isAsleep(排程口径,给主动 cron 用)
    // 仍判睡 → 半夜被 DM 唤醒不会触发 idle/proactive 等主动外联(Fix 1 的拆分)。
    expect(await getSleepPhase(bj('2026-06-08', 3, 0))).toBe('awake');
    expect(await isAsleep(bj('2026-06-08', 3, 0))).toBe(true);
  });

  it('flag 关 → poke 是 no-op,继续睡', async () => {
    envValues['SLEEP_WAKE_ON_DM_ENABLED'] = false;
    await pokeGlobalWake('dm');
    expect(await getSleepPhase(bj('2026-06-08', 3, 0))).toBe('night');
  });

  it('没 poke 过 → 夜里照常睡', async () => {
    envValues['SLEEP_WAKE_ON_DM_ENABLED'] = true;
    expect(await getSleepPhase(bj('2026-06-08', 3, 0))).toBe('night');
  });

  it('白天本来就醒 → 不受影响(也不查唤醒键)', async () => {
    envValues['SLEEP_WAKE_ON_DM_ENABLED'] = true;
    await pokeGlobalWake('dm');
    expect(await getSleepPhase(bj('2026-06-08', 17, 0))).toBe('awake');
  });
});
