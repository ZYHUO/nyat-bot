import { describe, expect, it, vi, beforeEach } from 'vitest';

// The participation budget is the host's answer to the Phase 2.3 negative
// result: the model, left purely to its own judgement, wanted to speak 48 times
// in 28 minutes (median gap 7s) and did not stop even when told it had just sent
// 4 messages that nobody answered.
//
// So the host keeps a physical throttle — but unlike the old hidden cooldown it
// is a budget the model can see and spend deliberately.

const envValues: Record<string, unknown> = {
  NYATOS_BUDGET_ENABLED: true,
  NYATOS_BUDGET_WINDOW_SEC: 3600,
  NYATOS_BUDGET_MAX_ACTS: 6,
  NYATOS_BUDGET_MIN_GAP_SEC: 90,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const store = new Map<string, number>();
const redis = {
  get: vi.fn(async (k: string) => (store.has(k) ? String(store.get(k)) : null)),
  incr: vi.fn(async (k: string) => {
    const next = (store.get(k) ?? 0) + 1;
    store.set(k, next);
    return next;
  }),
  expire: vi.fn(async () => 1),
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, Number(v));
    return 'OK';
  }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redis }));

beforeEach(() => {
  store.clear();
  redis.get.mockClear();
  redis.incr.mockClear();
  envValues['NYATOS_BUDGET_ENABLED'] = true;
  envValues['NYATOS_BUDGET_MAX_ACTS'] = 6;
  envValues['NYATOS_BUDGET_WINDOW_SEC'] = 3600;
});

const load = async () => {
  vi.resetModules();
  return await import('../../../src/nyatos/budget.js');
};

describe('participation budget', () => {
  it('starts full and decreases as the bot speaks', async () => {
    const m = await load();
    expect((await m.getParticipationBudget(-100))?.remaining).toBe(6);
    await m.spendParticipation(-100);
    await m.spendParticipation(-100);
    expect((await m.getParticipationBudget(-100))?.remaining).toBe(4);
  });

  it('refuses active speech once exhausted but allows direct replies', async () => {
    const m = await load();
    for (let i = 0; i < 6; i++) await m.spendParticipation(-100);
    expect(await m.canSpeakActively(-100)).toBe(false);
    // The exemption for addressed messages is the model's to apply; the budget
    // only gates ACTIVE speech, which is what can turn into spam.
    expect((await m.getParticipationBudget(-100))?.remaining).toBe(0);
  });

  it('counts past the limit instead of clamping, so the signal stays honest', async () => {
    const m = await load();
    for (let i = 0; i < 8; i++) await m.spendParticipation(-100);
    const b = await m.getParticipationBudget(-100);
    expect(b?.remaining).toBe(0);
    expect(b?.limit).toBe(6);
  });

  it('keeps chats isolated', async () => {
    const m = await load();
    await m.spendParticipation(-100);
    await m.spendParticipation(-100);
    expect((await m.getParticipationBudget(-100))?.remaining).toBe(4);
    expect((await m.getParticipationBudget(-200))?.remaining).toBe(6);
  });

  it('returns null when disabled so the frame shows no misleading zero', async () => {
    const m = await load();
    envValues['NYATOS_BUDGET_ENABLED'] = false;
    expect(await m.getParticipationBudget(-100)).toBeNull();
    expect(await m.spendParticipation(-100)).toBeNull();
    expect(await m.canSpeakActively(-100)).toBe(true);
  });

  it('fails open on redis errors (a throttle must not break the reply path)', async () => {
    const m = await load();
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    expect(await m.getParticipationBudget(-100)).toBeNull();
    redis.incr.mockRejectedValueOnce(new Error('redis down'));
    expect(await m.spendParticipation(-100)).toBeNull();
    // No budget information means "do not block".
    expect(await m.canSpeakActively(-100)).toBe(true);
  });

  it('renders recent activity as a fact about the past, not a quota', async () => {
    const m = await load();
    // A person knows "I've been talking a lot", never "I have 2 of 6 remaining".
    // The quota framing leaked into the model's reasoning ("本小时主动发言额度
    // 已用完"), which is the assistant mindset this rewrite exists to remove.
    const fresh = m.renderParticipationBudget(await m.getParticipationBudget(-100));
    expect(fresh).toBe('');
    expect(fresh).not.toContain('额度');
    expect(fresh).not.toContain('/6');

    await m.spendParticipation(-100);
    const some = m.renderParticipationBudget(await m.getParticipationBudget(-100));
    expect(some).toContain('已经说了 1 条');
    expect(some).not.toContain('额度');

    for (let i = 0; i < 5; i++) await m.spendParticipation(-100);
    const many = m.renderParticipationBudget(await m.getParticipationBudget(-100));
    expect(many).toContain('已经说了 6 条');
    expect(many).not.toContain('额度');
    expect(many).not.toMatch(/应该|必须|不要|少说|克制|还剩/);
  });

  it('renders nothing when there is no budget', async () => {
    const m = await load();
    expect(m.renderParticipationBudget(null)).toBe('');
  });
});

