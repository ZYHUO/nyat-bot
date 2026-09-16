import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { validateAcceptance, type AcceptanceContract } from '../src/agent/task-evidence.js';
import { buildHoldoutSet, type HoldoutTask } from './eval-holdout.js';

// 真 LLM 留出对照: 同一任务集 × 记忆开关(ON=提示里注入一条相关记忆, OFF=裸跑)。
// 度量「记忆是否提升真模型产物验收通过率」。需 NYAT_LIVE_ENV opt-in(读生产 .env 的
// StepFun 配额), 不进 CI, 手动跑。token 多, 12 次小调用可接受。
// 用法: NYAT_LIVE_ENV=/root/xxb-ts/.env tsx scripts/eval-holdout-live.ts
const envPath = process.env['NYAT_LIVE_ENV'];
if (!envPath) throw new Error('Set NYAT_LIVE_ENV to explicitly opt into the live holdout run');
const config = parse(await readFile(envPath));
const prefix = 'AI_PROVIDER_STEPFUN_';
const endpoint = config[`${prefix}ENDPOINT`];
const key = config[`${prefix}KEY`];
const model = config[`${prefix}MODEL`];
if (!endpoint || !key || !model) throw new Error('Required provider configuration missing');
const url = endpoint.replace(/\/$/, '').replace(/\/messages$/, '') + '/messages';

const MEMORY_LINE = '经验: 这类任务里, 凡是题面没直接给答案数字的, 都要先自己算一遍再写文件, 不要照抄题面数字。写 JSON 时数字不要加引号, 否则 host 验收会判失败。';

function contractFor(task: HoldoutTask): AcceptanceContract {
  if (task.artifactKind === 'json_sum') {
    return { source: 'caller', checks: [
      { kind: 'json_field', path: 'result.json', field: ['answer'], equals: task.payload.answer },
    ] };
  }
  // csv/txt 用 nonempty_file 保底 + host 侧字符串包含答案(validateAcceptance 只管存在性,
  // 内容比对由本脚本收尾时读文件判, 避免验收器类型外溢)。
  const file = task.artifactKind === 'csv_digest' ? 'ledger.csv' : 'report.txt';
  return { source: 'caller', checks: [{ kind: 'nonempty_file', path: file }] };
}

/** csv/txt 的答案包含检查(验收器无 text_marker, host 侧补判)。 */
async function fileContains(root: string, file: string, answer: number): Promise<boolean> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const content = await readFile(join(root, file), 'utf8');
    return content.includes(String(answer));
  } catch { return false; }
}

function promptFor(task: HoldoutTask, memoryOn: boolean): string {
  const file = task.artifactKind === 'json_sum' ? 'result.json' : task.artifactKind === 'csv_digest' ? 'ledger.csv' : 'report.txt';
  const mem = memoryOn ? `${MEMORY_LINE}\n` : '';
  // json_sum: content 必须是 {"answer":数字} 文档(验收器读 field ['answer'])。
  // csv/txt: content 是任意包含答案数字的文本。
  const shape = task.artifactKind === 'json_sum'
    ? '文件内容必须是严格 JSON 文档 {"answer":<数字>}，例如 {"answer":87}。不要裸数字、不要 markdown。'
    : '文件内容是纯文本，必须包含答案数字。';
  return `${mem}任务: ${task.goal}\n把答案写入 ${file}。${shape}只输出 JSON {"action":"write_file","path":"<文件名>","content":"<文件内容>"}，不要其他内容。`;
}

async function runOne(task: HoldoutTask, memoryOn: boolean): Promise<'verified' | 'failed' | 'unverified'> {
  const root = await mkdtemp(join(tmpdir(), 'nyat-holdout-live-'));
  try {
    const messages: { role: string; content: string }[] = [{ role: 'user', content: promptFor(task, memoryOn) }];
    for (let turn = 1; turn <= 3; turn++) {
      const response = await fetch(url, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
      }, body: JSON.stringify({ model, max_tokens: 2048, messages }), signal: AbortSignal.timeout(90000) });
      if (!response.ok) return 'unverified';
      const body = await response.json() as { content?: { type?: string; text?: string }[] };
      const text = body.content?.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('') ?? '';
      let action: Record<string, unknown>;
      try { action = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); }
      catch {
        messages.push({ role: 'assistant', content: text || '(empty)' }, { role: 'user', content: '输出非法 JSON，重试，只输出指定 JSON action。' });
        continue;
      }
      const fp = typeof action['path'] === 'string' ? action['path'] : '';
      const fc = typeof action['content'] === 'string' ? action['content'] : null;
      if (action['action'] !== 'write_file' || !fp || fc === null || fc.length > 20000) return 'failed';
      // 沙盒内文件名白名单(防模型写 ../../etc 之类)
      if (!/^[a-z0-9_.-]+\.(json|csv|txt)$/i.test(fp)) return 'failed';
      await writeFile(join(root, fp), fc);
      const result = await validateAcceptance(root, contractFor(task));
      // csv/txt: 验收器只判非空, 答案包含由 host 补判(两道都过才算 verified)
      let ok = result.status === 'verified';
      if (ok && task.artifactKind !== 'json_sum') {
        const file = task.artifactKind === 'csv_digest' ? 'ledger.csv' : 'report.txt';
        ok = await fileContains(root, file, task.payload.answer);
      }
      if (ok) return 'verified';
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Host 验收失败: ${JSON.stringify(result)}。重新计算并修复。` });
    }
    return 'failed';
  } finally { await rm(root, { recursive: true, force: true }); }
}

const tasks = buildHoldoutSet();
const cases: { id: string; domain: string; memoryOn: string; memoryOff: string }[] = [];
let onPassed = 0, offPassed = 0;
for (const t of tasks) {
  const on = await runOne(t, true);
  const off = await runOne(t, false);
  if (on === 'verified') onPassed++;
  if (off === 'verified') offPassed++;
  cases.push({ id: t.id, domain: t.domain, memoryOn: on, memoryOff: off });
  console.log(`${t.id}: ON=${on} OFF=${off}`);
}
console.log(JSON.stringify({
  kind: 'holdout_memory_ablation_live_not_agi_benchmark',
  model, memoryOn: { passed: onPassed, failed: tasks.length - onPassed },
  memoryOff: { passed: offPassed, failed: tasks.length - offPassed },
  delta: onPassed - offPassed, cases,
}, null, 2));
if (onPassed + offPassed === 0) process.exitCode = 1;
