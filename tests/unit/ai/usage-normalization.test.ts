import { describe, expect, it } from 'vitest';
import {
  normalizeAnthropicUsage, normalizeOpenAIUsage, normalizeSdkUsage,
} from '../../../src/ai/usage-normalization.js';

describe('OpenAI usage normalization', () => {
  it('keeps cached input inside the reported input total without counting it twice', () => {
    expect(normalizeOpenAIUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 999,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 } })).toEqual({
      prompt: 100, completion: 20, total: 120, cached: 60, cacheWrite: 10, inputKnown: true,
    });
  });

  it('accepts input/output counters and their cache details', () => {
    expect(normalizeOpenAIUsage({ input_tokens: 80, output_tokens: 5,
      input_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 } })).toEqual({
      prompt: 80, completion: 5, total: 85, cached: 50, cacheWrite: 20, inputKnown: true,
    });
  });

  it('reads DeepSeek hits without inferring cache writes from misses', () => {
    expect(normalizeOpenAIUsage({ prompt_tokens: 100, completion_tokens: 4,
      prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, cache_write_tokens: 30 })).toEqual({
      prompt: 100, completion: 4, total: 104, cached: 70, inputKnown: true,
    });
  });

  it('preserves explicit zero and prefers the first valid protocol field', () => {
    expect(normalizeOpenAIUsage({ prompt_tokens: 0, input_tokens: 90,
      completion_tokens: 0, output_tokens: 9,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      input_tokens_details: { cached_tokens: 70 }, prompt_cache_hit_tokens: 80 })).toEqual({
      prompt: 0, completion: 0, total: 0, cached: 0, cacheWrite: 0, inputKnown: true,
    });
  });

  it('keeps absent cache counters unknown and accepts independently valid alternative fields', () => {
    expect(normalizeOpenAIUsage({ prompt_tokens: 100, completion_tokens: 5 })).toEqual({
      prompt: 100, completion: 5, total: 105, inputKnown: true,
    });
    expect(normalizeOpenAIUsage({ prompt_tokens: '100', input_tokens: 80,
      completion_tokens: null, output_tokens: 5, prompt_tokens_details: [],
      input_tokens_details: { cached_tokens: 40 } })).toEqual({
      prompt: 80, completion: 5, total: 85, cached: 40, inputKnown: true,
    });
  });

  it.each([-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4', null, true])(
    'does not turn invalid cache observation %j into a miss', invalid => {
      const result = normalizeOpenAIUsage({ prompt_tokens: 10, completion_tokens: invalid,
        prompt_tokens_details: { cached_tokens: invalid, cache_write_tokens: invalid } });
      expect(result).toEqual({ prompt: 10, completion: 0, total: 10, inputKnown: true });
      expect(result).not.toHaveProperty('cached');
      expect(result).not.toHaveProperty('cacheWrite');
    },
  );

  it('rejects impossible cache components while retaining unrelated valid observations', () => {
    expect(normalizeOpenAIUsage({ prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: 11, cache_write_tokens: 2 } })).toEqual({
      prompt: 10, completion: 0, total: 10, cacheWrite: 2, inputKnown: true,
    });
    expect(normalizeOpenAIUsage({ prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 11 } })).toEqual({
      prompt: 10, completion: 0, total: 10, cached: 2, inputKnown: true,
    });
    expect(normalizeOpenAIUsage({ prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 5 } })).toEqual({
      prompt: 10, completion: 0, total: 10, inputKnown: true,
    });
  });

  it('retains a known cache count when total input is unknown without making a denominator', () => {
    expect(normalizeOpenAIUsage({ prompt_tokens: '10', prompt_cache_hit_tokens: 8 })).toEqual({
      prompt: 0, completion: 0, total: 0, cached: 8, inputKnown: false,
    });
  });
});

