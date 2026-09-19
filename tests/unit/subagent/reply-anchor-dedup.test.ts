import { describe, expect, it, vi } from 'vitest';

// 2026-09-19 production: one task answered 「眼熟」with THREE sendText calls and
// #1 and #3 both carried replyTo=265827. The existing rule ("segmented send:
// only the first bubble carries reply_to") only applied WITHIN one sendText call
// — separate calls each resolved their own anchor.
//
// The legitimate multi-anchor case is burst replies to DIFFERENT people, where
// each id is genuinely different. So the invariant is per-message-id, not per-call.

const sendMessage = vi.fn(async (_chatId: number, _text: string, replyTo?: number) => {
  void replyTo;
  return 4242;
});

vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...(a as [number, string, number?])),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));
vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_BANNED_WORDS: [] }) }));
vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => []),
  searchMemoryByUser: vi.fn(async () => []),
  memorizeMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: vi.fn(async () => undefined),
  getRecent: vi.fn(async () => []),
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ set: vi.fn(async () => 'OK') }) }));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ noteMetaBotReply: vi.fn(async () => undefined) }));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: vi.fn(async () => undefined) }));

const { createHostApi } = await import('../../../src/subagent/host-api.js');

describe('duplicate reply anchors within one task', () => {
  it('quotes the message once, then drops the repeated anchor', async () => {
    sendMessage.mockClear();
    const host = createHostApi(-1003184176508, {
      onEnd: () => {},
      defaultReplyTo: 265827,
      quoteIds: [265827],
      taskId: 't1',
    });
    // maxTextSends defaults to 2 — the production case used 3, so raise it to
    // reproduce the actual shape rather than tripping the cap first.
    const host3 = createHostApi(-1003184176508, {
      onEnd: () => {},
      defaultReplyTo: 265827,
      quoteIds: [265827],
      taskId: 't1',
      maxTextSends: 6,
    });
    await host3.telegram.sendText('你搬的？', 265827);
    await host3.telegram.sendText('搬的哪块石？', 265827);
    await host3.telegram.sendText('灵车也搬石？', 265827);

    const anchored = sendMessage.mock.calls.filter((c) => c[2] === 265827);
    expect(anchored).toHaveLength(1); // exactly one message carries the anchor
    expect(sendMessage).toHaveBeenCalledTimes(3); // all three still go out
  });

  it('still honours distinct anchors for a real burst (different people)', async () => {
    sendMessage.mockClear();
    const host = createHostApi(-1003184176508, {
      onEnd: () => {},
      quoteIds: [111, 222],
      taskId: 't2',
      maxTextSends: 6,
    });
    await host.telegram.sendText('回甲', 111);
    await host.telegram.sendText('回乙', 222);
    expect(sendMessage.mock.calls.map((c) => c[2])).toEqual([111, 222]);
  });
});
