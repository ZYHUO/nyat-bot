import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
// summarizeEpisodes 的依赖,recall 路径用不到
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: vi.fn(async () => []) }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));

const { recallEpisodes } = await import('../../../src/tracking/group-episodes.js');

const CHAT = -100;

function init(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0035_group_episodes.sql'), 'utf-8'));
}

function insertEpisode(opts: {
  summary: string;
  keywords: string;
  salience: number;
  createdAt?: number;
}): number {
  const r = testDb.prepare(
    'INSERT INTO group_episodes (chat_id, summary, keywords, salience, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(CHAT, opts.summary, opts.keywords, opts.salience, opts.createdAt ?? 1000);
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  init(testDb);
});
afterEach(() => testDb.close());

describe('recallEpisodes scoring (#36B)', () => {
  it('high-salience topical episode beats a stale 2-char-overlap one', () => {
    // 陈旧但"今天/这个"两个弱词都撞上 —— 旧逻辑先到先得会选它
    insertEpisode({
      summary: '旧事:某人今天迟到',
      keywords: '今天 这个 迟到',
      salience: 0.3,
      createdAt: 500,
    });
    const topicalId = insertEpisode({
      summary: '群友把服务器搞炸了',
      keywords: '服务器 搞炸 翻车',
      salience: 0.9,
      createdAt: 900,
    });

    const hits = recallEpisodes(CHAT, '今天这个服务器又翻车了吗');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe(topicalId); // hits×权重×salience 碾压弱重叠
  });

  it('incidental 今天/这个 single weak overlap injects NOTHING', () => {
    insertEpisode({
      summary: '无关旧事',
      keywords: '今天 计划',
      salience: 1.0,
    });
    // 只有"今天"(2字)单命中 → 硬门槛拦截
    expect(recallEpisodes(CHAT, '今天吃什么好呢')).toEqual([]);
  });

  it('two weak hits on a LOW-salience episode stay below the score floor', () => {
    insertEpisode({
      summary: '陈年流水账',
      keywords: '今天 这个',
      salience: 0.1, // 2 hits × weight 1 × 0.1 = 0.2 < 0.5
    });
    expect(recallEpisodes(CHAT, '今天这个怎么样')).toEqual([]);
  });

  it('single STRONG keyword (len>=4) with decent salience survives — callback case', () => {
    const id = insertEpisode({
      summary: '上周的拼好饭梗',
      keywords: '拼好饭团购',
      salience: 0.5, // 1 strong hit × weight 2 × 0.5 = 1.0 >= 0.5
    });
    const hits = recallEpisodes(CHAT, '又到了拼好饭团购的时间');
    expect(hits.map((h) => h.id)).toEqual([id]);
  });

  it('recall_count bumps ONLY for episodes that actually inject', () => {
    const weakId = insertEpisode({
      summary: '弱重叠',
      keywords: '今天 这个',
      salience: 0.1,
    });
    const strongId = insertEpisode({
      summary: '强相关',
      keywords: '服务器 翻车',
      salience: 0.9,
    });

    recallEpisodes(CHAT, '今天这个服务器翻车了');

    const counts = Object.fromEntries(
      (testDb.prepare('SELECT id, recall_count FROM group_episodes').all() as Array<{ id: number; recall_count: number }>)
        .map((r) => [r.id, r.recall_count]),
    );
    expect(counts[strongId]).toBe(1);
    expect(counts[weakId]).toBe(0); // 没注入就不自我强化
  });

  it('respects the limit and ranks by score', () => {
    insertEpisode({ summary: 'A', keywords: '服务器 翻车', salience: 0.9, createdAt: 100 });
    insertEpisode({ summary: 'B', keywords: '服务器 重启', salience: 0.6, createdAt: 200 });
    insertEpisode({ summary: 'C', keywords: '服务器 监控', salience: 0.7, createdAt: 300 });

    const hits = recallEpisodes(CHAT, '服务器翻车重启监控全占了', 2);
    expect(hits.length).toBe(2);
    expect(hits[0]!.summary).toBe('A'); // 最高分在前
  });

  it('short message (<4 chars) returns nothing', () => {
    insertEpisode({ summary: 'X', keywords: '服务器 翻车', salience: 1.0 });
    expect(recallEpisodes(CHAT, '翻车')).toEqual([]);
  });
});
