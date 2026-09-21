#!/usr/bin/env -S env PATH=/opt/node22/bin:$PATH npx tsx
/**
 * 把 embedding 的 onnx 权重抓进 transformers 的本地缓存，之后整条 memory 写入路径
 * 就可以完全离线跑（chroma.ts 在权重齐了之后会自动加 local_files_only）。
 *
 * 为什么需要这个脚本：
 *   2026-09-21 的 `Memory write failed (non-critical)` 洪水（一天 2280 条）里，
 *   **2270 条不是 Qdrant 的问题**，而是 onnx 权重从未落盘 —— 每次进程启动都从
 *   huggingface.co 重拉，本机 TLS 隧道 5 秒一断，undici 抛
 *   `terminated: other side closed`（栈里是 TLSSocket；Qdrant 是明文 HTTP）。
 *   @xenova/transformers 自己的下载没有重试、也不校验产物，所以 proxy 一抖就丢。
 *
 * 用法：
 *   npx tsx scripts/fetch-embed-model.mts            # 抓权重（默认 MEMORY_EMBED_MODEL 用的那个）
 *   npx tsx scripts/fetch-embed-model.mts --check    # 只检查，缺东西 exit 1
 *   MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2 npx tsx scripts/fetch-embed-model.mts
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { env as transformersEnv } from '@xenova/transformers';

const MODEL = process.env.MODEL ?? 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const CHECK_ONLY = process.argv.includes('--check');
const ONNX_DIR = join(transformersEnv.cacheDir, MODEL, 'onnx');
/** 带量化的那份是 `from_pretrained` 的默认取值，也就是我们要的那份；另一份只是兜底。 */
const FILES = ['model_quantized.onnx', 'model.onnx'];
const MIN_BYTES = 1_000_000;

/** 与 chroma.ts 的 findEmbedOnnxWeights 同一套口径：体积 + 头部都不是 redirect stub / HTML。 */
function usable(p: string): boolean {
  try {
    if (statSync(p).size < MIN_BYTES) return false;
    const head = readFileSync(p).subarray(0, 64).toString('latin1');
    return !/^\s*(?:found\.redirecting|<|<!doctype)/i.test(head);
  } catch {
    return false;
  }
}

function findProxy(): string | undefined {
  return process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
}

function curl(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn('curl', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    c.on('exit', (code) => resolve(code ?? 1));
    c.on('error', () => resolve(1));
  });
}

async function fetchOne(file: string): Promise<void> {
  const url = `https://huggingface.co/${MODEL}/resolve/main/onnx/${file}`;
  const dest = join(ONNX_DIR, file);
  const proxy = findProxy();
  const base = ['-sS', '-L', '-C', '-', '-o', dest, url]; // -L 必须有：不带它会把 307 redirect 文本页存下来
  if (proxy) base.unshift('-x', proxy);
  console.log(`  ${file}\n    url:   ${url}\n    dest:  ${dest}\n    via:   ${proxy ?? '(direct)'}`);

  const attempts: string[][] = [
    ['--retry', '8', '--retry-all-errors', '--retry-delay', '2'],
    ['--connect-timeout', '20', '--speed-time', '30', '--speed-limit', '1024', '--max-time', '1800'],
  ];
  let code = 1;
  for (let i = 0; i < attempts.length && !usable(dest); i++) {
    code = await curl([...base, ...attempts[i]!]);
  }
  if (!usable(dest)) {
    throw new Error(
      `没能把 ${file} 抓到 ${dest}（curl exit ${code}）。多半是出口/proxy 现在不可用。手工试：\n` +
      `    curl -sS -L${proxy ? ` -x '${proxy}'` : ''} -o '${dest}' '${url}'`,
    );
  }
  console.log(`    ok: ${statSync(dest).size} bytes`);
}

async function main(): Promise<void> {
  mkdirSync(ONNX_DIR, { recursive: true });
  console.log(`model:    ${MODEL}\nonnx dir: ${ONNX_DIR}\nmode:     ${CHECK_ONLY ? 'check only' : 'download'}`);

  const have = FILES.filter((f) => usable(join(ONNX_DIR, f)));
  const junk = FILES.filter((f) => existsSync(join(ONNX_DIR, f)) && !usable(join(ONNX_DIR, f)));

  if (CHECK_ONLY) {
    if (have.length === 0) {
      console.error(
        `✗ 本地缓存一个可用的 onnx 都没有 —— memory 写入路径现在每次启动都要联网拉权重，`,
        `这正是 "Memory write failed" 洪水的原因。修：npx tsx scripts/fetch-embed-model.mts`,
      );
      process.exit(1);
    }
    if (junk.length) console.log(`（留意：${junk.join(', ')} 在磁盘上但不是合法权重）`);
    console.log(`✓ embedding 权重齐了：${have.join(', ')}，memory 路径可离线`);
    return;
  }

  if (have.length === 0) {
    console.log(`\n一个可用的权重都没有，开始下载：`);
    await fetchOne(FILES[0]!); // quantized 那份就够
  } else {
    console.log(`✓ 已有可用权重：${have.join(', ')}`);
  }
  for (const f of junk) await fetchOne(f); // 补掉 stub / 半截文件

  const final = FILES.filter((f) => usable(join(ONNX_DIR, f)));
  if (final.length === 0) throw new Error('下载完仍然没有可用权重');
  console.log(`\n完成。重启 xxb-ts 后 chroma.ts 会给 pipeline 传 local_files_only=true，此后不再联网。`);
}

await main();