describe('budget spending semantics (wired at delivery)', () => {
  // The budget only gates ACTIVE speech. Addressed replies must stay unlimited:
  // failing to answer a direct question is a different failure from
  // over-participating, and the old gates exempted direct interaction too.
  it('a full window allows exactly limit active acts', async () => {
    const m = await load();
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (await m.canSpeakActively(-100)) {
        allowed++;
        await m.spendParticipation(-100);
      }
    }
    expect(allowed).toBe(6);
  });

  it('never tells the model to hold back', async () => {
    const m = await load();
    for (let i = 0; i < 6; i++) await m.spendParticipation(-100);
    const line = m.renderParticipationBudget(await m.getParticipationBudget(-100));
    // Restraint must come from the persona, not from an instruction the host
    // smuggles in. The host only reports what happened.
    expect(line).not.toMatch(/应该|必须|不要|少说|克制|额度|还剩|受限/);
  });
});

describe('active speech spacing (the burst dimension)', () => {
  // The count budget cannot stop a burst: 6 messages inside one minute still
  // passes "6 per hour". Phase 2.3 measured exactly that shape — 48 speak
  // verdicts in 28 minutes, median gap 7 seconds. Spacing is the other half.

  it('is free until the bot actually speaks', async () => {
    const m = await load();
    expect(await m.activeSpeechCooldownRemainingSec(-100)).toBe(0);
  });

  it('blocks for the configured gap after an active message', async () => {
    const m = await load();
    await m.markActiveSpeech(-100);
    const remaining = await m.activeSpeechCooldownRemainingSec(-100);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(90);
  });

  it('renders spacing as a felt sense, not a lockout timer', async () => {
    const m = await load();
    const line = m.renderActiveSpeechSpacing(45);
    expect(line).toContain('刚说过话');
    // No seconds, no quota, no instruction — a person feels "I just spoke",
    // they do not read a countdown.
    expect(line).not.toMatch(/45|额度|还剩|应该|必须|不要|禁止/);
  });

  it('renders nothing when the channel is free', async () => {
    const m = await load();
    expect(m.renderActiveSpeechSpacing(0)).toBe('');
  });

  it('keeps spacing isolated per chat', async () => {
    const m = await load();
    await m.markActiveSpeech(-100);
    expect(await m.activeSpeechCooldownRemainingSec(-200)).toBe(0);
  });
});

describe('spend wiring covers the production main path', () => {
  // The first wiring landed only in pipeline/stages/deliver.ts, but the Meta
  // path (production main path) sends via subagent/host-api.ts and never reaches
  // deliver.ts. Measured 2026-09-18: 96 "speak" shadow verdicts in 23 minutes
  // while Redis held ZERO budget keys, so every Frame still showed "6/6 left".
  // This guards the invariant that a real send decrements the budget.

  it('decrements after an active send and leaves the counter at 0 when fresh', async () => {
    const m = await load();
    expect((await m.getParticipationBudget(-777))?.remaining).toBe(6);
    await m.spendParticipation(-777);
    await m.markActiveSpeech(-777);
    expect((await m.getParticipationBudget(-777))?.remaining).toBe(5);
    expect(await m.activeSpeechCooldownRemainingSec(-777)).toBeGreaterThan(0);
  });
});
