import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingSender } from '../../../src/bot/sender/streaming.js';

// Mock the telegram sender
const mockSendMessage = vi.fn<(chatId: number, text: string, replyToId?: number) => Promise<number>>();
const mockEditMessage = vi.fn<(chatId: number, messageId: number, text: string) => Promise<void>>();

vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...args: Parameters<typeof mockSendMessage>) => mockSendMessage(...args),
  editMessage: (...args: Parameters<typeof mockEditMessage>) => mockEditMessage(...args),
}));

describe('StreamingSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue(100);
    mockEditMessage.mockResolvedValue(undefined);
  });

  describe('sendDirect', () => {
    it('sends a message directly', async () => {
      const sender = new StreamingSender();
      const result = await sender.sendDirect(1, 'hello');
      expect(mockSendMessage).toHaveBeenCalledWith(1, 'hello', undefined);
      expect(result.messageId).toBe(100);
    });

    it('sends with replyToId', async () => {
      const sender = new StreamingSender();
      await sender.sendDirect(1, 'hello', 42);
      expect(mockSendMessage).toHaveBeenCalledWith(1, 'hello', 42);
    });
  });

  describe('sendStream', () => {
    it('sends placeholder first then edits with final text', async () => {
      const sender = new StreamingSender({ minEditInterval: 0, minCharDelta: 0, placeholder: '💭' });

      async function* generateChunks(): AsyncIterable<string> {
        yield 'Hello';
        yield ' World';
      }

      const result = await sender.sendStream(1, generateChunks());

      // Placeholder message sent first
      expect(mockSendMessage).toHaveBeenCalledWith(1, '💭', undefined);
      expect(result.messageId).toBe(100);
      expect(result.text).toBe('Hello World');
    });

    it('respects minCharDelta debounce', async () => {
      const sender = new StreamingSender({ minEditInterval: 0, minCharDelta: 100 });

      async function* smallChunks(): AsyncIterable<string> {
        yield 'a';
        yield 'b';
        yield 'c';
      }

      const result = await sender.sendStream(1, smallChunks());

      // Should only have final edit (chars < minCharDelta during streaming)
      // Plus the initial sendMessage
      expect(result.text).toBe('abc');
      // Final edit should have been called with 'abc'
      expect(mockEditMessage).toHaveBeenCalledWith(1, 100, 'abc');
    });

    it('sends with replyToId', async () => {
      const sender = new StreamingSender({ minEditInterval: 0, minCharDelta: 0 });

      async function* generate(): AsyncIterable<string> {
        yield 'test';
      }

      await sender.sendStream(1, generate(), 42);
      expect(mockSendMessage).toHaveBeenCalledWith(1, '💭', 42);
    });

    it('handles empty stream', async () => {
      const sender = new StreamingSender();

      async function* emptyStream(): AsyncIterable<string> {
        // yields nothing
      }

      const result = await sender.sendStream(1, emptyStream());
      expect(result.text).toBe('…');
      expect(mockEditMessage).toHaveBeenCalledWith(1, 100, '…');
    });

    it('final edit always contains complete text', async () => {
      const sender = new StreamingSender({ minEditInterval: 0, minCharDelta: 0 });

      async function* generate(): AsyncIterable<string> {
        yield 'part1';
        yield 'part2';
        yield 'part3';
      }

      const result = await sender.sendStream(1, generate());
      expect(result.text).toBe('part1part2part3');

      // The last call to editMessage should have the complete text
      const editCalls = mockEditMessage.mock.calls;
      const lastCall = editCalls[editCalls.length - 1];
      expect(lastCall?.[2]).toBe('part1part2part3');
    });

    it('handles edit failure gracefully', async () => {
      const sender = new StreamingSender({ minEditInterval: 0, minCharDelta: 0 });
      mockEditMessage.mockRejectedValueOnce(new Error('429 Too Many Requests'));
      mockEditMessage.mockResolvedValue(undefined);

      async function* generate(): AsyncIterable<string> {
        yield 'chunk1';
        yield 'chunk2';
      }

      // Should not throw
      const result = await sender.sendStream(1, generate());
      expect(result.text).toBe('chunk1chunk2');
    });
  });
});
