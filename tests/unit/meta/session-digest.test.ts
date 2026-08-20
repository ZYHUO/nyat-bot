/**
 * session-digest.ts — CGM 式 digest 持久化。
 *
 * 真实 migration 0067 灌进 :memory: SQLite;getDb / env 按 tests/unit 惯例手 mock。
 * 覆盖:persist+recent+digestsSince+search 回环、中文 FTS 命中、默认值、
 * flag-off no-op、空文本跳过、DB 挂掉时全部 fail-soft(不抛)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
const envState = { DIGEST_PERSIST_ENABLED: true };

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { persistDigest, recentDigests, digestsSince, searchDigests } = await import(
  '../../../src/meta/session-digest.js'
);

function initSchema(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0067_session_digests.sql'), 'utf-8'));
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

function rowCount(): number {
  return (testDb.prepare('SELECT COUNT(*) AS c FROM session_digests').get() as { c: number }).c;
}

describe('session-digest', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
    envState.DIGEST_PERSIST_ENABLED = true;
  });
  afterEach(() => testDb.close());

  describe('migration 0067', () => {
    it('creates session_digests + FTS5 table, idempotent', () => {
      const names = (
        testDb
          .prepare(
            `SELECT name FROM sqlite_master WHERE name IN ('session_digests', 'session_digests_fts')`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(names.sort()).toEqual(['session_digests', 'session_digests_fts']);
      // 重复执行不抛(IF NOT EXISTS)。
      expect(() => initSchema(testDb)).not.toThrow();
    });

    it('importance column defaults to 0.5 at DDL level', () => {
      testDb
        .prepare(`INSERT INTO session_digests (kind, text, created_at) VALUES ('meta', 'x', 1)`)
        .run();
      const row = testDb.prepare(`SELECT importance, tags FROM session_digests`).get() as {
        importance: number;
        tags: string | null;
      };
      expect(row.importance).toBe(0.5);
      expect(row.tags).toBeNull();
    });
  });

  describe('persistDigest', () => {
    it('persists row + FTS entry, returns rowid', () => {
      const id = persistDigest({
        kind: 'meta',
        sourceChatId: -100123,
        taskId: 'task-1',
        text: '本轮派了三条回复,主人问了篮球赛程',
      });
      expect(id).toBeGreaterThanOrEqual(1);

      const row = testDb.prepare(`SELECT * FROM session_digests WHERE id = ?`).get(id!) as {
        kind: string;
        source_chat_id: number;
        task_id: string;
        text: string;
        importance: number;
        created_at: number;
      };
      expect(row.kind).toBe('meta');
      expect(row.source_chat_id).toBe(-100123);
      expect(row.task_id).toBe('task-1');
      expect(row.text).toContain('篮球赛程');
      expect(row.importance).toBe(0.5);
      expect(Math.abs(row.created_at - nowSec())).toBeLessThanOrEqual(2);

      const fts = testDb
        .prepare(`SELECT digest_id, seg FROM session_digests_fts WHERE digest_id = ?`)
        .get(id!) as { digest_id: number; seg: string } | undefined;
      expect(fts?.digest_id).toBe(id);
      expect(fts?.seg.length).toBeGreaterThan(0);
    });

    it('stores explicit tags (JSON) + importance, readable via recentDigests', () => {
      persistDigest({
        kind: 'subagent',
        sourceChatId: 42,
        taskId: 't-9',
        text: '帮主人查完资料了',
        tags: ['research', '主人'],
        importance: 0.9,
      });
      const [d] = recentDigests(1);
      expect(d?.kind).toBe('subagent');
      expect(d?.tags).toEqual(['research', '主人']);
      expect(d?.importance).toBe(0.9);
    });

    it('defaults: tags [] and importance 0.5', () => {
      persistDigest({ kind: 'meta', text: '随便一条' });
      const [d] = recentDigests(1);
      expect(d?.tags).toEqual([]);
      expect(d?.importance).toBe(0.5);
      expect(d?.sourceChatId).toBeNull();
      expect(d?.taskId).toBeNull();
    });

    it('blank / whitespace text is skipped', () => {
      expect(persistDigest({ kind: 'subagent', text: '   ' })).toBeNull();
      expect(persistDigest({ kind: 'subagent', text: '' })).toBeNull();
      expect(rowCount()).toBe(0);
    });

    it('flag off → no-op', () => {
      envState.DIGEST_PERSIST_ENABLED = false;
      expect(persistDigest({ kind: 'meta', text: '不该落盘' })).toBeNull();
      expect(rowCount()).toBe(0);
    });
  });

  describe('recentDigests / digestsSince', () => {
    it('recentDigests returns newest N in chronological order', () => {
      persistDigest({ kind: 'meta', text: '第一条' });
      persistDigest({ kind: 'subagent', text: '第二条', taskId: 't2' });
      persistDigest({ kind: 'dispatch', text: '第三条', taskId: 't3' });

      const all = recentDigests(10);
      expect(all.map((d) => d.text)).toEqual(['第一条', '第二条', '第三条']);

      const last2 = recentDigests(2);
      expect(last2.map((d) => d.text)).toEqual(['第二条', '第三条']);
    });

    it('recentDigests excludeKinds filters kinds out', () => {
      persistDigest({ kind: 'meta', text: 'meta 的' });
      persistDigest({ kind: 'dispatch', text: 'dispatch 的' });
      const rows = recentDigests(10, { excludeKinds: ['dispatch'] });
      expect(rows.map((d) => d.kind)).toEqual(['meta']);
    });

    it('digestsSince filters by timestamp (unix seconds), ascending', () => {
      testDb
        .prepare(
          `INSERT INTO session_digests (kind, text, created_at) VALUES ('meta', '老 digest', 1000)`,
        )
        .run();
      persistDigest({ kind: 'meta', text: '新 digest' });

      const recent = digestsSince(nowSec() - 10, 10);
      expect(recent.map((d) => d.text)).toEqual(['新 digest']);

      const everything = digestsSince(999, 10);
      expect(everything.map((d) => d.text)).toEqual(['老 digest', '新 digest']);
    });
  });

  describe('searchDigests (FTS)', () => {
    it('finds Chinese two-char words inside a digest', () => {
      const id = persistDigest({
        kind: 'meta',
        text: '主人让本喵帮忙查了篮球比赛的赛程,已经发到群里',
      });
      persistDigest({ kind: 'subagent', text: '晚饭吃了拉面,群里聊得很开心' });

      const hits = searchDigests('篮球', 5);
      expect(hits.map((d) => d.id)).toEqual([id]);
      expect(hits[0]?.text).toContain('篮球');

      // 另一条的双字词也能独立命中(写入/查询同一分词器)。
      expect(searchDigests('拉面', 5).map((d) => d.text)).toEqual([
        '晚饭吃了拉面,群里聊得很开心',
      ]);
    });

    it('no match / empty query / FTS-special chars → empty, never throws', () => {
      persistDigest({ kind: 'meta', text: '普通的摘要一条' });
      expect(searchDigests('zzqnotfound', 5)).toEqual([]);
      expect(searchDigests('', 5)).toEqual([]);
      expect(() => searchDigests('" OR ( NEAR/', 5)).not.toThrow();
    });
  });

  describe('fail-soft', () => {
    it('broken DB never throws — persist returns null, readers return []', () => {
      testDb.exec(`DROP TABLE session_digests`);
      expect(() =>
        persistDigest({ kind: 'meta', text: '表都没了' }),
      ).not.toThrow();
      expect(persistDigest({ kind: 'meta', text: '表都没了' })).toBeNull();
      expect(recentDigests(5)).toEqual([]);
      expect(digestsSince(0, 5)).toEqual([]);
      expect(searchDigests('篮球', 5)).toEqual([]);
    });
  });
});
