import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  env: {
    MEMORY_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2', MEMORY_COLLECTION: 'privacy-test',
    MEMORY_MIN_SCORE: 0, MEMORY_CROSS_CONTEXT_ENABLED: true, MEMORY_VISIBILITY_ENABLED: true,
    MEMORY_SENSITIVE_CHAT_IDS: [-999], DM_AUTO_PRIVATE: true,
  },
  hits: [] as Array<{ payload: Record<string, unknown>; score: number }>,
  search: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => state.env }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: class {
    getCollections = async () => ({ collections: [{ name: 'privacy-test' }] });
    createPayloadIndex = async () => ({});
    search = state.search;
  },
}));
vi.mock('@xenova/transformers', () => ({
  env: { cacheDir: '/nonexistent-privacy-test-cache' },
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.1) }),
}));

// Intentionally use the real visibility module: this is the exported retrieval boundary.
import { searchMemoryByUser } from '../../../src/memory/chroma.js';

function hit(text: string, fields: Record<string, unknown>) {
  return { score: 0.9, payload: { text, uid: 42, messageId: 1, timestamp: 100, role: 'user', ...fields } };
}

beforeEach(() => {
  state.env.MEMORY_CROSS_CONTEXT_ENABLED = true;
  state.env.MEMORY_VISIBILITY_ENABLED = true;
  state.hits = [];
  state.search.mockReset().mockImplementation(async () => state.hits);
});

describe('cross-context retrieval privacy boundary', () => {
  it('does not query storage unless both cross-context and visibility are enabled', async () => {
    state.env.MEMORY_VISIBILITY_ENABLED = false;
    expect(await searchMemoryByUser(42, 'remember', -100)).toEqual([]);
    state.env.MEMORY_VISIBILITY_ENABLED = true;
    state.env.MEMORY_CROSS_CONTEXT_ENABLED = false;
    expect(await searchMemoryByUser(42, 'remember', -100)).toEqual([]);
    expect(state.search).not.toHaveBeenCalled();
  });

  it('keeps shared-group hits while rejecting DM, sensitive, private, unproven and same-chat hits', async () => {
    state.hits = [
      hit('shared contextual', { chatId: -200, visibility: 'contextual' }),
      hit('shared public', { sourceChatId: -200, visibility: 'public' }),
      hit('legacy shared source', { chatId: -200 }),
      hit('DM private', { chatId: 42, visibility: 'private' }),
      hit('DM mislabeled public', { sourceChatId: 42, visibility: 'public' }),
      hit('legacy DM', { chatId: 42 }),
      hit('sensitive mislabeled public', { chatId: -999, visibility: 'public' }),
      hit('no provenance', {}),
      hit('unproven contextual', { visibility: 'contextual' }),
      hit('unproven public', { visibility: 'public' }),
      hit('same chat belongs to local retrieval', { chatId: -100, visibility: 'contextual' }),
    ];
    const results = await searchMemoryByUser(42, 'remember', -100, 20, 1000);
    expect(results.map((m) => m.textContent)).toEqual(['shared contextual', 'shared public', 'legacy shared source']);
    expect(state.search).toHaveBeenCalledWith('privacy-test', expect.objectContaining({
      filter: {
        must: [{ key: 'uid', match: { value: 42 } }],
        must_not: [{ key: 'visibility', match: { value: 'private' } }],
      },
    }));
  });

  it('returns no cross-context data for anonymous or invalid users', async () => {
    expect(await searchMemoryByUser(-1, 'remember', -100)).toEqual([]);
    expect(await searchMemoryByUser(0, 'remember', -100)).toEqual([]);
    expect(state.search).not.toHaveBeenCalled();
  });
});
