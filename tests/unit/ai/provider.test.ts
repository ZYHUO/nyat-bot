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
const { generateText } = await import('ai');

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

  it('forceRaw + 空 choices → 走 raw fetch、抛 AI_EMPTY(不崩 reading message)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const label: AILabel = {
      name: 'gemini35low', endpoint: 'http://relay/v1', apiKeys: ['k'],
      model: 'gemini-3.5-flash-low', forceRaw: true,
    };
    await expect(callModel(label, [{ role: 'user', content: 'hi' }], { maxTokens: 50 })).rejects.toMatchObject({
      code: 'AI_EMPTY',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(generateText).not.toHaveBeenCalled();
  });

  it('forceRaw + choices[0] 无 message → 同样抛 AI_EMPTY', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ finish_reason: 'content_filter' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const label: AILabel = {
      name: 'gemini35low', endpoint: 'http://relay/v1', apiKeys: ['k'],
      model: 'gemini-3.5-flash-low', forceRaw: true,
    };
    await expect(callModel(label, [{ role: 'user', content: 'hi' }], { maxTokens: 50 })).rejects.toMatchObject({
      code: 'AI_EMPTY',
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('forceRaw + 空 content 时回退 reasoning_content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: 'WRITE\n\n本喵困了' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const label: AILabel = {
      name: 'grok45', endpoint: 'http://relay/v1', apiKeys: ['k'],
      model: 'grok-4.5', forceRaw: true, reasoningEffort: 'low',
    };
    const result = await callModel(label, [{ role: 'user', content: '日记' }], { maxTokens: 50 });
    expect(result.content).toContain('本喵困了');
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

  it('jsonMode sets response_format when the prompt contains "json"', async () => {
    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: '{"replyContent":"hi","targetMessageId":1}' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    }));
    const label: AILabel = { name: 'deepseek', endpoint: 'https://ds.example/v1', apiKeys: ['k'], model: 'deepseek-v4-flash', disableThinking: true };

    await callModel(label, [{ role: 'system', content: '只输出 JSON' }, { role: 'user', content: 'hi' }], { maxTokens: 50, jsonMode: true });
    expect(capturedBody.response_format).toEqual({ type: 'json_object' });
  });

  it('jsonMode does NOT set response_format when the prompt lacks "json" (avoids DeepSeek hard-error)', async () => {
    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    }));
    const label: AILabel = { name: 'deepseek', endpoint: 'https://ds.example/v1', apiKeys: ['k'], model: 'deepseek-v4-flash', disableThinking: true };

    await callModel(label, [{ role: 'user', content: '回复:你好' }], { maxTokens: 50, jsonMode: true });
    expect(capturedBody.response_format).toBeUndefined();
  });

  it('classifies StepFun raw HTTP 451 censorship_blocked as content rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'The content you provided or machine outputted is blocked.',
            type: 'censorship_blocked',
          },
        }),
        { status: 451, headers: { 'Content-Type': 'application/json' } },
      ),
    ));
    const label: AILabel = {
      name: 'stepfun',
      endpoint: 'https://api.stepfun.com/step_plan/v1',
      apiKeys: ['k'],
      model: 'step-3.7-flash',
      reasoningEffort: 'medium',
    };

    await expect(callModel(label, [{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ code: 'AI_CONTENT_REJECTED', provider: 'stepfun' });
  });

  it('classifies StepFun SDK blocked text as content rejection', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error('The content you provided or machine outputted is blocked.'),
    );
    const label: AILabel = {
      name: 'stepfunjudge',
      endpoint: 'https://api.stepfun.com/step_plan/v1',
      apiKeys: ['k'],
      model: 'step-3.5-flash',
    };

    await expect(callModel(label, [{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ code: 'AI_CONTENT_REJECTED', provider: 'stepfunjudge' });
  });
});
