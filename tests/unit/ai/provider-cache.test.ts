import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AILabel } from '../../../src/ai/types.js';
import { buildClaudeSystem } from '../../../src/ai/system-cache.js';

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn((model: string) => ({ model }))),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { callModel, __resetTruncatingLabelsForTest } = await import('../../../src/ai/provider.js');
const { generateText } = await import('ai');
const { logger } = await import('../../../src/shared/logger.js');
const label: AILabel = {
  name: 'cache-test', endpoint: 'https://provider.invalid/v1',
  model: 'test-model', apiKeys: ['synthetic-test-key'],
};
const messages = [
  { role: 'system' as const, content: '固定规则。\n当前：合成状态' },
  { role: 'user' as const, content: '合成问题' },
  { role: 'system' as const, content: '第二段规则必须保留' },
  { role: 'assistant' as const, content: '此前的合成回复' },
];
const stable = '固定规则。\n';
const knownUsage = { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 5 };

function anthropic(usage: unknown = knownUsage, truncated = false): Response {
  return Response.json({
    content: truncated ? [{ type: 'thinking', thinking: 'synthetic' }] : [{ type: 'text', text: '合成回答' }],
    stop_reason: truncated ? 'max_tokens' : 'end_turn', usage,
  });
}

function capture(response: () => Response) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn((_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return Promise.resolve(response());
  });
  vi.stubGlobal('fetch', fetchMock);
  return { bodies, fetchMock };
}

