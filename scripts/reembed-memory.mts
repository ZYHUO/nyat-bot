// One-time migration: 用新的嵌入模型把整个记忆库重嵌入到**另一个** collection。
//
// 为什么不就地回填:新旧向量空间不兼容,就地改会让 collection 在整个回填期间处于
// 新旧混合状态 —— 检索结果比不改还乱。灌进新库、点数校验通过后再用 MEMORY_COLLECTION
// 切换,旧库原封不动留作回滚。
//
// 顺带灌 memory_fts(BM25 旁路)—— 分词不需要模型,和这一趟 scroll 合并做掉,
// 省一次 10 万点的全量扫描。
//
// 用法:
//   npx tsx scripts/reembed-memory.mts --probe                     # 只看样本,不写
//   npx tsx scripts/reembed-memory.mts                             # 全量
//   npx tsx scripts/reembed-memory.mts --resume                    # 断点续跑
//   nice -n 19 npx tsx scripts/reembed-memory.mts --sleep=80       # 让出 CPU 给生产 bot
import { QdrantClient } from '@qdrant/js-client-rest';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { insertLexicalBatch } from '../src/memory/lexical.js';

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const SOURCE = flag('source', 'xxb_group_history');
const TARGET = flag('target', 'xxb_group_history_v2');
const MODEL = flag('model', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
const BATCH = parseInt(flag('batch', '256'), 10);
const SLEEP_MS = parseInt(flag('sleep', '50'), 10);
const DB_PATH = flag('db', 'data/xxb.db');
const VECTOR_SIZE = 384;
const PROGRESS = '/tmp/reembed-memory.progress.json';

const probe = has('probe');
const resume = has('resume');
const withFts = !has('no-fts');

const qdrant = new QdrantClient({
  host: process.env['QDRANT_HOST'] ?? '127.0.0.1',
  port: parseInt(process.env['QDRANT_PORT'] ?? '6333', 10),
  https: false,
});

// ── 前置检查 ────────────────────────────────────────────────
const { collections } = await qdrant.getCollections();
if (!collections.some((c) => c.name === SOURCE)) {
  console.error(`源 collection 不存在: ${SOURCE}`);
  process.exit(1);
}
const srcInfo = await qdrant.getCollection(SOURCE);
const srcCount = srcInfo.points_count ?? 0;
console.log(`源 ${SOURCE}: ${srcCount} points, dim=${(srcInfo.config?.params?.vectors as { size?: number })?.size}`);

const targetExists = collections.some((c) => c.name === TARGET);
if (targetExists && !resume && !probe) {
  console.error(`目标 collection 已存在: ${TARGET}\n重跑请先删除,或加 --resume 续跑。`);
  process.exit(1);
}

// ── 载入新模型 ──────────────────────────────────────────────
console.log(`加载模型 ${MODEL} …(首次会下载约 120MB 到 ~/.cache/huggingface)`);
const { pipeline } = await import('@xenova/transformers');
const extractor = await pipeline('feature-extraction', MODEL, { progress_callback: undefined });
const embedOne = async (t: string): Promise<number[]> => {
  const out = await extractor(t.slice(0, 512), { pooling: 'mean', normalize: true });
  return Array.from(out.data as Float32Array);
};

// 维度自检:模型换错(比如挑了个 768 维的)会在这里当场炸,而不是灌完 10 万条才发现。
const probeVec = await embedOne('维度自检');
if (probeVec.length !== VECTOR_SIZE) {
  console.error(`模型维度不符: ${MODEL} 输出 ${probeVec.length} 维,collection 要求 ${VECTOR_SIZE} 维。`);
  console.error('换维度就不是本脚本能处理的了 —— collection 配置也要一起改。');
  process.exit(1);
}
console.log(`维度自检通过: ${probeVec.length}`);

// ── probe:只看样本 ─────────────────────────────────────────
if (probe) {
  const [pts] = await qdrant.scroll(SOURCE, { limit: 3, with_payload: true, with_vector: false }).then((r) => [r.points]);
  for (const p of pts ?? []) {
    const pl = (p.payload ?? {}) as Record<string, unknown>;
    console.log(`  id=${String(p.id).slice(0, 12)}… chatId=${pl['chatId']} text=${String(pl['text']).slice(0, 40)}`);
  }
  console.log('probe 结束,未写入任何东西。');
  process.exit(0);
}

// ── 建目标 collection(与源完全同配置)──────────────────────
if (!targetExists) {
  await qdrant.createCollection(TARGET, {
    vectors: { size: VECTOR_SIZE, distance: 'Cosine', on_disk: true },
    quantization_config: { scalar: { type: 'int8', quantile: 0.99, always_ram: true } },
  });
  await qdrant.createPayloadIndex(TARGET, { field_name: 'chatId', field_schema: 'integer', wait: true });
  await qdrant.createPayloadIndex(TARGET, { field_name: 'uid', field_schema: 'integer', wait: true });
  console.log(`目标 collection 已建: ${TARGET}`);
}

// ── FTS 表(与 migrations/0051 同 DDL,幂等)────────────────
const db = withFts ? new Database(DB_PATH) : undefined;
if (db) {
  db.pragma('journal_mode = WAL');
  // 生产 bot 正拿着同一个库的写锁。WAL 只允许单写者,批量事务撞上它会立刻 SQLITE_BUSY。
  // 给足退避时间,宁可这个离线脚本等,也不要让它把回填做崩、或反过来拖慢线上写入。
  db.pragma('busy_timeout = 15000');
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(chroma_id UNINDEXED, chat, seg, tokenize='unicode61')",
  );
}

