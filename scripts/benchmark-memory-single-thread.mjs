// Isolated synthetic benchmark; no bot configuration, Qdrant or database access.
// Tests session threading only: every call remains one text, mean pooling + normalization.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const cacheDir = resolve(option('cache-dir', '.benchmark-cache'));
const output = resolve(option('output', 'benchmark-memory-single-thread.json'));
const model = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const templates = [
  '项目周会改到周四下午三点，线上开会。',
  '服务器数据库连接数已经用完，调整连接池后恢复，请保留处理记录。',
  '小陈对花生过敏，点餐时需要避开花生和花生油。',
  '这是用于性能测试的合成中文段落，包含聊天上下文、服务故障处理、日期和数字，不含用户原始消息。',
];
const inputs = Array.from({ length: 16 }, (_, index) => {
  const text = `样本${index}：${templates[index % 4].repeat([1, 2, 5, 14][index % 4])}`;
  return `${text.length}:${text.slice(0, 512)}`;
});
const module = await import('onnxruntime-node');
const runtime = module.default ?? module;
const originalCreate = runtime.InferenceSession.create;
let configuredSessions = 0;
runtime.InferenceSession.create = function (buffer, options = {}) {
  configuredSessions++;
  return originalCreate.call(this, buffer, { ...options, intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' });
};
const { pipeline, env } = await import('@xenova/transformers');
env.cacheDir = cacheDir;
env.allowRemoteModels = false;
const report = {
  model, inputMode: 'production-cache-key-v1', cpu: cpus()[0]?.model, node: process.version,
  samples: inputs.length, concurrentLoad: 'Live migration with default ONNX threading and ffmpeg build; timing is indicative under contention.',
  scenarios: [],
};
let reference;
for (const threads of [1, 0]) {
  if (threads === 0) runtime.InferenceSession.create = originalCreate;
  const initialized = performance.now();
  const extractor = await pipeline('feature-extraction', model, { quantized: true, local_files_only: true });
  try {
    await extractor('12:中文预热', { pooling: 'mean', normalize: true });
    const loadAndWarmupMs = performance.now() - initialized;
    const started = performance.now();
    const cpu = process.cpuUsage();
    const latencies = [], vectors = [];
    for (const input of inputs) {
      const now = performance.now();
      const result = await extractor(input, { pooling: 'mean', normalize: true });
      const vector = Array.from(result.data);
      if (vector.length !== 384 || !vector.every(Number.isFinite)) throw new Error('Invalid model output');
      vectors.push(vector);
      latencies.push(performance.now() - now);
    }
    const wallMs = performance.now() - started;
    const cpuMicroseconds = process.cpuUsage(cpu);
    reference ??= vectors;
    let maxAbsoluteDifference = 0, minimumCosine = 1;
    for (let i = 0; i < vectors.length; i++) {
      let dot = 0, aa = 0, bb = 0;
      for (let j = 0; j < 384; j++) {
        const a = vectors[i][j], b = reference[i][j];
        maxAbsoluteDifference = Math.max(maxAbsoluteDifference, Math.abs(a - b));
        dot += a * b; aa += a * a; bb += b * b;
      }
      minimumCosine = Math.min(minimumCosine, dot / Math.sqrt(aa * bb));
    }
    const ordered = [...latencies].sort((a, b) => a - b);
    const scenario = {
      threads, configuredSessions: threads ? configuredSessions : 0, loadAndWarmupMs,
      wallMs, cpuMicroseconds, throughputPerSec: inputs.length * 1000 / wallMs,
      p50Ms: ordered[7], p95Ms: ordered[15], latencies,
      vectorComparison: { maxAbsoluteDifference, minimumCosine, withinTolerance: minimumCosine >= 0.9999 && maxAbsoluteDifference <= 0.00005 },
    };
    report.scenarios.push(scenario);
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(scenario));
  } finally { await extractor.dispose(); }
}
runtime.InferenceSession.create = originalCreate;
if (!report.scenarios.every((scenario) => scenario.vectorComparison.withinTolerance)) process.exitCode = 1;
