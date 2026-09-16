import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAcceptance, type AcceptanceContract } from '../../../src/agent/task-evidence.js';
import { buildHoldoutSet, runHoldoutEvaluation, type HoldoutTask } from '../../../scripts/eval-holdout.js';

/**
 * P3-4 留出评测:未见过的合成计算任务 × 记忆开关对照。
 * 执行器是确定性的 stub(不是 LLM):ON 组模拟"有正确记忆→一次写对",
 * OFF 组模拟"裸跑→首次写错→按 host 反馈修复"。断言的是评测器本身的
 * 记分能力(delta 计算、任务集完整性、验收器独立性),不是模型能力。
 * 真 LLM 的对照跑由人工用 scripts/eval-holdout-live 做,不进 CI。
 */
describe('holdout memory ablation harness', () => {
  it('scores the same task set under memory ON/OFF with independent acceptance', async () => {
    const tasks = buildHoldoutSet();
    expect(tasks.length).toBeGreaterThanOrEqual(6);
    // 跨域:至少 3 个不同 domain
    expect(new Set(tasks.map((t) => t.domain)).size).toBeGreaterThanOrEqual(3);

    const runOne = async (task: HoldoutTask, memoryOn: boolean): Promise<'verified' | 'failed' | 'unverified'> => {
      const root = await mkdtemp(join(tmpdir(), 'nyat-holdout-case-'));
      try {
        const contract: AcceptanceContract = {
          source: 'caller',
          checks: [{ kind: 'json_field', path: 'result.json', field: ['answer'], equals: task.payload.answer }],
        };
        // ON: 有记忆一次写对; OFF: 裸跑先写错一次再修复(模拟无记忆试错)。
        const first = memoryOn ? task.payload.answer : task.payload.answer + 1;
        await writeFile(join(root, 'result.json'), JSON.stringify({ answer: first }));
        const r1 = await validateAcceptance(root, contract);
        if (r1.status === 'verified') return 'verified';
        await writeFile(join(root, 'result.json'), JSON.stringify({ answer: task.payload.answer }));
        const r2 = await validateAcceptance(root, contract);
        return r2.status;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    const report = await runHoldoutEvaluation(runOne);
    expect(report.kind).toBe('holdout_memory_ablation_not_agi_benchmark');
    expect(report.cases).toHaveLength(tasks.length);
    // stub 执行器下 ON 全过、OFF 经修复也过 —— 评测器记分正确即算 pass。
    // 真实增益(delta>0)只能由真 LLM 跑出,此处不断言 delta。
    expect(report.memoryOn.passed).toBe(tasks.length);
    expect(report.memoryOff.passed).toBe(tasks.length);
  });

  it('acceptance is independent of the executor claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nyat-holdout-indep-'));
    try {
      const contract: AcceptanceContract = {
        source: 'caller',
        checks: [{ kind: 'json_field', path: 'result.json', field: ['answer'], equals: 87 }],
      };
      await writeFile(join(root, 'result.json'), JSON.stringify({ answer: 86 }));
      const r = await validateAcceptance(root, contract);
      expect(r.status).toBe('failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
