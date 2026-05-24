import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

const mockHgetall = vi.fn();
const mockHset = vi.fn();
const mockExpire = vi.fn();
const mockReviewPathDecision = vi.fn();

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    hgetall: mockHgetall,
    hset: mockHset,
    expire: mockExpire,
  }),
}));

vi.mock('../../../src/pipeline/path-reflection.js', () => ({
  reviewPathDecision: (...args: unknown[]) => mockReviewPathDecision(...args),
}));

import {
  applyChatPathPolicy,
  reflectChatPathPolicy,
} from '../../../src/pipeline/path-policy.js';
import { detectPathPatterns } from '../../../src/pipeline/path-patterns.js';

function makeMessage(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user',
    uid: 1001,
    username: 'alice',
    fullName: 'Alice',
    timestamp: 1700000000,
    messageId: 42,
    textContent: 'hello',
    isForwarded: false,
    ...overrides,
  };
}

describe('path policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHgetall.mockResolvedValue({});
    mockHset.mockResolvedValue(1);
    mockExpire.mockResolvedValue(1);
    mockReviewPathDecision.mockResolvedValue({
      shouldLearn: true,
      targetReplyPath: 'planned',
      pattern: 'realtime_info',
      confidence: 0.9,
      reason: 'realtime query',
    });
  });

  it('detects market quote requests', () => {
    const patterns = detectPathPatterns(makeMessage({ textContent: '看看Microsoft的股票' }), 9999);
    expect(patterns).toContain('market_quote');
  });

  it('detects follow-up lookup requests from replied bot message', () => {
    const patterns = detectPathPatterns(makeMessage({
      textContent: '老黄的呢',
      replyTo: {
        messageId: 11,
        uid: 9999,
        fullName: 'XXB',
        textSnippet: 'Microsoft (MSFT) 目前股价大约在 400 美元左右波动呢。',
      },
    }), 9999);
    expect(patterns).toContain('followup_lookup');
  });

  it('applies stored chat-local planned policy to matching pattern', async () => {
    mockHgetall.mockResolvedValue({ market_quote: '2' });

    const applied = await applyChatPathPolicy({
      chatId: 1,
      message: makeMessage({ textContent: '看看Microsoft的股票' }),
      botUid: 9999,
      rawReplyPath: 'direct',
    });

    expect(applied.replyPath).toBe('planned');
    expect(applied.matchedPatterns).toContain('market_quote');
    expect(applied.source).toBe('policy');
  });

  it('writes immediate planned policy for direct realtime requests', async () => {
    await reflectChatPathPolicy({
      chatId: 1,
      message: makeMessage({ textContent: '看看巴黎天气' }),
      botUid: 9999,
      effectiveReplyPath: 'direct',
      replyText: '巴黎今天多云',
      toolsUsed: [],
      toolExecutionFailed: false,
    });

    expect(mockHset).toHaveBeenCalledWith('xxb:path-policy:1', 'realtime_info', '1');
    expect(mockExpire).toHaveBeenCalled();
  });

  it('does not immediately flip to direct after one planned request with no tools', async () => {
    mockReviewPathDecision.mockResolvedValueOnce({
      shouldLearn: true,
      targetReplyPath: 'direct',
      pattern: 'realtime_info',
      confidence: 0.91,
      reason: 'no tool needed',
    });
    await reflectChatPathPolicy({
      chatId: 1,
      message: makeMessage({ textContent: '看看巴黎天气' }),
      botUid: 9999,
      effectiveReplyPath: 'planned',
      replyText: '巴黎今天多云',
      toolsUsed: [],
      toolExecutionFailed: false,
    });

    expect(mockHset).toHaveBeenCalledWith('xxb:path-policy:1', 'realtime_info', '-1');
  });

  it('does not learn when tool execution failed', async () => {
    await reflectChatPathPolicy({
      chatId: 1,
      message: makeMessage({ textContent: '看看巴黎天气' }),
      botUid: 9999,
      effectiveReplyPath: 'planned',
      replyText: '巴黎今天多云',
      toolsUsed: [],
      toolExecutionFailed: true,
    });

    expect(mockHset).not.toHaveBeenCalled();
    expect(mockExpire).not.toHaveBeenCalled();
  });

  it('uses higher-priority followup policy when multiple patterns match', async () => {
    mockHgetall.mockResolvedValue({
      followup_lookup: '-2',
      market_quote: '2',
    });

    const applied = await applyChatPathPolicy({
      chatId: 1,
      message: makeMessage({
        textContent: '老黄的呢',
        replyTo: {
          messageId: 11,
          uid: 9999,
          fullName: 'XXB',
          textSnippet: 'Microsoft (MSFT) 目前股价大约在 400 美元左右波动呢。',
        },
      }),
      botUid: 9999,
      rawReplyPath: 'planned',
    });

    expect(applied.replyPath).toBe('direct');
    expect(applied.source).toBe('policy');
  });

  it('requires stronger negative evidence before applying direct policy', async () => {
    mockHgetall.mockResolvedValue({ realtime_info: '-1' });

    const applied = await applyChatPathPolicy({
      chatId: 1,
      message: makeMessage({ textContent: '看看巴黎天气' }),
      botUid: 9999,
      rawReplyPath: 'planned',
    });

    expect(applied.replyPath).toBe('planned');
    expect(applied.source).toBe('raw');
  });
});
