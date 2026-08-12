import { describe, it, expect, vi, beforeEach } from 'vitest';

// P3:direct 路径挂工具时只给只读子集 —— generateReplyWithTools 必须把
// toolsOnly 透传给 buildToolSet,防止闲聊写手拿到 ADD_TIMER/CREATE_POLL/
// USE_BOT_COMMAND 这类副作用工具。

const { generateTextMock, buildToolSetMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  buildToolSetMock: vi.fn(() => ({ SEARCH: { description: 's' } })),
}));

vi.mock('ai', () => ({ generateText: generateTextMock }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn(() => (m: string) => m) }));
vi.mock('../../../../src/pipeline/tools/registry.js', () => ({ buildToolSet: buildToolSetMock }));
vi.mock('../../../../src/ai/labels.js', () => ({
  getUsage: vi.fn(() => ({ label: 'l1', backups: [], timeout: 30000 })),
  getLabel: vi.fn(() => ({ name: 'l1', endpoint: 'http://x', apiKeys: ['k'], model: 'm1' })),
}));
vi.mock('../../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class { isCoolingDown = async () => false; setCooldown = async () => {}; },
}));
vi.mock('../../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../../src/env.js', () => ({ env: () => ({ REPLY_TOOLS_MAX_STEPS: 4 }) }));
vi.mock('../../../../src/shared/abort.js', () => ({
  mergeAbortSignals: vi.fn(() => undefined),
  isCallerAbort: vi.fn(() => false),
}));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { generateReplyWithTools } from '../../../../src/pipeline/reply/reply-with-tools.js';

beforeEach(() => {
  generateTextMock.mockReset();
  buildToolSetMock.mockClear();
  generateTextMock.mockResolvedValue({
    text: '{"replies":[{"replyContent":"查到了,39 元"}]}',
    steps: [{ toolCalls: [] }],
    usage: { promptTokens: 1, completionTokens: 1 },
  });
});

describe('generateReplyWithTools toolsOnly (P3)', () => {
  it('传 toolsOnly → buildToolSet 收到白名单(direct 只读子集)', async () => {
    const subset = ['SEARCH', 'FETCH', 'RECALL'];
    const r = await generateReplyWithTools({
      messages: [{ role: 'user', content: '这个多少钱' }],
      usage: 'reply', chatId: -1, userId: 7, toolsOnly: subset,
    });
    expect(r.failed).toBe(false);
    expect(buildToolSetMock).toHaveBeenCalledWith(-1, 7, subset);
  });

  it('不传 toolsOnly → buildToolSet 拿全量(planned 路径原行为)', async () => {
    await generateReplyWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      usage: 'reply', chatId: -1, userId: 7,
    });
    expect(buildToolSetMock).toHaveBeenCalledWith(-1, 7, undefined);
  });
});
