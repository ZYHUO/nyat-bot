import { describe, it, expect, afterAll } from 'vitest';
import { countTokens, countMessageTokens, freeEncoder } from '../../../src/ai/token-counter.js';

afterAll(() => {
  freeEncoder();
});

describe('Token Counter', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('counts tokens for English text', () => {
    const count = countTokens('Hello, world!');
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });

  it('counts tokens for Chinese text', () => {
    const count = countTokens('你好世界');
    expect(count).toBeGreaterThan(0);
  });

  it('counts tokens for message array', () => {
    const count = countMessageTokens([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
    ]);
    // Should include message overhead (4 per message + 2 final)
    expect(count).toBeGreaterThan(10);
  });

  it('message token count is greater than sum of individual contents', () => {
    const messages = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' },
    ];
    const messageCount = countMessageTokens(messages);
    const rawCount = countTokens('System prompt') + countTokens('User message');
    // messageCount includes overhead per message (4 each) + 2 final
    expect(messageCount).toBeGreaterThan(rawCount);
  });

  it('handles long text', () => {
    const long = 'word '.repeat(1000);
    const count = countTokens(long);
    expect(count).toBeGreaterThan(500);
    expect(count).toBeLessThan(2000);
  });
});
