import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

const { upsertLoopPolicy, listActivePolicies, recordPolicyOutcome } = await import('../../../src/agent/loop-policy.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0060_loop_policies.sql'), 'utf8'));
});

describe('upsertLoopPolicy', () => {
  it('creates and dedupes by name', () => {
    const a = upsertLoopPolicy('verify_before_deliver', '交付前先验证', '验证策略');
    const b = upsertLoopPolicy('verify_before_deliver', '交付前先验证(更新版)', '验证策略');
    expect(a).toBe(b);
    const rows = db.prepare('SELECT COUNT(*) c FROM loop_policies').get() as { c: number };
    expect(rows.c).toBe(1);
    const row = db.prepare('SELECT rule FROM loop_policies WHERE id = ?').get(a) as { rule: string };
    expect(row.rule).toContain('更新版');
  });
});

describe('listActivePolicies', () => {
  it('returns enabled only, sorted by success rate', () => {
    upsertLoopPolicy('p1', '规则一');
    upsertLoopPolicy('p2', '规则二');
    upsertLoopPolicy('p3', '规则三');
    // p1 成功率高,p2 中,p3 失败多
    recordPolicyOutcome([1], true);
    recordPolicyOutcome([2], true);
    recordPolicyOutcome([2], false);
    recordPolicyOutcome([3], false);
    recordPolicyOutcome([3], false);
    const list = listActivePolicies();
    expect(list.map((p) => p.name)).toEqual(['p1', 'p2', 'p3']);
    expect(list[0]!.name).toBe('p1'); // 100% 成功率
  });

  it('respects limit', () => {
    upsertLoopPolicy('p1', 'r1');
    upsertLoopPolicy('p2', 'r2');
    expect(listActivePolicies(1)).toHaveLength(1);
  });
});

describe('recordPolicyOutcome', () => {
  it('increments counters and auto-disables low-success policies', () => {
    const id = upsertLoopPolicy('bad_policy', '总是失败的做法')!;
    // 4 次尝试 3 次失败(75% > 70% 阈值)且 ≥3 次 → disable
    recordPolicyOutcome([id], false);
    recordPolicyOutcome([id], true);
    recordPolicyOutcome([id], false);
    recordPolicyOutcome([id], false);
    const row = db.prepare('SELECT enabled, success_count, failure_count, trigger_count FROM loop_policies WHERE id = ?').get(id) as {
      enabled: number; success_count: number; failure_count: number; trigger_count: number;
    };
    expect(row.trigger_count).toBe(4);
    expect(row.success_count).toBe(1);
    expect(row.failure_count).toBe(3);
    expect(row.enabled).toBe(0); // 自动 disable
    expect(listActivePolicies()).toHaveLength(0);
  });

  it('keeps good policies enabled', () => {
    const id = upsertLoopPolicy('good_policy', '总是成功的方法')!;
    recordPolicyOutcome([id], true);
    recordPolicyOutcome([id], true);
    recordPolicyOutcome([id], true);
    const row = db.prepare('SELECT enabled FROM loop_policies WHERE id = ?').get(id) as { enabled: number };
    expect(row.enabled).toBe(1);
    expect(listActivePolicies()).toHaveLength(1);
  });
});
