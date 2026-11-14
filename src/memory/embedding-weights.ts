import { openSync, closeSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 本地缓存里必须存在的 onnx 权重文件名。`quantized` 是 transformers
 * `from_pretrained` 的默认取值，所以带量化的那份是常规路径；不带量化的留着兜底。
 */
const EMBED_ONNX_FILES = ['model_quantized.onnx', 'model.onnx'] as const;
/** onnx 权重是 MB 级二进制；判定"在本地"的下限，防 redirect stub 混进来（见 findEmbedOnnxWeights）。 */
const EMBED_ONNX_MIN_BYTES = 1_000_000;

/**
 * 权重真的在本地缓存里吗？返回命中的文件名，否则 null。
 *
 * 不能只 `existsSync`：HF 的 307 redirect stub 只有 ~1KB、是 ASCII 文本
 * （`Found. Redirecting to https://us.aws.cdn.hf.co/...`），curl 不带 `-L` 就把它
 * 原样存下来了。把它当"已缓存"塞进 `local_files_only`，只会换来一句读不懂的
 * onnx 解析错，比明说"权重没下载"更难查。所以这里体积 + 头部都验。
 */
export function findEmbedOnnxWeights(onnxDir: string): string | null {
  for (const f of EMBED_ONNX_FILES) {
    const p = join(onnxDir, f);
    try {
      if (statSync(p).size < EMBED_ONNX_MIN_BYTES) continue;
      const fd = openSync(p, 'r');
      try {
        const buf = Buffer.alloc(64);
        const n = readSync(fd, buf, 0, 64, 0);
        const head = buf.subarray(0, n).toString('latin1');
        if (/^\s*(?:found\.redirecting|<|<!doctype)/i.test(head)) continue; // redirect stub / HTML 错误页
      } finally {
        closeSync(fd);
      }
      return f;
    } catch {
      continue; // 不存在 / 不可读 → 看下一个
    }
  }
  return null;
}

/**
 * `pipeline()` 除了 onnx 权重还要读这三个 JSON（configs.js / tokenizers.js）。
 * 2026-09-24 只把权重 curl 进了缓存，chroma.ts 见到权重就上 `local_files_only`，
 * 于是 tokenizer.json 连下载的机会都没了 —— 六天 18,915 次
 * `Memory embedding unavailable`，零次成功。"锁离线"必须以整套文件为条件。
 */
const EMBED_JSON_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'] as const;

export function findMissingEmbedJson(modelDir: string): string[] {
  const missing: string[] = [];
  for (const f of EMBED_JSON_FILES) {
    try {
      const p = join(modelDir, f);
      if (statSync(p).size === 0) { missing.push(f); continue; }
      const fd = openSync(p, 'r');
      try {
        const buf = Buffer.alloc(16);
        const n = readSync(fd, buf, 0, 16, 0);
        const head = buf.subarray(0, n).toString('latin1');
        if (!/^\s*\{/.test(head)) missing.push(f); // redirect stub / HTML 错误页
      } finally {
        closeSync(fd);
      }
    } catch {
      missing.push(f);
    }
  }
  return missing;
}
