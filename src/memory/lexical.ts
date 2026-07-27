// ────────────────────────────────────────
// 长期记忆的词法(BM25)旁路 — SQLite FTS5
// ────────────────────────────────────────
// 384 维小模型对**专有名词、群内黑话、ID、型号**天然弱,而 jargon-miner 挖出来的
// 恰恰是这类词。向量召回之外并一路 BM25,再用 RRF 融合(见 fusion.ts)。
//
// 中文分词的坑(生产机实测):FTS5 内置的 `trigram` 分词器需要 ≥3 字符,
// 「篮球」「拉面」这类双字词**查不到**(返回空),而中文双字词恰恰最常见。
// 改用 Node 22 内置的 Intl.Segmenter 先分词、空格拼接后交给 `unicode61`,
// 查询侧用同一个分词器 → 两侧切法一致,「篮球/拉面/比特币/工作」实测全部命中。
// 零依赖(ICU 随 Node 自带),不引 nodejieba 之类的原生模块。
// ────────────────────────────────────────

import type { Database } from 'better-sqlite3';
import { logger } from '../shared/logger.js';

/** 分词器单例 —— 构造 Intl.Segmenter 不便宜,别放进热路径循环里。 */
let _seg: Intl.Segmenter | undefined;
function segmenter(): Intl.Segmenter {
  _seg ??= new Intl.Segmenter('zh-CN', { granularity: 'word' });
  return _seg;
}

/**
 * 文本 → 空格分隔的词序列。写入与查询**必须**共用本函数,否则两侧切法不一致就永远匹配不上。
 * (ICU 词典外的词会被切成单字 —— 例如「比特币」→ 比/特/币 —— 但只要两侧一致就仍能命中。)
 */
export function segment(text: string): string {
  const out: string[] = [];
  for (const s of segmenter().segment(text)) {
    if (s.isWordLike) out.push(s.segment);
  }
  return out.join(' ');
}

/**
 * chatId → FTS 可索引的 token。unicode61 会把 `-` 当分隔符吃掉,所以负数群 id
 * 直接存会和正数 DM id 撞车(-100123 与 100123 同为 token "100123")。用 n/p 前缀区分。
 */
export function chatToken(chatId: number): string {
  return `c${chatId < 0 ? 'n' : 'p'}${Math.abs(chatId)}`;
}

/**
 * 每个 token 转成 FTS5 的带引号字符串,避免分词结果里的字符被当查询语法解析
 * (AND、OR、NEAR、冒号、星号都是 FTS5 的保留写法)。
 * 用 JSON.stringify 而不是手工拼引号 —— 它同时处理了转义。
 */
function quoteTerms(seg: string): string[] {
  return seg.split(' ').filter(Boolean).map((t) => JSON.stringify(t));
}

/** 写入/更新一条。先删后插 —— FTS5 没有 upsert 语义。 */
export function upsertLexical(db: Database, chromaId: string, chatId: number, text: string): void {
  const seg = segment(text);
  if (!seg) return;
  db.prepare('DELETE FROM memory_fts WHERE chroma_id = ?').run(chromaId);
  db.prepare('INSERT INTO memory_fts(chroma_id, chat, seg) VALUES (?, ?, ?)')
    .run(chromaId, chatToken(chatId), seg);
}

/** 批量写(回填用)。调用方负责包 transaction。 */
export function insertLexicalBatch(
  db: Database,
  rows: Array<{ chromaId: string; chatId: number; text: string }>,
): number {
  const del = db.prepare('DELETE FROM memory_fts WHERE chroma_id = ?');
  const ins = db.prepare('INSERT INTO memory_fts(chroma_id, chat, seg) VALUES (?, ?, ?)');
  let n = 0;
  for (const r of rows) {
    const seg = segment(r.text);
    if (!seg) continue;
    del.run(r.chromaId);
    ins.run(r.chromaId, chatToken(r.chatId), seg);
    n++;
  }
  return n;
}

/**
 * 删除。**必须**与 deleteMemories(遗忘 cron)同步调用,否则 Qdrant 删了、FTS 还留着,
 * 索引单向泄漏,BM25 会持续召回已被遗忘的记忆。
 */
export function deleteLexical(db: Database, chromaIds: string[]): number {
  if (chromaIds.length === 0) return 0;
  const del = db.prepare('DELETE FROM memory_fts WHERE chroma_id = ?');
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) del.run(id);
  });
  tx(chromaIds);
  return chromaIds.length;
}

/** BM25 检索,返回按相关度升序的 chroma_id(FTS5 rank 越小越相关)。 */
export function searchLexical(
  db: Database,
  chatId: number,
  query: string,
  topK: number,
): Array<{ chromaId: string; rank: number }> {
  const terms = quoteTerms(segment(query));
  if (terms.length === 0) return [];
  // chat 是被索引列 → 走 FTS 自身的倒排,而不是先全表 MATCH 再过滤。
  const match = `chat : ${chatToken(chatId)} AND seg : (${terms.join(' OR ')})`;
  try {
    return db
      .prepare('SELECT chroma_id AS chromaId, rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?')
      .all(match, topK) as Array<{ chromaId: string; rank: number }>;
  } catch (err) {
    // 查询语法异常不该拖垮回复链路 —— 词法路只是向量路的补充。
    logger.debug({ err, chatId }, 'lexical search failed (non-critical)');
    return [];
  }
}
