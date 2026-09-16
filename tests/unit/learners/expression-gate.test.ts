import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
const mockCallWithFallback = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...a: unknown[]) => mockCallWithFallback(...a),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { parseGateVerdicts, reviewChatExpressions } = await import('../../../src/learners/expression-gate.js');
const { getTopExpressions, getPendingExpressions } = await import('../../../src/learners/expression-learner.js');

function initSchema(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0016_learners.sql'), 'utf-8'));
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0031_expression_gate.sql'), 'utf-8'));
}
const now = Math.floor(Date.now() / 1000);
function addPending(situation: string, style: string): void {
  testDb.prepare(
    "INSERT INTO expressions (chat_id, situation, style, count, created_at, updated_at, status, confidence) VALUES (-100, ?, ?, 3, ?, ?, 'pending', 0.5)",
  ).run(situation, style, now, now);
}

describe('expression-gate', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
    mockCallWithFallback.mockReset();
  });
  afterEach(() => testDb.close());

  describe('parseGateVerdicts', () => {
    it('parses verdict array', () => {
      const v = parseGateVerdicts('[{"idx":0,"approve":true,"confidence":0.8},{"idx":1,"approve":false,"confidence":0.2}]');
      expect(v).toHaveLength(2);
      expect(v[0]).toMatchObject({ idx: 0, approve: true });
      expect(v[1]!.approve).toBe(false);
    });
    it('tolerates fences and returns [] on garbage', () => {
      expect(parseGateVerdicts('```json\n[{"idx":0,"approve":true}]\n```')).toHaveLength(1);
      expect(parseGateVerdicts('nope')).toEqual([]);
    });
  });

  describe('reviewChatExpressions', () => {
    it('approves/rejects pending by the LLM verdict', async () => {
      addPending('打招呼', '热情卖萌');
      addPending('被骂', '阴阳怪气'); // should be rejected
      mockCallWithFallback.mockResolvedValue({
        content: '[{"idx":0,"approve":true,"confidence":0.9},{"idx":1,"approve":false,"confidence":0.1}]',
      });

      const r = await reviewChatExpressions(-100);
      expect(r).toEqual({ approved: 1, rejected: 1 });
      // approved one now injectable, rejected one is not, none pending
      const top = getTopExpressions(-100, 10).map((e) => e.style);
      expect(top).toContain('热情卖萌');
      expect(top).not.toContain('阴阳怪气');
      expect(getPendingExpressions(-100, 10)).toHaveLength(0);
    });

    it('no-ops when nothing pending', async () => {
      expect(await reviewChatExpressions(-100)).toEqual({ approved: 0, rejected: 0 });
      expect(mockCallWithFallback).not.toHaveBeenCalled();
    });
  });
});
