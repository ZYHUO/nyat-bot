// Synthetic, read-only model benchmark. Does not import bot env or contact Qdrant.
// Run the whole command inside a CPU/memory-limited scope; no migration is started.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';

const format = (text) => `${text.length}:${text.slice(0, 512)}`;

if (!isMainThread) {
  let extractor;
  let patchedSessions = 0;
  try {
    if (workerData.threads) {
      const module = await import('onnxruntime-node');
      const runtime = module.default ?? module;
      const original = runtime.InferenceSession.create;
      runtime.InferenceSession.create = function (buffer, options = {}) {
        patchedSessions++;
        return original.call(this, buffer, {
          ...options, intraOpNumThreads: workerData.threads, interOpNumThreads: 1, executionMode: 'sequential',
        });
      };
    }
    const { pipeline, env } = await import('@xenova/transformers');
    env.cacheDir = workerData.cacheDir;
    env.allowRemoteModels = false;
    const started = performance.now();
    extractor = await pipeline('feature-extraction', workerData.model, { quantized: true, local_files_only: true });
    await extractor(format('这是一条中文预热消息。'), { pooling: 'mean', normalize: true });
    if (workerData.threads && !patchedSessions) throw new Error('ONNX thread configuration was not applied');
    parentPort.postMessage({ ready: true, loadAndWarmupMs: performance.now() - started, patchedSessions });
    parentPort.on('message', async (job) => {
      try {
        if (job.stop) { await extractor.dispose(); parentPort.postMessage({ stopped: true }); parentPort.close(); return; }
        const started = performance.now();
        // One input per call: no padding or batch pooling changes.
        const output = await extractor(job.input, { pooling: 'mean', normalize: true });
        parentPort.postMessage({ index: job.index, vector: Array.from(output.data), elapsedMs: performance.now() - started });
      } catch (error) {
        parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
    parentPort.close();
  }
} else {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const model = option('model', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  const cacheDir = resolve(option('cache-dir', '.benchmark-cache'));
  const outputPath = resolve(option('output', 'benchmark-memory-workers.json'));
  const count = Number(option('samples', '64'));
  if (!Number.isInteger(count) || count < 8 || count > 256) throw new Error('samples must be between 8 and 256');
  const templates = [
    '项目周会改到周四下午三点，线上开会。',
    '服务器数据库连接数已经用完，调整连接池后恢复，请保留处理记录。',
    '小陈对花生过敏，点餐时需要避开花生和花生油。',
    '这是用于性能测试的合成中文段落，包含聊天上下文、服务故障处理、日期和数字，不含用户原始消息。',
  ];
  const inputs = Array.from({ length: count }, (_, index) => format(
    `样本${index}：${templates[index % templates.length].repeat([1, 2, 5, 14][index % 4])}`,
  ));
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  const report = { model, inputMode: 'production-cache-key-v1', samples: count, distinctInputs: new Set(inputs).size, node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, scenarios: [] };
  let reference;
  for (const config of [{ workers: 1, threads: 0 }, { workers: 1, threads: 1 }, { workers: 2, threads: 1 }, { workers: 4, threads: 1 }]) {
    const workers = [];
    const results = new Array(inputs.length);
    const scenario = { ...config };
    try {
      const loadStart = performance.now();
      const ready = [];
      for (let i = 0; i < config.workers; i++) {
        const worker = new Worker(new URL(import.meta.url), { workerData: { model, cacheDir, threads: config.threads } });
        workers.push(worker);
        ready.push(new Promise((accept, reject) => {
          worker.once('error', reject);
          worker.once('message', (message) => message.error ? reject(new Error(message.error)) : accept(message));
        }));
      }
      scenario.workerInitialization = await Promise.all(ready);
      scenario.loadWallMs = performance.now() - loadStart;
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      let next = 0;
      await Promise.all(workers.map((worker) => new Promise((accept, reject) => {
        const dispatch = () => {
          if (next >= inputs.length) { worker.off('message', handler); accept(); return; }
          const index = next++;
          worker.postMessage({ index, input: inputs[index] });
        };
        const handler = (message) => {
          if (message.error) { reject(new Error(message.error)); return; }
          results[message.index] = message;
          dispatch();
        };
        worker.on('message', handler);
        worker.once('error', reject);
        dispatch();
      })));
      scenario.inferenceWallMs = performance.now() - started;
      scenario.cpuMicroseconds = process.cpuUsage(cpuStart);
      scenario.throughputPerSec = inputs.length * 1000 / scenario.inferenceWallMs;
      scenario.latencyP50Ms = percentile(results.map((result) => result.elapsedMs), 0.5);
      scenario.latencyP95Ms = percentile(results.map((result) => result.elapsedMs), 0.95);
      scenario.processRssBytes = process.memoryUsage().rss;
      if (!reference) reference = results.map((result) => result.vector);
      let maxAbsoluteDifference = 0, minimumCosine = 1;
      for (let index = 0; index < results.length; index++) {
        const actual = results[index].vector;
        const expected = reference[index];
        if (actual.length !== 384 || expected.length !== 384) throw new Error('Invalid vector dimensions');
        let dot = 0, aa = 0, bb = 0;
        for (let d = 0; d < actual.length; d++) {
          maxAbsoluteDifference = Math.max(maxAbsoluteDifference, Math.abs(actual[d] - expected[d]));
          dot += actual[d] * expected[d]; aa += actual[d] ** 2; bb += expected[d] ** 2;
        }
        minimumCosine = Math.min(minimumCosine, dot / Math.sqrt(aa * bb));
      }
      scenario.vectorComparison = { maxAbsoluteDifference, minimumCosine, withinTolerance: maxAbsoluteDifference <= 0.00005 && minimumCosine >= 0.999999 };
    } catch (error) {
      scenario.error = error instanceof Error ? error.message : String(error);
    } finally {
      await Promise.allSettled(workers.map(async (worker) => {
        await Promise.race([
          new Promise((done) => { worker.once('message', done); worker.postMessage({ stop: true }); }),
          new Promise((done) => setTimeout(done, 2000)),
        ]);
        await worker.terminate();
      }));
    }
    report.scenarios.push(scenario);
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ workers: config.workers, threads: config.threads, wallMs: scenario.inferenceWallMs, throughputPerSec: scenario.throughputPerSec, equivalent: scenario.vectorComparison?.withinTolerance, error: scenario.error }));
  }
  if (report.scenarios.some((scenario) => scenario.error || !scenario.vectorComparison?.withinTolerance)) process.exitCode = 1;
}
