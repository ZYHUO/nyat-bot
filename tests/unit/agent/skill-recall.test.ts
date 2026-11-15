/**
 * `findRelevantSkills` 的检索有效性。
 *
 * 为什么专门测这个：2026-09-21 发现它在生产里**一次都没成功过**——
 * `skill recall injected` 日志 0 次。病因是 skills_fts（fts5 外部内容表，默认
 * unicode61 tokenizer）把整段中文连续串当成一个 token，短语查询只有恰好等于
 * 某个字段里的完整串才命中；而 task 的 contentDirection 是自由文本，
 * 永远不可能和 trigger_when/summary 逐字相同。
 *
 * 改成二元组 + LIKE 之后才有结果。这些测试锁的是"自由文本能检索到 skill"，
 * 不是锁某个具体 tokenizer 行为——后者是实现细节，会随换索引方式而变。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));

const { findRelevantSkills, saveSkill } = await import('../../../src/agent/skills.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0071_skills.sql', 'utf8'));
  // 造 4 个 big skill（对应生产里那 4 个）
  saveSkill({ name: '人设群聊接梗', tier: 'big', triggerWhen: '群聊私聊中收到闲聊调侃质疑、技术求助、动作互动或敏感追问需用人设回复时', steps: '1. 判断场合；2. 用人设口吻短回', summary: '用人设口吻接住闲聊调侃技术动作的群聊短回技能', tags: [] });
  saveSkill({ name: '角色语气适配', tier: 'big', triggerWhen: '主人提出明确语气要求、且已注入特定角色设定时', steps: '1. 提取语气要求；2. 用角色口吻转述', summary: '按指定语气用角色口吻转述回应的适配技能', tags: [] });
  saveSkill({ name: '承诺跟踪', tier: 'big', triggerWhen: 'bot 承诺过将来的动作、需要静默检查进展时', steps: '1. 查承诺列表；2. 有变才汇报', summary: '静默检查承诺进展有变才汇报的跟踪技能', tags: [] });
  saveSkill({ name: '社群互动与交付', tier: 'big', triggerWhen: '社群挡箭牌互动与调研止损需要交付结果时', steps: '1. 汇总互动数据；2. 产出交付', summary: '社群挡箭牌互动与调研止损交付技能', tags: [] });
  // 一个已归档的：任何查询都不该返回它
  const archived = saveSkill({ name: '已归档的旧技能', tier: 'small', triggerWhen: '什么时候都不该被检索到', steps: 'x', summary: '归档的不返回', tags: [] })!;
  db.prepare('UPDATE skills SET archived = 1 WHERE id = ?').run(archived);
});

describe('findRelevantSkills · 自由文本能检索到', () => {
  it('① 口语化的 task 方向能命中对应 big skill', () => {
    const hits = findRelevantSkills('回复群友关于节点延迟的调侃，用人设口吻接话', 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.name)).toContain('人设群聊接梗');
  });

  it('② 语气/转述类方向命中语气适配', () => {
    const hits = findRelevantSkills('按主人要求的语气转述回应内容', 2);
    expect(hits.map((h) => h.name)).toContain('角色语气适配');
  });

  it('③ 承诺检查命中承诺跟踪', () => {
    const hits = findRelevantSkills('检查之前承诺的事情有没有进展', 2);
    expect(hits.map((h) => h.name)).toContain('承诺跟踪');
  });

  it('④ 交付类方向命中社群交付', () => {
    const hits = findRelevantSkills('社群挡箭牌互动与调研止损交付', 2);
    expect(hits.map((h) => h.name)).toContain('社群互动与交付');
  });

  it('⑤ 已归档的 skill 永不被返回（哪怕字面全中）', () => {
    const hits = findRelevantSkills('已归档的旧技能 什么时候都不该被检索到', 5);
    expect(hits.map((h) => h.name)).not.toContain('已归档的旧技能');
  });

  it('⑥ 完全无关的查询返回空（不硬凑）', () => {
    expect(findRelevantSkills('量子纠缠对区块链共识机制的影响', 2)).toEqual([]);
  });

  it('⑦ limit 生效', () => {
    const hits = findRelevantSkills('群聊人设语气承诺交付跟踪适配接梗', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('⑧ 命中会累加 use_count（召回计数，与 verified_use_count 是两件事）', () => {
    findRelevantSkills('回复群友关于节点延迟的调侃，用人设口吻接话', 2);
    const rows = db.prepare('SELECT name, use_count FROM skills WHERE use_count > 0').all() as { name: string; use_count: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.use_count).toBeGreaterThan(0);
  });
});
