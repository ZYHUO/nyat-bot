/**
 * `findRelevantExperience` 的检索有效性。
 *
 * 2026-09-21：它和 skills 那个是同一种病——按标点切中文等于把整句当一个 token，
 * 而 experience_fts 的写入侧是触发器直接塞 raw content（没有预分词），
 * FTS5 unicode61 把整段中文连续串当一个 token，整句 token 一条都对不上。
 * 存的是「接话前未核对自身此前发言内容…禁止复读上一句…」，
 * 查「接话前要注意不要复读上一句」返回 0 个。
 *
 * 改成 Intl.Segmenter 分词 + LIKE 之后才有结果。lexical.ts 里的 segment()
 * 是这块代码里已验证过的中文分词（memory_fts 两侧都用它）。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));

const { findRelevantExperience } = await import('../../../src/agent/episodes.js');

const BOT = 'hunhebi_bot';

function seed(content: string, tags = '[]'): void {
  db.prepare(
    `INSERT INTO experience_entries (kind, content, tags, origin_bot, verified, created_at)
     VALUES ('lesson', ?, ?, ?, 1, strftime('%s','now'))`,
  ).run(content, tags, BOT);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0071_skills.sql', 'utf8'));
  // experience_entries + 它的 FTS 触发器
  for (const f of readdirMigrations()) {
    if (/experience/.test(f)) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  seed('接话前未核对自身此前发言内容，容易违反「禁止复读上一句」的规则，回复前需先回溯自身近3条发言确认无重复');
  seed('处理群内追问类短回任务时，若未先明确追问的上下文指向就回复，极易出现内容偏离对话语境的问题');
  seed('调用消息发送类工具后必须return执行结果，否则无法确认消息是否成功送达，也造成无效调用');
});

function readdirMigrations(): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  return readdirSync('migrations').filter((f) => f.endsWith('.sql'));
}

describe('findRelevantExperience · 自由文本能检索到', () => {
  it('① 复读相关的查询命中复读那条经验', () => {
    const hits = findRelevantExperience('接话前要注意不要复读上一句', 3, { botId: BOT });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.content).join(' ')).toContain('复读');
  });

  it('② 上下文对齐的查询命中上下文那条', () => {
    const hits = findRelevantExperience('回复前先对齐对话上下文', 3, { botId: BOT });
    expect(hits.map((h) => h.content).join(' ')).toContain('上下文');
  });

  it('③ 工具送达的查询命中送达那条', () => {
    const hits = findRelevantExperience('调用消息发送工具后要确认送达', 3, { botId: BOT });
    expect(hits.map((h) => h.content).join(' ')).toContain('送达');
  });

  it('④ 命中会累加 use_count', () => {
    findRelevantExperience('接话前要注意不要复读上一句', 3, { botId: BOT });
    const rows = db.prepare('SELECT use_count FROM experience_entries WHERE use_count > 0').all() as { use_count: number }[];
    expect(rows.length).toBeGreaterThan(0);
  });

  it('⑤ 空查询不炸', () => {
    expect(findRelevantExperience('', 3, { botId: BOT })).toEqual([]);
    expect(findRelevantExperience('   ', 3, { botId: BOT })).toEqual([]);
  });

  it('⑥ limit 生效', () => {
    const hits = findRelevantExperience('复读 上下文 送达 回复 接话', 2, { botId: BOT });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('⑦ allowShared=false 时只回本 bot 的（别的 bot 的一条都不给）', () => {
    const hits = findRelevantExperience('接话前要注意不要复读上一句', 3, {
      botId: 'other_bot', allowShared: false,
    });
    expect(hits).toEqual([]);
  });

  it('⑦b allowShared=true 时别的 bot 的**已验证**经验也能拿到', () => {
    // 这正是生产的配置：EXPERIENCE_SHARE_ENABLED 开着时，跨 bot 借已验证的教训。
    const hits = findRelevantExperience('接话前要注意不要复读上一句', 3, {
      botId: 'other_bot', allowShared: true,
    });
    expect(hits.length).toBeGreaterThan(0);
  });
});
