import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── 可变的 env,让每个用例单独调 flag ────────────────────────
const envState = {
  MEMORY_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2',
  MEMORY_COLLECTION: 'xxb_group_history',
  MEMORY_MIN_SCORE: 0,
  MEMORY_HYBRID_ENABLED: false,
  MEMORY_DEDUP_ENABLED: false,
  MEMORY_DEDUP_THRESHOLD: 0.93,
  MEMORY_CROSS_CONTEXT_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: false,
};
vi.mock('../../../src/env.js', () => ({ env: () => envState }));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('../../../src/memory/visibility.js', () => ({
  defaultVisibilityForChat: () => 'contextual',
  scrubMemoryHits: (hits: unknown[]) => ({ kept: hits, dropped: 0 }),
}));

const recordCreated = vi.fn();
const recordReferenced = vi.fn();
vi.mock('../../../src/memory/importance.js', () => ({
  recordMemoryCreated: recordCreated,
  recordMemoryReferenced: recordReferenced,
}));

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => ({}) }));

let lexicalRows: Array<{ chromaId: string; rank: number }> = [];
const upsertLexicalSpy = vi.fn();
const deleteLexicalSpy = vi.fn();
vi.mock('../../../src/memory/lexical.js', () => ({
  searchLexical: () => lexicalRows,
  upsertLexical: upsertLexicalSpy,
  deleteLexical: deleteLexicalSpy,
}));

// ── 假的 Qdrant ─────────────────────────────────────────────
let searchHits: Array<{ payload: Record<string, unknown>; score: number }> = [];
let retrievePoints: Array<{ payload: Record<string, unknown> }> = [];
const searchSpy = vi.fn(async () => searchHits);
const retrieveSpy = vi.fn(async () => retrievePoints);
const upsertSpy = vi.fn(async () => ({}));
const deleteSpy = vi.fn(async () => ({}));
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: class {
    getCollections = async () => ({ collections: [{ name: envState.MEMORY_COLLECTION }] });
    createCollection = async () => ({});
    createPayloadIndex = async () => ({});
    search = searchSpy;
    retrieve = retrieveSpy;
    upsert = upsertSpy;
    delete = deleteSpy;
  },
}));

// ── 假的嵌入模型 ────────────────────────────────────────────
const loadedModels: string[] = [];
vi.mock('@xenova/transformers', () => ({
  pipeline: async (_task: string, model: string) => {
    loadedModels.push(model);
    return async () => ({ data: new Float32Array(384).fill(0.1) });
  },
}));

const { searchMemory, memorizeMessage, deleteMemories } = await import('../../../src/memory/chroma.js');

const CHAT = -100;
function payload(text: string, messageId: number) {
  return { mid: `${CHAT}_${messageId}`, text, chatId: CHAT, sourceChatId: CHAT, uid: 1, messageId, timestamp: 0, role: 'user' };
}
function hit(text: string, score: number, messageId = 1) {
  return { payload: payload(text, messageId), score };
}
function msg(text: string, messageId = 1) {
  return { role: 'user' as const, uid: 1, username: 'u', fullName: 'U', timestamp: 0, messageId, textContent: text, isForwarded: false, isBot: false };
}

