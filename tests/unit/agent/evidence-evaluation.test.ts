import { describe, expect, it } from 'vitest';

describe('offline artifact acceptance harness', () => {
  it('runs real file-producing tasks with positive and negative controls', async () => {
    const { runEvidenceEvaluation } = await import('../../../scripts/eval-agent-evidence.js');
    const report = await runEvidenceEvaluation();
    expect(report.kind).toBe('engineering_acceptance_not_agi_benchmark');
    expect(report.failed).toBe(0);
    expect(report.cases.length).toBeGreaterThanOrEqual(8);
    expect(report.cases.some((c) => c.name === 'real-command-json-computation' && c.actual === 'verified')).toBe(true);
    expect(report.cases.some((c) => c.name === 'model-self-check-not-independent' && c.actual === 'unverified')).toBe(true);
    expect(report.cases.some((c) => c.name === 'failed-check-then-repair' && c.actual === 'verified')).toBe(true);
  });
});
