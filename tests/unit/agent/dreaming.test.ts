import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;
const callWithFallbackMock = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallbackMock(...args),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({ DREAM_CONSOLIDATE_USAGE: 'judge' }),
}));

vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: () => 'dream system prompt',
}));

const { parseDreamOutput, applyDream, listAllExperience, runDreamOnce } = await import('../../../src/agent/dreaming.js');
const { saveExperienceEntries } = await import('../../../src/agent/episodes.js');

function loadMigrations(): void {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0054_episodes_experience.sql'), 'utf8'));
  db.exec(readFileSync(join(__dirname, '../../../migrations/0057_experience_verify.sql'), 'utf8'));
  db.exec(readFileSync(join(__dirname, '../../../migrations/0058_dreaming.sql'), 'utf8'));
  db.exec(readFileSync(join(__dirname, '../../../migrations/0061_experience_share.sql'), 'utf8'));
}

beforeEach(() => {
  loadMigrations();
  callWithFallbackMock.mockReset();
});

function seed(contents: string[]): number[] {
  saveExperienceEntries(
    contents.map((c, i) => ({
      kind: 'trick',
      content: c,
      tags: ['测试'],
      sourceEpisodeId: i + 1,
    })),
  );
  return db.prepare('SELECT id FROM experience_entries ORDER BY id').all().map((r) => (r as { id: number }).id);
}

describe('parseDreamOutput', () => {
  it('parses clean JSON', () => {
    const raw = JSON.stringify({
      merges: [{ keep_id: 1, remove_ids: [2], merged_content: '合并内容' }],
      conflicts: [{ id_a: 3, id_b: 4, winner_id: 3, resolution: '3 更具体' }],
      drops: [5],
    });
    const r = parseDreamOutput(raw)!;
    expect(r.merges).toHaveLength(1);
    expect(r.merges[0]!.keepId).toBe(1);
    expect(r.conflicts[0]!.winnerId).toBe(3);
    expect(r.drops).toEqual([5]);
  });

  it('returns null on garbage', () => {
    expect(parseDreamOutput('')).toBeNull();
    expect(parseDreamOutput('随便说说')).toBeNull();
  });

  it('tolerates code fence', () => {
    const raw = '```json\n{"merges":[],"conflicts":[],"drops":[1]}\n```';
    expect(parseDreamOutput(raw)!.drops).toEqual([1]);
  });
});

describe('applyDream', () => {
  it('merges duplicate entries (keep + remove)', () => {
    const [a, b] = seed(['写完必须 sendFile 交付', '写文件后要交付给用户']);
    const ops = applyDream(db, {
      merges: [{ keepId: a, removeIds: [b], mergedContent: '写完文件必须 sendFile 交付给用户' }],
      conflicts: [],
      drops: [],
    });
    expect(ops).toBeGreaterThanOrEqual(2);
    const row = db.prepare('SELECT content FROM experience_entries WHERE id = ?').get(a) as { content: string };
    expect(row.content).toContain('合并');
    const gone = db.prepare('SELECT COUNT(*) c FROM experience_entries WHERE id = ?').get(b) as { c: number };
    expect(gone.c).toBe(0);
  });

  it('conflict resolution keeps winner, deletes loser', () => {
    const [a, b] = seed(['先发贴纸再说话', '不要先发贴纸']);
    const ops = applyDream(db, {
      merges: [],
      conflicts: [{ idA: a, idB: b, winnerId: a, resolution: '已证实优先' }],
      drops: [],
    });
    expect(ops).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT content FROM experience_entries WHERE id = ?').get(a) as { content: string };
    expect(row.content).toContain('冲突消解');
    const gone = db.prepare('SELECT COUNT(*) c FROM experience_entries WHERE id = ?').get(b) as { c: number };
    expect(gone.c).toBe(0);
  });

  it('drops low-value entries', () => {
    const [a] = seed(['过时经验']);
    const ops = applyDream(db, { merges: [], conflicts: [], drops: [a] });
    expect(ops).toBe(1);
    const gone = db.prepare('SELECT COUNT(*) c FROM experience_entries WHERE id = ?').get(a) as { c: number };
    expect(gone.c).toBe(0);
  });

  it('FTS stays in sync after merge (content update)', () => {
    const [a, b] = seed(['sendFile 交付经验', 'sendFile 交付经验重复']);
    applyDream(db, { merges: [{ keepId: a, removeIds: [b], mergedContent: 'sendFile 交付合并版' }], conflicts: [], drops: [] });
    // FTS 触发器应在 UPDATE 后同步 content —— 搜合并后特有的词应命中 keep_id
    // (FTS5 unicode61 对中文按连续串分词,用前缀匹配)
    const hits = db.prepare('SELECT rowid FROM experience_fts WHERE experience_fts MATCH ?').all('交付*') as { rowid: number }[];
    expect(hits.some((h) => h.rowid === a)).toBe(true);
    // 被删的 b 不应再出现在 FTS
    const gone = db.prepare('SELECT rowid FROM experience_fts WHERE experience_fts MATCH ?').all('交付*') as { rowid: number }[];
    expect(gone.some((h) => h.rowid === b)).toBe(false);
  });
});

describe('runDreamOnce', () => {
  it('skips when too few entries', async () => {
    seed(['一条']);
    const r = await runDreamOnce(db);
    expect(r).toBeNull();
  });

  it('runs end-to-end with LLM mock', async () => {
    seed(['经验一 写代码前验证', '经验二 写代码前验证重复', '经验三 过时内容', '经验四 独立内容', '经验五 另一条独立']);
    callWithFallbackMock.mockResolvedValue({
      content: JSON.stringify({
        merges: [{ keep_id: 1, remove_ids: [2], merged_content: '写代码前必须验证合并版' }],
        conflicts: [],
        drops: [3],
      }),
    });
    const r = await runDreamOnce(db);
    expect(r).not.toBeNull();
    expect(r!.merges).toHaveLength(1);
    // 应用生效
    const row = db.prepare('SELECT content FROM experience_entries WHERE id = 1').get() as { content: string };
    expect(row.content).toContain('合并版');
    expect(db.prepare('SELECT COUNT(*) c FROM experience_entries').get()).toEqual({ c: 3 });
  });

  it('unparseable output → null, no crash', async () => {
    seed(['经验一', '经验二', '经验三', '经验四', '经验五']);
    callWithFallbackMock.mockResolvedValue({ content: '我不知道' });
    const r = await runDreamOnce(db);
    expect(r).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM experience_entries').get()).toEqual({ c: 5 });
  });
});
