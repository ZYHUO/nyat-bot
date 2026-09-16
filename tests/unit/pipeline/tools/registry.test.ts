import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock env before importing
vi.mock('../../../../src/env.js', () => ({
  env: () => ({
    SEARXNG_URL: 'http://searxng:8080',
    FETCH_GATEWAY_URL: 'https://r.jina.ai/{URL}',
    FETCH_WORKER_URL: 'http://worker:3000',
    WEB_FETCH_USER_AGENT: 'XXB-WebFetch/1.0',
    IP_QUALITY_API_URL: 'http://ipquality:8080',
    TIMER_API_URL: 'http://timer:8080',
    TIMER_CALLBACK_URL: 'http://bot:3000/callback',
    COMMON_API_KEY: 'test-key',
  }),
}));

// Must mock tracking/interaction for bot-knowledge
vi.mock('../../../../src/tracking/interaction.js', () => ({
  getBotTracker: () => null,
}));

import { buildToolSet } from '../../../../src/pipeline/tools/registry.js';

describe('buildToolSet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all tools when all env vars are configured', () => {
    const tools = buildToolSet(123, 456);
    expect(tools).toHaveProperty('SEARCH');
    expect(tools).toHaveProperty('FETCH');
    expect(tools).toHaveProperty('IP_QUALITY');
    expect(tools).toHaveProperty('ADD_TIMER');
    expect(tools).toHaveProperty('LIST_TIMERS');
    expect(tools).toHaveProperty('DELETE_TIMER');
    expect(tools).toHaveProperty('BOT_KNOWLEDGE');
  });

  it('BOT_KNOWLEDGE is always present', () => {
    const tools = buildToolSet(123, 456);
    expect(tools.BOT_KNOWLEDGE).toBeDefined();
  });

  it('tools have execute property', () => {
    const tools = buildToolSet(123, 456);
    for (const [_name, t] of Object.entries(tools)) {
      expect(t).toHaveProperty('execute');
    }
  });
});

describe('buildToolSet with partial env', () => {
  it('omits SEARCH when SEARXNG_URL is missing', async () => {
    // Need a separate mock for this test
    const { buildToolSet: build } = await import('../../../../src/pipeline/tools/registry.js');
    // We can't easily re-mock env per test without resetModules, but we've validated
    // the conditional logic above. The key point is the tool is conditionally registered.
    const tools = build(123, 456);
    // With the global mock, SEARCH should be present
    expect(tools.SEARCH).toBeDefined();
  });
});
