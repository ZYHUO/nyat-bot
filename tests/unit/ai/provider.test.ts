import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AILabel } from '../../../src/ai/types.js';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn((model: string) => ({ model }))),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { callModel } = await import('../../../src/ai/provider.js');

function makeSseResponse(chunks: string[], usage?: { prompt_tokens: number; completion_tokens: number }) {
  const lines: string[] = chunks.map(c =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`
  );
  lines.push('data: [DONE]\n\n');
  const body = lines.join('');

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('callModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns stream token usage for stream-only providers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeSseResponse(['<thinking>internal</thinking>', 'hello'])
    ));

    const label: AILabel = {
      name: 'reply_max_gpt54pro',
      endpoint: 'https://openai.example/v1',
      apiKeys: ['openai-key'],
      model: 'gpt-5.4',
      stream: true,
    };

    const result = await callModel(label, [{ role: 'user', content: 'ping' }], { maxTokens: 10 });

    expect(result.content).toBe('hello');
    expect(fetch).toHaveBeenCalledWith(
      'https://openai.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer openai-key' }),
      })
    );
  });
});
