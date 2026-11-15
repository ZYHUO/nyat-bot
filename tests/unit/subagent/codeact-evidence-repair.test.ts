import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../src/env.js', () => ({ env: () => ({
  SANDBOX_ENABLED: true, CODEACT_BANNED_WORDS: [], MASTER_UID: 1,
  CODEACT_TIMEOUT_MS: 5000, POST_TASK_WINDOW_ENABLED: false,
}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/sandbox/paths.js', () => ({
  resolveSandboxRoot: () => state.root,
  resolveInsideSandbox: (path: string) => join(state.root, path),
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: vi.fn(async () => 1), sendChatAction: vi.fn() }));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: () => ({}), getBotUid: () => 999 }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => ({ prepare: () => ({ all: () => [] }) }) }));

// Host acceptance contract, using only a test-owned directory. Filesystem tools
// are deliberately not exposed through the minimal isolated CodeAct RPC profile.
describe('host evidence repair across actions', () => {
  beforeEach(async () => { state.root = await mkdtemp(join(tmpdir(), 'nyat-codeact-test-')); });
  afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

  it('rejects a premature success claim, executes a repair and only then permits completion', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const onEnd = vi.fn();
    const host = createHostApi(1, { onEnd, taskId: 'real-codeact-repair', acceptance: {
      source: 'caller', checks: [{ kind: 'json_field', path: 'answer.json', field: ['value'], equals: 42 }],
    } });
    await host.computer.writeFile('answer.json', '{"value":0}');
    await host.runtime.verifyAcceptance();
    expect(() => host.runtime.endTask('done')).toThrow();
    expect(onEnd).not.toHaveBeenCalled();
    await host.computer.writeFile('answer.json', '{"value":42}');
    const repaired = await host.runtime.verifyAcceptance();
    expect(JSON.stringify(repaired)).toContain('verified');
    host.runtime.endTask('artifact checked');
    expect(onEnd).toHaveBeenCalledWith('artifact checked');
  }, 20000);
});
