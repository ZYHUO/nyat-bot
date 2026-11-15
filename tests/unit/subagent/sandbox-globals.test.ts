import { describe, expect, it, vi } from 'vitest';
import { CODEACT_CAPABILITY_METHODS, selectCodeActCapabilities } from '../../../src/sandbox/codeact/capabilities.js';

vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_TIMEOUT_MS: 5000, CODEACT_ISOLATION_ENABLED: false }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

describe('CodeAct host boundary', () => {
  it('exports only explicitly allowed own methods', async () => {
    const find = vi.fn(async () => 'known-chat');
    const host = { chats: { find, constructor: () => 'escape' }, computer: { run: vi.fn() } };
    const capabilities = selectCodeActCapabilities(host, CODEACT_CAPABILITY_METHODS);
    expect(await capabilities.get('chats.find')!('known')).toBe('known-chat');
    expect(find).toHaveBeenCalledWith('known');
    expect(capabilities.has('chats.constructor')).toBe(false);
    expect(capabilities.has('computer.run')).toBe(false);
  });

  it('never executes generated code when OS isolation is disabled', async () => {
    const { runHostCodeForTest } = await import('../../../src/subagent/executor.js');
    const send = vi.fn();
    const host = { telegram: { sendText: send }, runtime: { flushBookkeeping: async () => {} } } as never;
    const result = await runHostCodeForTest('globalThis.__unsafeCodeActExecuted = true; await telegram.sendText("no");', host,
      { isClosed: () => false, onTimeout: () => {}, timeoutMs: 1000 });
    expect(result).toEqual({ ok: false, output: 'codeact_isolation_disabled' });
    expect((globalThis as Record<string, unknown>)['__unsafeCodeActExecuted']).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
