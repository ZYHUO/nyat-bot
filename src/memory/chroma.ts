// ────────────────────────────────────────
// 长期记忆向量库客户端 (Qdrant-backed)
// ────────────────────────────────────────
// - 写入：fire-and-forget，消息进 pipeline 后异步存入
// - 读取：语义搜索，填 retriever.ts 的 semantic 路
// - Embedding：@xenova/transformers 本地模型 (384-dim)，无外部 API。模型由
//   MEMORY_EMBED_MODEL 指定 —— 默认的 all-MiniLM-L6-v2 是**英文单语**模型，对中文
//   实测同义/无关区分度仅 0.14(无关句对 0.72 高于英文同义句对 0.70)，即检索结果
//   接近随机；paraphrase-multilingual-MiniLM-L12-v2 同为 384 维、区分度 0.56。
//   换模型必须整库重嵌入(新旧向量空间不兼容)——见 scripts/reembed-memory.ts，
//   灌进新 collection 再用 MEMORY_COLLECTION 切换，旧库留作回滚。
// - 存储：Qdrant (HNSW + cosine)，进程外但内存/性能远优于旧的 Chroma Python 服务
//   迁移自 ChromaDB；点 id = UUIDv5(`${chatId}_${messageId}`) 以满足 Qdrant id 约束。
// ────────────────────────────────────────

import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import type { FormattedMessage } from '../shared/types.js';
import { logger } from '../shared/logger.js';
import { defaultVisibilityForChat, scrubMemoryHits, type MemoryVisibility } from './visibility.js';
import { incrCounter } from '../metrics/registry.js';
import { env } from '../env.js';

/**
 * A semantic-search result carrying its relevance score (0..1, higher = closer).
 * Qdrant returns cosine similarity directly (normalized embeddings ⇒ ~[0,1]); we
 * clamp it to [0,1]. Optional so callers that don't need it can ignore it.
 */
export type ScoredMessage = FormattedMessage & {
  score?: number;
  /** 机制1:记忆级 visibility 与来源会话(跨上下文召回时 scrub 用)。 */
  visibility?: MemoryVisibility;
  sourceChatId?: number | null;
};

const QDRANT_HOST = process.env['QDRANT_HOST'] ?? '127.0.0.1';
const QDRANT_PORT = parseInt(process.env['QDRANT_PORT'] ?? '6333', 10);
const VECTOR_SIZE = 384;
/** 去重查询的硬超时。写入是 fire-and-forget,但仍然跑在消息处理的任务里。 */
const DEDUP_TIMEOUT_MS = 300;
/** 混合检索时每一路的超取倍数 —— 融合后才截到 topK,单路取满 topK 会让融合无从选择。 */
const HYBRID_OVERFETCH = 2;

/**
 * Collection 名走 env,好让"重嵌入到新库 → 切换 → 保留旧库回滚"成为改一行配置的事。
 * 读取点都走这个函数(而不是模块常量),这样测试 mock env() 就能生效;运行时改动需重启,
 * 因为 getStore() 会把首次解析的结果连同 client 一起 memo 住。
 */
function collectionName(): string {
  return env().MEMORY_COLLECTION;
}