describe('chroma 检索与写入', () => {
  beforeEach(() => {
    Object.assign(envState, {
      MEMORY_MIN_SCORE: 0, MEMORY_COLLECTION: 'xxb_group_history',
      MEMORY_HYBRID_ENABLED: false, MEMORY_DEDUP_ENABLED: false, MEMORY_DEDUP_THRESHOLD: 0.93,
    });
    searchHits = []; retrievePoints = []; lexicalRows = [];
    for (const s of [searchSpy, retrieveSpy, upsertSpy, deleteSpy, upsertLexicalSpy, deleteLexicalSpy, recordCreated, recordReferenced]) s.mockClear();
    loadedModels.length = 0;
  });

  describe('MEMORY_MIN_SCORE', () => {
    it('0 = 不过滤(保持历史的纯 topK 行为)', async () => {
      searchHits = [hit('高', 0.9, 1), hit('中', 0.5, 2), hit('低', 0.05, 3)];
      expect(await searchMemory(CHAT, '查询')).toHaveLength(3);
    });

    it('按阈值切分:边界值算通过(>=)', async () => {
      searchHits = [hit('高', 0.9, 1), hit('正好', 0.35, 2), hit('低', 0.34, 3)];
      envState.MEMORY_MIN_SCORE = 0.35;
      const r = await searchMemory(CHAT, '查询');
      expect(r.map((m) => m.textContent)).toEqual(['高', '正好']);
    });

    it('全部低于阈值时返回空,而不是退回 topK', async () => {
      searchHits = [hit('a', 0.2, 1), hit('b', 0.1, 2)];
      envState.MEMORY_MIN_SCORE = 0.5;
      expect(await searchMemory(CHAT, '查询')).toEqual([]);
    });

    // 这是本改动要消灭的行为:冷门话题下,无论多不相关都稳定注入 topK 条噪声。
    it('阈值把「无关但仍是 top-K」的命中挡在外面', async () => {
      searchHits = [hit('唯一相关', 0.72, 1), hit('凑数1', 0.11, 2), hit('凑数2', 0.09, 3)];
      envState.MEMORY_MIN_SCORE = 0.35;
      const r = await searchMemory(CHAT, '查询');
      expect(r.map((m) => m.textContent)).toEqual(['唯一相关']);
    });
  });

  describe('flag 接线', () => {
    // embedder 是进程级单例(ONNX session 很贵),要拿全新模块实例才看得到加载动作。
    it('嵌入模型从 MEMORY_EMBED_MODEL 读,不是写死的', async () => {
      envState.MEMORY_EMBED_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
      vi.resetModules();
      loadedModels.length = 0;
      const fresh = await import('../../../src/memory/chroma.js');
      searchHits = [hit('x', 0.9)];
      await fresh.searchMemory(CHAT, '查询');
      expect(loadedModels).toEqual(['Xenova/paraphrase-multilingual-MiniLM-L12-v2']);
    });

    // 钉住这个行为:改 MEMORY_EMBED_MODEL 必须重启才生效。半途换模型会让同一个
    // collection 混进两个不兼容向量空间的点。
    it('模型在进程内只加载一次,不随 env 变化热切', async () => {
      vi.resetModules();
      loadedModels.length = 0;
      const fresh = await import('../../../src/memory/chroma.js');
      searchHits = [hit('x', 0.9)];
      await fresh.searchMemory(CHAT, '查询');
      envState.MEMORY_EMBED_MODEL = 'Xenova/some-other-model';
      await fresh.searchMemory(CHAT, '再查一次');
      expect(loadedModels).toHaveLength(1);
    });

    it('collection 名从 MEMORY_COLLECTION 读', async () => {
      envState.MEMORY_COLLECTION = 'xxb_group_history_v2';
      searchHits = [hit('x', 0.9)];
      await searchMemory(CHAT, '查询');
      expect(searchSpy.mock.calls[0]?.[0]).toBe('xxb_group_history_v2');
    });
  });

  describe('混合检索(MEMORY_HYBRID_ENABLED)', () => {
    it('关闭时完全不碰词法路', async () => {
      searchHits = [hit('a', 0.9, 1)];
      lexicalRows = [{ chromaId: `${CHAT}_99`, rank: -1 }];
      const r = await searchMemory(CHAT, '查询');
      expect(retrieveSpy).not.toHaveBeenCalled();
      expect(r.map((m) => m.textContent)).toEqual(['a']);
    });

    it('开启时每路超取,融合后才截到 topK', async () => {
      searchHits = [hit('a', 0.9, 1)];
      envState.MEMORY_HYBRID_ENABLED = true;
      await searchMemory(CHAT, '查询', 8);
      expect((searchSpy.mock.calls[0]?.[1] as { limit: number }).limit).toBe(16);
    });

    // 混合检索存在的意义:向量路没召回的专名/黑话,词法路能捞上来。
    it('词法路独有的命中会进入结果', async () => {
      searchHits = [hit('向量命中', 0.9, 1)];
      lexicalRows = [{ chromaId: `${CHAT}_42`, rank: -1.2 }];
      retrievePoints = [{ payload: payload('词法独有的黑话', 42) }];
      envState.MEMORY_HYBRID_ENABLED = true;
      const r = await searchMemory(CHAT, '查询');
      expect(r.map((m) => m.textContent)).toContain('词法独有的黑话');
    });

    it('词法路无命中时退化成纯向量,不报错', async () => {
      searchHits = [hit('a', 0.9, 1)];
      lexicalRows = [];
      envState.MEMORY_HYBRID_ENABLED = true;
      const r = await searchMemory(CHAT, '查询');
      expect(r.map((m) => m.textContent)).toEqual(['a']);
      expect(retrieveSpy).not.toHaveBeenCalled();
    });

    it('词法路抛错时退化成纯向量,不拖垮检索', async () => {
      searchHits = [hit('a', 0.9, 1)];
      lexicalRows = [{ chromaId: `${CHAT}_42`, rank: -1 }];
      retrieveSpy.mockRejectedValueOnce(new Error('qdrant down'));
      envState.MEMORY_HYBRID_ENABLED = true;
      const r = await searchMemory(CHAT, '查询');
      expect(r.map((m) => m.textContent)).toEqual(['a']);
    });

    it('两路都命中同一条时不重复出现', async () => {
      searchHits = [hit('共同', 0.9, 7)];
      lexicalRows = [{ chromaId: `${CHAT}_7`, rank: -1 }];
      retrievePoints = [{ payload: payload('共同', 7) }];
      envState.MEMORY_HYBRID_ENABLED = true;
      const r = await searchMemory(CHAT, '查询');
      expect(r).toHaveLength(1);
    });
  });

  describe('写入侧去重(MEMORY_DEDUP_ENABLED)', () => {
    it('关闭时照常写入,不做近邻查询', async () => {
      await memorizeMessage(CHAT, msg('哈哈哈'));
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect(searchSpy).not.toHaveBeenCalled();
    });

    it('命中近重复时不新增点,改为顶高已有那条的 ref_count', async () => {
      envState.MEMORY_DEDUP_ENABLED = true;
      searchHits = [hit('哈哈哈', 0.97, 5)];
      await memorizeMessage(CHAT, msg('哈哈哈哈'));
      expect(upsertSpy).not.toHaveBeenCalled();
      expect(recordReferenced).toHaveBeenCalledWith([`${CHAT}_5`]);
    });

    it('低于阈值时正常写入', async () => {
      envState.MEMORY_DEDUP_ENABLED = true;
      searchHits = [hit('不相干', 0.4, 5)];
      await memorizeMessage(CHAT, msg('今天天气不错'));
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect(recordReferenced).not.toHaveBeenCalled();
    });

    it('阈值可调', async () => {
      envState.MEMORY_DEDUP_ENABLED = true;
      envState.MEMORY_DEDUP_THRESHOLD = 0.3;
      searchHits = [hit('勉强像', 0.4, 5)];
      await memorizeMessage(CHAT, msg('今天天气不错'));
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    // 去重跑在消息处理路径上,近邻查询失败绝不能吞掉这条记忆。
    it('近邻查询失败时照常写入', async () => {
      envState.MEMORY_DEDUP_ENABLED = true;
      searchSpy.mockRejectedValueOnce(new Error('qdrant down'));
      await memorizeMessage(CHAT, msg('要被记住的话'));
      expect(upsertSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('词法索引与向量库同生同灭', () => {
    it('混合开启时写入会同步写 FTS', async () => {
      envState.MEMORY_HYBRID_ENABLED = true;
      await memorizeMessage(CHAT, msg('要被索引的话', 3));
      expect(upsertLexicalSpy).toHaveBeenCalledWith({}, `${CHAT}_3`, CHAT, '要被索引的话');
    });

    it('混合关闭时不写 FTS', async () => {
      await memorizeMessage(CHAT, msg('不索引', 3));
      expect(upsertLexicalSpy).not.toHaveBeenCalled();
    });

    // 只删向量库会让 FTS 单向泄漏:遗忘 cron 删掉的记忆仍被 BM25 召回。
    it('删除时同步删 FTS', async () => {
      envState.MEMORY_HYBRID_ENABLED = true;
      await deleteMemories([`${CHAT}_1`, `${CHAT}_2`]);
      expect(deleteLexicalSpy).toHaveBeenCalledWith({}, [`${CHAT}_1`, `${CHAT}_2`]);
    });

    it('FTS 删除失败不影响向量库删除的返回值', async () => {
      envState.MEMORY_HYBRID_ENABLED = true;
      deleteLexicalSpy.mockImplementationOnce(() => { throw new Error('locked'); });
      expect(await deleteMemories([`${CHAT}_1`])).toBe(1);
    });
  });

  it('空 query 直接短路,不打 Qdrant', async () => {
    expect(await searchMemory(CHAT, '   ')).toEqual([]);
    expect(searchSpy).not.toHaveBeenCalled();
  });
});
