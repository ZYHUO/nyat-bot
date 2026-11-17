import type { AITokenUsage } from './types.js';

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Fields : {};
}

/** Provider counters are observations: never coerce strings or invent cache zeroes. */
function tokens(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      return value === 0 ? 0 : value;
    }
  }
  return undefined;
}

function sum(values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) return undefined;
    total += value;
  }
  return total;
}

/** OpenAI and SDK input counters already include all cached input tokens. */
function totalInputUsage(
  input: number | undefined, output: number | undefined,
  cached: number | undefined, cacheWrite?: number,
): AITokenUsage {
  if (input !== undefined) {
    if (cached !== undefined && cached > input) cached = undefined;
    if (cacheWrite !== undefined && cacheWrite > input) cacheWrite = undefined;
    if (cached !== undefined && cacheWrite !== undefined
      && cached > input - cacheWrite) {
      // Contradictory cache components are not usable numerator observations.
      cached = undefined;
      cacheWrite = undefined;
    }
  }
  const prompt = input ?? 0;
  const completion = output ?? 0;
  const total = sum([prompt, completion]);
  return {
    prompt, completion, total: total ?? 0,
    inputKnown: input !== undefined && total !== undefined,
    ...(cached === undefined ? {} : { cached }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

export function normalizeOpenAIUsage(usage: unknown): AITokenUsage {
  const value = fields(usage);
  const promptDetails = fields(value.prompt_tokens_details);
  const inputDetails = fields(value.input_tokens_details);
  return totalInputUsage(
    tokens(value.prompt_tokens, value.input_tokens),
    tokens(value.completion_tokens, value.output_tokens),
    tokens(promptDetails.cached_tokens, inputDetails.cached_tokens, value.prompt_cache_hit_tokens),
    tokens(promptDetails.cache_write_tokens, inputDetails.cache_write_tokens),
  );
}

/** Anthropic input_tokens counts fresh input, excluding cache reads and writes. */
export function normalizeAnthropicUsage(usage: unknown): AITokenUsage {
  const value = fields(usage);
  const fresh = tokens(value.input_tokens);
  const cached = tokens(value.cache_read_input_tokens);
  const cacheWrite = tokens(value.cache_creation_input_tokens);
  const input = sum([fresh ?? 0, cached ?? 0, cacheWrite ?? 0]);
  const prompt = input ?? 0;
  const completion = tokens(value.output_tokens) ?? 0;
  const total = input === undefined ? undefined : sum([prompt, completion]);
  return {
    prompt, completion, total: total ?? 0,
    inputKnown: fresh !== undefined && cached !== undefined && cacheWrite !== undefined
      && input !== undefined && total !== undefined,
    ...(cached === undefined ? {} : { cached }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

export function normalizeSdkUsage(
  usage: unknown, providerMetadata: unknown, rawResponse?: unknown,
): AITokenUsage {
  const value = fields(usage);
  const metadata = fields(fields(providerMetadata).openai);
  const rawUsage = fields(fields(rawResponse).usage);
  const promptDetails = fields(rawUsage.prompt_tokens_details);
  const inputDetails = fields(rawUsage.input_tokens_details);
  return totalInputUsage(
    tokens(value.promptTokens, value.inputTokens),
    tokens(value.completionTokens, value.outputTokens),
    tokens(metadata.cachedPromptTokens, promptDetails.cached_tokens,
      inputDetails.cached_tokens, rawUsage.prompt_cache_hit_tokens),
    tokens(promptDetails.cache_write_tokens, inputDetails.cache_write_tokens),
  );
}
