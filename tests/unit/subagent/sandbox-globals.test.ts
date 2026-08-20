import { describe, expect, it, vi } from 'vitest';

// 2026-08-19 事故回归：host-api 加了 chats/goals 命名空间但 runHostCode 的
// AsyncFunction 没注入同名全局 → 模型在沙盒里调 chats.find 得到
// ReferenceError: chats is not defined（bot 对用户说「工具调用不起来」是真话）。
// 本测试直接跑 runHostCode，锁死「文档里有的命名空间必须真实存在于沙盒」。

const envBase = {
  CODEACT_TIMEOUT_MS: 5000,
  MASTER_UID: 6251541967,
};
vi.mock('../../../src/env.js', () => ({ env: () => envBase }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

function makeHostStub() {
  return {
    telegram: { __ns: 'telegram' },
    memory: { __ns: 'memory' },
    stickers: { __ns: 'stickers' },
    web: { __ns: 'web' },
    meta: { __ns: 'meta' },
    runtime: {
      __ns: 'runtime',
      flushBookkeeping: async () => undefined,
    },
    computer: { __ns: 'computer' },
    chats: { __ns: 'chats' },
    goals: { __ns: 'goals' },
    members: { __ns: 'members' },
    allowlist: { __ns: 'allowlist' },
  } as never;
}

describe('runHostCode sandbox globals', () => {
  it('all documented namespaces are defined in the sandbox', async () => {
    const { runHostCodeForTest } = await import('../../../src/subagent/executor.js');
    const host = makeHostStub();
    const r = await runHostCodeForTest(
      `return [
        typeof telegram, typeof memory, typeof stickers, typeof web,
        typeof meta, typeof runtime, typeof computer,
        typeof chats, typeof goals, typeof members, typeof allowlist, typeof console,
      ].join(',');`,
      host,
      { isClosed: () => false, onTimeout: () => undefined, timeoutMs: 30_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe(
      'object,object,object,object,object,object,object,object,object,object,object,object',
    );
  }, 20_000);

  it('chats/goals/members/allowlist receive the host implementations', async () => {
    const { runHostCodeForTest } = await import('../../../src/subagent/executor.js');
    const host = makeHostStub();
    const r = await runHostCodeForTest(
      `return chats.__ns + '/' + goals.__ns + '/' + members.__ns + '/' + allowlist.__ns;`,
      host,
      { isClosed: () => false, onTimeout: () => undefined, timeoutMs: 30_000 },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe('chats/goals/members/allowlist');
  }, 20_000);
});
