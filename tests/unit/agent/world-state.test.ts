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