// Deterministic mid → Qdrant point id. Qdrant ids must be uint64 or UUID, but our
// natural key is the string `${chatId}_${messageId}`, so map it to a stable UUIDv5
// (no external dep). memorizeMessage + deleteMemories + the migration all agree.
const ID_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'); // RFC4122 URL ns
export function midToPointId(mid: string): string {
  const h = Buffer.from(
    createHash('sha1').update(ID_NAMESPACE).update(mid, 'utf8').digest().subarray(0, 16),
  );
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC4122 variant
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// Lazy singletons
let _client: QdrantClient | undefined;
let _ready: Promise<QdrantClient> | undefined;
let _embedder: ((texts: string[]) => Promise<number[][]>) | undefined;
// Promise singleton: concurrent callers await the same load; errors clear it so next call retries
let _embedderPromise: Promise<(texts: string[]) => Promise<number[][]>> | undefined;

// Embedding cache. The same text often gets embedded twice within a single
// pipeline run — once for memorizeMessage (fire-and-forget write), once when
// searchMemory uses similar query text. Local CPU embedding is ~10-50ms per
// call, so caching cuts that. TTL keeps memory bounded; LRU drops cold keys.
const EMBED_CACHE_MAX = 200;
const EMBED_CACHE_TTL_MS = 5 * 60 * 1000;
const _embedCache = new LRUCache<string, number[]>({
  max: EMBED_CACHE_MAX,
  ttl: EMBED_CACHE_TTL_MS,
});

// ── Embedder (local, lazy-loaded) ────────────────────────

/**
 * 启动预热:把 ONNX session init(~23MB 量化模型,冷缓存时还要下载)从"第一条文本消息
 * 的关键路径"挪到进程启动期。不预热时每次 systemctl restart 后的第一条消息要当场阻塞
 * 0.5-2s,且 searchMemory 的 500ms 竞速会返回 [] —— 重启后头几条回复静默地完全没有长期记忆。
 */
export function warmEmbedder(): void {
  void getEmbedder().catch(() => { /* non-critical; getEmbedder 内部失败会清空 promise 以便重试 */ });
}

function getEmbedder(): Promise<(texts: string[]) => Promise<number[][]>> {
  if (_embedder) return Promise.resolve(_embedder);
  if (_embedderPromise) return _embedderPromise;

  _embedderPromise = (async () => {
    // Dynamic import to avoid blocking startup
    const { pipeline } = await import('@xenova/transformers');
    const modelId = env().MEMORY_EMBED_MODEL;
    const extractor = await pipeline('feature-extraction', modelId, {
      progress_callback: undefined, // suppress download progress logs
    });

    _embedder = async (texts: string[]): Promise<number[][]> => {
      const keys = texts.map((t) => t.slice(0, 512));
      const results: (number[] | null)[] = new Array(keys.length).fill(null);
      const uncachedIndices: number[] = [];

      // Check cache first
      for (let i = 0; i < keys.length; i++) {
        const cached = _embedCache.get(keys[i]!);
        if (cached) {
          results[i] = cached;
        } else {
          uncachedIndices.push(i);
        }
      }

      // Batch-embed all uncached texts in one call
      if (uncachedIndices.length > 0) {
        const uncachedTexts = uncachedIndices.map((i) => keys[i]!);
        for (let j = 0; j < uncachedTexts.length; j++) {
          const out = await extractor(uncachedTexts[j]!, { pooling: 'mean', normalize: true });
          const vector = Array.from(out.data as Float32Array);
          const idx = uncachedIndices[j]!;
          _embedCache.set(keys[idx]!, vector);
          results[idx] = vector;
        }
      }

      return results as number[][];
    };

    // 打真实模型名:写死的日志在换模型后会撒谎,而"检索质量变差"最先查的就是这一行。
    logger.info({ model: modelId, dim: VECTOR_SIZE, collection: collectionName() }, 'Memory embedder loaded');
    return _embedder;
  })().catch((err) => {
    // Clear promise so next call retries
    _embedderPromise = undefined;
    throw err;
  });

  return _embedderPromise;
}

// ── Qdrant client + collection ───────────────────────────

function client(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({ host: QDRANT_HOST, port: QDRANT_PORT, https: false });
  }
  return _client;
}

/** Ensure the collection (+ payload indexes) exists; returns the client. */
function getStore(): Promise<QdrantClient> {
  if (_ready) return _ready;
  _ready = (async () => {
    const c = client();
    const { collections } = await c.getCollections();
    if (!collections.some((col) => col.name === collectionName())) {
      await c.createCollection(collectionName(), {
        // Scalar int8 quantization: keep the quantized vectors in RAM for fast ANN,
        // offload the float32 originals to disk; search rescores from disk to keep
        // recall near-lossless. ~4x less RAM for the vector data.
        vectors: { size: VECTOR_SIZE, distance: 'Cosine', on_disk: true },
        quantization_config: {
          scalar: { type: 'int8', quantile: 0.99, always_ram: true },
        },
      });
      // Index chatId so the per-chat filter is a fast pre-filter, not a scan.
      await c.createPayloadIndex(collectionName(), {
        field_name: 'chatId', field_schema: 'integer', wait: true,
      });
      logger.info({ host: QDRANT_HOST, port: QDRANT_PORT }, 'Qdrant collection created');
    }
    // 机制1/4:uid index 支撑 per-user 跨上下文检索(searchMemoryByUser)。
    // 幂等——已存在的 collection(首建分支不跑)也要补建;createPayloadIndex
    // 对已有 index 是 no-op,包 try/catch 防并发/竞态噪声。
    await ensurePayloadIndex(c, 'uid', 'integer');
    logger.info({ host: QDRANT_HOST, port: QDRANT_PORT }, 'Qdrant collection ready');
    return c;
  })().catch((err) => {
    _ready = undefined; // allow retry
    throw err;
  });
  return _ready;
}

