import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { SLEEP_SCHEDULE_ENABLED: true, SLEEP_WAKE_ON_DM_ENABLED: true },
  values: new Map<string, string>(),
  get: vi.fn<(key: string) => Promise<string | null>>(),
  set: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  cached: vi.fn(async () => ({ sleep_schedule: { force: 'awake' as const } })),
}));
vi.mock('../../../src/env.js', () => ({ env: () => mocks.config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => mocks }));
vi.mock('../../../src/admin/runtime-config.js', () => ({ loadOverrideCached: mocks.cached }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn() } }));

import { getSleepPhase, isAsleepStrict } from '../../../src/tracking/sleep.js';
import { _resetBedtimeShifts, daySchedule } from '../../../src/tracking/life-state.js';

const OVERRIDE_KEY = 'xxb:admin:model_routing:override';
const NIGHT = new Date('2026-06-07T19:00:00Z'); // Beijing 03:00
const DAY = new Date('2026-06-08T09:00:00Z'); // Beijing 17:00

beforeEach(() => {
  vi.clearAllMocks();
  mocks.values.clear();
  mocks.config.SLEEP_SCHEDULE_ENABLED = true;
  mocks.get.mockImplementation(async key => mocks.values.get(key) ?? null);
  _resetBedtimeShifts();
});

describe('strict assignment sleep reads', () => {
  it('uses the real date-seeded schedule for night and day', async () => {
    expect(await isAsleepStrict(NIGHT)).toBe(true);
    expect(await isAsleepStrict(DAY)).toBe(false);
    expect(mocks.cached).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('includes naps from the same real schedule', async () => {
    const dates = Array.from({ length: 28 }, (_, index) => `2026-06-${String(index + 1).padStart(2, '0')}`);
    const date = dates.find(value => daySchedule(value).napStart !== null)!;
    const minutes = daySchedule(date).napStart!;
    const now = new Date(Date.parse(`${date}T00:00:00Z`) + (minutes - 8 * 60 + 2) * 60_000);
    expect(await isAsleepStrict(now)).toBe(true);
  });

  it('does not read Redis when the existing schedule flag is off', async () => {
    mocks.config.SLEEP_SCHEDULE_ENABLED = false;
    expect(await isAsleepStrict(NIGHT)).toBe(false);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each([
    [{ force: 'asleep' }, DAY, true],
    [{ force: 'awake' }, NIGHT, false],
    [{ enabled: false }, NIGHT, false],
    [{ enabled: false, force: 'asleep' }, NIGHT, false],
    [{ enabled: true }, NIGHT, true],
    [{}, DAY, false],
  ])('uses verified override %j with the existing precedence', async (sleep, now, asleep) => {
    mocks.values.set(OVERRIDE_KEY, JSON.stringify({ sleep_schedule: sleep }));
    expect(await isAsleepStrict(now)).toBe(asleep);
  });

  it('reads changes immediately even while ordinary ingress has a cached awake override', async () => {
    expect(await getSleepPhase(NIGHT)).toBe('awake');
    mocks.values.set(OVERRIDE_KEY, JSON.stringify({ sleep_schedule: { force: 'awake' } }));
    expect(await isAsleepStrict(NIGHT)).toBe(false);
    mocks.values.set(OVERRIDE_KEY, JSON.stringify({ sleep_schedule: { force: 'asleep' } }));
    expect(await isAsleepStrict(DAY)).toBe(true);
    expect(mocks.cached).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('ignores private global wake and bedtime hold without reading or mutating either key', async () => {
    mocks.values.set('xxb:sleep:global_wake', 'owner-dm');
    mocks.values.set('xxb:sleep:bedtime_hold', '1');
    expect(await isAsleepStrict(NIGHT)).toBe(true);
    expect(mocks.get.mock.calls).toEqual([[OVERRIDE_KEY]]);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.incr).not.toHaveBeenCalled();
    expect(mocks.expire).not.toHaveBeenCalled();
  });

  it('denies unknown Redis state instead of falling back to an awake daytime schedule', async () => {
    mocks.get.mockRejectedValueOnce(new Error('unavailable upstream state'));
    await expect(isAsleepStrict(DAY)).rejects.toThrow('sleep_state_unavailable');
  });

  it.each([
    '', '{broken-json', 'null', '[]', 'true',
    '{"sleep_schedule":null}', '{"sleep_schedule":[]}', '{"sleep_schedule":"awake"}',
    '{"sleep_schedule":{"enabled":"false"}}', '{"sleep_schedule":{"force":"unknown"}}',
    '{"sleep_schedule":{"forse":"asleep"}}',
  ])('refuses malformed override %s without exposing its contents', async raw => {
    mocks.values.set(OVERRIDE_KEY, raw);
    await expect(isAsleepStrict(DAY)).rejects.toThrow('sleep_override_invalid');
  });

  it('does not expose unrelated private configuration in a parse failure', async () => {
    const privateValue = 'private-provider-value';
    mocks.values.set(OVERRIDE_KEY, `{"providers":{"api_key":"${privateValue}"},broken`);
    await expect(isAsleepStrict(DAY)).rejects.toMatchObject({ message: 'sleep_override_invalid' });
    mocks.values.set(OVERRIDE_KEY, JSON.stringify({ providers: { api_key: privateValue } }));
    expect(await isAsleepStrict(DAY)).toBe(false);
  });

  it('refuses an invalid clock value', async () => {
    await expect(isAsleepStrict(new Date(Number.NaN))).rejects.toThrow('sleep_time_invalid');
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