// ── 回填 ────────────────────────────────────────────────────
type Progress = { offset: string | number | null; done: number; skipped: number; fts: number };
let prog: Progress = { offset: null, done: 0, skipped: 0, fts: 0 };
if (resume && existsSync(PROGRESS)) {
  prog = JSON.parse(readFileSync(PROGRESS, 'utf8')) as Progress;
  console.log(`续跑:已完成 ${prog.done},从 offset=${String(prog.offset).slice(0, 12)}… 继续`);
}

const started = Date.now();
for (;;) {
  const res = await qdrant.scroll(SOURCE, {
    limit: BATCH,
    offset: prog.offset ?? undefined,
    with_payload: true,
    with_vector: false,
  });
  const points = res.points ?? [];
  if (points.length === 0) break;

  const upserts: Array<{ id: string | number; vector: number[]; payload: Record<string, unknown> }> = [];
  const ftsRows: Array<{ chromaId: string; chatId: number; text: string }> = [];

  for (const p of points) {
    const payload = (p.payload ?? {}) as Record<string, unknown>;
    const text = payload['text'];
    // 没有原文就无法重嵌入 —— 计数报告,不静默丢弃。
    if (typeof text !== 'string' || !text.trim()) { prog.skipped++; continue; }
    upserts.push({ id: p.id, vector: await embedOne(text), payload });
    const mid = payload['mid'];
    const chatId = payload['chatId'];
    if (typeof mid === 'string' && typeof chatId === 'number') {
      ftsRows.push({ chromaId: mid, chatId, text });
    }
  }

  if (upserts.length > 0) {
    await qdrant.upsert(TARGET, { wait: false, points: upserts });
    prog.done += upserts.length;
  }
  if (db && ftsRows.length > 0) {
    const tx = db.transaction((rows: typeof ftsRows) => insertLexicalBatch(db, rows));
    prog.fts += tx(ftsRows);
  }

  prog.offset = (res.next_page_offset as string | number | null) ?? null;
  writeFileSync(PROGRESS, JSON.stringify(prog));

  const pct = srcCount ? ((prog.done / srcCount) * 100).toFixed(1) : '?';
  const rate = prog.done / ((Date.now() - started) / 1000);
  const eta = rate > 0 ? Math.round((srcCount - prog.done) / rate) : 0;
  console.log(`  ${prog.done}/${srcCount} (${pct}%) fts=${prog.fts} skip=${prog.skipped} ~${rate.toFixed(0)}/s ETA ${Math.floor(eta / 60)}m${eta % 60}s`);

  if (prog.offset === null) break;
  // 让出 CPU:这台机器同时在跑生产 bot,嵌入是纯 CPU 活。
  if (SLEEP_MS > 0) await new Promise((r) => setTimeout(r, SLEEP_MS));
}

// ── 校验 ────────────────────────────────────────────────────
// upsert 用的 wait:false,Qdrant 索引是异步的 —— 立刻查会少数。轮询到稳定为止。
let tgtCount = 0;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  tgtCount = (await qdrant.getCollection(TARGET)).points_count ?? 0;
  if (tgtCount >= prog.done) break;
}

console.log('\n──────── 结果 ────────');
console.log(`源 ${SOURCE}:      ${srcCount}`);
console.log(`目标 ${TARGET}:    ${tgtCount}`);
console.log(`已重嵌入:          ${prog.done}`);
console.log(`无原文跳过:        ${prog.skipped}`);
console.log(`FTS 行:            ${prog.fts}`);
console.log(`耗时:              ${Math.round((Date.now() - started) / 1000)}s`);

const ok = tgtCount === prog.done && prog.done + prog.skipped >= srcCount;
if (ok) {
  unlinkSync(PROGRESS);
  console.log('\n✅ 校验通过。切换方式(改 .env 后重启):');
  console.log(`   MEMORY_EMBED_MODEL=${MODEL}`);
  console.log(`   MEMORY_COLLECTION=${TARGET}`);
  console.log(`   回滚:删掉这两行重启即可,${SOURCE} 全程未被改动。`);
} else {
  console.error('\n❌ 点数对不上 —— 不要切换。进度文件已保留,可 --resume 续跑。');
  process.exitCode = 1;
}
db?.close();