/** 幂等建 payload index(已存在则 no-op;失败仅告警,不阻断)。 */
async function ensurePayloadIndex(
  c: QdrantClient,
  field: string,
  schema: 'integer' | 'keyword',
): Promise<void> {
  try {
    await c.createPayloadIndex(collectionName(), {
      field_name: field, field_schema: schema, wait: true,
    });
  } catch (err) {
    logger.debug({ err, field }, 'createPayloadIndex non-fatal (likely already exists)');
  }
}

// ── Public API ────────────────────────────────────────────

/**
 * Store a message into long-term memory.
 * Call fire-and-forget from pipeline — never awaited on the hot path.
 */
export async function memorizeMessage(
  chatId: number,
  msg: FormattedMessage,
  /** 机制1:覆盖默认 visibility(如频道帖显式传 'public');默认按会话私密性推断。 */
  visibilityOverride?: MemoryVisibility,
): Promise<void> {
  const text = msg.textContent || msg.captionContent || '';
  if (!text.trim() || msg.isBot) return;

  try {
    const [embed, store] = await Promise.all([getEmbedder(), getStore()]);
    const [vector] = await embed([text]);
    if (!vector) return;

    const mid = `${chatId}_${msg.messageId}`;

    // 近重复合并:群聊里「哈哈哈」「+1」「同问」会被原样存成几万条独立记忆,
    // 既撑大索引又挤占 topK 预算。命中已有近邻时不新增点,改为把它的 ref_count 顶上去
    // —— 语义上"这件事又被说了一次"本就该是强化,而不是复制。
    // 复用上面已算好的 vector,不额外 embed;整段套硬超时,绝不阻塞消息处理。
    if (env().MEMORY_DEDUP_ENABLED) {
      const dup = await findNearDuplicate(store, chatId, vector);
      if (dup) {
        try {
          const { recordMemoryReferenced } = await import('./importance.js');
          recordMemoryReferenced([dup]);
        } catch { /* non-critical */ }
        logger.debug({ chatId, messageId: msg.messageId, mergedInto: dup }, 'memory near-duplicate merged');
        return;
      }
    }
    // 机制1:无条件写 visibility + sourceChatId(前向兼容,让数据先积累;
    // scrub 由 MEMORY_VISIBILITY_ENABLED 门控,不影响默认锁 chatId 的检索)。
    const visibility: MemoryVisibility = visibilityOverride ?? defaultVisibilityForChat(chatId);
    await store.upsert(collectionName(), {
      wait: false,
      points: [{
        id: midToPointId(mid),
        vector,
        payload: {
          mid,
          chatId,
          messageId: msg.messageId,
          uid: msg.uid,
          username: msg.username,
          fullName: msg.fullName,
          timestamp: msg.timestamp,
          role: msg.role,
          text,
          visibility,
          sourceChatId: chatId,
        },
      }],
    });
    // Importance sidecar — track creation for later scoring / forgetting
    try {
      const { recordMemoryCreated } = await import('./importance.js');
      recordMemoryCreated(mid, chatId, msg.timestamp);
    } catch { /* non-critical */ }
    // 词法索引与向量库必须同生同灭 —— 只写一边会让 BM25 与向量两路看到不同的库。
    await writeLexical(mid, chatId, text);
  } catch (err) {
    logger.warn({ err, chatId, messageId: msg.messageId }, 'Memory write failed (non-critical)');
  }
}

/**
 * 找同 chat 内的近重复。返回被合并到的 mid,没有则 null。
 * 这是**热路径**(每条消息都走),所以套硬超时:超时就当没有重复、正常写入 ——
 * 宁可多存一条,也不能让去重把消息处理卡住。
 */
async function findNearDuplicate(
  store: QdrantClient,
  chatId: number,
  vector: number[],
): Promise<string | null> {
  const threshold = env().MEMORY_DEDUP_THRESHOLD;
  try {
    const hits = await Promise.race([
      store.search(collectionName(), {
        vector,
        limit: 1,
        filter: { must: [{ key: 'chatId', match: { value: chatId } }] },
        with_payload: true,
        params: { quantization: { rescore: true, oversampling: 2.0 } },
      }),
      new Promise<never[]>((resolve) => setTimeout(() => resolve([]), DEDUP_TIMEOUT_MS)),
    ]);
    const top = hits[0];
    if (!top || typeof top.score !== 'number' || top.score < threshold) return null;
    const mid = (top.payload ?? {})['mid'];
    return typeof mid === 'string' ? mid : null;
  } catch (err) {
    logger.debug({ err, chatId }, 'near-duplicate check failed (non-critical)');
    return null;
  }
}