describe('provider prompt cache wiring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetTruncatingLabelsForTest();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('marks the exact native stable prefix, retaining its dynamic suffix and every system message', async () => {
    const { bodies } = capture(() => anthropic());
    const result = await callModel({ ...label, apiFormat: 'claude' }, messages, { systemCachePrefix: stable });
    expect(bodies[0]?.system).toEqual([
      { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '当前：合成状态' },
      { type: 'text', text: messages[2]!.content },
    ]);
    expect(bodies[0]?.messages).toEqual([messages[1], messages[3]]);
    const blocks = bodies[0]?.system as Array<{ text: string }>;
    expect(blocks.map(block => block.text).join('')).toBe(messages[0]!.content + messages[2]!.content);
    expect(result.transportPath).toBe('anthropic_json');
    expect(result.tokenUsage).toEqual({ prompt: 110, completion: 5, total: 115, cached: 80, cacheWrite: 10, inputKnown: true });
  });

  it('rejects a replacement hint without losing content or logging the supplied text', async () => {
    const { bodies } = capture(() => anthropic());
    await callModel({ ...label, apiFormat: 'claude' }, messages, { systemCachePrefix: 'SECRET-INVALID-HINT' });
    expect(bodies[0]?.system).toEqual([
      { type: 'text', text: messages[0]!.content }, { type: 'text', text: messages[2]!.content },
    ]);
    expect(logger.warn).toHaveBeenCalledWith({ label: label.name }, 'Invalid system cache prefix ignored');
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('SECRET-INVALID-HINT');
  });

  it('keeps legacy first-system caching when no boundary is supplied and preserves later systems', async () => {
    const { bodies } = capture(() => anthropic());
    await callModel({ ...label, apiFormat: 'claude' }, messages);
    expect(bodies[0]?.system).toEqual([
      { type: 'text', text: messages[0]!.content, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: messages[2]!.content },
    ]);
  });

  it('accepts a whole-system boundary without emitting an empty suffix', () => {
    expect(buildClaudeSystem(['fixed', 'second'], 'fixed')).toEqual({ invalidPrefix: false, blocks: [
      { type: 'text', text: 'fixed', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'second' },
    ] });
  });

  it.each(['', '   ', 'unrelated', 'x😀'.slice(0, 2)])('does not mark an invalid or partial-surrogate prefix %j', prefix => {
    const system = 'x😀dynamic';
    expect(buildClaudeSystem([system], prefix)).toEqual({ invalidPrefix: true, blocks: [{ type: 'text', text: system }] });
  });

  it('uses the flattened text-parts system unchanged at the native boundary', async () => {
    const { bodies } = capture(() => anthropic());
    await callModel({ ...label, apiFormat: 'claude' }, [
      { role: 'system', content: [{ type: 'text', text: stable }, { type: 'text', text: 'dynamic' }] },
      { role: 'user', content: 'test' },
    ], { systemCachePrefix: stable });
    expect(bodies[0]?.system).toEqual([
      { type: 'text', text: stable, cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'dynamic' },
    ]);
  });

  it('keeps SDK message ordering and recovers cache metadata without adding to inclusive input', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'answer', usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 },
      providerMetadata: { openai: { cachedPromptTokens: 60 } },
    } as never);
    const result = await callModel(label, messages, { systemCachePrefix: stable });
    expect(vi.mocked(generateText).mock.calls[0]?.[0].messages).toEqual(messages);
    expect(vi.mocked(generateText).mock.calls[0]?.[0]).not.toHaveProperty('systemCachePrefix');
    expect(result.transportPath).toBe('openai_sdk');
    expect(result.tokenUsage).toEqual({ prompt: 100, completion: 5, total: 105, cached: 60, inputKnown: true });
  });

  it('uses parsed SDK raw-response cache fields only as a metadata fallback', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'answer', usage: { promptTokens: 100, completionTokens: 5 },
      response: { body: { usage: { prompt_cache_hit_tokens: 40 } } },
    } as never);
    expect((await callModel(label, messages)).tokenUsage.cached).toBe(40);
  });

  it('keeps raw message ordering and all systems, without sending native cache controls', async () => {
    const { bodies } = capture(() => Response.json({
      choices: [{ message: { content: 'answer' } }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
    }));
    const result = await callModel({ ...label, forceRaw: true }, messages, { systemCachePrefix: stable });
    expect(bodies[0]?.messages).toEqual(messages);
    expect(bodies[0]).not.toHaveProperty('system');
    expect(bodies[0]).not.toHaveProperty('systemCachePrefix');
    expect(result.tokenUsage).toEqual({ prompt: 100, completion: 5, total: 105, cached: 0, inputKnown: true });
    expect(result.transportPath).toBe('openai_json');
  });

  it.each([['https://api.openai.com/v1', true], ['https://provider.invalid/v1', false]] as const)(
    'only requests optional stream usage at verified official endpoint %s', async (endpoint, includesUsage) => {
      const { bodies } = capture(() => new Response([
        'data: {"choices":[{"delta":{"content":"answer"}}],"usage":null}', '',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60}}}', '',
        'data: [DONE]', '', '',
      ].join('\n')));
      const result = await callModel({ ...label, endpoint, stream: true }, messages);
      if (includesUsage) expect(bodies[0]?.stream_options).toEqual({ include_usage: true });
      else expect(bodies[0]).not.toHaveProperty('stream_options');
      expect(result.transportPath).toBe('openai_stream');
      expect(result.tokenUsage).toEqual({ prompt: 100, completion: 5, total: 105, cached: 60, inputKnown: true });
    },
  );

  it('reports an otherwise successful stream without usage as unknown, never a measured zero', async () => {
    capture(() => new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n'));
    const result = await callModel({ ...label, stream: true }, messages);
    expect(result.tokenUsage).toEqual({ prompt: 0, completion: 0, total: 0, inputKnown: false });
  });

  it('accepts absent native usage without inventing cache fields', async () => {
    capture(() => Response.json({ content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn' }));
    expect((await callModel({ ...label, apiFormat: 'claude' }, messages)).tokenUsage)
      .toEqual({ prompt: 0, completion: 0, total: 0, inputKnown: false });
  });

  it('retains usage from both native truncation attempts, with an explicit request count', async () => {
    let attempt = 0;
    capture(() => ++attempt === 1 ? anthropic(knownUsage, true) : anthropic({
      input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 7,
    }));
    const result = await callModel({ ...label, apiFormat: 'claude' }, messages);
    expect(result.content).toBe('合成回答');
    expect(result.providerRequests).toBe(2);
    expect(result.tokenUsage).toEqual({ prompt: 220, completion: 12, total: 232, cached: 180, cacheWrite: 10, inputKnown: true });
  });

  it('retains both observed usages even when both native attempts truncate', async () => {
    capture(() => anthropic(knownUsage, true));
    const result = await callModel({ ...label, apiFormat: 'claude' }, messages);
    expect(result.content).toBe('');
    expect(result.providerRequests).toBe(2);
    expect(result.tokenUsage).toEqual({ prompt: 220, completion: 10, total: 230, cached: 160, cacheWrite: 20, inputKnown: true });
  });

  it('does not claim complete cache coverage if one native retry omits fields', async () => {
    let attempt = 0;
    capture(() => ++attempt === 1 ? anthropic(knownUsage, true) : anthropic({ input_tokens: 10, output_tokens: 7 }));
    const result = await callModel({ ...label, apiFormat: 'claude' }, messages);
    expect(result.tokenUsage).toEqual({ prompt: 120, completion: 12, total: 132, inputKnown: false });
  });

  it('marks the retained subtotal as incomplete when the second native attempt fails', async () => {
    let attempt = 0;
    capture(() => ++attempt === 1 ? anthropic(knownUsage, true) : new Response('synthetic failure', { status: 503 }));
    const result = await callModel({ ...label, apiFormat: 'claude' }, messages);
    expect(result.content).toBe('');
    expect(result.providerRequests).toBe(2);
    expect(result.tokenUsage).toEqual({ prompt: 110, completion: 5, total: 115, inputKnown: false });
  });
});
