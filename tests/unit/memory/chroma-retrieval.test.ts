import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── 可变的 env,让每个用例单独调 flag ────────────────────────
const envState = {
  MEMORY_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2',
  MEMORY_COLLECTION: 'xxb_group_history',
  MEMORY_MIN_SCORE: 0,
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

// ── 假的 Qdrant ─────────────────────────────────────────────
let searchHits: Array<{ payload: Record<string, unknown>; score: number }> = [];
const searchSpy = vi.fn(async () => searchHits);
const upsertSpy = vi.fn(async () => ({}));
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: class {
    getCollections = async () => ({ collections: [{ name: envState.MEMORY_COLLECTION }] });
    createCollection = async () => ({});
    createPayloadIndex = async () => ({});
    search = searchSpy;
    upsert = upsertSpy;
    delete = async () => ({});
  },
}));

// ── 假的嵌入模型:记下被要求加载的是哪个模型 ─────────────────
const loadedModels: string[] = [];
vi.mock('@xenova/transformers', () => ({
  pipeline: async (_task: string, model: string) => {
    loadedModels.push(model);
    return async () => ({ data: new Float32Array(384).fill(0.1) });
  },
}));

const { searchMemory } = await import('../../../src/memory/chroma.js');

function hit(text: string, score: number) {
  return { payload: { text, chatId: -100, sourceChatId: -100, uid: 1, messageId: 1, timestamp: 0, role: 'user' }, score };
}

describe('chroma 检索:相关性下限与模型/collection flag', () => {
  beforeEach(() => {
    envState.MEMORY_MIN_SCORE = 0;
    envState.MEMORY_COLLECTION = 'xxb_group_history';
    searchHits = [];
    searchSpy.mockClear();
    loadedModels.length = 0;
  });

  describe('MEMORY_MIN_SCORE', () => {
    it('0 = 不过滤(保持历史的纯 topK 行为)', async () => {
      searchHits = [hit('高', 0.9), hit('中', 0.5), hit('低', 0.05)];
      const r = await searchMemory(-100, '查询');
      expect(r).toHaveLength(3);
    });

    it('按阈值切分:边界值算通过(>=)', async () => {
      searchHits = [hit('高', 0.9), hit('正好', 0.35), hit('低', 0.34)];
      envState.MEMORY_MIN_SCORE = 0.35;
      const r = await searchMemory(-100, '查询');
      expect(r.map((m) => m.textContent)).toEqual(['高', '正好']);
    });

    it('全部低于阈值时返回空,而不是退回 topK', async () => {
      searchHits = [hit('a', 0.2), hit('b', 0.1)];
      envState.MEMORY_MIN_SCORE = 0.5;
      expect(await searchMemory(-100, '查询')).toEqual([]);
    });

    // 这是本改动要消灭的行为:冷门话题下,无论多不相关都稳定注入 topK 条噪声。
    it('阈值把「无关但仍是 top-K」的命中挡在外面', async () => {
      searchHits = [hit('唯一相关', 0.72), hit('凑数1', 0.11), hit('凑数2', 0.09)];
      envState.MEMORY_MIN_SCORE = 0.35;
      const r = await searchMemory(-100, '查询');
      expect(r.map((m) => m.textContent)).toEqual(['唯一相关']);
    });
  });

  describe('flag 接线', () => {
    // embedder 是进程级单例(ONNX session 很贵),所以要拿一份全新的模块实例才看得到加载动作。
    it('嵌入模型从 MEMORY_EMBED_MODEL 读,不是写死的', async () => {
      envState.MEMORY_EMBED_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
      vi.resetModules();
      loadedModels.length = 0;
      const fresh = await import('../../../src/memory/chroma.js');
      searchHits = [hit('x', 0.9)];
      await fresh.searchMemory(-100, '查询');
      expect(loadedModels).toEqual(['Xenova/paraphrase-multilingual-MiniLM-L12-v2']);
    });

    // 钉住这个行为:改 MEMORY_EMBED_MODEL 必须重启才生效。运维上这很重要 ——
    // 半途换模型会让同一个 collection 里混进两个不兼容向量空间的点。
    it('模型在进程内只加载一次,不随 env 变化热切', async () => {
      vi.resetModules();
      loadedModels.length = 0;
      const fresh = await import('../../../src/memory/chroma.js');
      searchHits = [hit('x', 0.9)];
      await fresh.searchMemory(-100, '查询');
      envState.MEMORY_EMBED_MODEL = 'Xenova/some-other-model';
      await fresh.searchMemory(-100, '再查一次');
      expect(loadedModels).toHaveLength(1);
    });

    it('collection 名从 MEMORY_COLLECTION 读', async () => {
      envState.MEMORY_COLLECTION = 'xxb_group_history_v2';
      searchHits = [hit('x', 0.9)];
      await searchMemory(-100, '查询');
      expect(searchSpy.mock.calls[0]?.[0]).toBe('xxb_group_history_v2');
    });
  });

  it('空 query 直接短路,不打 Qdrant', async () => {
    expect(await searchMemory(-100, '   ')).toEqual([]);
    expect(searchSpy).not.toHaveBeenCalled();
  });
});