/** 写 FTS 词法索引。非关键路径:失败只告警,不影响向量库那份已经写成功的记忆。 */
async function writeLexical(mid: string, chatId: number, text: string): Promise<void> {
  if (!env().MEMORY_HYBRID_ENABLED) return;
  try {
    const [{ getDb }, { upsertLexical }] = await Promise.all([
      import('../db/sqlite.js'),
      import('./lexical.js'),
    ]);
    upsertLexical(getDb(), mid, chatId, text);
  } catch (err) {
    logger.debug({ err, mid }, 'lexical index write failed (non-critical)');
  }
}

/**
 * Semantic search — returns FormattedMessage-shaped results from long-term memory.
 * Has a hard timeout to avoid slowing down the reply pipeline.
 */
export async function searchMemory(
  chatId: number,
  query: string,
  topK = 8,
  timeoutMs = 500,
): Promise<ScoredMessage[]> {
  if (!query.trim()) return [];

  try {
    const result = await Promise.race([
      _searchMemoryInner(chatId, query, topK),
      new Promise<ScoredMessage[]>((resolve) =>
        setTimeout(() => resolve([]), timeoutMs)
      ),
    ]);
    return result;
  } catch (err) {
    logger.debug({ err, chatId }, 'Memory search failed (non-critical)');
    return [];
  }
}

async function _searchMemoryInner(
  chatId: number,
  query: string,
  topK: number,
): Promise<ScoredMessage[]> {
  const hybrid = env().MEMORY_HYBRID_ENABLED;
  // 混合时每路多取:融合要靠名次交叉,单路只取 topK 会让第二路没有发言权。
  const perPath = hybrid ? topK * HYBRID_OVERFETCH : topK;

  const [embed, store] = await Promise.all([getEmbedder(), getStore()]);
  const [vector] = await embed([query]);
  if (!vector) return [];

  const hits = await store.search(collectionName(), {
    vector,
    limit: perPath,
    filter: { must: [{ key: 'chatId', match: { value: chatId } }] },
    with_payload: true,
    // Under int8 quantization: over-fetch on the quantized index, then re-rank the
    // candidates with the original (on-disk) vectors → near-lossless recall.
    params: { quantization: { rescore: true, oversampling: 2.0 } },
  });

  const semantic: ScoredMessage[] = [];
  for (const hit of hits) {
    const m = hitToMessage(hit);
    if (m) semantic.push(m);
  }

  if (!hybrid) return applyMinScore(semantic, { chatId }).slice(0, topK);

  // 词法路:384 维小模型对专有名词/黑话/型号天然弱,BM25 正好补这一块。
  const lexical = await lexicalPath(store, chatId, query, perPath);
  if (lexical.length === 0) return applyMinScore(semantic, { chatId }).slice(0, topK);

  // 阈值只施加于语义路 —— 词法路没有可比的 [0,1] 分数,拿余弦阈值卡它没有意义。
  const { rrfFuse } = await import('./fusion.js');
  const fused = rrfFuse<ScoredMessage>(
    [applyMinScore(semantic, { chatId }), lexical],
    (m) => `${m.sourceChatId ?? chatId}_${m.messageId}`,
    { limit: topK },
  );
  return fused;
}

/**
 * BM25 一路:FTS5 只存 id,所以命中后要回 Qdrant 取 payload 才能拼成 ScoredMessage。
 * 全程非关键 —— 任何一步失败就返回空,退化成纯向量检索。
 */
