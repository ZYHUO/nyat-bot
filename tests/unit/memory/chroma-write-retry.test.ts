/**
 * Qdrant 写的连接级瞬断重试。
 *
 * 2026-09-21 实测：`Memory write failed (non-critical)` 这条 catch 一天吃掉 **700 次**：
 *   terminated: other side closed   431
 *   Connect Timeout Error           181
 *   socket disconnected              50
 *   read ECONNRESET                  38
 * 全是**连接级瞬断**——本地 Qdrant 抖一下，这条消息的长期记忆就永久少了。
 * 这类错误重试一次基本就成，而调用方是 fire-and-forget（bookkeeping.ts 里 `.catch()`
 * 挂着），多重试两次不阻塞回复链路。
 *
 * 这里锁四件事：
 *   ① 瞬断 → 重试，最终成功（不再一抖就丢）
 *   ② 非瞬断（payload 非法/维度不对）→ 立刻抛，不重试（重试只是翻倍同样的错）
 *   ③ 三次都失败 → 仍旧上抛，warn 照打（失败不会变安静）
 *   ④ 退避是真的等了（0 / 150 / 400ms）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const envState = {
  MEMORY_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2',
  MEMORY_COLLECTION: 'xxb_group_history',
  MEMORY_MIN_SCORE: 0,
  MEMORY_HYBRID_ENABLED: true,
  MEMORY_DEDUP_ENABLED: false,
  MEMORY_DEDUP_THRESHOLD: 0.93,
  MEMORY_CROSS_CONTEXT_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: false,
};
vi.mock('../../../src/env.js', () => ({ env: () => envState }));
const warnSpy = vi.fn();
const debugSpy = vi.fn();
vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    debug: debugSpy, info: vi.fn(), warn: warnSpy, error: vi.fn(),
    child: () => ({ debug: debugSpy, info: vi.fn(), warn: warnSpy, error: vi.fn() }),
  },
}));
vi.mock('../../../src/memory/visibility.js', () => ({
  defaultVisibilityForChat: () => 'contextual',
  scrubMemoryHits: (hits: unknown[]) => ({ kept: hits, dropped: 0 }),
  isPrivateChat: (id: number) => id > 0,
}));
vi.mock('../../../src/memory/importance.js', () => ({
  recordMemoryCreated: vi.fn(), recordMemoryReferenced: vi.fn(),
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => ({}) }));

const upsertLexicalSpy = vi.fn(async () => ({}));
vi.mock('../../../src/memory/lexical.js', () => ({
  searchLexical: () => [],
  upsertLexical: upsertLexicalSpy,
  deleteLexical: vi.fn(async () => {}),
}));

// ── 可控的假 Qdrant ─────────────────────────────────────────
let upsertImpl: (() => Promise<unknown>) = async () => ({});
const upsertSpy = vi.fn(() => upsertImpl());
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: class {
    getCollections = async () => ({ collections: [{ name: envState.MEMORY_COLLECTION }] });
    createCollection = async () => ({});
    createPayloadIndex = async () => ({});
    search = async () => [];
    retrieve = async () => [];
    upsert = upsertSpy;
    delete = async () => ({});
  },
}));
vi.mock('@xenova/transformers', () => ({
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.1) }),
}));

const { memorizeMessage } = await import('../../../src/memory/chroma.js');

const CHAT = -100;
function msg(text: string, messageId = 1) {
  return { role: 'user' as const, uid: 1, username: 'u', fullName: 'U', timestamp: 0, messageId, textContent: text, isForwarded: false, isBot: false };
}

/** 让 upsert 前 failCount 次抛指定错，之后成功。 */
function failThenSucceed(failCount: number, message: string): { calls: () => number } {
  let n = 0;
  upsertImpl = async () => {
    n++;
    if (n <= failCount) throw new Error(message);
    return {};
  };
  return { calls: () => n };
}

beforeEach(() => {
  upsertSpy.mockClear();
  upsertLexicalSpy.mockClear();
  warnSpy.mockClear();
  debugSpy.mockClear();
  upsertImpl = async () => ({});
});

describe('Qdrant 写的瞬断重试', () => {
  it('① 第一次 terminated、第二次成功 → 最终写入成功（不再一抖就丢）', async () => {
    failThenSucceed(1, 'terminated: other side closed');
    await memorizeMessage(CHAT, msg('在吗', 1));
    expect(upsertSpy).toHaveBeenCalledTimes(2);
    expect(upsertLexicalSpy).toHaveBeenCalledTimes(1); // 向量写成功后才写词法
  });

  it('①b Connect Timeout / ECONNRESET / socket disconnected 同样重试', async () => {
    for (const m of ['fetch failed: Connect Timeout Error', 'read ECONNRESET', 'Client network socket disconnected']) {
      upsertSpy.mockClear();
      upsertLexicalSpy.mockClear();
      failThenSucceed(2, m);
      await memorizeMessage(CHAT, msg('在吗', 2));
      expect(upsertSpy, m).toHaveBeenCalledTimes(3);
    }
  });

  it('② 非瞬断（payload 非法）→ 不重试（重试只是翻倍同样的错）', async () => {
    failThenSucceed(9, 'Bad Request: invalid payload');
    await memorizeMessage(CHAT, msg('在吗', 3));
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('③ 三次都瞬断 → 试满三次，并且 warn 照打（失败不会变安静）', async () => {
    failThenSucceed(99, 'terminated: other side closed');
    await memorizeMessage(CHAT, msg('在吗', 4));
    expect(upsertSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 4 }),
      'Memory write failed (non-critical)',
    );
  });

  it('③b 三次都失败时**不写词法索引**（两边必须同生同灭）', async () => {
    failThenSucceed(99, 'terminated: other side closed');
    await memorizeMessage(CHAT, msg('在吗', 5));
    expect(upsertLexicalSpy).not.toHaveBeenCalled();
  });

  it('④ 退避真的等了（三次尝试之间不是零延迟猛打）', async () => {
    vi.useFakeTimers();
    try {
      failThenSucceed(99, 'terminated: other side closed');
      const p = memorizeMessage(CHAT, msg('在吗', 6));
      const start = Date.now();
      await vi.runAllTimersAsync();
      await p;
      // 退避 0 + 150 + 400 = 550ms
      expect(Date.now() - start).toBeGreaterThanOrEqual(540);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⑤ 一切正常时行为不变（一次成功，无额外调用）', async () => {
    await memorizeMessage(CHAT, msg('在吗', 7));
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertLexicalSpy).toHaveBeenCalledTimes(1);
  });
});
