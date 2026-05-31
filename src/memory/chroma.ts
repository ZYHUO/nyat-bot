// ────────────────────────────────────────
// 长期记忆向量库客户端 (Qdrant-backed)
// ────────────────────────────────────────
// - 写入：fire-and-forget，消息进 pipeline 后异步存入
// - 读取：语义搜索，填 retriever.ts 的 semantic 路
// - Embedding：@xenova/transformers 本地模型 (all-MiniLM-L6-v2, 384-dim)，无外部 API
// - 存储：Qdrant (HNSW + cosine)，进程外但内存/性能远优于旧的 Chroma Python 服务
//   迁移自 ChromaDB；点 id = UUIDv5(`${chatId}_${messageId}`) 以满足 Qdrant id 约束。
// ────────────────────────────────────────

import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import type { FormattedMessage } from '../shared/types.js';
import { logger } from '../shared/logger.js';

/**
 * A semantic-search result carrying its relevance score (0..1, higher = closer).
 * Qdrant returns cosine similarity directly (normalized embeddings ⇒ ~[0,1]); we
 * clamp it to [0,1]. Optional so callers that don't need it can ignore it.
 */
export type ScoredMessage = FormattedMessage & { score?: number };

const QDRANT_HOST = process.env['QDRANT_HOST'] ?? '127.0.0.1';
const QDRANT_PORT = parseInt(process.env['QDRANT_PORT'] ?? '6333', 10);
const COLLECTION_NAME = 'xxb_group_history';
const VECTOR_SIZE = 384;

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

function getEmbedder(): Promise<(texts: string[]) => Promise<number[][]>> {
  if (_embedder) return Promise.resolve(_embedder);
  if (_embedderPromise) return _embedderPromise;

  _embedderPromise = (async () => {
    // Dynamic import to avoid blocking startup
    const { pipeline } = await import('@xenova/transformers');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
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

    logger.info('Memory embedder loaded (all-MiniLM-L6-v2, 384-dim)');
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

/** Ensure the collection (+ chatId payload index) exists; returns the client. */
function getStore(): Promise<QdrantClient> {
  if (_ready) return _ready;
  _ready = (async () => {
    const c = client();
    const { collections } = await c.getCollections();
    if (!collections.some((col) => col.name === COLLECTION_NAME)) {
      await c.createCollection(COLLECTION_NAME, {
        // Scalar int8 quantization: keep the quantized vectors in RAM for fast ANN,
        // offload the float32 originals to disk; search rescores from disk to keep
        // recall near-lossless. ~4x less RAM for the vector data.
        vectors: { size: VECTOR_SIZE, distance: 'Cosine', on_disk: true },
        quantization_config: {
          scalar: { type: 'int8', quantile: 0.99, always_ram: true },
        },
      });
      // Index chatId so the per-chat filter is a fast pre-filter, not a scan.
      await c.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'chatId', field_schema: 'integer', wait: true,
      });
      logger.info({ host: QDRANT_HOST, port: QDRANT_PORT }, 'Qdrant collection created');
    }
    logger.info({ host: QDRANT_HOST, port: QDRANT_PORT }, 'Qdrant collection ready');
    return c;
  })().catch((err) => {
    _ready = undefined; // allow retry
    throw err;
  });
  return _ready;
}

// ── Public API ────────────────────────────────────────────

/**
 * Store a message into long-term memory.
 * Call fire-and-forget from pipeline — never awaited on the hot path.
 */
export async function memorizeMessage(
  chatId: number,
  msg: FormattedMessage,
): Promise<void> {
  const text = msg.textContent || msg.captionContent || '';
  if (!text.trim() || msg.isBot) return;

  try {
    const [embed, store] = await Promise.all([getEmbedder(), getStore()]);
    const [vector] = await embed([text]);
    if (!vector) return;

    const mid = `${chatId}_${msg.messageId}`;
    await store.upsert(COLLECTION_NAME, {
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
        },
      }],
    });
    // Importance sidecar — track creation for later scoring / forgetting
    try {
      const { recordMemoryCreated } = await import('./importance.js');
      recordMemoryCreated(mid, chatId, msg.timestamp);
    } catch { /* non-critical */ }
  } catch (err) {
    logger.warn({ err, chatId, messageId: msg.messageId }, 'Memory write failed (non-critical)');
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
  const [embed, store] = await Promise.all([getEmbedder(), getStore()]);
  const [vector] = await embed([query]);
  if (!vector) return [];

  const hits = await store.search(COLLECTION_NAME, {
    vector,
    limit: topK,
    filter: { must: [{ key: 'chatId', match: { value: chatId } }] },
    with_payload: true,
    // Under int8 quantization: over-fetch on the quantized index, then re-rank the
    // candidates with the original (on-disk) vectors → near-lossless recall.
    params: { quantization: { rescore: true, oversampling: 2.0 } },
  });

  const messages: ScoredMessage[] = [];
  for (const hit of hits) {
    const meta = (hit.payload ?? {}) as Record<string, unknown>;
    const doc = meta['text'] as string | undefined;
    if (!doc) continue;

    // Qdrant Cosine returns similarity directly (higher = closer); clamp to [0,1].
    const score = typeof hit.score === 'number'
      ? Math.max(0, Math.min(1, hit.score))
      : undefined;

    messages.push({
      role: (meta['role'] as 'user' | 'assistant') ?? 'user',
      uid: (meta['uid'] as number) ?? 0,
      username: (meta['username'] as string) ?? '',
      fullName: (meta['fullName'] as string) ?? '',
      timestamp: (meta['timestamp'] as number) ?? 0,
      messageId: (meta['messageId'] as number) ?? 0,
      textContent: doc,
      isForwarded: false,
      score,
    });
  }

  return messages;
}

/** Delete memory entries by their string id (`${chatId}_${messageId}`). */
export async function deleteMemories(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    const store = await getStore();
    await store.delete(COLLECTION_NAME, { points: ids.map(midToPointId), wait: false });
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