async function lexicalPath(
  store: QdrantClient,
  chatId: number,
  query: string,
  limit: number,
): Promise<ScoredMessage[]> {
  try {
    const [{ getDb }, { searchLexical }] = await Promise.all([
      import('../db/sqlite.js'),
      import('./lexical.js'),
    ]);
    const rows = searchLexical(getDb(), chatId, query, limit);
    if (rows.length === 0) return [];

    const points = await store.retrieve(collectionName(), {
      ids: rows.map((r) => midToPointId(r.chromaId)),
      with_payload: true,
    });
    // retrieve 不保证顺序,而 RRF 吃的是名次 —— 必须按 BM25 的原始排序还原。
    const byMid = new Map<string, ScoredMessage>();
    for (const p of points) {
      const m = hitToMessage(p as { payload?: Record<string, unknown> | null; score?: number });
      const mid = (p.payload ?? {})['mid'];
      if (m && typeof mid === 'string') byMid.set(mid, m);
    }
    return rows.map((r) => byMid.get(r.chromaId)).filter((m): m is ScoredMessage => m !== undefined);
  } catch (err) {
    logger.debug({ err, chatId }, 'lexical path failed (non-critical, falling back to vector-only)');
    return [];
  }
}

/**
 * 相关性下限。原先是纯 topK 无阈值 —— 那不是"检索不到就不注入",而是**无论多不相关
 * 都稳定注入 topK 条**,冷门话题下等于持续往 prompt 里灌噪声(既误导模型又烧 token)。
 *
 * 默认 0 = 保持旧行为,换模型与调阈值分成两次改动,出问题才分得清是谁的锅。
 * 阈值必须在换完模型之后、用真实语料标定 —— 旧的英文单语模型下中文相似度普遍虚高
 * (无关句对 0.72),任何在旧空间里选的阈值搬到新空间都是错的。
 */
function applyMinScore<T extends ScoredMessage>(hits: T[], ctx: Record<string, unknown>): T[] {
  const min = env().MEMORY_MIN_SCORE;
  if (min <= 0) return hits;
  const kept = hits.filter((m) => (m.score ?? 0) >= min);
  const dropped = hits.length - kept.length;
  if (dropped > 0) {
    // 计数器而非日志:生产是 LOG_LEVEL=info,debug 根本不落盘 —— 只写 debug 等于
    // 开了一个看不见效果的开关,阈值调高调低都无从判断。计数器走 /metrics,
    // 既能观测又不刷屏。keep/drop 两个都记,光看 drop 数不知道分母。
    incrCounter('memory_hits_filtered_total', { reason: 'below_min_score' }, dropped);
    incrCounter('memory_hits_kept_total', {}, kept.length);
    logger.debug({ ...ctx, min, dropped, kept: kept.length }, 'memory hits below MEMORY_MIN_SCORE');
  }
  return kept;
}

/** Qdrant hit → ScoredMessage(带 visibility/sourceChatId);无文本返回 null。 */
function hitToMessage(hit: { payload?: Record<string, unknown> | null; score?: number }): ScoredMessage | null {
  const meta = (hit.payload ?? {}) as Record<string, unknown>;
  const doc = meta['text'] as string | undefined;
  if (!doc) return null;
  // Qdrant Cosine returns similarity directly (higher = closer); clamp to [0,1].
  const score = typeof hit.score === 'number'
    ? Math.max(0, Math.min(1, hit.score))
    : undefined;
  const rawVis = meta['visibility'];
  const visibility = (rawVis === 'private' || rawVis === 'contextual' || rawVis === 'public')
    ? rawVis
    : undefined;
  return {
    role: (meta['role'] as 'user' | 'assistant') ?? 'user',
    uid: (meta['uid'] as number) ?? 0,
    username: (meta['username'] as string) ?? '',
    fullName: (meta['fullName'] as string) ?? '',
    timestamp: (meta['timestamp'] as number) ?? 0,
    messageId: (meta['messageId'] as number) ?? 0,
    textContent: doc,
    isForwarded: false,
    score,
    visibility,
    sourceChatId: (meta['sourceChatId'] as number) ?? (meta['chatId'] as number) ?? null,
  };
}

/**
 * 机制4:per-uid 跨上下文记忆检索(旁路,不锁 chatId)。filter 改按 uid,
 * 返回**强制过 scrubMemoryHits(boundChatId)**——默认带 public + 非私密来源
 * contextual,private 一律剔除。
 *
 * **双 flag fail-closed 在本函数内收口**(不再靠调用方自觉)。原先的约定是"仅
 * MEMORY_CROSS_CONTEXT_ENABLED && MEMORY_VISIBILITY_ENABLED 同开时才应由调用方启用",
 * retriever.retrieveCrossContext 照做了,但 subagent 的 host-api.recallPerson 漏了 ——
 * 而 scrubMemoryHits 在 MEMORY_VISIBILITY_ENABLED=false(默认)时是**空操作**,于是
 * 任意群成员可让 CodeAct 模型对任意 uid 调 recallPerson,把受害者 DM 原文取回并念到群里。
 * 守卫放在唯一出口这里,新调用方不可能再绕过。
 */
