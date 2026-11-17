import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSdkUsageObserver } from '../../../src/ai/sdk-usage-observer.js';
import { llmEvents } from '../../../src/ai/events.js';

const listener = vi.fn();
afterEach(() => { llmEvents.off('result', listener); listener.mockReset(); });

describe('SDK tool-step cache usage', () => {
  it('emits separate denominators for cached, zero-hit and missing-cache steps without plaintext', () => {
    llmEvents.on('result', listener);
    const observe = createSdkUsageObserver('reply', 'synthetic-label', 'synthetic-model', -101);
    observe({ usage: { promptTokens: 100, completionTokens: 4 }, providerMetadata: { openai: { cachedPromptTokens: 80 } } });
    observe({ usage: { promptTokens: 200, completionTokens: 5 }, providerMetadata: { openai: { cachedPromptTokens: 0 } } });
    observe({ usage: { promptTokens: 300, completionTokens: 6 } });
    expect(listener).toHaveBeenCalledTimes(3);
    const events = listener.mock.calls.map(([event]) => event);
    expect(events.map(event => [event.promptTokens, event.cachedTokens])).toEqual([[100, 80], [200, 0], [300, undefined]]);
    expect(events.every(event => event.chatId === -101 && event.transportPath === 'openai_sdk')).toBe(true);
    expect(events.every(event => !('content' in event) && !('messages' in event))).toBe(true);
  });

  it('does not turn observation failure into a failed tool step', () => {
    listener.mockImplementation(() => { throw new Error('synthetic metrics failure'); });
    llmEvents.on('result', listener);
    expect(() => createSdkUsageObserver('judge', 'synthetic', 'synthetic', -1)({ usage: undefined })).not.toThrow();
  });
});
