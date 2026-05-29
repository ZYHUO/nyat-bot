// ────────────────────────────────────────
// ChromaDB 长期记忆客户端
// ────────────────────────────────────────
// - 写入：fire-and-forget，消息进 pipeline 后异步存入
// - 读取：语义搜索，填 retriever.ts 的 semantic 路
// - Embedding：@xenova/transformers 本地模型，无需外部 API
// ────────────────────────────────────────

import { ChromaClient, type Collection } from 'chromadb';
import { LRUCache } from 'lru-cache';
import type { FormattedMessage } from '../shared/types.js';
import { logger } from '../shared/logger.js';

/**
 * A semantic-search result carrying its relevance score (0..1, higher = closer).
 * Score is derived from the cosine distance Chroma returns (relevance = 1 - distance,
 * clamped). Optional so callers that don't need it can ignore it; undefined when the
 * memory layer can't surface a distance.
 */
export type ScoredMessage = FormattedMessage & { score?: number };

const CHROMA_HOST = process.env['CHROMA_HOST'] ?? 'localhost';
const CHROMA_PORT = parseInt(process.env['CHROMA_PORT'] ?? '8400', 10);
const COLLECTION_NAME = 'xxb_group_history';

// Lazy singletons
let _client: ChromaClient | undefined;
let _collection: Collection | undefined;
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

// ── ChromaDB client + collection ─────────────────────────

async function getCollection(): Promise<Collection> {
  if (_collection) return _collection;

  if (!_client) {
    _client = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT, ssl: false });
  }

  _collection = await _client.getOrCreateCollection({
    name: COLLECTION_NAME,
    embeddingFunction: null as unknown as undefined, // we supply embeddings manually
    metadata: { 'hnsw:space': 'cosine' },
  });

  logger.info({ host: CHROMA_HOST, port: CHROMA_PORT }, 'Chroma collection ready');
  return _collection;
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
    const [embed, col] = await Promise.all([getEmbedder(), getCollection()]);
    const [vector] = await embed([text]);
    if (!vector) return;

    await col.upsert({
      ids: [`${chatId}_${msg.messageId}`],
      embeddings: [vector],
      documents: [text],
      metadatas: [{
        chatId,
        messageId: msg.messageId,
        uid: msg.uid,
        username: msg.username,
        fullName: msg.fullName,
        timestamp: msg.timestamp,
        role: msg.role,
      }],
    });
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
  const [embed, col] = await Promise.all([getEmbedder(), getCollection()]);
  const [vector] = await embed([query]);
  if (!vector) return [];

  const res = await col.query({
    queryEmbeddings: [vector],
    nResults: topK,
    where: { chatId: { $eq: chatId } },
  });

  const docs = res.documents?.[0] ?? [];
  const metas = res.metadatas?.[0] ?? [];
  const distances = res.distances?.[0] ?? [];

  const messages: ScoredMessage[] = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const meta = metas[i] as Record<string, unknown> | null;
    if (!doc || !meta) continue;

    // Collection uses cosine space → distance ∈ [0,2]; relevance = 1 - distance,
    // clamped to [0,1]. Leave score undefined if Chroma didn't return a distance.
    const dist = distances[i];
    const score = typeof dist === 'number'
      ? Math.max(0, Math.min(1, 1 - dist))
      : undefined;

    messages.push({
      role: (meta['role'] as 'user' | 'assistant') ?? 'user',
      uid: meta['uid'] as number ?? 0,
      username: meta['username'] as string ?? '',
      fullName: meta['fullName'] as string ?? '',
      timestamp: meta['timestamp'] as number ?? 0,
      messageId: meta['messageId'] as number ?? 0,
      textContent: doc,
      isForwarded: false,
      score,
    });
  }

  return messages;
}

export async function isMemoryAvailable(): Promise<boolean> {
  try {
    if (!_client) {
      _client = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT, ssl: false });
    }
    await _client.heartbeat();
    return true;
  } catch {
    return false;
  }
}
