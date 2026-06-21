import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage, RetrievedContext } from '../../../src/shared/types.js';

const mockBuildSystemPrompt = vi.fn();
const mockBuildMessages = vi.fn();
const mockSlimContextForAI = vi.fn();
const mockCompressContext = vi.fn();
const mockSearchKnowledge = vi.fn();
const mockCallWithFallback = vi.fn();
const mockParseReplyResponse = vi.fn();
const mockGetRecent = vi.fn();
const mockGetGroupMembers = vi.fn();
const mockDoCheckin = vi.fn();
const mockGetBotTracker = vi.fn();
const mockGetUserProfilePrompt = vi.fn();
const mockGetUserPreferences = vi.fn();
const mockGetReflection = vi.fn();
const mockPlanReply = vi.fn();
const mockExecuteToolPlan = vi.fn();
const mockSegmentReply = vi.fn();

vi.mock('../../../src/tracking/life-state.js', () => ({
  getLifeState: vi.fn(() => ({ state: 'normal', energy: 0.85, hint: null, speedFactor: 1, lazyDay: false })),
}));

vi.mock('../../../src/pipeline/heart/self-state.js', () => ({
  // 测试里不要真实自我状态(执念/作息会随日期漂移) → 抛错走 fail-soft 跳过
  composeSelfState: vi.fn(async () => {
    throw new Error('self-state disabled in tests');
  }),
}));

vi.mock('../../../src/pipeline/reply/prompt-builder.js', () => ({
  buildSystemPrompt: (...args: unknown[]) => mockBuildSystemPrompt(...args),
  buildMessages: (...args: unknown[]) => mockBuildMessages(...args),
}));

vi.mock('../../../src/pipeline/context/slim.js', () => ({
  slimContextForAI: (...args: unknown[]) => mockSlimContextForAI(...args),
}));

vi.mock('../../../src/pipeline/context/compressor.js', () => ({
  compressContext: (...args: unknown[]) => mockCompressContext(...args),
}));

vi.mock('../../../src/knowledge/manager.js', () => ({
  searchKnowledge: (...args: unknown[]) => mockSearchKnowledge(...args),
}));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => mockCallWithFallback(...args),
}));

vi.mock('../../../src/pipeline/reply/parser.js', () => ({
  parseReplyResponse: (...args: unknown[]) => mockParseReplyResponse(...args),
}));

vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: (...args: unknown[]) => mockGetRecent(...args),
  getGroupMembers: (...args: unknown[]) => mockGetGroupMembers(...args),
}));

vi.mock('../../../src/pipeline/checkin.js', () => ({
  doCheckin: (...args: unknown[]) => mockDoCheckin(...args),
}));

vi.mock('../../../src/tracking/interaction.js', () => ({
  getBotTracker: (...args: unknown[]) => mockGetBotTracker(...args),
}));

vi.mock('../../../src/tracking/user-profile.js', () => ({
  getUserProfilePrompt: (...args: unknown[]) => mockGetUserProfilePrompt(...args),
  getUserPreferences: (...args: unknown[]) => mockGetUserPreferences(...args),
}));

vi.mock('../../../src/tracking/outcome.js', () => ({
  getReflection: (...args: unknown[]) => mockGetReflection(...args),
}));

vi.mock('../../../src/pipeline/planner/planner.js', () => ({
  planReply: (...args: unknown[]) => mockPlanReply(...args),
}));

vi.mock('../../../src/pipeline/planner/executor.js', () => ({
  executeToolPlan: (...args: unknown[]) => mockExecuteToolPlan(...args),
  formatToolResultsForPrompt: (steps: Array<{ tool: string; output: unknown }>) =>
    steps.map((step) => `${step.tool}: ${JSON.stringify(step.output)}`).join('\n'),
}));

vi.mock('../../../src/pipeline/tools/registry.js', () => ({
  getToolNames: () => ['SEARCH', 'FETCH'],
  buildToolSet: () => ({ SEARCH: {}, FETCH: {} }),
}));

