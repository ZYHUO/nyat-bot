import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextEngine, staticText, ephemeralText, volatileText } from '@nyat/context-engine';
import type { AILabel } from '../../src/ai/types.js';

const f = vi.hoisted(() => ({ fetch: vi.fn(), labels: {} as Record<string, AILabel>, events: vi.fn() }));
vi.mock('../../src/ai/labels.js', () => ({
  getUsage: () => ({ label: 'first', backups: ['backup'], timeout: 5000 }),
  getLabel: (name: string) => f.labels[name],
}));
vi.mock('../../src/ai/smart-group.js', () => ({
  isAutoAssignEnabled: () => false, smartGroupAutoAssign: async () => [],
  smartGroupReorder: async (names: string[]) => names, recordSmartGroupResult: async () => {},
}));
vi.mock('../../src/ai/cooldown.js', () => ({ CooldownTracker: class {
  isCoolingDown = async () => false; getRemainingSeconds = async () => 0;
  recordSuccess = async () => {}; recordFailure = async () => false; setCooldown = async () => {};
} }));
vi.mock('../../src/ai/concurrency.js', () => ({
  AI_MAX_CONCURRENCY_PER_ACCOUNT: 7, acquireConcurrency: async () => () => {},
}));
vi.mock('../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../src/env.js', () => ({ env: () => ({ HEDGE_DELAY_MS: 0 }) }));
vi.mock('../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { callWithFallback } from '../../src/ai/fallback.js';
import { llmEvents } from '../../src/ai/events.js';

const response = (usage: Record<string, number>) => new Response(JSON.stringify({
  content: [{ type: 'text', text: 'synthetic answer' }], model: 'synthetic-model',
  stop_reason: 'end_turn', usage,
}), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  f.fetch.mockReset(); f.events.mockReset(); vi.stubGlobal('fetch', f.fetch);
  for (const name of ['first', 'backup']) f.labels[name] = {
    name, model: `synthetic-${name}`, endpoint: 'https://synthetic.invalid/v1',
    apiKeys: ['synthetic-test-key'], apiFormat: 'claude',
  };
  llmEvents.on('result', f.events);
});
afterEach(() => { llmEvents.off('result', f.events); vi.unstubAllGlobals(); });

describe('context assembly → fallback → serialized cache boundary → usage event', () => {
  it('preserves the scoped prefix through fallback while sending the current dynamic context in full', async () => {
    const engine = new ContextEngine('synthetic-scope');
    const assemble = (turn: string) => engine.assemble([
      staticText('identity', 'synthetic scoped identity'),
      ephemeralText('memory', `synthetic memory ${turn}`), volatileText('now', `synthetic time ${turn}`),
    ]);
    const first = await assemble('A');
    const second = await assemble('B');
    expect(second.cachePrefix).toBe(first.cachePrefix);
    f.fetch.mockResolvedValueOnce(new Response('synthetic failure', { status: 500 }))
      .mockResolvedValueOnce(response({ input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 5 }));
    await callWithFallback({ usage: 'synthetic-cache', systemCachePrefix: second.cachePrefix,
      messages: [{ role: 'system', content: second.prompt }, { role: 'user', content: 'synthetic task' }] });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of f.fetch.mock.calls) {
      const body = JSON.parse(init.body as string);
      expect(body.system[0]).toEqual({ type: 'text', text: second.cachePrefix, cache_control: { type: 'ephemeral' } });
      expect(body.system.map((part: { text: string }) => part.text).join('')).toBe(second.prompt);
      expect(body.system[1].cache_control).toBeUndefined();
      expect(body.messages).toEqual([{ role: 'user', content: 'synthetic task' }]);
      expect(JSON.stringify(body)).not.toContain('memory A');
    }
    const successes = f.events.mock.calls.map(([event]) => event).filter(event => event.outcome === 'ok');
    expect(successes).toHaveLength(1);
    expect(successes[0]).toMatchObject({ label: 'backup', promptTokens: 110, cachedTokens: 80, completionTokens: 5 });
  });

  it('does not invent cache misses when a compatible provider omits cache usage', async () => {
    f.fetch.mockResolvedValue(response({ input_tokens: 20, output_tokens: 5 }));
    await callWithFallback({ usage: 'synthetic-cache-unknown', messages: [{ role: 'user', content: 'synthetic task' }] });
    expect(f.events).toHaveBeenCalledOnce();
    expect(f.events.mock.calls[0]![0].cachedTokens).toBeUndefined();
  });
});