describe('Anthropic usage normalization', () => {
  it('adds fresh input, cache reads and writes exactly once', () => {
    expect(normalizeAnthropicUsage({ input_tokens: 10, output_tokens: 5,
      cache_read_input_tokens: 60, cache_creation_input_tokens: 30 })).toEqual({
      prompt: 100, completion: 5, total: 105, cached: 60, cacheWrite: 30, inputKnown: true,
    });
  });

  it('requires all input components for a known denominator, preserving available observations', () => {
    expect(normalizeAnthropicUsage({ input_tokens: 10, output_tokens: 5,
      cache_read_input_tokens: 60 })).toEqual({
      prompt: 70, completion: 5, total: 75, cached: 60, inputKnown: false,
    });
    expect(normalizeAnthropicUsage({ input_tokens: '10', output_tokens: 5,
      cache_read_input_tokens: 60, cache_creation_input_tokens: 30 })).toEqual({
      prompt: 90, completion: 5, total: 95, cached: 60, cacheWrite: 30, inputKnown: false,
    });
    expect(normalizeAnthropicUsage({ input_tokens: 10 })).toEqual({
      prompt: 10, completion: 0, total: 10, inputKnown: false,
    });
  });

  it('treats three explicit zeroes as known input rather than missing data', () => {
    expect(normalizeAnthropicUsage({ input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toEqual({
      prompt: 0, completion: 0, total: 0, cached: 0, cacheWrite: 0, inputKnown: true,
    });
  });

  it.each([-1, 0.25, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'])(
    'excludes invalid Anthropic components %j without claiming complete input', invalid => {
      expect(normalizeAnthropicUsage({ input_tokens: 10, output_tokens: invalid,
        cache_read_input_tokens: invalid, cache_creation_input_tokens: invalid })).toEqual({
        prompt: 10, completion: 0, total: 10, inputKnown: false,
      });
    },
  );
});

describe('SDK usage normalization', () => {
  it('reads cache observations from OpenAI provider metadata without adding them to input', () => {
    expect(normalizeSdkUsage({ promptTokens: 100, completionTokens: 7, totalTokens: 1000 },
      { openai: { cachedPromptTokens: 80 } })).toEqual({
      prompt: 100, completion: 7, total: 107, cached: 80, inputKnown: true,
    });
  });

  it('accepts the newer camelCase input/output names and an explicit cache zero', () => {
    expect(normalizeSdkUsage({ inputTokens: 100, outputTokens: 7 },
      { openai: { cachedPromptTokens: 0 } })).toEqual({
      prompt: 100, completion: 7, total: 107, cached: 0, inputKnown: true,
    });
  });

  it('does not invent metadata or accept cache counters from unrelated sources', () => {
    const usage = { promptTokens: 100, completionTokens: 7, cachedPromptTokens: 90 };
    for (const metadata of [undefined, null, [], { openai: { cachedPromptTokens: '90' } },
      { anthropic: { cachedPromptTokens: 90 } }, { cachedPromptTokens: 90 }]) {
      expect(normalizeSdkUsage(usage, metadata)).toEqual({
        prompt: 100, completion: 7, total: 107, inputKnown: true,
      });
    }
  });

  it('rejects cache counts larger than known SDK input', () => {
    expect(normalizeSdkUsage({ inputTokens: 10 }, { openai: { cachedPromptTokens: 11 } })).toEqual({
      prompt: 10, completion: 0, total: 10, inputKnown: true,
    });
  });

  it('uses object response cache details when SDK metadata does not report them', () => {
    expect(normalizeSdkUsage({ inputTokens: 100, outputTokens: 7 }, undefined, {
      usage: { input_tokens: 999, output_tokens: 999,
        input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 } },
    })).toEqual({ prompt: 100, completion: 7, total: 107,
      cached: 60, cacheWrite: 10, inputKnown: true });
    expect(normalizeSdkUsage({ promptTokens: 100, completionTokens: 7 }, null, {
      usage: { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
    })).toEqual({ prompt: 100, completion: 7, total: 107, cached: 80, inputKnown: true });
  });

  it('preserves metadata zero over raw hits and validates combined raw cache observations', () => {
    expect(normalizeSdkUsage({ inputTokens: 100 }, { openai: { cachedPromptTokens: 0 } }, {
      usage: { prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } },
    })).toEqual({ prompt: 100, completion: 0, total: 100,
      cached: 0, cacheWrite: 20, inputKnown: true });
    expect(normalizeSdkUsage({ inputTokens: 100 }, { openai: { cachedPromptTokens: 90 } }, {
      usage: { prompt_tokens_details: { cache_write_tokens: 20 } },
    })).toEqual({ prompt: 100, completion: 0, total: 100, inputKnown: true });
  });

  it('never parses raw strings or substitutes raw main counters for unknown SDK input', () => {
    const raw = { usage: { prompt_tokens: 100, completion_tokens: 7, prompt_cache_hit_tokens: 80 } };
    expect(normalizeSdkUsage(undefined, undefined, raw)).toEqual({
      prompt: 0, completion: 0, total: 0, cached: 80, inputKnown: false,
    });
    expect(normalizeSdkUsage({ inputTokens: 100 }, null, JSON.stringify(raw))).toEqual({
      prompt: 100, completion: 0, total: 100, inputKnown: true,
    });
  });
});

describe('unknown or unrepresentable usage', () => {
  it.each([undefined, null, 'usage', 42, []])('handles non-object input %j conservatively', usage => {
    for (const result of [normalizeOpenAIUsage(usage), normalizeAnthropicUsage(usage), normalizeSdkUsage(usage, null)]) {
      expect(result).toEqual({ prompt: 0, completion: 0, total: 0, inputKnown: false });
    }
  });

  it('never returns an imprecise integer when otherwise valid counters overflow', () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const results = [
      normalizeOpenAIUsage({ prompt_tokens: maximum, completion_tokens: 1 }),
      normalizeAnthropicUsage({ input_tokens: maximum, cache_read_input_tokens: 1,
        cache_creation_input_tokens: 0, output_tokens: 1 }),
      normalizeSdkUsage({ inputTokens: maximum, outputTokens: 1 }, { openai: { cachedPromptTokens: 0 } }),
    ];
    for (const result of results) {
      expect(result.inputKnown).toBe(false);
      expect(result.total).toBe(0);
      expect(Object.values(result).filter(value => typeof value === 'number').every(Number.isSafeInteger)).toBe(true);
    }
    expect(results[1]).toEqual({ prompt: 0, completion: 1, total: 0, cached: 1, cacheWrite: 0, inputKnown: false });
  });

  it('does not mutate supplied usage or metadata', () => {
    const usage = { input_tokens: 10, output_tokens: 1,
      cache_read_input_tokens: 20, cache_creation_input_tokens: 30,
      prompt_tokens_details: { cached_tokens: 5 } };
    const metadata = { openai: { cachedPromptTokens: 4 } };
    const original = structuredClone({ usage, metadata });
    normalizeOpenAIUsage(usage);
    normalizeAnthropicUsage(usage);
    normalizeSdkUsage(usage, metadata);
    expect({ usage, metadata }).toEqual(original);
  });
});
