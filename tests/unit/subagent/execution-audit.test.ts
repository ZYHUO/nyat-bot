import { describe, expect, it } from 'vitest';
import { createExecutionAudit } from '../../../src/agent/execution-audit.js';

describe('host execution telemetry', () => {
  it('records actual success, return failures and thrown errors, not claimed summaries', async () => {
    const audit = createExecutionAudit('/tmp');
    const tools = audit.wrap('computer', {
      async run(ok: boolean) { return { exitCode: ok ? 0 : 1 }; },
      async fail() { throw new Error('secret'); },
    });
    await tools.run(false); await tools.run(true);
    await expect(tools.fail()).rejects.toThrow('secret');
    expect(audit.snapshot()).toMatchObject({ totalCalls: 3, failedCalls: 2, retryCount: 1 });
    expect(JSON.stringify(audit.snapshot())).not.toContain('secret');
    expect((await audit.verify()).status).toBe('unverified');
  });
  it('cannot overwrite caller criteria and bounds stored receipts', async () => {
    const audit = createExecutionAudit('/tmp', { source: 'caller', checks: [{ kind: 'nonempty_file', path: 'missing' }] });
    expect(() => audit.propose([])).toThrow('caller_contract');
    const tools = audit.wrap('tools', { async ping() { return { ok: true }; } });
    for (let i=0;i<110;i++) await tools.ping();
    expect(audit.snapshot().totalCalls).toBe(110);
    expect(audit.snapshot().receipts).toHaveLength(100);
  });
});