export async function searchMemoryByUser(
  uid: number,
  query: string,
  boundChatId: number,
  topK = 8,
  timeoutMs = 500,
): Promise<ScoredMessage[]> {
  const e = env();
  if (!e.MEMORY_CROSS_CONTEXT_ENABLED || !e.MEMORY_VISIBILITY_ENABLED) return [];
  // 负数 uid = sender_chat(匿名管理员/频道),不是真实的人,不做 per-person 检索。
  if (!query.trim() || !uid || uid <= 0) return [];
  try {
    return await Promise.race([
      _searchMemoryByUserInner(uid, query, boundChatId, topK),
      new Promise<ScoredMessage[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
    ]);
  } catch (err) {
    logger.debug({ err, uid }, 'per-user memory search failed (non-critical)');
    return [];
  }
}

async function _searchMemoryByUserInner(
  uid: number,
  query: string,
  boundChatId: number,
  topK: number,
): Promise<ScoredMessage[]> {
  const [embed, store] = await Promise.all([getEmbedder(), getStore()]);
  const [vector] = await embed([query]);
  if (!vector) return [];

  // 多取一些候选,scrub 掉跨界私密后仍够 topK。
  const hits = await store.search(collectionName(), {
    vector,
    limit: topK * 3,
    filter: {
      must: [{ key: 'uid', match: { value: uid } }],
      // 纵深:private 在**数据库侧**就剔掉,不要取回进程内存再靠 JS 过滤(取回即已是
      // 泄漏面 —— 中途任何日志/异常都会带出原文)。存量点没有 visibility 字段时
      // must_not 不会命中,仍由下面的 scrubMemoryHits 按 sourceChatId 兜底。
      must_not: [{ key: 'visibility', match: { value: 'private' satisfies MemoryVisibility } }],
    },
    with_payload: true,
    params: { quantization: { rescore: true, oversampling: 2.0 } },
  });

  const raw: ScoredMessage[] = [];
  for (const hit of hits) {
    const m = hitToMessage(hit);
    // review #7:同会话命中由 semantic 路覆盖,这里只要"别的场景"的 —— 在
    // scrub/slice **之前**就剔除,否则本会话记忆挤占 topK 预算、跨上下文召回饿死。
    if (m && m.sourceChatId !== boundChatId) raw.push(m);
  }
  // 阈值放在 scrub **之前**:低分噪声不该先占掉 topK 预算再被裁掉。
  const scored = applyMinScore(raw, { uid, boundChatId });
  // R1 读隔离:剔除跨界私密(DM private / 敏感群来源)。
  const { kept, dropped } = scrubMemoryHits(scored, boundChatId);
  if (dropped > 0) {
    // info 级:隐私防线真的挡下了跨界私密(DM/敏感群)内容 —— 生产可观测。
    logger.info({ uid, boundChatId, dropped, kept: kept.length }, 'per-user memory scrubbed cross-context private');
  }
  return kept.slice(0, topK);
}

/** Delete memory entries by their string id (`${chatId}_${messageId}`). */
export async function deleteMemories(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    const store = await getStore();
    await store.delete(collectionName(), { points: ids.map(midToPointId), wait: false });
    // 必须同步删词法索引。只删向量库的话索引会单向泄漏 —— 遗忘 cron 每天删一批,
    // BM25 却继续召回这些"已被遗忘"的记忆,而且回 Qdrant 取 payload 会取空、
    // 被 lexicalPath 静默滤掉,表现为"混合检索莫名其妙少了几条",极难定位。
    if (env().MEMORY_HYBRID_ENABLED) {
      try {
        const [{ getDb }, { deleteLexical }] = await Promise.all([
          import('../db/sqlite.js'),
          import('./lexical.js'),
        ]);
        deleteLexical(getDb(), ids);
      } catch (err) {
        logger.warn({ err, count: ids.length }, 'lexical delete failed — FTS index may now leak');
      }
    }
    return ids.length;
  } catch (err) {
    logger.warn({ err, count: ids.length }, 'deleteMemories failed (non-critical)');
    return 0;
  }
}

export async function isMemoryAvailable(): Promise<boolean> {
  try {
    await client().getCollections();
    return true;
  } catch {
    return false;
  }
}
