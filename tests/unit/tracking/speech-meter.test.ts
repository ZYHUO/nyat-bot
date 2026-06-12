import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
const redisMock = {
  incr: vi.fn(async (k: string) => {
    const n = parseInt(store.get(k) ?? '0', 10) + 1;
    store.set(k, String(n));
    return n;
  }),
  expire: vi.fn(async () => 1),
  mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const { bjDateStr, recordSpeech, getSpeechCounts, bedtimeShiftFromCount } = await import(
  '../../../src/tracking/speech-meter.js'
);

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('speech-meter', () => {
  it('bjDateStr:UTC 18:00 = 北京次日 02:00', () => {
    expect(bjDateStr(new Date('2026-06-12T18:00:00Z'))).toBe('2026-06-13');
    expect(bjDateStr(new Date('2026-06-12T10:00:00Z'))).toBe('2026-06-12');
  });

  it('recordSpeech 累加当日键;getSpeechCounts 读今昨两日', async () => {
    const now = new Date('2026-06-12T10:00:00Z'); // 北京 6-12 18:00
    recordSpeech(now);
    recordSpeech(now);
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget 落地
    store.set('xxb:speech:2026-06-11', '120');
    const counts = await getSpeechCounts(now);
    expect(counts).toEqual({ today: 2, prev: 120, todayDate: '2026-06-12', prevDate: '2026-06-11' });
  });

  it('getSpeechCounts:Redis 故障 fail-soft 全 0', async () => {
    redisMock.mget.mockRejectedValueOnce(new Error('down'));
    const counts = await getSpeechCounts(new Date('2026-06-12T10:00:00Z'));
    expect(counts.today).toBe(0);
    expect(counts.prev).toBe(0);
  });

  it('bedtimeShiftFromCount 阶梯:话少晚睡,话多早睡', () => {
    expect(bedtimeShiftFromCount(0)).toBe(45);
    expect(bedtimeShiftFromCount(29)).toBe(45);
    expect(bedtimeShiftFromCount(50)).toBe(0);
    expect(bedtimeShiftFromCount(150)).toBe(-30);
    expect(bedtimeShiftFromCount(300)).toBe(-60);
  });
});
