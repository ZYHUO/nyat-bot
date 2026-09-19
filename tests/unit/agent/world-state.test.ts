import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

const { upsertEntity, findEntities, buildWorldStateBlock, listAllEntities } = await import('../../../src/agent/world-state.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0062_world_entities.sql'), 'utf8'));
});

describe('upsertEntity', () => {
  it('creates and merges properties by name+kind', () => {
    const a = upsertEntity('Sub2API', 'project', { status: '开发中' }, -100123);
    const b = upsertEntity('Sub2API', 'project', { 用户: '500' }, -100123);
    expect(a).toBe(b);
    const row = db.prepare('SELECT properties FROM world_entities WHERE id = ?').get(a) as { properties: string };
    const props = JSON.parse(row.properties);
    expect(props.status).toBe('开发中');
    expect(props.用户).toBe('500');
  });

  it('rejects blank names', () => {
    expect(upsertEntity('   ', 'topic', {})).toBeNull();
  });

  it('different kinds are distinct entities', () => {
    const a = upsertEntity('比特币', 'topic', { 价格: '高' });
    const b = upsertEntity('比特币', 'place', { 位置: '交易所' });
    expect(a).not.toBe(b);
  });
});

describe('findEntities / buildWorldStateBlock', () => {
  it('finds by name LIKE and returns properties', () => {
    upsertEntity('主人的 Sub2API 项目', 'project', { 进度: 'Phase 5' }, -100123);
    const entities = findEntities('Sub2API');
    expect(entities).toHaveLength(1);
    expect(entities[0]!.properties.进度).toBe('Phase 5');
    expect(entities[0]!.sourceChatId).toBe(-100123);
  });

  it('filters by kind', () => {
    upsertEntity('nyat-bot', 'project', {});
    upsertEntity('nyat-bot', 'topic', {});
    expect(findEntities('nyat-bot', 'project')).toHaveLength(1);
    expect(findEntities('nyat-bot', 'topic')).toHaveLength(1);
  });

  it('buildWorldStateBlock includes entity and staleness caveat', () => {
    upsertEntity('追踪话题', 'topic', { 状态: '进行中' });
    const block = buildWorldStateBlock('追踪话题');
    expect(block).toContain('追踪话题');
    expect(block).toContain('状态=进行中');
    expect(block).toContain('以最新聊天为准');
  });

  it('buildWorldStateBlock empty when no match', () => {
    expect(buildWorldStateBlock('不存在的实体xyz')).toBe('');
  });

  it('listAllEntities orders by recency', () => {
    upsertEntity('老实体', 'topic', {});
    upsertEntity('新实体', 'topic', {});
    const all = listAllEntities();
    expect(all[0]!.name).toBe('新实体');
  });
});

describe('entity-name shape guard (2026-09-18 pollution fix)', () => {
  // Background: world_entities was found to contain 2,711 rows that were ALL
  // reply instructions, because callers passed `contentDirection` straight in.
  // Those rows were then rendered into the live prompt as "[相关世界实体]".
  // These tests pin the guard so the pollution cannot come back.

  it('accepts real entity names', () => {
    for (const name of ['Rust', '显示器选购', '@awei', 'Sub2API', '喵团子']) {
      expect(upsertEntity(name, 'topic', {}), name).not.toBeNull();
    }
  });

  it('rejects reply instructions', () => {
    const instructions = [
      '@a76526 用 reply+@ 点了你上一句 #80208「是你们这群人思想太不纯洁了喵～」。针对那句短评/接话，禁止空问候（在呢/怎么啦/啥事）。',
      '回应主人上一条消息，简短自然接一句 禁止复读自己上一句。',
      '短回 #153465。短接话，自然延续 禁止复读自己上一句。',
      '先弄清对方这一句和你上一句的关系再回',
    ];
    for (const text of instructions) {
      expect(upsertEntity(text, 'topic', {}), text.slice(0, 30)).toBeNull();
    }
    expect(db.prepare('SELECT count(*) c FROM world_entities').get()).toMatchObject({ c: 0 });
  });

  it('rejects over-long names and newline/markdown-shaped text', () => {
    expect(upsertEntity('x'.repeat(81), 'topic', {})).toBeNull();
    expect(upsertEntity('正常名字\n第二行', 'topic', {})).toBeNull();
    expect(upsertEntity('话题 #123 引用', 'topic', {})).toBeNull();
  });

  it('accepts a real long group title (needs headroom past 40 chars)', () => {
    // Measured against the 2,710 polluted rows from the 2026-09-18 backup: the
    // shape rules reject 100% of them at every limit 40..80, so the cap can stay
    // generous enough for genuine chat titles.
    const title = 'Uzumaru公群 | 音游交流群版 🔥东南亚上押1920U 不灵不开 灵车狂欢';
    expect(title.length).toBeGreaterThan(40);
    expect(upsertEntity(title, 'place', { type: 'supergroup' }, -1003184176508)).not.toBeNull();
  });

  it('still allows a legitimate short topic to be written and read back', () => {
    expect(upsertEntity('显示器选购', 'topic', { 状态: '讨论中' }, -100123)).not.toBeNull();
    const block = buildWorldStateBlock('显示器选购');
    expect(block).toContain('显示器选购');
  });
});
