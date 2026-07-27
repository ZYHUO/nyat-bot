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
//   npx tsx scripts/reembed-memory.mts                             # 全量(10 万条约 90 分钟)
//   npx tsx scripts/reembed-memory.mts --resume                    # 断点续跑
//   npx tsx scripts/reembed-memory.mts --delta                     # 只补目标缺的(几十条约 1 分钟)
//   npx tsx scripts/reembed-memory.mts --fts-only --source=v2 --target=v2
//                                                                 # 只补/对齐 FTS(开 hybrid 前用)
//   taskset -c 0-3 nice -n 19 npx tsx ... --sleep=80               # 让出 CPU 给生产 bot
//
// ⚠️ 限制 CPU 时 taskset 不够:ONNX Runtime 会给自己线程池里的线程**单独设**亲和性,
// 覆盖掉从父进程继承的掩码。实测 8 核机器上 `nice -n 19 taskset -c 0-2` 仍吃到 548% CPU,
// 有线程跑在掩码外的核 7 上。补救是对**运行中**的进程再来一次 `taskset -acp 0-3 <pid>`
// (-a 才作用于全部线程),但新生成的线程还会跑掉 —— 要彻底管住得用 cgroup:
//   systemd-run --scope -p CPUQuota=300% -- npx tsx scripts/reembed-memory.mts ...
// nice 本身是生效的,所以生产 bot 始终有优先级;高 load average 主要是观感问题。
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
/**
 * 增量模式:只补目标库里缺的点。
 *
 * 用途 —— 回填是一次性快照,而 bot 在回填期间仍在往**旧库**写。切换完成后,
 * 「回填开始 → 切换生效」这段窗口内的记忆只存在于旧库,新库检索不到。
 * 全量重跑虽然幂等但要 90 分钟,而缺口通常只有几十条。
 *
 * 做法:scroll 时不嵌入,先按 id 批量 retrieve 目标库,只对**确实缺失**的那些
 * 做 embed + upsert。scroll 本身不算贵(不取向量),嵌入才是瓶颈。
 */
const delta = has('delta');
/**
 * 只补 FTS 词法索引,完全跳过嵌入与 Qdrant 写入。
 *
 * 用途 —— memorizeMessage 里写 FTS 那一步受 MEMORY_HYBRID_ENABLED 门控,所以
 * "回填完成 → 开启混合检索" 这段窗口内写入的记忆,向量有、词法索引没有,BM25
 * 那一路对它们是盲的。--delta 帮不上忙:它只处理目标库**缺失**的点,而这些点
 * 在向量库里是存在的。scroll 不取向量、不加载模型,10 万条约 1-2 分钟。
 */
const ftsOnly = has('fts-only');

const qdrant = new QdrantClient({
  host: process.env['QDRANT_HOST'] ?? '127.0.0.1',
  port: parseInt(process.env['QDRANT_PORT'] ?? '6333', 10),
  https: false,
});

/**
 * Qdrant 调用重试。实测在长回填里会撞上 `fetch failed / EPIPE` —— Qdrant 关掉了
 * keep-alive 连接,而 undici 的连接池复用了那个已死的 socket。这是连接层的瞬时故障,
 * 重试即可;没有它,跑到一半崩掉就得靠 --resume 人工续,几十分钟的任务几乎必然中断。
 */
