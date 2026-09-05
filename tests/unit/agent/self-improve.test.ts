import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({}) }) }),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mod = await import('../../../src/agent/self-improve.js');

beforeEach(() => {
  mod.__resetSelfEditCooldownForTest();
});

describe('self-edit guardrails', () => {
  it('rejects self-edit within cooldown', () => {
    const first = mod.selfEditPrompt('task/x.md', 'a'.repeat(100), 'first', { skipFsForTest: 'x'.repeat(100) });
    expect(first.ok).toBe(true);
    const second = mod.selfEditPrompt('task/y.md', 'b'.repeat(100), 'second', { skipFsForTest: 'y'.repeat(100) });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/cooldown/);
  });

  it('rejects oversized prompt rewrites', () => {
    const r = mod.selfEditPrompt('task/x.md', 'c'.repeat(20000), 'too big', { skipCooldownForTest: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too large/);
  });
});
