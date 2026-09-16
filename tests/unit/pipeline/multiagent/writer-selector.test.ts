import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/pipeline/reply/reply.js', () => ({ generateReply: vi.fn() }));
vi.mock('../../../../src/pipeline/multiagent/orchestrator.js', () => ({ runMultiAgentReply: vi.fn() }));

import { runWriterRoute } from '../../../../src/pipeline/multiagent/writer-selector.js';
import { generateReply } from '../../../../src/pipeline/reply/reply.js';
import { runMultiAgentReply } from '../../../../src/pipeline/multiagent/orchestrator.js';

const args = {
  message: { textContent: 'hi', messageId: 1, uid: 100 } as never,
  retrievedContext: { contextStr: 'CTX' } as never,
  action: 'REPLY' as never,
  chatId: -100,
  botUid: 9,
  replyPath: 'planned' as never,
  segmenterConfig: undefined,
  turnCallOpts: { signal: undefined } as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  (generateReply as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve({ replies: [], toolsUsed: [], toolExecutionFailed: false }));
  (runMultiAgentReply as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve({ replies: [], toolsUsed: [], toolExecutionFailed: false }));
});

describe('runWriterRoute (L3 deliver 分支接缝)', () => {
  it('multiAgent=true → 调 runMultiAgentReply,不调 generateReply', async () => {
    await runWriterRoute(args, true);
    expect(runMultiAgentReply).toHaveBeenCalledTimes(1);
    expect(generateReply).not.toHaveBeenCalled();
    // 透传整个 args 对象(不拆字段)
    expect((runMultiAgentReply as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(args);
  });

  it('multiAgent=false → 调 generateReply,不调 runMultiAgentReply', async () => {
    await runWriterRoute(args, false);
    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(runMultiAgentReply).not.toHaveBeenCalled();
    // 字段按 generateReply 的位置参数对齐
    const c = (generateReply as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(c[0]).toBe(args.message);
    expect(c[1]).toBe(args.retrievedContext);
    expect(c[2]).toBe(args.action);
    expect(c[3]).toBe(args.chatId);
    expect(c[4]).toBe(args.botUid);
    expect(c[5]).toBe(args.replyPath);
    expect(c[6]).toBe(args.segmenterConfig);
    expect(c[7]).toBe(args.turnCallOpts);
  });
});
