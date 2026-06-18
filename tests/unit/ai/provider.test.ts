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

  it('serializes audio parts as input_audio and uses the raw fetch path', async () => {
    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: '一段猫叫' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    }));

    const label: AILabel = {
      name: 'audio',
      endpoint: 'https://audio.example/v1',
      apiKeys: ['audio-key'],
      model: 'gpt-4o-audio-preview',
    };

    const result = await callModel(label, [{
      role: 'user',
      content: [
        { type: 'audio', audio: 'QkFTRTY0', format: 'ogg' },
        { type: 'text', text: '这是什么?' },
      ],
    }], { maxTokens: 50 });

    expect(result.content).toBe('一段猫叫');
    // audio must NOT go through the AI SDK generateText path — raw fetch only
    expect(fetch).toHaveBeenCalledOnce();
    const part = capturedBody.messages[0].content[0];
    expect(part).toEqual({ type: 'input_audio', input_audio: { data: 'QkFTRTY0', format: 'ogg' } });
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
