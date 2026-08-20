import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, NextFunction } from 'grammy';

vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const hget = vi.fn(async () => null);
vi.mock('../../../../src/db/redis.js', () => ({
  getRedis: () => ({ hget: (...args: unknown[]) => hget(...args) }),
}));

const config = {
  enabled: true,
  redisPrefix: 'xxb:mal:',
  defaultEnabledAfterApproval: false,
  maxSubmissionsPerUserPerDay: 3,
  autoAiReviewOnSubmit: true,
  autoAiReviewMessageLimit: 50,
  aiReviewContextMaxChars: 5000,
  aiApproveAutoEnable: false,
  aiApproveConfidenceThreshold: 0.85,
};

async function importMw() {
  const { createAllowlistMiddleware } = await import('../../../../src/bot/middleware/allowlist.js');
  return createAllowlistMiddleware(config);
}

function makeCtx(overrides: Record<string, unknown> = {}): Context {
  return {
    chat: { id: -100123, type: 'supergroup' },
    ...overrides,
  } as unknown as Context;
}

describe('allowlist middleware', () => {
  beforeEach(() => {
    hget.mockClear();
    hget.mockResolvedValue(null);
  });

  it('my_chat_member update 放行（群不在白名单也要放——入群提示/自动审核靠它）', async () => {
    const mw = await importMw();
    const next = vi.fn(async () => undefined) as unknown as NextFunction;
    // 关键回归：这个群故意不在白名单（hget → null），my_chat_member 也必须 next
    const ctx = makeCtx({ myChatMember: { new_chat_member: { status: 'member' } } });
    await mw(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('普通消息：群不在白名单 → 吞掉（不 next）', async () => {
    const mw = await importMw();
    const next = vi.fn(async () => undefined) as unknown as NextFunction;
    await mw(makeCtx(), next);
    expect(next).not.toHaveBeenCalled();
  });

  it('普通消息：群在白名单（approved+enabled）→ next', async () => {
    hget.mockResolvedValue(JSON.stringify({ approved: true, enabled: true }));
    const mw = await importMw();
    const next = vi.fn(async () => undefined) as unknown as NextFunction;
    await mw(makeCtx(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('DM 不拦', async () => {
    const mw = await importMw();
    const next = vi.fn(async () => undefined) as unknown as NextFunction;
    await mw(makeCtx({ chat: { id: 12345, type: 'private' } }), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('白名单开关关闭时全放行', async () => {
    const { createAllowlistMiddleware } = await import('../../../../src/bot/middleware/allowlist.js');
    const mw = createAllowlistMiddleware({ ...config, enabled: false });
    const next = vi.fn(async () => undefined) as unknown as NextFunction;
    await mw(makeCtx(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
