import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { extractAliasPairs, recordAlias, getChatAliases, buildAliasInjection, captureAliases } =
  await import('../../../src/knowledge/person-aliases.js');

function initSchema(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0027_person_aliases.sql'), 'utf-8'));
}

describe('person-aliases', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
  });
  afterEach(() => testDb.close());

  describe('extractAliasPairs', () => {
    it('captures 外号/绰号/别名 declarations', () => {
      expect(extractAliasPairs('张三的外号是大佬')).toContainEqual({ subject: '张三', alias: '大佬' });
      expect(extractAliasPairs('李四绰号叫老李')).toContainEqual({ subject: '李四', alias: '老李' });
      expect(extractAliasPairs('王五别名五哥')).toContainEqual({ subject: '王五', alias: '五哥' });
    });

    it('captures 管X叫Y and X又叫Y', () => {
      expect(extractAliasPairs('大家都管赵六叫六子')).toContainEqual({ subject: '赵六', alias: '六子' });
      expect(extractAliasPairs('钱七又叫七爷')).toContainEqual({ subject: '钱七', alias: '七爷' });
    });

    it('rejects pronoun subjects and subject==alias', () => {
      expect(extractAliasPairs('我的外号是猫娘')).toHaveLength(0); // 我 is a stopword
      expect(extractAliasPairs('他又叫他')).toHaveLength(0);
    });

    it('does not fire on casual text', () => {
      expect(extractAliasPairs('今天天气不错啊')).toHaveLength(0);
      expect(extractAliasPairs('我们去吃饭吧')).toHaveLength(0);
    });
  });

  describe('store + inject', () => {
    it('upserts and increments count', () => {
      recordAlias(-100, '张三', '大佬', 1);
      recordAlias(-100, '张三', '大佬', 2);
      const rows = getChatAliases(-100);
      expect(rows).toHaveLength(1);
      const cnt = (testDb.prepare(
        'SELECT count FROM person_aliases WHERE chat_id=-100 AND subject_name=? AND alias=?',
      ).get('张三', '大佬') as { count: number }).count;
      expect(cnt).toBe(2);
    });

    it('captureAliases persists from a message', () => {
      captureAliases(-100, { textContent: '张三的外号是大佬', uid: 5 } as never);
      expect(getChatAliases(-100)).toContainEqual({ subject_name: '张三', alias: '大佬' });
    });

    it('buildAliasInjection groups aliases per subject and caps', () => {
      recordAlias(-100, '张三', '大佬');
      recordAlias(-100, '张三', '三哥');
      recordAlias(-100, '李四', '小李');
      const block = buildAliasInjection(-100);
      expect(block).toContain('张三(外号:');
      expect(block).toContain('大佬');
      expect(block).toContain('三哥');
      expect(block).toContain('李四(外号:小李)');
    });

    it('buildAliasInjection returns null when empty', () => {
      expect(buildAliasInjection(-100)).toBeNull();
    });
  });
});
