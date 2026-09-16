import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/ai/labels.js', () => {
  const labels = new Map([
    ['reply', { name: 'reply', endpoint: 'https://main.example/v1', apiKeys: ['main-key'], model: 'main-model', stream: true, apiFormat: 'openai' }],
    ['reply_pro', { name: 'reply_pro', endpoint: 'https://main.example/v1', apiKeys: ['main-key'], model: 'pro-model' }],
    ['allowlist_review', { name: 'allowlist_review', endpoint: 'https://review.example/v1', apiKeys: ['review-key'], model: 'review-model', apiFormat: 'claude' }],
  ]);

  return {
    getLabels: () => labels,
    getLabel: (name: string) => {
      const label = labels.get(name);
      if (!label) throw new Error(`missing label ${name}`);
      return label;
    },
    getUsage: (name: string) => {
      if (name === 'reply') {
        return { label: 'reply', backups: ['reply_pro'], timeout: 60_000 };
      }
      if (name === 'allowlist_review') {
        return { label: 'allowlist_review', backups: [], timeout: 60_000 };
      }
      throw new Error(`missing usage ${name}`);
    },
  };
});

const {
  buildProviderCatalog,
  resolveUsageForRuntime,
  resolveLabelForRuntime,
  validateProvider,
} = await import('../../../src/admin/runtime-config.js');

describe('runtime routing helpers', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('builds provider catalog with built-ins and custom overrides', () => {
    const providers = buildProviderCatalog({
      providers: {
        custom_fast: {
          endpoint: 'https://custom.example/v1',
          model: 'custom-model',
          api_key: 'custom-key',
        },
      },
    });

    expect(providers['reply']?.model).toBe('main-model');
    expect(providers['reply_pro']?.model).toBe('pro-model');
    expect(providers['custom_fast']?.model).toBe('custom-model');
  });

  it('preserves built-in provider metadata in the catalog', () => {
    const providers = buildProviderCatalog(null);

    expect(providers['reply']).toMatchObject({
      endpoint: 'https://main.example/v1',
      model: 'main-model',
      api_keys: ['main-key'],
      stream: true,
      api_format: 'openai',
    });
    expect(providers['allowlist_review']).toMatchObject({
      api_format: 'claude',
    });
  });

  it('applies usage override for runtime routing', () => {
    const usage = resolveUsageForRuntime('reply', {
      usage: {
        reply: {
          label: 'custom_fast',
          backups: ['reply'],
        },
      },
    });

    expect(usage.label).toBe('custom_fast');
    expect(usage.backups).toEqual(['reply']);
  });

  it('resolves custom runtime provider into an AI label', () => {
    const label = resolveLabelForRuntime('custom_fast', {
      providers: {
        custom_fast: {
          endpoint: 'https://custom.example/v1',
          model: 'custom-model',
          api_key: 'custom-key',
        },
      },
    });

    expect(label).toMatchObject({
      name: 'custom_fast',
      endpoint: 'https://custom.example/v1',
      model: 'custom-model',
      apiKeys: ['custom-key'],
    });
  });

  it('validates stream-only OpenAI-compatible providers with stream=true', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
    }) as unknown as typeof fetch;

    const result = await validateProvider({
      endpoint: 'https://custom.example/v1',
      model: 'gpt-5.4',
      api_key: 'openai-key',
      stream: true,
    });

    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://custom.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer openai-key',
        },
      }),
    );
    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: 'gpt-5.4',
      stream: true,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  });

  it('validates Claude-format providers against /messages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
    }) as unknown as typeof fetch;

    const result = await validateProvider({
      endpoint: 'https://claude.example/v1',
      model: 'claude-sonnet-4-5',
      api_key: 'claude-key',
      api_format: 'claude',
    });

    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://claude.example/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'claude-key',
          'anthropic-version': '2023-06-01',
        },
      }),
    );
    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: 'claude-sonnet-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  });
});
