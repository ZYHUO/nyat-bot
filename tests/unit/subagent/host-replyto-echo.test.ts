import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/env.js', () => ({
  env: () => ({ CODEACT_BANNED_WORDS: [], MASTER_UID: 1 }),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sendMessage = vi.fn(async () => 1001);
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  sendSticker: vi.fn(),
  reactToMessage: vi.fn(),
  sendChatAction: vi.fn(),
}));

vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async () => [
    { role: 'assistant', textContent: '本喵才不臭呢，主人才是臭主人喵！' },
    { role: 'user', textContent: '喵喵', messageId: 392277 },
  ]),
  addAssistant: vi.fn(),
}));

vi.mock('../../../src/meta/answered.js', () => ({
  markMessageAnswered: vi.fn(async () => {}),
}));

vi.mock('../../../src/pipeline/reply/anti-repeat.js', () => ({
  checkNearDuplicate: vi.fn(async () => ({ isNearDuplicate: false, ratio: 0 })),
}));

vi.mock('../../../src/meta/timing-adapter.js', () => ({
  noteMetaBotReply: vi.fn(async () => {}),
}));
vi.mock('../../../src/memory/chroma.js', () => ({
  memorizeMessage: vi.fn(async () => {}),
  searchMemory: vi.fn(async () => []),
  searchMemoryByUser: vi.fn(async () => []),
}));
vi.mock('../../../src/pipeline/reply/segmenter.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/pipeline/reply/segmenter.js')>(
    '../../../src/pipeline/reply/segmenter.js',
  );
  return {
    ...actual,
    calculateTypingDelay: () => 0,
    segmentReply: (text: string) => {
      // Deterministic split for host tests (real segmenter probabilistically merges).
      if (text.length > 60 && text.includes('。')) {
        const parts = text.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
        if (parts.length > 1) return { segments: parts, originalText: text };
      }
      return actual.segmentReply(text);
    },
  };
});

import { createHostApi } from '../../../src/subagent/host-api.js';

describe('host sendText replyTo + self-echo', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    sendMessage.mockImplementation(async () => 1001 + sendMessage.mock.calls.length);
  });

  it('rejects stale model replyTo ≠ task quote (does not relabel wrong content)', async () => {
    const host = createHostApi(-1001, {
      defaultReplyTo: 392277,
      onEnd: () => {},
    });
    await expect(host.telegram.sendText('喵？', 392161)).rejects.toThrow(/reply_to_mismatch/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('omitting replyTo sends plain bubble (no forced quote since 2026-08-22)', async () => {
    const host = createHostApi(-1001, {
      defaultReplyTo: 392277,
      onEnd: () => {},
    });
    await host.telegram.sendText('喵？');
    // 引用有指向才用——模型省略 = 不引用（真人不是每条回复都顶引用标）
    expect(sendMessage).toHaveBeenCalledWith(-1001, '喵？', undefined, undefined);
  });

  it('explicit task-quote replyTo still quotes (有指向的引用)', async () => {
    const host = createHostApi(-1001, {
      defaultReplyTo: 392277,
      onEnd: () => {},
    });
    await host.telegram.sendText('回你这句喵', 392277);
    expect(sendMessage).toHaveBeenCalledWith(-1001, '回你这句喵', 392277, undefined);
  });

  it('segments long reply: no bubble quotes unless model explicitly asks', async () => {
    const host = createHostApi(-1001, {
      defaultReplyTo: 392277,
      onEnd: () => {},
    });
    // Must be >60 JS chars to enter segmenter path (same threshold as legacy reply)
    const long =
      '今天天气真的超级好啊，风也软软的，连云都懒得动。本喵想出去玩喵！你要不要一起去河边散步呀？回来还可以吃小鱼干，顺便rua一rua本喵的毛喵~';
    expect(long.length).toBeGreaterThan(60);
    await host.telegram.sendText(long);
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < sendMessage.mock.calls.length; i++) {
      expect(sendMessage.mock.calls[i]![2]).toBeUndefined();
    }
  });

  it('DM does not force replyTo when model omits', async () => {
    const host = createHostApi(6251541967, {
      defaultReplyTo: 99,
      onEnd: () => {},
    });
    await host.telegram.sendText('哼，才不告诉你');
    expect(sendMessage).toHaveBeenCalledWith(6251541967, '哼，才不告诉你', undefined, undefined);
  });

  it('DM rejects foreign replyTo ≠ task quote (no group→DM 串台)', async () => {
    const host = createHostApi(6251541967, {
      defaultReplyTo: 2862,
      onEnd: () => {},
    });
    await expect(host.telegram.sendText('所以这群冒充号到底怎么来的喵？', 392467)).rejects.toThrow(
      /reply_to_mismatch/,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects copying a line just sent in another chat', async () => {
    const group = createHostApi(-1003579270814, {
      defaultReplyTo: 392467,
      onEnd: () => {},
    });
    await group.telegram.sendText('所以这群冒充号到底怎么来的喵？', 392467);
    expect(sendMessage).toHaveBeenCalled();
    sendMessage.mockClear();

    const dm = createHostApi(6251541967, {
      defaultReplyTo: 2862,
      onEnd: () => {},
    });
    await expect(dm.telegram.sendText('所以这群冒充号到底怎么来的喵？')).rejects.toThrow(/echo_self/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('marks relatedQuoteIds answered only after successful send', async () => {
    const { markMessageAnswered } = await import('../../../src/meta/answered.js');
    vi.mocked(markMessageAnswered).mockClear();
    const host = createHostApi(-1001, {
      defaultReplyTo: 100,
      relatedQuoteIds: [98, 99],
      onEnd: () => {},
    });
    await host.telegram.sendText('收到');
    expect(markMessageAnswered).toHaveBeenCalledWith(-1001, 100);
    expect(markMessageAnswered).toHaveBeenCalledWith(-1001, 98);
    expect(markMessageAnswered).toHaveBeenCalledWith(-1001, 99);
  });

  it('does not mark relatedQuoteIds when send is rejected', async () => {
    const { markMessageAnswered } = await import('../../../src/meta/answered.js');
    vi.mocked(markMessageAnswered).mockClear();
    const host = createHostApi(-1001, {
      defaultReplyTo: 100,
      relatedQuoteIds: [98, 99],
      onEnd: () => {},
    });
    await expect(host.telegram.sendText('喵？', 50)).rejects.toThrow(/reply_to_mismatch/);
    expect(markMessageAnswered).not.toHaveBeenCalled();
  });

  it('rejects copying the bot own previous line', async () => {
    const host = createHostApi(-1001, {
      defaultReplyTo: 392289,
      onEnd: () => {},
    });
    let err: unknown;
    try {
      await host.telegram.sendText('本喵才不臭呢，主人才是臭主人喵！', 392289);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/echo_self/);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
