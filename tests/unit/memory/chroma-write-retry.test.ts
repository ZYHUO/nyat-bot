/**
 * Qdrant 写的连接级瞬断重试 + 失败归因的**正确分层**。
 *
 * 2026-09-21 的教训（这条头注以前写错过，改正如下）：日志里那条
 * `Memory write failed (non-critical)` 一天 2280 条，**不是**这条 catch 的调用方
 * （Qdrant upsert）产生的问题。按 err.stack 分类：
 *   ① 2270 条栈里有 @xenova/transformers（getModelFile / AutoModel.from_pretrained）
 *      —— 本地 onnx 权重从未缓存，每次进程启动都去 huggingface.co 重拉，本机 TLS
 *      隧道 5 秒一断，undici 报 `terminated: other side closed`（栈里是 TLSSocket；
 *      Qdrant 是明文 HTTP，只可能报 Socket）。
 *   ② 只有 10 条栈里有 @qdrant/js-client-rest 的 upsert 帧。
 * 所以重试本身是对的（针对真的 Qdrant 瞬断），但它治不了那 2270 条。
 * 真正的问题是共用一个 try/catch 把两件事混成一句告警 —— 现在分阶段各报各的。
 *
 * 这里锁五件事：
 *   ① embedding 装不上 / 嵌不出来 → 报各自的告警，且**不打 upsert**（不能静默跳过）
 *   ② 向量写 Qdrant 真失败（terminated）→ 重试，且几次尝试用的是**同一个确定性
 *      id**（UUIDv5(`${chatId}_${messageId}`)），所以重试是幂等覆盖，不产生重复点
 *   ③ 非瞬断（payload 非法/维度不对）→ 立刻抛，不重试（重试只是翻倍同样的错）
 *   ④ 三次都失败 → 仍旧上抛，`Memory write failed` 照打（失败不会变安静）
 *   ⑤ 退避是真的等了（0 / 150 / 400ms）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const envState = {
  MEMORY_EMBED_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
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
let upsertImpl: () => Promise<unknown> = async () => ({});
const upsertSpy = vi.fn(() => upsertImpl());
/** getCollections 失败 ⇒ getStore() 建不了 collection，与 embedding 是两回事。 */
let getCollectionsImpl: () => Promise<{ collections: { name: string }[] }> = async () => ({
  collections: [{ name: envState.MEMORY_COLLECTION }],
});
// ── 可控的假 embedding ──────────────────────────────────────
/** pipeline() 本身失败 ⇒ 权重/模型装不上（2026-09-21 那 2270 条告警的真实来源）。 */
let pipelineShouldFail = false;
/** extractor 调用失败 ⇒ 模型在、但这一条嵌不出来。 */
let extractorImpl: () => Promise<{ data: Float32Array }> = async () => ({ data: new Float32Array(384).fill(0.1) });
/** 测试用的 transformers env —— 刻意指向一个不存在的 cacheDir：本地没权重，走下载分支。 */
vi.mock('@xenova/transformers', () => ({
  env: { cacheDir: '/nonexistent-embed-cache-dir-for-tests' },
  pipeline: async () => {
    if (pipelineShouldFail) throw new Error('terminated: other side closed');
    return async () => extractorImpl();
  },
}));
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: class {
    getCollections = async () => await getCollectionsImpl();
    createCollection = async () => ({});
    createPayloadIndex = async () => ({});
    search = async () => [];
    retrieve = async () => [];
    upsert = upsertSpy;
    delete = async () => ({});
  },
}));

/**
 * chroma.ts 里 getStore()/getEmbedder() 是进程内单例（`_ready` / `_embedderPromise`
 * 会跨调用记住结果）。要让每条测试互不污染 —— 比如"collection 建不了"这条，
 * 必须跑在 `_ready` 还没被别的测试填过的模块实例上 —— 每次重新 import 一份。
 */
async function loadFreshChroma(): Promise<{
  memorizeMessage: typeof import('../../../src/memory/chroma.js').memorizeMessage;
  midToPointId: typeof import('../../../src/memory/chroma.js').midToPointId;
}> {
  vi.resetModules();
  return await import('../../../src/memory/chroma.js');
}

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
  getCollectionsImpl = async () => ({ collections: [{ name: envState.MEMORY_COLLECTION }] });
  pipelineShouldFail = false;
  extractorImpl = async () => ({ data: new Float32Array(384).fill(0.1) });
});

