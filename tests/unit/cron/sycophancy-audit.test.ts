import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;
const callWithFallbackMock = vi.fn();
const getRecentMock = vi.fn();
const zrangeMock = vi.fn();
const envMock = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ zrange: (...args: unknown[]) => zrangeMock(...args) }),
}));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallbackMock(...args),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: (...args: unknown[]) => getRecentMock(...args),
}));
vi.mock('../../../src/env.js', () => ({ env: () => envMock() }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const { parseSycoOutput, weekKey, auditChat, runSycophancyAudit, recentSycoTrend } =
  await import('../../../src/cron/sycophancy-audit.js');

function init(db: Database.Database): void {
  db.exec(readFileSync(join(__dirname, '../../../migrations/0077_sycophancy_audit.sql'), 'utf8'));
}

const BOT_MSGS = Array.from({ length: 10 }, (_, i) => ({
  isBot: true, uid: 0, textContent: `bot 回复第 ${i} 条内容足够长`,
  timestamp: i, messageId: 100 + i,
}));

beforeEach(() => {
  db = new Database(':memory:');
  init(db);
  envMock.mockReturnValue({ SYCOPHANCY_AUDIT_ENABLED: true });
  callWithFallbackMock.mockReset();
  getRecentMock.mockReset().mockResolvedValue(BOT_MSGS);
  zrangeMock.mockReset().mockResolvedValue(['-1001', '-1002']);
});

describe('parseSycoOutput', () => {
  it('parses five dims and computes overall', () => {
    const r = parseSycoOutput('{"agree":0.5,"praise":0.3,"pander":0,"apologize":0.2,"credit":0}')!;
    expect(r.agree).toBe(0.5);
    expect(r.overall).toBeCloseTo(0.2, 2);
  });

  it('parses fenced JSON', () => {
    const r = parseSycoOutput('```json\n{"agree":0,"praise":0,"pander":0,"apologize":0,"credit":0}\n```')!;
    expect(r.overall).toBe(0);
  });

  it('returns null on garbage / missing dims', () => {
    expect(parseSycoOutput('今天天气不错')).toBeNull();
    expect(parseSycoOutput('{"agree": 0.5}')).toBeNull();
  });

  it('strips thinking blocks (reasoning-model output)', () => {
    // 线上实测: judge 链 reasoning 模型回 thinking 包 JSON / 未闭合 thinking 前缀
    const r1 = parseSycoOutput('<thinking>我先看看这些回复……</thinking>{"agree":0.2,"praise":0.1,"pander":0,"apologize":0,"credit":0}')!;
    expect(r1.overall).toBeCloseTo(0.06, 2);
    const r2 = parseSycoOutput('<think>嗯……\n{"agree":0,"praise":0,"pander":0,"apologize":0,"credit":0}')!;
    expect(r2.overall).toBe(0);
    const r3 = parseSycoOutput('```json\n<thinking>分析中</thinking>\n{"agree":0.5,"praise":0.5,"pander":0,"apologize":0,"credit":0}\n```')!;
    expect(r3.agree).toBe(0.5);
  });

  it('clamps out-of-range values', () => {
    const r = parseSycoOutput('{"agree":2,"praise":-1,"pander":0,"apologize":0,"credit":0}')!;
    expect(r.agree).toBe(1);
    expect(r.praise).toBe(0);
  });
});

describe('weekKey', () => {
  it('is stable within a week, changes across weeks', () => {
    // 2026-09-05 是周六; 同周周一 2026-08-31
    expect(weekKey(Math.floor(new Date('2026-09-05T12:00:00Z').getTime() / 1000))).toBe('2026-08-31');
    expect(weekKey(Math.floor(new Date('2026-09-07T12:00:00Z').getTime() / 1000))).toBe('2026-09-07');
  });
});

describe('auditChat', () => {
  it('full flow: samples → LLM → row written', async () => {
    callWithFallbackMock.mockResolvedValue({
      content: '{"agree":0.4,"praise":0.2,"pander":0,"apologize":0.1,"credit":0}',
    });
    const r = await auditChat(-1001, '2026-08-31');
    expect(r).toBeCloseTo(0.14, 2);
    const row = db.prepare('SELECT * FROM sycophancy_audits').get() as { sample_count: number; overall: number };
    expect(row.sample_count).toBe(10);
    expect(row.overall).toBeCloseTo(0.14, 2);
    const arg = callWithFallbackMock.mock.calls[0]![0] as { usage: string; temperature: number };
    expect(arg.usage).toBe('judge');
    expect(arg.temperature).toBe(0);
  });

  it('skips silently with too few samples', async () => {
    getRecentMock.mockResolvedValue(BOT_MSGS.slice(0, 2));
    expect(await auditChat(-1001, '2026-08-31')).toBeNull();
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('skips silently on unparseable output and LLM failure', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '今天天气不错' });
    expect(await auditChat(-1001, '2026-08-31')).toBeNull();
    callWithFallbackMock.mockRejectedValue(new Error('down'));
    expect(await auditChat(-1001, '2026-08-31')).toBeNull();
  });
});

describe('runSycophancyAudit', () => {
  it('audits each active group once per week, skips already-audited', async () => {
    callWithFallbackMock.mockResolvedValue({
      content: '{"agree":0,"praise":0,"pander":0,"apologize":0,"credit":0}',
    });
    await runSycophancyAudit();
    expect(db.prepare('SELECT COUNT(*) c FROM sycophancy_audits').get() as { c: number }).toEqual({ c: 2 });
    // 第二遍同周跳过,不重复调 LLM
    callWithFallbackMock.mockClear();
    await runSycophancyAudit();
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('does nothing when flag off', async () => {
    envMock.mockReturnValue({ SYCOPHANCY_AUDIT_ENABLED: false });
    await runSycophancyAudit();
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });
});

describe('recentSycoTrend', () => {
  it('returns null with no audits, summary otherwise', () => {
    expect(recentSycoTrend()).toBeNull();
    db.prepare(`INSERT INTO sycophancy_audits (week, chat_id, sample_count, agree, praise, pander, apologize, credit, overall, created_at)
      VALUES ('2026-08-31', -1001, 10, 0.4, 0.2, 0, 0.1, 0, 0.14, 1)`).run();
    const t = recentSycoTrend()!;
    expect(t).toContain('谄媚审计');
    expect(t).toContain('0.14');
  });
});