vi.mock('../../../src/pipeline/reply/segmenter.js', () => ({
  segmentReply: (...args: unknown[]) => mockSegmentReply(...args),
}));

vi.mock('../../../src/shared/config.js', () => ({
  loadPrompt: () => 'splitter system prompt',
  loadCachedPrompt: () => 'splitter system prompt',
  getConfig: () => ({ promptsDir: '/tmp/prompts' }),
}));

import { generateReply } from '../../../src/pipeline/reply/reply.js';

// 这些用例测的是 legacy planner / 工具执行路径。.env 现已开 REPLY_MERGED_TOOLS_ENABLED
// (合并写手会旁路 planner 块);env() 首调即缓存,故在首个 env() 调用前钉死为关,
// 让 planned 用例确定性走 planner→executeToolPlan 路径。
process.env['REPLY_MERGED_TOOLS_ENABLED'] = 'false';

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

function makeContext(): RetrievedContext {
  return {
    recent: [],
    semantic: [],
    thread: [],
    entity: [],
    merged: [],
    tokenCount: 0,
  };
}

describe('generateReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockBuildSystemPrompt.mockReturnValue('system prompt');
    mockBuildMessages.mockReturnValue([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ]);
    mockSlimContextForAI.mockReturnValue('context');
    mockCompressContext.mockReturnValue([]);
    mockSearchKnowledge.mockReturnValue('');
    mockGetRecent.mockResolvedValue([]);
    mockGetGroupMembers.mockResolvedValue([]);
    mockDoCheckin.mockReturnValue({ isNew: true, streak: 1, totalCheckins: 1, rank: 1 });
    mockGetBotTracker.mockReturnValue(null);
    mockGetUserProfilePrompt.mockReturnValue(undefined);
    mockGetUserPreferences.mockReturnValue(undefined);
    mockGetReflection.mockReturnValue(undefined);
    mockPlanReply.mockResolvedValue({
      needTools: true,
      answerStrategy: 'tool_then_answer',
      steps: [{ tool: 'SEARCH', args: { query: 'q' }, purpose: 'fetch facts' }],
    });
    mockExecuteToolPlan.mockResolvedValue([
      {
        tool: 'SEARCH',
        args: { query: 'q' },
        purpose: 'fetch facts',
        output: { answer: 'fresh data' },
      },
    ]);
    mockParseReplyResponse.mockImplementation((content: string, fallbackId: number) => ([
      { replyContent: content, targetMessageId: fallbackId },
    ]));
    mockCallWithFallback.mockResolvedValue({
      content: 'direct reply',
      tokenUsage: { prompt: 10, completion: 5, total: 15 },
      model: 'reply-model',
      label: 'reply',
      latencyMs: 12,
    });
    // Default: segmenter returns a single segment (no split) unless a test overrides
    mockSegmentReply.mockImplementation((text: string) => ({ segments: [text], originalText: text }));
  });

  it('retargets a reply aimed at a channel/bot message back to the asker (no delegation)', async () => {
    // 线上事故:主人问"什么时候支持支付宝口令支付",模型把 targetMessageId
    // 指向了 1.5h 前频道身份的相关吐槽 → 回复贴到频道贴子下面。
    mockParseReplyResponse.mockImplementation(() => ([
      { replyContent: '主人，本喵不确定喵', targetMessageId: 196230 },
    ]));
    const ctx = makeContext();
    ctx.merged = [
      { role: 'user', uid: 777, fullName: '灵车频道', timestamp: 1700000000, messageId: 196230, textContent: 'api 要钱啊', isForwarded: false, isAnonymous: true } as never,
    ];

    const result = await generateReply(
      makeMessage({ messageId: 196242, textContent: '什么时候支持支付宝口令支付' }),
      ctx, 'REPLY', 123, 9999, 'direct', 'normal',
    );

    expect(result.replies[0]!.targetMessageId).toBe(196242); // 拉回提问者
  });

  it('keeps a cross-target when the user explicitly delegated (回复/怼/告诉)', async () => {
    mockParseReplyResponse.mockImplementation(() => ([
      { replyContent: '你个大笨蛋', targetMessageId: 196230 },
    ]));
    const ctx = makeContext();
    ctx.merged = [
      { role: 'user', uid: 777, fullName: '某频道', timestamp: 1700000000, messageId: 196230, textContent: '瞎说什么', isForwarded: false, isAnonymous: true } as never,
    ];

    const result = await generateReply(
      makeMessage({ messageId: 196242, textContent: '帮我怼一下楼上那条' }),
      ctx, 'REPLY', 123, 9999, 'direct', 'normal',
    );

    expect(result.replies[0]!.targetMessageId).toBe(196230); // 明确委托 → 保留
  });

  it('retries on empty model output and recovers (DeepSeek empty-response mitigation)', async () => {
    mockCallWithFallback
      .mockResolvedValueOnce({ content: '', tokenUsage: { prompt: 10, completion: 0, total: 10 }, model: 'm', label: 'reply', latencyMs: 5 })
      .mockResolvedValueOnce({ content: 'recovered reply', tokenUsage: { prompt: 12, completion: 4, total: 16 }, model: 'm', label: 'reply', latencyMs: 8 });

    const result = await generateReply(makeMessage(), makeContext(), 'REPLY', 123, 9999, 'direct', 'normal');

    expect(mockCallWithFallback).toHaveBeenCalledTimes(2); // 1 empty + 1 constrained retry
    expect(result.replies[0]!.replyContent).toBe('recovered reply');
  });

  it('uses direct execution without tools when replyPath is direct', async () => {
    const result = await generateReply(makeMessage(), makeContext(), 'REPLY', 123, 9999, 'direct', 'normal');

    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    expect(mockCallWithFallback).toHaveBeenCalledWith(expect.objectContaining({
      usage: 'reply',
      messages: mockBuildMessages.mock.results[0]!.value,
    }));
    expect(mockBuildSystemPrompt).toHaveBeenCalledWith('normal', 1001, 123);
    expect(mockCompressContext).not.toHaveBeenCalled();
    expect(mockPlanReply).not.toHaveBeenCalled();
    expect(mockExecuteToolPlan).not.toHaveBeenCalled();
    expect(mockGetGroupMembers).not.toHaveBeenCalled();
    expect(mockGetBotTracker).not.toHaveBeenCalled();
    expect(mockGetUserProfilePrompt).toHaveBeenCalledWith(123, 1001);
    expect(mockGetReflection).not.toHaveBeenCalled();
    expect(result).toEqual({
      replies: [{ replyContent: 'direct reply', targetMessageId: 42, stickerIntent: undefined }],
      toolsUsed: [],
      toolExecutionFailed: false,
    });
  });

  it('uses planner + explicit tool execution when replyPath is planned', async () => {
    const result = await generateReply(makeMessage(), makeContext(), 'REPLY', 123, 9999, 'planned', 'normal');

    expect(mockCompressContext).not.toHaveBeenCalled();
    expect(mockPlanReply).toHaveBeenCalledTimes(1);
    expect(mockExecuteToolPlan).toHaveBeenCalledTimes(1);
    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      replies: [{ replyContent: 'direct reply', targetMessageId: 42, stickerIntent: undefined }],
      toolsUsed: ['SEARCH'],
      toolExecutionFailed: false,
    });
  });

  it('retries final drafting instead of sending raw web_search tool output', async () => {
    const rawSearchOutput = `<web_search>
Search results for "Cloudflare NET stock 2026 year performance YTD":

1. Title: **Cloudflare (NET) Stock Price History 2019-2026**
   URL: https://stockanalysis.com/stocks/net/history/
</web_search>`;
    mockExecuteToolPlan.mockResolvedValueOnce([
      {
        tool: 'SEARCH',
        args: { query: 'Cloudflare NET stock 2026 year performance YTD' },
        purpose: 'fetch facts',
        output: rawSearchOutput,
      },
    ]);
    mockCallWithFallback
      .mockResolvedValueOnce({
        content: rawSearchOutput,
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
        model: 'reply-model',
        label: 'reply',
        latencyMs: 12,
      })
      .mockResolvedValueOnce({
        content: '{"replyContent":"NET 今年表现波动很大：有资料说财报前一度涨超 30%，但也有来源显示回撤后 YTD 转负，得按具体日期口径看。","targetMessageId":42}',
        tokenUsage: { prompt: 12, completion: 8, total: 20 },
        model: 'reply-model',
        label: 'reply',
        latencyMs: 14,
      });
    mockParseReplyResponse.mockImplementation((content: string, fallbackId: number) => {
      if (content.startsWith('{')) {
        return [{
          replyContent: 'NET 今年表现波动很大：有资料说财报前一度涨超 30%，但也有来源显示回撤后 YTD 转负，得按具体日期口径看。',
          targetMessageId: fallbackId,
        }];
      }
      return [{ replyContent: content, targetMessageId: fallbackId }];
    });

    const result = await generateReply(makeMessage(), makeContext(), 'REPLY', 123, 9999, 'planned', 'normal');

    expect(mockCallWithFallback).toHaveBeenCalledTimes(2);
    expect(mockCallWithFallback).toHaveBeenNthCalledWith(2, expect.objectContaining({
      usage: 'reply',
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('上一次输出泄露了工具原始结果'),
        }),
      ]),
    }));
    expect(result.replies[0]?.replyContent).not.toContain('<web_search>');
    expect(result.replies[0]?.replyContent).not.toContain('Search results for');
  });

  it('defaults REPLY to direct execution when replyPath is omitted', async () => {
    await generateReply(makeMessage(), makeContext(), 'REPLY', 123, 9999);

    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    expect(mockPlanReply).not.toHaveBeenCalled();
  });

  it('defaults REPLY to direct + normal when both replyPath and replyTier are omitted', async () => {
    await generateReply(makeMessage(), makeContext(), 'REPLY', 123, 9999);

    expect(mockCallWithFallback).toHaveBeenCalledWith(expect.objectContaining({
      usage: 'reply',
    }));
    expect(mockBuildSystemPrompt).toHaveBeenCalledWith('normal', 1001, 123);
    expect(mockPlanReply).not.toHaveBeenCalled();
  });

  it('uses pro tier model selection without changing direct path', async () => {
    await generateReply(makeMessage(), makeContext(), 'REPLY', 123, 9999, 'direct', 'pro');

    expect(mockCompressContext).not.toHaveBeenCalled();
    expect(mockCallWithFallback).toHaveBeenCalledWith(expect.objectContaining({
      usage: 'reply_pro',
    }));
    expect(mockBuildSystemPrompt).toHaveBeenCalledWith('pro', 1001, 123);
    expect(mockPlanReply).not.toHaveBeenCalled();
  });

  it('planned path can skip tool execution when planner says tools are unnecessary', async () => {
    mockPlanReply.mockResolvedValueOnce({
      needTools: false,
      answerStrategy: 'direct',
      steps: [],
    });

    await generateReply(makeMessage(), makeContext(), 'REPLY', 123, 9999, 'planned', 'normal');

    expect(mockPlanReply).toHaveBeenCalledTimes(1);
    expect(mockExecuteToolPlan).not.toHaveBeenCalled();
    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
  });

  it('planned path degrades safely when tool execution fails', async () => {
    mockExecuteToolPlan.mockRejectedValue(new Error('Unknown or non-executable tool: MADE_UP_TOOL'));

    const result = await generateReply(makeMessage(), makeContext(), 'REPLY', 123, 9999, 'planned', 'normal');

    expect(mockPlanReply).toHaveBeenCalledTimes(1);
    expect(mockExecuteToolPlan).toHaveBeenCalledTimes(2); // retried once
    expect(mockCallWithFallback).toHaveBeenCalledTimes(0); // no final writer called
    expect(result.toolExecutionFailed).toBe(true);
    expect(result.replies[0]?.replyContent).toContain('没查到');
  });

  it('retries with strict count instruction when user explicitly asks for two messages', async () => {
    const multiReply = [
      { replyContent: '第一条', targetMessageId: 42 },
      { replyContent: '第二条', targetMessageId: 42 },
    ];

    mockParseReplyResponse
      .mockReturnValueOnce([{ replyContent: '只发了一条', targetMessageId: 42 }])
      .mockReturnValueOnce(multiReply);

    const result = await generateReply(
      makeMessage({ textContent: '发我两条消息' }),
      makeContext(),
      'REPLY',
      123,
      9999,
      'direct',
      'normal',
    );

    expect(mockCallWithFallback).toHaveBeenCalledTimes(2);
    expect(mockBuildMessages).toHaveBeenLastCalledWith(
      'system prompt',
      'context',
      expect.objectContaining({ textContent: '发我两条消息' }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { exactReplyCount: 2 },
      123,
      undefined, // burstHint
      undefined, // expressionOverride
      undefined, // midTermMemory
    );
    expect(result.replies).toEqual([
      { replyContent: '第一条', targetMessageId: 42 },
      { replyContent: '第二条', targetMessageId: 42 },
    ]);
  });

  it('splits long single replies via the local code segmenter (no extra AI call)', async () => {
    const longReply = '这是一条很长很长的回复'.repeat(20);
    mockCallWithFallback.mockResolvedValue({
      content: longReply,
      tokenUsage: { prompt: 10, completion: 5, total: 15 },
      model: 'reply-model',
      label: 'reply',
      latencyMs: 12,
    });
    mockParseReplyResponse.mockImplementation((content: string, fallbackId: number) => (
      [{ replyContent: content, targetMessageId: fallbackId }]
    ));
    // Local segmenter splits the long reply into two messages
    mockSegmentReply.mockReturnValue({ segments: ['第一段短句', '第二段短句'], originalText: longReply });

    const result = await generateReply(makeMessage(), makeContext(), 'REPLY', 123, 9999, 'direct', 'normal');

    // Only ONE AI call — segmentation is now local code, not a second model call
    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    expect(mockSegmentReply).toHaveBeenCalledWith(longReply, undefined);
    // All segments keep the primary target id; only the first quote-replies
    expect(result.replies).toEqual([
      { replyContent: '第一段短句', targetMessageId: 42 },
      { replyContent: '第二段短句', targetMessageId: 42, replyQuote: false },
    ]);
  });

  it('segments an AI handoff draft locally (handoffToSplitter → code segmenter)', async () => {
    mockCallWithFallback.mockResolvedValue({
      content: '{"replyContent":"给主人：收到啦。给不听：也有你的份。","targetMessageId":42,"handoffToSplitter":true}',
      tokenUsage: { prompt: 10, completion: 5, total: 15 },
      model: 'reply-model',
      label: 'reply',
      latencyMs: 12,
    });
    mockParseReplyResponse.mockImplementation((content: string, fallbackId: number) => {
      if (content.includes('handoffToSplitter')) {
        return [{
          replyContent: '给主人：收到啦。给不听：也有你的份。',
          targetMessageId: fallbackId,
          handoffToSplitter: true,
        }];
      }
      return [{ replyContent: content, targetMessageId: fallbackId }];
    });
    mockSegmentReply.mockReturnValue({
      segments: ['收到啦主人', '不听也有你一份'],
      originalText: '给主人：收到啦。给不听：也有你的份。',
    });

    const result = await generateReply(
      makeMessage({
        textContent: '再发给我和不听一人一条',
        replyTo: { messageId: 24, uid: 2002, fullName: '不听', textSnippet: '你们都别吵' },
      }),
      makeContext(),
      'REPLY',
      123,
      9999,
      'direct',
      'normal',
    );

    // Handoff triggers local segmentation, not a second AI call.
    // NOTE: the local segmenter routes every segment to the PRIMARY target (42);
    // per-segment target routing (the old AI splitter behavior) is no longer supported.
    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    expect(mockSegmentReply).toHaveBeenCalled();
    expect(result.replies).toEqual([
      { replyContent: '收到啦主人', targetMessageId: 42 },
      { replyContent: '不听也有你一份', targetMessageId: 42, replyQuote: false },
    ]);
  });
});
