import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/ai/labels.js', () => ({
  getLabels: () => new Map([
    ['main', { endpoint: 'https://main.example/v1', model: 'main-model', apiFormat: 'openai', stream: false }],
    ['reply', { endpoint: 'https://reply.example/v1', model: 'reply-model', apiFormat: 'openai', stream: false }],
  ]),
  getUsage: (name: string) => ({
    label: name === 'reply' ? 'reply' : 'main',
    backups: name === 'allowlist_review' ? ['reply'] : [],
    timeout: name === 'path_reflection' ? 20_000 : 60_000,
    ...(name === 'path_reflection' ? { maxTokens: 200, temperature: 0 } : {}),
  }),
}));

vi.mock('../../../src/env.js', () => ({
  getUsageRouting: () => new Map([
    ['reply', { label: 'reply', backups: ['main'], timeout: 60_000 }],
    ['allowlist_review', { label: 'main', backups: ['reply'], timeout: 60_000 }],
  ]),
}));

import {
  loadOverride,
  saveOverride,
  buildModelRoutingAdminView,
  buildStickerPolicyAdminView,
} from '../../../src/admin/runtime-config.js';
import type { RuntimeOverride } from '../../../src/admin/runtime-config.js';

function createMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    _store: store,
  };
}

describe('loadOverride', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  it('returns null when no key exists', async () => {
    const result = await loadOverride(redis as never);
    expect(result).toBeNull();
  });

  it('returns parsed override', async () => {
    const override: RuntimeOverride = {
      sticker_policy: { enabled: false, mode: 'off', send_position: 'before' },
      reply_quote: false,
    };
    redis._store.set('xxb:admin:model_routing:override', JSON.stringify(override));

    const result = await loadOverride(redis as never);
    expect(result).not.toBeNull();
    expect(result).toEqual(override);
  });

  it('returns null for invalid JSON', async () => {
    redis._store.set('xxb:admin:model_routing:override', 'not-json{');
    const result = await loadOverride(redis as never);
    expect(result).toBeNull();
  });
});

describe('saveOverride', () => {
  it('writes JSON to Redis', async () => {
    const redis = createMockRedis();
    const override: RuntimeOverride = {
      sticker_policy: { enabled: true, mode: 'ai', send_position: 'after' },
    };

    await saveOverride(redis as never, override);
    expect(redis.set).toHaveBeenCalledWith(
      'xxb:admin:model_routing:override',
      JSON.stringify(override),
    );
  });
});

describe('buildModelRoutingAdminView', () => {
  it('returns env-backed providers and effective routing', () => {
    const view = buildModelRoutingAdminView();

    expect(view.source).toBe('env');
    expect((view.providers as Record<string, { model: string }>)['reply']!.model).toBeTruthy();
    expect((view.usage_routing as Record<string, string>)['reply']).toBeTruthy();
    expect((view.effective as Record<string, { label: string }>)['reply']!.label).toBeTruthy();
  });
});

describe('buildStickerPolicyAdminView', () => {
  it('returns defaults when no override', () => {
    const view = buildStickerPolicyAdminView(null);
    expect(view.enabled).toBe(true);
    expect(view.mode).toBe('ai');
    expect(view.send_position).toBe('after');
    expect(view.has_override).toBe(false);
  });

  it('returns override values when present', () => {
    const override: RuntimeOverride = {
      sticker_policy: { enabled: false, mode: 'off', send_position: 'before' },
    };
    const view = buildStickerPolicyAdminView(override);
    expect(view.enabled).toBe(false);
    expect(view.mode).toBe('off');
    expect(view.send_position).toBe('before');
    expect(view.has_override).toBe(true);
  });
});
