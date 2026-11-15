import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPORT_NOW = '2026-11-15T12:00:00.000Z';
const base = Date.parse('2026-11-15T10:00:00Z');
export const reportRows = [
  { time: base - 4 * 86_400_000, msg: 'rejected semantic repeat' },
  { time: base, msg: 'Bot started (polling)' },
  { time: base + 1_000, msg: 'message in', chatId: -100, text: '湖水安静，天色明亮' },
  { time: base + 2_000, msg: 'host sendText', chatId: -100, taskId: 'synthetic-a', text: '湖水安静', preview: '湖水安静' },
  { time: base + 3_000, msg: 'message in', chatId: -100, text: '请说一种水果' },
  { time: base + 4_000, msg: 'host sendText', chatId: -100, taskId: 'synthetic-b', text: '苹果', preview: '苹果' },
  { time: base + 4_100, msg: 'task delivery recorded', taskId: 'synthetic-a' },
  { time: base + 4_200, msg: 'task delivery recorded', taskId: 'synthetic-b' },
  { time: base + 5_000, msg: 'message in', chatId: -100, text: '一条合成输入' },
  { time: base + 6_000, msg: 'message in', chatId: -100, text: '另一条合成输入' },
  { time: base + 7_000, msg: 'message in', chatId: -100, isEdit: true, text: '合成编辑' },
  { time: base + 8_000, msg: 'agent interrupt triage: addressed (directly at the bot)' },
  { time: base + 9_000, msg: 'agent interrupt triage: addressed (directly at the bot)' },
  { time: base + 10_000, msg: 'agent interrupt triage: background (chat noise while task runs)' },
  ...['reply', 'wait', 'pass', 'react'].map((act, i) => ({ time: base + 11_000 + i * 1000, msg: 'Heart decision', act })),
  { time: base + 15_000, msg: 'Meta heart: pass', why: 'llm_failed' },
  { time: base + 16_000, msg: 'Meta heart: pass', why: 'parse_failed' },
  { time: base + 17_000, msg: 'Meta heart: pass', why: 'not_interested' },
  { time: base + 18_000, msg: 'shadow decision THREW (counted as silent)' },
  { time: base + 19_000, msg: 'rejected semantic repeat' },
  { time: base + 20_000, msg: 'rejected semantic repeat' },
  { time: Date.parse(REPORT_NOW) + 86_400_000, msg: 'rejected semantic repeat' },
];

/** Each suite owns its temp files; subprocesses cannot fetch, read .env, or
 * accidentally share another test's app.log. No shell/npx/platform commands. */
export function reportFixture(rows: readonly Record<string, unknown>[] = reportRows) {
  const directory = mkdtempSync(join(tmpdir(), 'nyat-report-'));
  const logFile = join(directory, 'input.jsonl');
  const metricsFile = join(directory, 'metrics.txt');
  const networkMarker = join(directory, 'network-attempt');
  const guard = join(directory, 'deny-network.mjs');
  writeFileSync(logFile, ['not json', ...rows.map(row => JSON.stringify(row))].join('\n') + '\n');
  writeFileSync(metricsFile, 'llm_requests_total{label="synthetic",outcome="ok"} 3\nllm_requests_total{label="synthetic",outcome="error"} 1\n');
  writeFileSync(guard, `import {writeFileSync} from 'node:fs'; globalThis.fetch=()=>{writeFileSync(${JSON.stringify(networkMarker)},'attempt'); throw new Error('network forbidden in report fixture');};`);
  const cache = new Map<string, { code: number | null; out: string; err: string }>();
  return {
    logFile, metricsFile,
    run(script: string, args: string[] = [], includeInputs = true) {
      const key = JSON.stringify([script, args, includeInputs]);
      const cached = cache.get(key);
      if (cached) return cached;
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, '--import', 'tsx',
        resolve(script), ...args, ...(includeInputs ? ['--log-file', logFile, '--now', REPORT_NOW] : [])],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 25_000, maxBuffer: 4 * 1024 * 1024 });
      if (result.error) throw result.error;
      if (existsSync(networkMarker)) throw new Error('report attempted network access');
      const output = { code: result.status, out: result.stdout, err: result.stderr };
      cache.set(key, output);
      return output;
    },
    cleanup() {
      if (resolve(directory) !== directory || !directory.startsWith(join(tmpdir(), 'nyat-report-'))) throw new Error('unexpected_report_fixture_path');
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
