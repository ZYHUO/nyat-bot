import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { segment, chatToken, upsertLexical, insertLexicalBatch, deleteLexical, searchLexical } =
  await import('../../../src/memory/lexical.js');

let db: Database.Database;

const GROUP = -100123;
const DM = 100123;          // 与 GROUP 绝对值相同 —— 用来钉住 chatToken 的正负区分
const OTHER = -999888;

const DOCS: Array<[number, string, string]> = [
  [GROUP, 'g1', '我今天下午去打篮球了'],
  [GROUP, 'g2', '这家店的拉面特别好吃'],
  [GROUP, 'g3', '帮我查一下比特币现在的价格'],
  [GROUP, 'g4', '他昨天说他要换工作'],
  [DM,    'd1', '我也想去打篮球'],
  [OTHER, 'o1', '这个显卡驱动装不上'],
];

function ids(rows: Array<{ chromaId: string }>): string[] {
  return rows.map((r) => r.chromaId);
}

describe('memory lexical (FTS5 BM25 旁路)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(readFileSync(resolve(process.cwd(), 'migrations/0051_memory_fts.sql'), 'utf-8'));
    insertLexicalBatch(db, DOCS.map(([chatId, chromaId, text]) => ({ chatId, chromaId, text })));
  });
  afterEach(() => db.close());

  describe('segment', () => {
    it('把中文切成词而不是整句一个 token', () => {
      expect(segment('我今天下午去打篮球了').split(' ')).toContain('篮球');
    });
    it('丢掉标点与空白', () => {
      expect(segment('好吃！！！')).toBe('好吃');
      expect(segment('   ')).toBe('');
    });
    it('英文数字照常切', () => {
      expect(segment('装了 CUDA 12.4').split(' ')).toContain('CUDA');
    });
  });

  describe('chatToken', () => {
    it('区分正负 —— unicode61 会吃掉减号,群 -100123 与 DM 100123 不能撞车', () => {
      expect(chatToken(GROUP)).not.toBe(chatToken(DM));
    });
  });

  describe('检索', () => {
    // 这条是本设计存在的理由:FTS5 内置 trigram 需要 ≥3 字符,双字词返回空,
    // 而中文双字词最常见。改成先分词再 unicode61 才有这个能力。
    it('双字词能命中(trigram 分词器在这里会返回空)', () => {
      expect(ids(searchLexical(db, GROUP, '篮球', 5))).toContain('g1');
      expect(ids(searchLexical(db, GROUP, '拉面', 5))).toContain('g2');
      expect(ids(searchLexical(db, GROUP, '工作', 5))).toContain('g4');
    });

    it('三字专名能命中', () => {
      expect(ids(searchLexical(db, GROUP, '比特币', 5))).toContain('g3');
    });

    it('整句 query 也能落到正确的那条', () => {
      expect(ids(searchLexical(db, GROUP, '昨天他说想换个工作', 5))).toContain('g4');
    });

    it('按群隔离 —— 不串到别的群', () => {
      expect(ids(searchLexical(db, OTHER, '篮球', 5))).toEqual([]);
      expect(ids(searchLexical(db, GROUP, '显卡', 5))).toEqual([]);
    });

    it('正负 chatId 绝对值相同也不串', () => {
      expect(ids(searchLexical(db, DM, '篮球', 5))).toEqual(['d1']);
      expect(ids(searchLexical(db, GROUP, '篮球', 5))).toEqual(['g1']);
    });

    it('尊重 topK', () => {
      expect(searchLexical(db, GROUP, '我 的 了', 2).length).toBeLessThanOrEqual(2);
    });

    it('空 / 纯符号 query 安全返回空,不抛', () => {
      expect(searchLexical(db, GROUP, '', 5)).toEqual([]);
      expect(searchLexical(db, GROUP, '！！！', 5)).toEqual([]);
    });

    it('FTS5 查询语法字符不会被当语法解析', () => {
      expect(() => searchLexical(db, GROUP, 'AND OR NEAR* "x"', 5)).not.toThrow();
    });
  });

  describe('写入与删除', () => {
    it('upsertLexical 重复写同一 id 不产生重复行', () => {
      upsertLexical(db, 'g1', GROUP, '我今天下午去打篮球了');
      upsertLexical(db, 'g1', GROUP, '我今天下午去打篮球了');
      expect(ids(searchLexical(db, GROUP, '篮球', 10)).filter((x) => x === 'g1')).toHaveLength(1);
    });

    it('upsertLexical 覆盖旧内容', () => {
      upsertLexical(db, 'g1', GROUP, '改成聊显卡了');
      expect(ids(searchLexical(db, GROUP, '篮球', 5))).not.toContain('g1');
      expect(ids(searchLexical(db, GROUP, '显卡', 5))).toContain('g1');
    });

    it('空文本不写入', () => {
      upsertLexical(db, 'empty', GROUP, '！！！');
      expect(db.prepare('SELECT COUNT(*) c FROM memory_fts WHERE chroma_id = ?').get('empty')).toEqual({ c: 0 });
    });

    // 遗忘 cron 删 Qdrant 时必须同步删这里,否则 BM25 会一直召回已被遗忘的记忆。
    it('deleteLexical 删掉后不再被召回', () => {
      deleteLexical(db, ['g1']);
      expect(ids(searchLexical(db, GROUP, '篮球', 5))).toEqual([]);
    });

    it('deleteLexical 空数组是 no-op', () => {
      expect(deleteLexical(db, [])).toBe(0);
    });
  });
});
