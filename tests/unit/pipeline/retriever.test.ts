import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

// Mock the context manager and token counter
const mockGetRecent = vi.fn<(chatId: number, count: number) => Promise<FormattedMessage[]>>();
const mockGetAll = vi.fn<(chatId: number) => Promise<FormattedMessage[]>>();
const mockSearchMemory = vi.fn<
  (chatId: number, query: string, topK: number, timeoutMs: number) => Promise<FormattedMessage[]>
>();

vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: (...args: Parameters<typeof mockGetRecent>) => mockGetRecent(...args),
  getAll: (...args: Parameters<typeof mockGetAll>) => mockGetAll(...args),
}));

vi.mock('../../../src/ai/token-counter.js', () => ({
  countTokens: (text: string) => Math.ceil(text.length / 4),
}));

vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: (
    ...args: Parameters<typeof mockSearchMemory>
  ) => mockSearchMemory(...args),
}));

import { retrieveContext } from '../../../src/pipeline/context/retriever.js';

function makeMsg(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user',
    uid: 1001,
    username: 'alice',
    fullName: 'Alice',
    timestamp: 1700000000,
    messageId: 100,
    textContent: 'Hello',
    isForwarded: false,
    ...overrides,
  };
}

describe('Context Retriever', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRecent.mockResolvedValue([]);
    mockGetAll.mockResolvedValue([]);
    mockSearchMemory.mockResolvedValue([]);
  });

  it('returns recent window messages', async () => {
    const msgs = [
      makeMsg({ messageId: 1, timestamp: 1700000001 }),
      makeMsg({ messageId: 2, timestamp: 1700000002 }),
      makeMsg({ messageId: 3, timestamp: 1700000003 }),
    ];
    mockGetRecent.mockResolvedValue(msgs);

    const result = await retrieveContext(1, makeMsg({ messageId: 99 }), 9999);
    expect(result.recent).toHaveLength(3);
    expect(result.merged.length).toBeGreaterThanOrEqual(3);
  });

  it('semantic path returns empty (Phase 2 stub)', async () => {
    mockGetRecent.mockResolvedValue([]);
    const result = await retrieveContext(1, makeMsg(), 9999);
    expect(result.semantic).toHaveLength(0);
  });

  it('runs semantic retrieval when recent window is full but still within token budget', async () => {
    const recent = Array.from({ length: 20 }, (_, i) =>
      makeMsg({
        messageId: i + 1,
        timestamp: 1700000000 + i,
        textContent: 'hi',
      }),
    );
    const semanticHit = makeMsg({
      messageId: 501,
      timestamp: 1700001000,
      textContent: 'semantic hit',
    });
    mockGetRecent.mockResolvedValue(recent);
    mockSearchMemory.mockResolvedValue([semanticHit]);

    const result = await retrieveContext(
      1,
      makeMsg({ messageId: 999, textContent: 'query' }),
      9999,
      { totalTokenBudget: 1500 },
    );

    expect(mockSearchMemory).toHaveBeenCalledWith(1, 'query', 10, 500);
    expect(result.semantic).toEqual([semanticHit]);
  });

  it('skips semantic retrieval when recent context alone exceeds token budget', async () => {
    const recent = Array.from({ length: 6 }, (_, i) =>
      makeMsg({
        messageId: i + 1,
        timestamp: 1700000000 + i,
        textContent: 'This is a long recent message that should exceed the small token budget.',
      }),
    );
    mockGetRecent.mockResolvedValue(recent);

    await retrieveContext(
      1,
      makeMsg({ messageId: 1000, textContent: 'query' }),
      9999,
      { totalTokenBudget: 40 },
    );

    expect(mockSearchMemory).not.toHaveBeenCalled();
  });

  it('follows reply_to chain for thread trace', async () => {
    const msg3 = makeMsg({ messageId: 3, timestamp: 1700000003, replyTo: { messageId: 2, uid: 1002, fullName: 'Bob', textSnippet: 'msg2' } });
    const msg2 = makeMsg({ messageId: 2, timestamp: 1700000002, uid: 1002, username: 'bob', fullName: 'Bob', replyTo: { messageId: 1, uid: 1001, fullName: 'Alice', textSnippet: 'msg1' } });
    const msg1 = makeMsg({ messageId: 1, timestamp: 1700000001 });

    const current = makeMsg({ messageId: 4, timestamp: 1700000004, replyTo: { messageId: 3, uid: 1001, fullName: 'Alice', textSnippet: 'msg3' } });

    mockGetRecent.mockResolvedValue([]);
    mockGetAll.mockResolvedValue([msg1, msg2, msg3]);

    const result = await retrieveContext(1, current, 9999);
    expect(result.thread.length).toBeGreaterThanOrEqual(1);
    // Should include msg3 and its chain
    const threadIds = result.thread.map((m) => m.messageId);
    expect(threadIds).toContain(3);
  });

  it('respects threadMaxDepth', async () => {
    // Build a chain of 10 messages
    const msgs: FormattedMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      msgs.push(makeMsg({
        messageId: i,
        timestamp: 1700000000 + i,
        replyTo: i > 1 ? { messageId: i - 1, uid: 1001, fullName: 'Alice', textSnippet: `msg${i - 1}` } : undefined,
      }));
    }

    const current = makeMsg({
      messageId: 11,
      timestamp: 1700000011,
      replyTo: { messageId: 10, uid: 1001, fullName: 'Alice', textSnippet: 'msg10' },
    });

    mockGetRecent.mockResolvedValue([]);
    mockGetAll.mockResolvedValue(msgs);

    const result = await retrieveContext(1, current, 9999, { threadMaxDepth: 3 });
    expect(result.thread.length).toBeLessThanOrEqual(3);
  });

  it('extracts entity messages for @mentions', async () => {
    const bobMsgs = [
      makeMsg({ messageId: 10, timestamp: 1700000010, uid: 1002, username: 'bob', fullName: 'Bob' }),
      makeMsg({ messageId: 11, timestamp: 1700000011, uid: 1002, username: 'bob', fullName: 'Bob' }),
    ];
    const aliceMsgs = [
      makeMsg({ messageId: 12, timestamp: 1700000012 }),
    ];

    mockGetRecent.mockResolvedValue([]);
    mockGetAll.mockResolvedValue([...bobMsgs, ...aliceMsgs]);

    const current = makeMsg({ messageId: 99, textContent: 'Hey @bob what do you think?' });
    const result = await retrieveContext(1, current, 9999);
    expect(result.entity.length).toBeGreaterThanOrEqual(1);
    expect(result.entity.some((m) => m.username === 'bob')).toBe(true);
  });

  it('deduplicates messages by messageId', async () => {
    const msg = makeMsg({ messageId: 5, timestamp: 1700000005 });
    // Same message appears in both recent and entity paths
    mockGetRecent.mockResolvedValue([msg]);
    mockGetAll.mockResolvedValue([msg]);

    const current = makeMsg({ messageId: 99, textContent: 'Hey @alice' });
    const result = await retrieveContext(1, current, 9999);

    const ids = result.merged.map((m) => m.messageId);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  it('preserves recent raw messages even when token budget is small', async () => {
    // Create many messages that would exceed the old token budget
    const msgs: FormattedMessage[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push(makeMsg({
        messageId: i,
        timestamp: 1700000000 + i,
        textContent: 'This is a relatively long message that should consume some tokens in the budget calculation.',
      }));
    }
    mockGetRecent.mockResolvedValue(msgs);

    const current = makeMsg({ messageId: 999 });
    const result = await retrieveContext(1, current, 9999, { totalTokenBudget: 200 });
    expect(result.merged.length).toBe(50);
    expect(result.tokenCount).toBeGreaterThan(200);
  });

  it('sorts merged messages by timestamp', async () => {
    const msgs = [
      makeMsg({ messageId: 3, timestamp: 1700000003 }),
      makeMsg({ messageId: 1, timestamp: 1700000001 }),
      makeMsg({ messageId: 2, timestamp: 1700000002 }),
    ];
    mockGetRecent.mockResolvedValue(msgs);

    const result = await retrieveContext(1, makeMsg({ messageId: 99 }), 9999);
    for (let i = 1; i < result.merged.length; i++) {
      expect(result.merged[i]!.timestamp).toBeGreaterThanOrEqual(result.merged[i - 1]!.timestamp);
    }
  });

  it('handles message with no reply_to', async () => {
    mockGetRecent.mockResolvedValue([makeMsg({ messageId: 1 })]);
    const result = await retrieveContext(1, makeMsg({ messageId: 2 }), 9999);
    expect(result.thread).toHaveLength(0);
  });

  it('handles message with no @mentions', async () => {
    mockGetRecent.mockResolvedValue([makeMsg({ messageId: 1 })]);
    const result = await retrieveContext(1, makeMsg({ messageId: 2, textContent: 'no mentions here' }), 9999);
    expect(result.entity).toHaveLength(0);
  });

  it('direct mode skips thread and entity lookups, and skips semantic when no extra budget remains', async () => {
    mockGetRecent.mockResolvedValue([
      makeMsg({ messageId: 1, timestamp: 1700000001 }),
      makeMsg({ messageId: 2, timestamp: 1700000002 }),
    ]);

    const result = await retrieveContext(
      1,
      makeMsg({ messageId: 3, textContent: 'just chatting' }),
      9999,
      { mode: 'direct', totalTokenBudget: 1 } as never,
    );

    expect(mockSearchMemory).not.toHaveBeenCalled();
    expect(mockGetAll).not.toHaveBeenCalled();
    expect(result.semantic).toEqual([]);
    expect(result.thread).toEqual([]);
    expect(result.entity).toEqual([]);
    expect(result.recent).toHaveLength(2);
  });

  it('direct mode requests a 50-message recent window by default', async () => {
    mockGetRecent.mockResolvedValue([]);

    await retrieveContext(
      1,
      makeMsg({ messageId: 3, textContent: 'just chatting' }),
      9999,
      { mode: 'direct' } as never,
    );

    expect(mockGetRecent).toHaveBeenCalledWith(1, 50);
  });

  it('planned mode still allows expensive retrieval paths', async () => {
    mockGetRecent.mockResolvedValue([
      makeMsg({ messageId: 1, timestamp: 1700000001 }),
    ]);
    mockGetAll.mockResolvedValue([
      makeMsg({ messageId: 4, timestamp: 1700000004, username: 'bob', fullName: 'Bob' }),
    ]);

    await retrieveContext(
      1,
      makeMsg({ messageId: 3, textContent: 'hey @bob check this' }),
      9999,
      { mode: 'planned' } as never,
    );

    expect(mockGetAll).toHaveBeenCalled();
  });
});