describe('失败归因分层（2026-09-21 误诊的修复）', () => {
  it('① embedding 装不上（pipeline 失败）→ 报 embedding 告警，且**不打 upsert**', async () => {
    pipelineShouldFail = true;
    const { memorizeMessage } = await loadFreshChroma();
    await memorizeMessage(CHAT, msg('在吗', 20));
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(upsertLexicalSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, stage: 'embedder' }),
      'Memory embedding unavailable (non-critical)',
    );
    // 关键：**不能**再被记成 "Memory write failed" ——
    // 那正是把「模型下不下来」误诊成「Qdrant 抖了」、还白加一层重试的原因。
    expect(warnSpy).not.toHaveBeenCalledWith(expect.anything(), 'Memory write failed (non-critical)');
  });

  it('② embedding 建模了但这一条嵌不出来 → 同样报 embedding，且不打 upsert', async () => {
    extractorImpl = async () => { throw new Error('terminated: other side closed'); };
    const { memorizeMessage } = await loadFreshChroma();
    await memorizeMessage(CHAT, msg('在吗', 21));
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 21, stage: 'embed' }),
      'Memory embedding failed (non-critical)',
    );
    expect(warnSpy).not.toHaveBeenCalledWith(expect.anything(), 'Memory write failed (non-critical)');
  });

  it('③ collection 建不起来 → 报 store 告警，且不打 upsert', async () => {
    getCollectionsImpl = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:6333'); };
    const { memorizeMessage } = await loadFreshChroma();
    await memorizeMessage(CHAT, msg('在吗', 22));
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, stage: 'store' }),
      'Memory store unavailable (non-critical)',
    );
    expect(warnSpy).not.toHaveBeenCalledWith(expect.anything(), 'Memory write failed (non-critical)');
  });

  it('④ terminated 重试三次用的是**同一个确定性 id** ⇒ 不可能产生重复点', async () => {
    failThenSucceed(2, 'terminated: other side closed'); // 前两次瞬断挂，第三次成
    const { memorizeMessage, midToPointId } = await loadFreshChroma();
    await memorizeMessage(CHAT, msg('在吗', 77));
    expect(upsertSpy).toHaveBeenCalledTimes(3);
    // upsert(collection, { points: [{ id, … }] }) —— 第二个参数才是载荷
    const calls = upsertSpy.mock.calls as unknown as [string, { points: { id: string }[] }][];
    const cols = calls.map((c) => c[0]);
    const ids = calls.map((c) => c[1].points[0]!.id);
    // upsert 同一个 id 在 Qdrant 里是覆盖，不是新增 ——「重试写重复点」这个担心不成立。
    expect(ids).toEqual([midToPointId(`${CHAT}_77`), midToPointId(`${CHAT}_77`), midToPointId(`${CHAT}_77`)]);
    expect(new Set(ids).size).toBe(1);
    // 三次都写进同一个 collection（重试不会因为换库而漏掉/复制）
    expect(new Set(cols)).toEqual(new Set([envState.MEMORY_COLLECTION]));
  });
});

describe('Qdrant 写的瞬断重试', () => {
  it('① 第一次 terminated、第二次成功 → 最终写入成功（不再一抖就丢）', async () => {
    failThenSucceed(1, 'terminated: other side closed');
    const { memorizeMessage } = await loadFreshChroma();
    await memorizeMessage(CHAT, msg('在吗', 1));
    expect(upsertSpy).toHaveBeenCalledTimes(2);
    expect(upsertLexicalSpy).toHaveBeenCalledTimes(1); // 向量写成功后才写词法
  });

  it('①b Connect Timeout / ECONNRESET / socket disconnected 同样重试', async () => {
    for (const m of ['fetch failed: Connect Timeout Error', 'read ECONNRESET', 'Client network socket disconnected']) {
      upsertSpy.mockClear();
      upsertLexicalSpy.mockClear();
      failThenSucceed(2, m);
      const { memorizeMessage } = await loadFreshChroma();
      await memorizeMessage(CHAT, msg('在吗', 2));
      expect(upsertSpy, m).toHaveBeenCalledTimes(3);
    }
  });

  it('② 非瞬断（payload 非法）→ 不重试（重试只是翻倍同样的错）', async () => {
    failThenSucceed(9, 'Bad Request: invalid payload');
    const { memorizeMessage } = await loadFreshChroma();
    await memorizeMessage(CHAT, msg('在吗', 3));
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('③ 三次都瞬断 → 试满三次，并且 warn 照打（失败不会变安静）', async () => {
    failThenSucceed(99, 'terminated: other side closed');
    const { memorizeMessage } = await loadFreshChroma();
    await memorizeMessage(CHAT, msg('在吗', 4));
    expect(upsertSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 4 }),
      'Memory write failed (non-critical)',
    );
  });

  it('③b 三次都失败时**不写词法索引**（两边必须同生同灭）', async () => {
    failThenSucceed(99, 'terminated: other side closed');
    const { memorizeMessage } = await loadFreshChroma();
    await memorizeMessage(CHAT, msg('在吗', 5));
    expect(upsertLexicalSpy).not.toHaveBeenCalled();
  });

  it('④ 退避真的等了（三次尝试之间不是零延迟猛打）', async () => {
    failThenSucceed(99, 'terminated: other side closed');
    const { memorizeMessage } = await loadFreshChroma();
    const start = Date.now();
    await memorizeMessage(CHAT, msg('在吗', 6));
    // 退避 0 + 150 + 400 = 550ms。用真时钟量：假时钟下 memoriseMessage 那次动态
    // `import('./importance.js')`（模块缓存已被别的测试 resetModules 清冷）解析不完，
    // 会直接把测试挂到超时——那不是被测行为，是测试自己的坑。
    expect(Date.now() - start).toBeGreaterThanOrEqual(540);
  });

  it('⑤ 一切正常时行为不变（一次成功，无额外调用）', async () => {
    const { memorizeMessage } = await loadFreshChroma();
    await memorizeMessage(CHAT, msg('在吗', 7));
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertLexicalSpy).toHaveBeenCalledTimes(1);
  });
});
