import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;
const envMock = vi.fn();
const recentMock = vi.fn();
const nowSecTest = (): number => Math.floor(Date.now() / 1000);

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => envMock() }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: (chatId: number) => recentMock(chatId) }));

const {
  recordBotMessageForConnectivity, calculateConnectivityWindows, groupConnectivity,
  scoreDmRisk, hasEmotionWord, isNightHour,
} = await import('../../../src/agent/reverse-valve.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0001_init.sql'), 'utf8'));
  db.exec(readFileSync(join(__dirname, '../../../migrations/0066_connectivity.sql'), 'utf8'));
  envMock.mockReturnValue({ CONNECTIVITY_TRACKING_ENABLED: true });
  recentMock.mockReset();
  recentMock.mockResolvedValue([]);
});

describe('connectivity windows', () => {
  it('records bot message window', async () => {
    await recordBotMessageForConnectivity(-100, 500, 'bot', 1000);
    const row = db.prepare('SELECT * FROM connectivity_windows').get() as { chat_id: number; window_end: number };
    expect(row.chat_id).toBe(-100);
    expect(row.window_end).toBe(1300); // 5 分钟
  });

  it('calculates human-to-human rounds after window expires', async () => {
    await recordBotMessageForConnectivity(-100, 500, 'bot', 1000);
    // bot 消息(1000s)后窗口内人类消息: A, B, A → 2 轮人-人
    recentMock.mockResolvedValue([
      { timestamp: 1001, uid: 7, isBot: false } as never,
      { timestamp: 1002, uid: 8, isBot: false } as never,
      { timestamp: 1003, uid: 7, isBot: false } as never,
    ]);
    const n = await calculateConnectivityWindows(2000);
    expect(n).toBe(1);
    const w = db.prepare('SELECT human_rounds, calculated FROM connectivity_windows').get() as { human_rounds: number; calculated: number };
    expect(w.human_rounds).toBe(2);
    expect(w.calculated).toBe(1);
    expect(groupConnectivity(-100, 0)).toBe(2);
  });

  it('excludes bot messages and out-of-window messages', async () => {
    await recordBotMessageForConnectivity(-100, 500, 'bot', 1000);
    recentMock.mockResolvedValue([
      { timestamp: 900, uid: 7, isBot: false } as never,   // 窗口外(早)
      { timestamp: 1001, uid: 7, isBot: false } as never,
      { timestamp: 1002, uid: 999, isBot: true } as never, // bot 消息忽略
      { timestamp: 1301, uid: 8, isBot: false } as never,  // 窗口外(晚)
    ]);
    const n = await calculateConnectivityWindows(2000);
    expect(n).toBe(1);
    const w = db.prepare('SELECT human_rounds FROM connectivity_windows').get() as { human_rounds: number };
    expect(w.human_rounds).toBe(0); // 只有 1 条有效人类消息,无轮次
  });

  it('normalizes ms input to seconds (regression: reviewer critical #1)', async () => {
    // 上层误传 ms(1e12 量级) → 入口归一化为秒,window 能正常到期
    await recordBotMessageForConnectivity(-100, 500, 'bot', 1000 * 1000 * 1000 + 500);
    const row = db.prepare('SELECT bot_ts, window_end FROM connectivity_windows').get() as { bot_ts: number; window_end: number };
    expect(row.window_end).toBeLessThan(1e10);   // 秒量级,不是毫秒
    expect(row.window_end - row.bot_ts).toBe(300);
  });

  it('cleans up stale calculated windows > 7 days', async () => {
    await recordBotMessageForConnectivity(-100, 500, 'bot', nowSecTest());
    db.prepare('UPDATE connectivity_windows SET calculated = 1').run();
    // 旧窗口(20 天前)
    db.prepare(`INSERT OR IGNORE INTO connectivity_windows (chat_id, bot_mid, bot_username, bot_ts, window_end, human_rounds, calculated)
                VALUES (-100, 1, 'bot', ?, ?, 0, 1)`).run(nowSecTest() - 20 * 86400, nowSecTest() - 20 * 86400 + 300);
    await calculateConnectivityWindows(nowSecTest());
    const remaining = db.prepare('SELECT COUNT(*) c FROM connectivity_windows').get() as { c: number };
    expect(remaining.c).toBe(1); // 只有新窗口,20 天前的被清理
  });

  it('flag off → no record', async () => {
    envMock.mockReturnValue({ CONNECTIVITY_TRACKING_ENABLED: false });
    await recordBotMessageForConnectivity(-100, 500, 'bot', 1000);
    expect(db.prepare('SELECT COUNT(*) c FROM connectivity_windows').get()).toEqual({ c: 0 });
  });
});

describe('dm risk scoring', () => {
  it('high risk: long streak + night + emotion + no group talk', () => {
    const r = scoreDmRisk({ consecutiveDays: 12, nightRatio: 0.8, avgSessionMin: 100, emotionWordDensity: 0.6, groupTalkRatio: 0.05 });
    expect(r.level).toBe('high');
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.factors).toContain('连续 12 天');
  });

  it('low risk: healthy user', () => {
    const r = scoreDmRisk({ consecutiveDays: 1, nightRatio: 0.05, avgSessionMin: 10, emotionWordDensity: 0.02, groupTalkRatio: 0.9 });
    expect(r.level).toBe('low');
    expect(r.score).toBeLessThan(40);
  });

  it('medium risk threshold', () => {
    const r = scoreDmRisk({ consecutiveDays: 7, nightRatio: 0.5, avgSessionMin: 30, emotionWordDensity: 0.2, groupTalkRatio: 0.5 });
    expect(r.level).toBe('medium');
  });

  it('emotion word detection', () => {
    expect(hasEmotionWord('最近好孤独')).toBe(true);
    expect(hasEmotionWord('今天吃了个苹果')).toBe(false);
  });

  it('night hour detection', () => {
    expect(isNightHour(1)).toBe(true);
    expect(isNightHour(23)).toBe(true);
    expect(isNightHour(12)).toBe(false);
  });
});
