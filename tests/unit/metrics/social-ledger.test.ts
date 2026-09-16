import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const {
  recordMessageSeen, recordDecision, recordReplySent, recordInterrupt,
  flushSocialLedger, getSocialReport,
} = await import('../../../src/metrics/social-ledger.js');

const CHAT = -1001;
const OTHER = -1002;
const today = new Date().toISOString().slice(0, 10);

function report(chatId: number) {
  return getSocialReport(today, today).find((r) => r.chatId === chatId);
}

describe('social ledger (G8 A/B 基线)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(readFileSync(resolve(process.cwd(), 'migrations/0053_social_daily.sql'), 'utf-8'));
    flushSocialLedger(); // 清掉上个用例可能残留的 pending
    testDb.exec('DELETE FROM social_daily');
  });
  afterEach(() => testDb.close());

  it('未 flush 时不写库', () => {
    recordMessageSeen(CHAT);
    expect(getSocialReport(today, today)).toEqual([]);
  });

  it('flush 后可读到累计值', () => {
    recordMessageSeen(CHAT);
    recordMessageSeen(CHAT);
    flushSocialLedger();
    expect(report(CHAT)?.msgSeen).toBe(2);
  });

  it('多次 flush 累加而不是覆盖', () => {
    recordMessageSeen(CHAT);
    flushSocialLedger();
    recordMessageSeen(CHAT);
    flushSocialLedger();
    expect(report(CHAT)?.msgSeen).toBe(2);
  });

  it('按群隔离', () => {
    recordMessageSeen(CHAT);
    recordMessageSeen(OTHER);
    recordMessageSeen(OTHER);
    flushSocialLedger();
    expect(report(CHAT)?.msgSeen).toBe(1);
    expect(report(OTHER)?.msgSeen).toBe(2);
  });

  it('三种心流出口分别计数', () => {
    recordDecision(CHAT, 'reply');
    recordDecision(CHAT, 'reply');
    recordDecision(CHAT, 'wait');
    recordDecision(CHAT, 'pass');
    flushSocialLedger();
    expect(report(CHAT)?.decisions).toEqual({ reply: 2, wait: 1, pass: 1 });
  });

  describe('四个 A/B 派生指标', () => {
    it('回复/消息比', () => {
      for (let i = 0; i < 10; i++) recordMessageSeen(CHAT);
      for (let i = 0; i < 3; i++) recordReplySent(CHAT);
      flushSocialLedger();
      expect(report(CHAT)?.replyRate).toBeCloseTo(0.3, 5);
    });

    it('端到端延迟取均值', () => {
      recordReplySent(CHAT, 100);
      recordReplySent(CHAT, 300);
      flushSocialLedger();
      expect(report(CHAT)?.e2eLatencyMs).toBe(200);
    });

    it('不带延迟的投递只计数,不污染均值', () => {
      recordReplySent(CHAT, 200);
      recordReplySent(CHAT);           // 多段回复的后续段 / 主动发言
      flushSocialLedger();
      const r = report(CHAT);
      expect(r?.replySent).toBe(2);
      expect(r?.e2eLatencyMs).toBe(200);
    });

    it('打断率', () => {
      for (let i = 0; i < 4; i++) recordReplySent(CHAT);
      recordInterrupt(CHAT);
      flushSocialLedger();
      expect(report(CHAT)?.interruptRate).toBeCloseTo(0.25, 5);
    });

    // G8 的核心主张就是"1 次调用代替 2-3 次",这个比值是判定它成败的主指标。
    it('每回复 LLM 调用数', () => {
      testDb.prepare('INSERT INTO social_daily (date, chat_id, metric, value) VALUES (?,?,?,?)')
        .run(today, CHAT, 'llm_calls', 9);
      for (let i = 0; i < 3; i++) recordReplySent(CHAT);
      flushSocialLedger();
      expect(report(CHAT)?.llmCallsPerReply).toBe(3);
    });

    it('分母为 0 时返回 null 而不是 NaN/Infinity', () => {
      recordInterrupt(CHAT);
      flushSocialLedger();
      const r = report(CHAT);
      expect(r?.replyRate).toBeNull();
      expect(r?.interruptRate).toBeNull();
      expect(r?.llmCallsPerReply).toBeNull();
      expect(r?.e2eLatencyMs).toBeNull();
    });
  });

  describe('健壮性 —— telemetry 绝不能拖垮主链路', () => {
    it('非法 chatId 被丢弃而不是写进库', () => {
      recordMessageSeen(NaN);
      recordMessageSeen(Infinity);
      flushSocialLedger();
      expect(getSocialReport(today, today)).toEqual([]);
    });

    it('负延迟被忽略', () => {
      recordReplySent(CHAT, -5);
      flushSocialLedger();
      expect(report(CHAT)?.e2eLatencyMs).toBeNull();
    });

    it('flush 失败时增量不丢,下次重试仍能写入', () => {
      recordMessageSeen(CHAT);
      testDb.exec('DROP TABLE social_daily');
      flushSocialLedger();                       // 失败,增量应放回 pending
      testDb.exec(readFileSync(resolve(process.cwd(), 'migrations/0053_social_daily.sql'), 'utf-8'));
      flushSocialLedger();                       // 重试
      expect(report(CHAT)?.msgSeen).toBe(1);
    });

    it('库坏掉时 getSocialReport 返回空而不是抛', () => {
      testDb.exec('DROP TABLE social_daily');
      expect(getSocialReport(today, today)).toEqual([]);
      testDb.exec(readFileSync(resolve(process.cwd(), 'migrations/0053_social_daily.sql'), 'utf-8'));
    });

    it('空 flush 是 no-op', () => {
      expect(() => flushSocialLedger()).not.toThrow();
    });
  });

  it('报表按消息量降序,便于一眼找到主力群', () => {
    recordMessageSeen(CHAT);
    for (let i = 0; i < 5; i++) recordMessageSeen(OTHER);
    flushSocialLedger();
    expect(getSocialReport(today, today).map((r) => r.chatId)).toEqual([OTHER, CHAT]);
  });
});