async function withRetry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = 500 * 2 ** i;
      console.warn(`  ⚠ ${what} 失败(第 ${i + 1}/${attempts} 次),${wait}ms 后重试: ${String(err).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

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
// --delta 的**前提**就是目标已存在(它只补缺失),所以这里必须放行,否则增量模式永远跑不了。
if (targetExists && !resume && !probe && !delta && !ftsOnly) {
  console.error(`目标 collection 已存在: ${TARGET}\n重跑请先删除,或加 --resume 续跑,或加 --delta 只补缺失。`);
  process.exit(1);
}
if (delta && !targetExists) {
  console.error(`--delta 需要目标 collection 已存在,但 ${TARGET} 不存在。先跑一次全量。`);
  process.exit(1);
}

// ── 载入新模型(--fts-only 不需要)────────────────────────────
if (!ftsOnly) console.log(`加载模型 ${MODEL} …(首次会下载约 120MB 到 ~/.cache/huggingface)`);
let embedOne: (t: string) => Promise<number[]> = async () => [];
if (!ftsOnly) {
  const { pipeline } = await import('@xenova/transformers');
  const extractor = await pipeline('feature-extraction', MODEL, { progress_callback: undefined });
  embedOne = async (t: string): Promise<number[]> => {
    const out = await extractor(t.slice(0, 512), { pooling: 'mean', normalize: true });
    return Array.from(out.data as Float32Array);
  };
}

// 维度自检:模型换错(比如挑了个 768 维的)会在这里当场炸,而不是灌完 10 万条才发现。
const probeVec = ftsOnly ? new Array(VECTOR_SIZE) : await embedOne('维度自检');
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
if (!targetExists && !ftsOnly) {
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
type Progress = { offset: string | number | null; done: number; skipped: number; fts: number; existing: number };
let prog: Progress = { offset: null, done: 0, skipped: 0, fts: 0, existing: 0 };
if (resume && existsSync(PROGRESS)) {
  prog = JSON.parse(readFileSync(PROGRESS, 'utf8')) as Progress;
  console.log(`续跑:已完成 ${prog.done},从 offset=${String(prog.offset).slice(0, 12)}… 继续`);
}

const started = Date.now();
/** --fts-only 对账用:本次 scroll 见到的全部 mid。见到的之外都是孤儿。 */
const seenMids = ftsOnly ? new Set<string>() : undefined;
for (;;) {
  const res = await withRetry('scroll', () => qdrant.scroll(SOURCE, {
    limit: BATCH,
    offset: prog.offset ?? undefined,
    with_payload: true,
    with_vector: false,
  }));
  const points = res.points ?? [];
  if (points.length === 0) break;

  const upserts: Array<{ id: string | number; vector: number[]; payload: Record<string, unknown> }> = [];
  const ftsRows: Array<{ chromaId: string; chatId: number; text: string }> = [];

  // 增量:先问目标库这一批里哪些已经有了,只处理缺的。retrieve 不返回向量,很便宜。
  let todo = points;
  if (delta) {
    const existing = await withRetry('retrieve', () =>
      qdrant.retrieve(TARGET, { ids: points.map((p) => p.id), with_payload: false, with_vector: false }));
    const have = new Set(existing.map((p) => String(p.id)));
    todo = points.filter((p) => !have.has(String(p.id)));
    // 与 skipped(缺原文)分开计:两者含义完全不同,混在一起报表就没法读。
    prog.existing += points.length - todo.length;
  }

  for (const p of todo) {
    const payload = (p.payload ?? {}) as Record<string, unknown>;
    const text = payload['text'];
    // 没有原文就无法重嵌入 —— 计数报告,不静默丢弃。
    if (typeof text !== 'string' || !text.trim()) { prog.skipped++; continue; }
    if (!ftsOnly) upserts.push({ id: p.id, vector: await embedOne(text), payload });
    const mid = payload['mid'];
    const chatId = payload['chatId'];
    if (typeof mid === 'string' && typeof chatId === 'number') {
      ftsRows.push({ chromaId: mid, chatId, text });
      seenMids?.add(mid);
    }
  }

  if (upserts.length > 0) {
    await withRetry('upsert', () => qdrant.upsert(TARGET, { wait: false, points: upserts }));
    prog.done += upserts.length;
  } else if (ftsOnly) {
    prog.done += todo.length;
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

// ── 对账(仅 --fts-only)────────────────────────────────────
// 遗忘 cron 删 Qdrant 时同步删 FTS 那一步受 MEMORY_HYBRID_ENABLED 门控;flag 关着的
// 期间删掉的记忆会在 FTS 里留下孤儿行。孤儿不会导致错误(回 Qdrant 取 payload 取空后
// 被静默滤掉),但会白占 BM25 的名额,而且这个偏差只增不减、越攒越久越难查。
let orphans = 0;
if (ftsOnly && db && seenMids) {
  const all = db.prepare('SELECT chroma_id FROM memory_fts').all() as Array<{ chroma_id: string }>;
  const dead = all.map((r) => r.chroma_id).filter((id) => !seenMids.has(id));
  if (dead.length > 0) {
    const del = db.prepare('DELETE FROM memory_fts WHERE chroma_id = ?');
    const tx = db.transaction((ids: string[]) => { for (const id of ids) del.run(id); });
    tx(dead);
    orphans = dead.length;
  }
  console.log(`对账:FTS ${all.length} 行,向量库已无对应的孤儿 ${orphans} 行已删`);
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
console.log(`模式:              ${ftsOnly ? 'fts-only(只补词法索引)' : delta ? 'delta(只补缺失)' : 'full(全量)'}`);
console.log(`源 ${SOURCE}:      ${srcCount}`);
console.log(`目标 ${TARGET}:    ${tgtCount}`);
console.log(`本次写入:          ${prog.done}`);
if (delta) console.log(`已存在跳过:        ${prog.existing}`);
console.log(`无原文跳过:        ${prog.skipped}`);
console.log(`FTS 行:            ${prog.fts}`);
if (ftsOnly) console.log(`孤儿清理:          ${orphans}`);
console.log(`耗时:              ${Math.round((Date.now() - started) / 1000)}s`);

// 全量:目标点数应等于本次写入。增量:目标已含存量,只要覆盖到源的全部即可。
const ok = ftsOnly
  ? prog.fts > 0 || srcCount === 0
  : delta
    ? prog.done + prog.existing + prog.skipped >= srcCount
    : tgtCount === prog.done && prog.done + prog.skipped >= srcCount;
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
