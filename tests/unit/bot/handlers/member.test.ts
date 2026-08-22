import { beforeEach, describe, expect, it, vi } from 'vitest';

// member handler：权限切换不重触发入群审核 + 退群只停用不删记录
//（2026-08-22 test 群「我放行过了怎么又问」事故回归）

const setGroupEnabledMock = vi.fn(async () => true);
const removeGroupMock = vi.fn(async () => true);
const reviewOnJoinMock = vi.fn(async () => undefined);
const onBotJoinedGroupMock = vi.fn(async () => undefined);

vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../../src/env.js', () => ({
  env: () => ({ ALLOWLIST_REVIEW_ON_JOIN: true, MASTER_UID: 6251541967 }),
}));
vi.mock('../../../../src/allowlist/allowlist.js', () => ({
  setGroupEnabled: (...a: unknown[]) => setGroupEnabledMock(...a),
  removeGroup: (...a: unknown[]) => removeGroupMock(...a),
  getGroupRecord: vi.fn(async () => null),
  listPending: vi.fn(async () => []),
}));
vi.mock('../../../../src/allowlist/notify.js', () => ({
  onBotJoinedGroup: (...a: unknown[]) => onBotJoinedGroupMock(...a),
}));
vi.mock('../../../../src/allowlist/ai-call.js', () => ({ callAllowlistReviewModel: vi.fn() }));
vi.mock('../../../../src/allowlist/bot-flow.js', () => ({
  reviewOnJoin: (...a: unknown[]) => reviewOnJoinMock(...a),
  defaultGetRecentContext: vi.fn(async () => ''),
}));
vi.mock('../../../../src/bot/bot.js', () => ({ getBotUid: () => 999 }));

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

function makeCtx(oldStatus: string, newStatus: string) {
  return {
    myChatMember: {
      chat: { id: -1004384664699, type: 'supergroup' },
      old_chat_member: { status: oldStatus },
      new_chat_member: { status: newStatus },
      from: { id: 6251541967 },
    },
  };
}

describe('member handler（入群/退群语义）', () => {
  let handlers: Array<(ctx: unknown) => Promise<void>>;
  beforeEach(async () => {
    vi.clearAllMocks();
    handlers = [];
    const bot = {
      on: (_event: string, fn: (ctx: unknown) => Promise<void>) => { handlers.push(fn); },
    };
    const { registerMemberHandler } = await import('../../../../src/bot/handlers/member.js');
    registerMemberHandler(bot as never, config);
  });

  it('真入群（left→member）→ 跑入群审核', async () => {
    await handlers[0]!(makeCtx('left', 'member'));
    expect(reviewOnJoinMock).toHaveBeenCalledTimes(1);
  });

  it('权限升级（member→administrator）→ 不重触发', async () => {
    await handlers[0]!(makeCtx('member', 'administrator'));
    expect(reviewOnJoinMock).not.toHaveBeenCalled();
    expect(onBotJoinedGroupMock).not.toHaveBeenCalled();
  });

  it('权限降级（administrator→member）→ 不重触发', async () => {
    await handlers[0]!(makeCtx('administrator', 'member'));
    expect(reviewOnJoinMock).not.toHaveBeenCalled();
  });

  it('退群（member→left）→ 只停用不删记录', async () => {
    await handlers[0]!(makeCtx('member', 'left'));
    expect(setGroupEnabledMock).toHaveBeenCalledWith(expect.anything(), config, -1004384664699, false);
    expect(removeGroupMock).not.toHaveBeenCalled();
  });
});
