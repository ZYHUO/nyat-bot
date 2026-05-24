import type { Redis } from 'ioredis';
import { getLabels, getUsage } from '../ai/labels.js';
import type { AILabel, AIUsage } from '../ai/types.js';
import { getUsageRouting } from '../env.js';
import { logger } from '../shared/logger.js';
import { AIConfigError } from '../shared/errors.js';

const OVERRIDE_KEY = 'xxb:admin:model_routing:override';

interface RuntimeProviderOverride {
  endpoint: string;
  model: string;
  api_key?: string;
  api_format?: 'openai' | 'claude';
  stream?: boolean;
}

interface RuntimeUsageOverride {
  label: string;
  backups?: string[];
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface RuntimeRoutingOverride {
  providers?: Record<string, RuntimeProviderOverride>;
  usage?: Record<string, RuntimeUsageOverride>;
}

export interface RuntimeOverride {
  sticker_policy?: {
    enabled: boolean;
    mode: 'ai' | 'sticker_only' | 'off';
    send_position: 'before' | 'after';
  };
  reply_quote?: boolean; // true = always quote (default), false = never attach reply_to
}

export async function loadOverride(redis: Redis): Promise<RuntimeOverride | null> {
  const raw = await redis.get(OVERRIDE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Only extract sticker_policy and reply_quote, ignore legacy providers/usage
    const result: RuntimeOverride = {};
    if (parsed['sticker_policy']) result.sticker_policy = parsed['sticker_policy'] as RuntimeOverride['sticker_policy'];
    if (parsed['reply_quote'] !== undefined) result.reply_quote = parsed['reply_quote'] as boolean;
    return result;
  } catch {
    logger.warn('Failed to parse runtime override from Redis');
    return null;
  }
}

let _cachedOverride: { data: RuntimeOverride | null; expiry: number } | undefined;
const OVERRIDE_CACHE_TTL = 5_000; // 5 seconds

export async function loadOverrideCached(redis: Redis): Promise<RuntimeOverride | null> {
  const now = Date.now();
  if (_cachedOverride && now < _cachedOverride.expiry) return _cachedOverride.data;
  const data = await loadOverride(redis);
  _cachedOverride = { data, expiry: now + OVERRIDE_CACHE_TTL };
  return data;
}

export async function saveOverride(redis: Redis, override: RuntimeOverride): Promise<void> {
  await redis.set(OVERRIDE_KEY, JSON.stringify(override));
}

export function buildProviderCatalog(override: RuntimeRoutingOverride | null): Record<string, Record<string, unknown>> {
  const catalog = Object.fromEntries(
    Array.from(getLabels().entries()).map(([name, label]) => [
      name,
      {
        endpoint: label.endpoint,
        model: label.model,
        api_keys: label.apiKeys,
        api_format: label.apiFormat,
        stream: label.stream,
      },
    ]),
  ) as Record<string, Record<string, unknown>>;

  for (const [name, provider] of Object.entries(override?.providers ?? {})) {
    catalog[name] = {
      endpoint: provider.endpoint,
      model: provider.model,
      api_keys: provider.api_key ? [provider.api_key] : [],
      api_format: provider.api_format,
      stream: provider.stream,
    };
  }

  return catalog;
}

export function resolveUsageForRuntime(name: string, override: RuntimeRoutingOverride | null): AIUsage {
  const usage = override?.usage?.[name];
  if (!usage) return getUsage(name);
  return {
    label: usage.label,
    backups: usage.backups ?? [],
    timeout: usage.timeout ?? 60_000,
    maxTokens: usage.maxTokens,
    temperature: usage.temperature,
  };
}

export function resolveLabelForRuntime(name: string, override: RuntimeRoutingOverride | null): AILabel {
  const builtin = getLabels().get(name);
  if (builtin) return builtin;

  const provider = override?.providers?.[name];
  if (!provider) {
    throw new AIConfigError(`AI label not found: ${name}`);
  }

  return {
    name,
    endpoint: provider.endpoint,
    apiKeys: provider.api_key ? [provider.api_key] : [],
    model: provider.model,
    apiFormat: provider.api_format,
    stream: provider.stream,
  };
}

export function buildModelRoutingAdminView(): Record<string, unknown> {
  const providers = Object.fromEntries(
    Array.from(getLabels().entries()).map(([name, label]) => [
      name,
      {
        endpoint: label.endpoint,
        model: label.model,
        api_format: label.apiFormat,
        stream: label.stream,
      },
    ]),
  );

  const usageNames = ['reply', 'reply_pro', 'judge', 'vision', 'summarize', 'path_reflection', 'allowlist_review', 'reply_splitter'];
  const effective: Record<string, unknown> = {};
  for (const name of usageNames) {
    try {
      effective[name] = getUsage(name);
    } catch { /* skip unconfigured */ }
  }

  return {
    source: 'env',
    providers,
    usage_routing: Object.fromEntries(getUsageRouting()),
    effective,
  };
}

export function buildStickerPolicyAdminView(
  override: RuntimeOverride | null,
): Record<string, unknown> {
  return {
    enabled: override?.sticker_policy?.enabled ?? true,
    mode: override?.sticker_policy?.mode ?? 'ai',
    send_position: override?.sticker_policy?.send_position ?? 'after',
    has_override: !!override?.sticker_policy,
  };
}

export interface ProviderValidateInput {
  endpoint: string;
  model: string;
  api_key?: string;
  api_format?: 'openai' | 'claude';
  stream?: boolean;
}

export async function validateProvider(provider: ProviderValidateInput): Promise<{
  ok: boolean;
  latency_ms: number;
  error?: string;
}> {
  if (!provider.api_key) return { ok: false, latency_ms: 0, error: 'No API key' };

  const start = Date.now();
  try {
    const isClaude = provider.api_format === 'claude';
    const endpoint = isClaude
      ? `${provider.endpoint}/messages`
      : `${provider.endpoint}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isClaude) {
      headers['x-api-key'] = provider.api_key;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${provider.api_key}`;
    }
    const body = isClaude
      ? {
          model: provider.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }
      : {
          model: provider.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          ...(provider.stream ? { stream: true } : {}),
        };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const latency = Date.now() - start;

    if (!res.ok) {
      return { ok: false, latency_ms: latency, error: `HTTP ${res.status}` };
    }
    return { ok: true, latency_ms: latency };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
