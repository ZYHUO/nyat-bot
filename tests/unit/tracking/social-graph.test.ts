import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));

const { recordInteraction, getTopEdges, buildSocialInjection, buildBridgeHint, getClosestPeer } =
  await import('../../../src/tracking/social-graph.js');

function init(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0034_social_edges.sql'), 'utf-8'));
}

describe('social-graph', () => {
  beforeEach(() => { testDb = new Database(':memory:'); init(testDb); });
  afterEach(() => testDb.close());

  it('records a canonical edge regardless of direction and accumulates weight', () => {
    recordInteraction(-100, 5, 'Bob', 3, 'Alice');   // 5→3
    recordInteraction(-100, 3, 'Alice', 5, 'Bob');   // 3→5 (same edge)
    const row = testDb.prepare('SELECT uid_a, uid_b, weight, name_a, name_b FROM social_edges').get() as any;
    expect(row.uid_a).toBe(3); expect(row.uid_b).toBe(5);
    expect(row.weight).toBe(2);
    expect(row.name_a).toBe('Alice'); expect(row.name_b).toBe('Bob');
  });

  it('ignores self-interaction', () => {
    recordInteraction(-100, 7, 'X', 7, 'X');
    expect((testDb.prepare('SELECT count(*) c FROM social_edges').get() as any).c).toBe(0);
  });

  it('getTopEdges applies the floor and sorts by weight', () => {
    for (let i = 0; i < 3; i++) recordInteraction(-100, 1, 'A', 2, 'B'); // weight 3
    recordInteraction(-100, 3, 'C', 4, 'D');                            // weight 1 (< floor)
    const top = getTopEdges(-100);
    expect(top).toHaveLength(1);
    expect(top[0]!.nameA).toBe('A'); expect(top[0]!.nameB).toBe('B');
  });

  it('decay drops a stale edge below the floor', () => {
    testDb.prepare(
      "INSERT INTO social_edges (chat_id, uid_a, uid_b, name_a, name_b, weight, last_at) VALUES (-100,1,2,'A','B',3,0)",
    ).run();
    expect(getTopEdges(-100)).toHaveLength(0); // last_at=1970 → decayed to ~0
  });

  it('buildSocialInjection formats the top ties', () => {
    for (let i = 0; i < 3; i++) recordInteraction(-100, 1, 'Alice', 2, 'Bob');
    expect(buildSocialInjection(-100)).toContain('Alice 和 Bob 常互动');
  });

  it('returns empty when nothing is strong enough', () => {
    recordInteraction(-100, 1, 'A', 2, 'B'); // single interaction, below floor
    expect(buildSocialInjection(-100)).toBe('');
  });

  it('getClosestPeer returns the strongest peer', () => {
    for (let i = 0; i < 4; i++) recordInteraction(-100, 1, 'A', 2, 'B');
    for (let i = 0; i < 2; i++) recordInteraction(-100, 1, 'A', 3, 'C');
    expect(getClosestPeer(-100, 1)).toBe('B');
    expect(getClosestPeer(-100, 9)).toBeUndefined(); // 无边
  });

  it('buildBridgeHint prefers shared episode, falls back to peer, else empty', () => {
    // 有往事 → 提往事
    expect(buildBridgeHint(-100, 1, 'A', '上次团建真好玩', () => [{ summary: '上次团建去了海边' }]))
      .toContain('上次团建去了海边');
    // 无往事但有熟人 → cue 熟人
    for (let i = 0; i < 3; i++) recordInteraction(-100, 1, 'A', 2, 'B');
    expect(buildBridgeHint(-100, 1, 'A', '今天天气不错', () => []))
      .toContain('B');
    // 都没有 → 空,调用方跳过
    expect(buildBridgeHint(-100, 9, 'Z', '今天天气不错', () => [])).toBe('');
    // 太短的消息不查往事
    expect(buildBridgeHint(-100, 9, 'Z', '好', () => [{ summary: '不该命中' }])).toBe('');
  });
});
