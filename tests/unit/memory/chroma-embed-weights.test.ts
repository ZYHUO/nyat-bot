/**
 * embedding 的「本地权重」判定 + 离线装载。
 *
 * 这条锁的是 2026-09-21 那次误诊的**修复本身**会不会退回去：
 * 只要磁盘上有合法 onnx 权重，chroma.ts 就必须给 pipeline 传 `local_files_only: true`。
 * 这条一旦失效，proxy 一抖 memory 就又会被兜进 `Memory write failed` 里，
 * 而且从日志上看不出是 embedding 的锅（这正是原来被误诊成 Qdrant 的原因）。
 *
 * 两条容易被忽略的判据：
 *   ① HF 的 307 redirect stub 只有 ~1KB、是 ASCII 文本 —— 不能算「已在本地」
 *      （上一次抓权重时 curl 忘了 `-L`，就存下来一个这种文件）。
 *   ② 权重要够大（onnx 是 MB 级）——空文件/半截文件也不算。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const envState = {
  MEMORY_EMBED_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  MEMORY_COLLECTION: 'probe_unit_col',
  MEMORY_MIN_SCORE: 0,
  MEMORY_HYBRID_ENABLED: false,
  MEMORY_DEDUP_ENABLED: false,
  MEMORY_DEDUP_THRESHOLD: 0.93,
  MEMORY_CROSS_CONTEXT_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: false,
};
vi.mock('../../../src/env.js', () => ({ env: () => envState }));
const warnSpy = vi.fn();
vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() }),
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

// ── 可控的假 embedding / 假 Qdrant ──────────────────────────
/** pipeline() 收到的第二个参数（{ progress_callback, local_files_only? }）。 */
const pipelineCalls: Record<string, unknown>[] = [];
/** 每次测试换一个 cacheDir，控制"本地有没有权重"。 */
let cacheDir = '';
const upsertSpy = vi.fn(async () => ({}));
vi.mock('@xenova/transformers', () => ({
  env: { get cacheDir() { return cacheDir; } },
  pipeline: async (_task: string, _model: string, opts: Record<string, unknown> = {}) => {
    pipelineCalls.push(opts);
    return async () => ({ data: new Float32Array(384).fill(0.1) });
  },
}));
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

const { findEmbedOnnxWeights } = await import('../../../src/memory/chroma.js');

const MODEL = envState.MEMORY_EMBED_MODEL;
const CHAT = -100;
const msg = (messageId: number) => ({
  role: 'user' as const, uid: 1, username: 'u', fullName: 'U', timestamp: 0,
  messageId, textContent: '在吗', isForwarded: false, isBot: false,
});

/** 造一个"像 onnx"的目录：head 是二进制，体积 > 1MB。 */
function makeFakeOnnx(root: string, file = 'model_quantized.onnx'): void {
  const dir = join(root, MODEL, 'onnx');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), Buffer.concat([Buffer.from([0x08, 0x01, 0x12, 0x00]), Buffer.alloc(2 * 1024 * 1024, 0x7f)]));
}

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'xxb-embed-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) { try { rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  pipelineCalls.length = 0;
  upsertSpy.mockClear();
  warnSpy.mockClear();
});

describe('findEmbedOnnxWeights —— "已在本地"的判定', () => {
  it('① 合法 onnx（MB 级二进制）→ 认', () => {
    const root = tmp();
    makeFakeOnnx(root);
    expect(findEmbedOnnxWeights(join(root, MODEL, 'onnx'))).toBe('model_quantized.onnx');
  });

  it('② 目录里什么都没有 → null', () => {
    const root = tmp();
    mkdirSync(join(root, MODEL, 'onnx'), { recursive: true });
    expect(findEmbedOnnxWeights(join(root, MODEL, 'onnx'))).toBeNull();
  });

  it('③ HF 的 307 redirect stub（~1KB ASCII）→ null，不能当已缓存', () => {
    const root = tmp();
    const dir = join(root, MODEL, 'onnx');
    mkdirSync(dir, { recursive: true });
    // 上次抓权重时 curl 漏了 -L，存下来的就是这个：一行 "Found. Redirecting to ..."
    writeFileSync(join(dir, 'model_quantized.onnx'),
      'Found. Redirecting to https://us.aws.cdn.hf.co/xet-bridge-us/64623c13d290a75bd98bdc54/1bdde2?X-Amz-Signature=abc');
    expect(findEmbedOnnxWeights(dir)).toBeNull();
  });

  it('④ HTML 错误页 / 太小 → null', () => {
    const root = tmp();
    const dir = join(root, MODEL, 'onnx');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'model_quantized.onnx'), '<!DOCTYPE html><html><body>503 Service Unavailable</body></html>');
    writeFileSync(join(dir, 'model.onnx'), Buffer.alloc(512, 0)); // 半截文件
    expect(findEmbedOnnxWeights(dir)).toBeNull();
  });

  it('⑤ quantized 缺、非量化的在（MB 级）→ 认非量化那份（兜底）', () => {
    const root = tmp();
    makeFakeOnnx(root, 'model.onnx');
    const dir = join(root, MODEL, 'onnx');
    expect(findEmbedOnnxWeights(dir)).toBe('model.onnx');
  });
});

describe('getEmbedder 的离线装载', () => {
  it('⑥ 权重在本地 → pipeline 收到 local_files_only:true', async () => {
    const root = tmp();
    makeFakeOnnx(root);
    cacheDir = root;
    const { memorizeMessage: fresh } = await importFresh();
    await fresh(CHAT, msg(1));
    expect(pipelineCalls.at(-1)).toMatchObject({ local_files_only: true });
    expect(upsertSpy).toHaveBeenCalledTimes(1); // 装载没被打断，写入照常
  });

  it('⑦ 权重不在本地 → 不带 local_files_only，并告警指明出路', async () => {
    const root = tmp(); // 空目录
    cacheDir = root;
    const { memorizeMessage: fresh } = await importFresh();
    await fresh(CHAT, msg(2));
    expect(pipelineCalls.at(-1)).not.toHaveProperty('local_files_only');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: MODEL }),
      expect.stringContaining('scripts/fetch-embed-model.mts'),
    );
  });
});

/** chroma.ts 的 getEmbedder() 是进程内单例 —— 换 cacheDir 得换一份模块实例。 */
async function importFresh(): Promise<{ memorizeMessage: (c: number, m: unknown) => Promise<void> }> {
  vi.resetModules();
  const mod = await import('../../../src/memory/chroma.js');
  return { memorizeMessage: mod.memorizeMessage as unknown as (c: number, m: unknown) => Promise<void> };
}
