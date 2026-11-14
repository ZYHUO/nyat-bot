import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';

const f = vi.hoisted(() => ({
  config: { META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true, META_SUBAGENT_CHAT_IDS: [42], META_ACTIVATED_AT_SEC: 100 },
  archive: vi.fn(async () => 1), state: vi.fn(), persist: vi.fn(), send: vi.fn(), collect: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ hsetnx: f.archive }) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { throw new Error('unexpected_database_access'); } }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: f.state }));
vi.mock('../../../src/subagent/task-store.js', () => ({ persistCodeActTask: f.persist }));
vi.mock('../../../src/subagent/prompt-inputs.js', () => ({ collectPromptInputs: f.collect }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendChatAction: f.send, sendMessage: f.send, sendSticker: f.send, reactToMessage: f.send }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
import { runCodeActTask } from '../../../src/subagent/executor.js';

beforeEach(() => {
  vi.clearAllMocks();
  f.config.META_SUBAGENT_ENABLED = true;
  f.config.META_ACTIVATED_AT_SEC = 100;
});
describe('executor activation boundary on local and resumed tasks', () => {
  it.each([0, 4])('holds old segment %i before state, persistence, prompt collection or typing', async (segment) => {
    const task: DispatchTask = { id: 'synthetic-held', chatId: 42, createdAt: 99000, status: 'queued', segment, contentDirection: 'old synthetic task' };
    const before = structuredClone(task);
    await runCodeActTask(task);
    expect(task).toEqual(before);
    expect(f.archive).toHaveBeenCalledOnce();
    const args = f.archive.mock.calls[0] as unknown as [string, string, string];
    expect(args[0]).toBe('xxb:codeact:activation-held');
    expect(JSON.parse(args[2])).toMatchObject({ reason: 'predates_activation', task: before });
    for (const effect of [f.state, f.persist, f.send, f.collect]) expect(effect).not.toHaveBeenCalled();
  });
  it('holds new tasks if Meta is switched off after enqueue', async () => {
    f.config.META_SUBAGENT_ENABLED = false;
    await runCodeActTask({ id: 'synthetic-new', chatId: 42, createdAt: 101000, status: 'queued', contentDirection: 'new synthetic task' });
    expect(f.archive).toHaveBeenCalledOnce();
    expect(f.state).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});
