import { describe, it, expect, vi, beforeEach } from 'vitest';

// generateText mock — 可按用例改写返回
const generateTextMock = vi.fn();
vi.mock('ai', () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => (model: string) => ({ model }) }));

let labels: Record<string, { name: string; endpoint: string; apiKeys: string[]; model: string; apiFormat?: string }>;
vi.mock('../../../src/ai/labels.js', () => ({
  getUsage: () => ({ label: 'primary', backups: ['backup'], timeout: 60000, maxTokens: 400, temperature: 0.8 }),
  getLabel: (n: string) => labels[n],
}));

let cooling = false;
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class { isCoolingDown = vi.fn(async () => cooling); setCooldown = vi.fn(async () => {}); },
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/pipeline/tools/registry.js', () => ({ buildToolSet: () => ({ SEARCH: {} }) }));
vi.mock('../../../src/shared/abort.js', () => ({ mergeAbortSignals: () => undefined, isCallerAbort: () => false }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ REPLY_TOOLS_MAX_STEPS: 4 }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const { generateReplyWithTools } = await import('../../../src/pipeline/reply/reply-with-tools.js');

const MESSAGES = [{ role: 'system' as const, content: 'persona' }, { role: 'user' as const, content: 'q' }];

beforeEach(() => {
  cooling = false;
  generateTextMock.mockReset();
  labels = {
    primary: { name: 'primary', endpoint: 'http://x', apiKeys: ['k'], model: 'gpt-5.5' },
    backup: { name: 'backup', endpoint: 'http://y', apiKeys: ['k2'], model: 'mini' },
  };
});

describe('generateReplyWithTools', () => {
  it('成功:返回末步文本 + 收集 toolsUsed', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: '{"replyContent":"查到啦"}',
      steps: [{ toolCalls: [{ toolName: 'SEARCH' }] }, { toolCalls: [] }],
      usage: { promptTokens: 100, completionTokens: 20 },
    });
    const r = await generateReplyWithTools({ messages: MESSAGES, usage: 'reply', chatId: -1, userId: 1 });
    expect(r.failed).toBe(false);
    expect(r.content).toBe('{"replyContent":"查到啦"}');
    expect(r.toolsUsed).toEqual(['SEARCH']);
    expect(r.tokenUsage.total).toBe(120);
  });

  it('剥离 <think> 块', async () => {
    generateTextMock.mockResolvedValueOnce({ text: '<think>纠结</think>{"replyContent":"好"}', steps: [], usage: {} });
    const r = await generateReplyWithTools({ messages: MESSAGES, usage: 'reply', chatId: -1, userId: 1 });
    expect(r.content).toBe('{"replyContent":"好"}');
  });

  it('首 label 失败 → 回退下一个', async () => {
    generateTextMock.mockRejectedValueOnce(new Error('500 boom')).mockResolvedValueOnce({ text: 'ok', steps: [], usage: {} });
    const r = await generateReplyWithTools({ messages: MESSAGES, usage: 'reply', chatId: -1, userId: 1 });
    expect(r.failed).toBe(false);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('claude 格式 label 跳过(AI SDK 工具走 openai 兼容)', async () => {
    labels.primary.apiFormat = 'claude';
    generateTextMock.mockResolvedValueOnce({ text: 'ok', steps: [], usage: {} });
    await generateReplyWithTools({ messages: MESSAGES, usage: 'reply', chatId: -1, userId: 1 });
    // 只应调用 backup 那次
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('全 label 挂 → failed:true(调用方回退老路)', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));
    const r = await generateReplyWithTools({ messages: MESSAGES, usage: 'reply', chatId: -1, userId: 1 });
    expect(r.failed).toBe(true);
    expect(r.content).toBe('');
  });

  it('冷却中的 label 跳过', async () => {
    cooling = true;
    const r = await generateReplyWithTools({ messages: MESSAGES, usage: 'reply', chatId: -1, userId: 1 });
    expect(r.failed).toBe(true);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
