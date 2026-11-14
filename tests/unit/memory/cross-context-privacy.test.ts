import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

const db = new Database(':memory:');
db.exec(readFileSync('migrations/0118_platform_identity.sql', 'utf8'));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));

const state = vi.hoisted(() => ({
  env: {
    BOT_TOKEN: '123:synthetic',
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
import { searchMemory, searchMemoryByUser, searchMemoryForInjection } from '../../../src/memory/chroma.js';
import { getOrCreateConversationId, getOrCreateUserId } from '../../../src/platform/identity-store.js';

function hit(text: string, fields: Record<string, unknown>) {
  return { score: 0.9, payload: { text, uid: 42, messageId: 1, timestamp: 100, role: 'user', ...fields } };
}

beforeEach(() => {
  state.env.MEMORY_CROSS_CONTEXT_ENABLED = true;
  state.env.MEMORY_VISIBILITY_ENABLED = true;
  state.env.DM_AUTO_PRIVATE = true;
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
      hit('shared public', { sourceChatId: -200, visibility: 'public', sourcePlatform: 'telegram', sourceAccountId: '123' }),
      hit('unproven public account', { sourceChatId: -200, visibility: 'public' }),
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
    expect(results.map((m) => m.textContent)).toEqual(['shared public']);
    expect(state.search).toHaveBeenCalledWith('privacy-test', expect.objectContaining({
      filter: {
        must: [{ key: 'uid', match: { value: 42 } }, { key: 'visibility', match: { value: 'public' } },
          { key: 'sourcePlatform', match: { value: 'telegram' } }, { key: 'sourceAccountId', match: { value: '123' } }],
        must_not: [{ key: 'visibility', match: { value: 'private' } }],
      },
    }));
  });

  it('returns no cross-context data for anonymous or invalid users', async () => {
    expect(await searchMemoryByUser(-1, 'remember', -100)).toEqual([]);
    expect(await searchMemoryByUser(0, 'remember', -100)).toEqual([]);
    expect(state.search).not.toHaveBeenCalled();
  });

  it('validates actual local payload provenance even with both legacy privacy flags off', async () => {
    state.env.MEMORY_VISIBILITY_ENABLED = false;
    state.env.DM_AUTO_PRIVATE = false;
    state.hits = [
      hit('own private', { chatId: 42, sourceChatId: 42, visibility: 'private' }),
      hit('own legacy', { chatId: 42 }),
      hit('foreign returned by backend', { chatId: -200, visibility: 'public' }),
      hit('conflicting fields', { chatId: 42, sourceChatId: -200, visibility: 'public' }),
      hit('invalid source cannot fallback', { chatId: 42, sourceChatId: '42' }),
      hit('different Telegram account', { chatId: 42, sourcePlatform: 'telegram', sourceAccountId: '124' }),
      hit('unknown legacy', {}),
    ];
    expect((await searchMemory(42, 'remember', 20, 1000)).map(row => row.textContent)).toEqual(['own private', 'own legacy']);
    expect((await searchMemoryForInjection(42, 'remember', 20, 1000)).map(row => row.textContent)).toEqual(['own private', 'own legacy']);
  });

  it('does not mistake cross-platform public hits or another QQ account for permitted memories', async () => {
    const group = (accountId: string, id: string) => getOrCreateConversationId({ platform: 'qq' as const, accountId,
      idNamespace: 'qq-number' as const, conversationKind: 'group' as const, id });
    const current = group('41', '100'), localPublic = group('41', '200'), foreign = group('42', '200');
    const uid = getOrCreateUserId({ platform: 'qq', accountId: '41', idNamespace: 'qq-number', id: '7' });
    state.hits = [
      hit('same account public', { uid, chatId: localPublic, visibility: 'public', sourcePlatform: 'qq', sourceAccountId: '41' }),
      hit('another QQ account', { uid, chatId: foreign, visibility: 'public', sourcePlatform: 'qq', sourceAccountId: '42' }),
      hit('Telegram public', { uid, chatId: -200, visibility: 'public', sourcePlatform: 'telegram', sourceAccountId: '123' }),
      hit('wrong user despite DB filter', { uid: 42, chatId: localPublic, visibility: 'public', sourcePlatform: 'qq', sourceAccountId: '41' }),
      hit('unknown mapped ID', { uid, chatId: -(2 ** 52 + 100000), visibility: 'public', sourcePlatform: 'qq', sourceAccountId: '41' }),
    ];
    expect((await searchMemoryByUser(uid, 'remember', current, 20, 1000)).map(row => row.textContent)).toEqual(['same account public']);
    state.search.mockClear();
    expect(await searchMemoryByUser(42, 'remember', current)).toEqual([]);
    expect(await searchMemory(-(2 ** 52 + 100000), 'remember')).toEqual([]);
    expect(state.search).not.toHaveBeenCalled();
  });
});
