import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
const state = vi.hoisted(() => ({
  config: { BOT_TOKEN: '123:synthetic', MASTER_UID: 7, ONEBOT_ACCOUNT_ID: '41', ONEBOT_OWNER_ID: '8',
    OWNER_MEMORY_LINK_ENABLED: true as boolean | undefined,
    MEMORY_SENSITIVE_CHAT_IDS: [-999], MEMORY_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2',
    MEMORY_COLLECTION: 'owner-recall-test', MEMORY_MIN_SCORE: 0, MEMORY_VISIBILITY_ENABLED: false },
  hits: [] as Array<{ payload: Record<string, unknown>; score: number }>,
  search: vi.fn(), honorFilter: true, upsert: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => state.config }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('@qdrant/js-client-rest', () => ({ QdrantClient: class {
  getCollections = async () => ({ collections: [{ name: 'owner-recall-test' }] });
  createPayloadIndex = async () => ({});
  search = state.search;
  upsert = state.upsert;
} }));
vi.mock('@xenova/transformers', () => ({ env: { cacheDir: '/nonexistent-owner-recall-cache' },
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.1) }) }));

import { searchOwnerMemory, searchMemoryForInjection } from '../../../src/memory/chroma.js';
import { getOrCreateUserId, getOrCreateConversationId } from '../../../src/platform/identity-store.js';

/** Model the actual filter subset, including applying LIMIT after source/author checks. */
function matches(payload: Record<string, unknown>, filter: unknown): boolean {
  const f = filter as Record<string, unknown>;
  if (typeof f['key'] === 'string') {
    const value = payload[f['key']];
    if (f['match']) return value === (f['match'] as { value: unknown }).value;
    if (f['range']) return typeof value === 'number' && value < (f['range'] as { lt: number }).lt;
  }
  if (f['is_empty']) return payload[(f['is_empty'] as { key: string }).key] == null;
  return (!f['must'] || (f['must'] as unknown[]).every(item => matches(payload, item)))
    && (!f['must_not'] || !(f['must_not'] as unknown[]).some(item => matches(payload, item)))
    && (!f['should'] || (f['should'] as unknown[]).some(item => matches(payload, item)));
}
const qqUser = (id: string, accountId = '41') => getOrCreateUserId({ platform: 'qq', accountId, idNamespace: 'qq-number', id });
const qqGroup = (id: string, accountId = '41') => getOrCreateConversationId({ platform: 'qq', accountId, idNamespace: 'qq-number', id, conversationKind: 'group' });
let owner: number, bot: number, group: number, nextMessageId: number;
function hit(text: string, chatId: number, uid: number, fields: Record<string, unknown> = {}, score = 0.9) {
  return { score, payload: { text, chatId, sourceChatId: chatId, uid, role: 'user', timestamp: 1790000000,
    messageId: nextMessageId++, ...fields } };
}
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0118_platform_identity.sql', 'utf8'));
  Object.assign(state.config, { BOT_TOKEN: '123:synthetic', MASTER_UID: 7, ONEBOT_ACCOUNT_ID: '41', ONEBOT_OWNER_ID: '8',
    OWNER_MEMORY_LINK_ENABLED: true, MEMORY_SENSITIVE_CHAT_IDS: [-999], MEMORY_MIN_SCORE: 0 });
  owner = qqUser('8'); bot = qqUser('41'); group = qqGroup('100'); nextMessageId = 1;
  state.hits = []; state.honorFilter = true; state.upsert.mockReset();
  state.search.mockReset().mockImplementation(async (_collection: string, options: { filter: unknown; limit: number }) =>
    state.honorFilter ? state.hits.filter(item => matches(item.payload, options.filter)).slice(0, options.limit) : state.hits);
});
afterEach(() => db.close());

describe('owner-only linked retrieval with real scope checks', () => {
  it('returns owner words and verified bot replies from both private chats, plus owner group words', async () => {
    state.hits = [
      hit('TG owner DM', 7, 7, { sourcePlatform: 'telegram', sourceAccountId: '123', visibility: 'private' }),
      hit('TG bot DM', 7, 123, { role: 'assistant', sourceAccountId: '123', visibility: 'private' }),
      hit('QQ owner DM', owner, owner, { visibility: 'private' }),
      hit('QQ bot DM', owner, bot, { role: 'assistant', sourcePlatform: 'qq', sourceAccountId: '41', visibility: 'private' }),
      hit('QQ owner group', group, owner, { visibility: 'contextual' }),
      hit('other person DM', qqUser('9'), qqUser('9')),
      hit('other person group', group, qqUser('9')),
      hit('unrelated bot group reply', group, bot, { role: 'assistant' }),
    ];
    const results = await searchOwnerMemory(7, 'our memories', 10);
    expect(new Set(results.map(row => row.textContent))).toEqual(new Set(['TG owner DM', 'TG bot DM', 'QQ owner DM', 'QQ bot DM', 'QQ owner group']));
    for (const row of results) {
      expect(row.ownerRecall.audience).toBe('owner_dm');
      expect(row.sourceChatId).toBe(row.ownerRecall.sourceChatId);
      expect(row.ownerRecall.accountId).not.toBeNull();
    }
    expect(results.find(row => row.textContent === 'QQ owner DM')?.ownerRecall).toMatchObject({ platform: 'qq', accountId: '41', visibility: 'private' });
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it('preserves and labels narrow legacy Telegram owner authorship without relabelling it', async () => {
    state.hits = [hit('old own group words', -100, 7), hit('old own private words', 7, 7),
      hit('unproven old bot', 7, 123, { role: 'assistant' }), hit('explicit different bot', -100, 7, { sourceAccountId: '124' })];
    const original = structuredClone(state.hits);
    const results = await searchOwnerMemory(owner, 'old memories', 10);
    expect(results.map(row => row.textContent)).toEqual(['old own group words', 'old own private words']);
    for (const row of results) {
      expect(row.sourceAccountId).toBeUndefined();
      expect(row.visibility).toBeUndefined();
      expect(row.ownerRecall).toMatchObject({ platform: 'telegram', accountId: null, provenance: 'legacy_owner_authored',
        label: '历史Telegram/账号未知（主人本人发言）' });
    }
    expect(state.hits).toEqual(original);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it('rejects groups and unverified private recipients before querying storage', async () => {
    for (const chatId of [-100, group, 8, qqUser('9'), 2 ** 52 + 99999]) {
      expect(await searchOwnerMemory(chatId, 'private history')).toEqual([]);
      expect(await searchOwnerMemory(chatId, 'private history', 5, 100, 7)).toEqual([]);
    }
    expect(await searchOwnerMemory(7, 'private history', 5, 100, owner)).toEqual([]);
    expect(state.search).not.toHaveBeenCalled();
  });

  it.each([false, undefined])('keeps same-platform owner recall but never cross-links when configured %s', async (enabled) => {
    state.config.OWNER_MEMORY_LINK_ENABLED = enabled;
    state.honorFilter = false; // The post-filter must also enforce the deployment grant.
    state.hits = [hit('TG owner history', -100, 7), hit('QQ owner history', group, owner)];
    expect((await searchOwnerMemory(7, 'history')).map(row => row.textContent)).toEqual(['TG owner history']);
    expect((await searchOwnerMemory(owner, 'history')).map(row => row.textContent)).toEqual(['QQ owner history']);
  });

  it('filters authors and sources before LIMIT so other people cannot starve permitted recall', async () => {
    state.hits = Array.from({ length: 50 }, () => hit('other private high score', 9, 9, {}, 0.99));
    state.hits.push(hit('own actual memory', -100, 7, {}, 0.7));
    expect((await searchOwnerMemory(7, 'memory', 1)).map(row => row.textContent)).toEqual(['own actual memory']);
    expect(state.search).toHaveBeenCalledTimes(2);
    for (const [, params] of state.search.mock.calls) expect(params.limit).toBe(3);
  });

  it('does not trust backend matches for damaged, sensitive or foreign-account payloads', async () => {
    state.honorFilter = false;
    state.hits = [
      hit('permitted control', group, owner),
      hit('sensitive', -999, 7),
      hit('other DM even with owner uid', 9, 7),
      hit('foreign QQ account', qqGroup('100', '42'), owner),
      hit('explicit foreign bot account', -100, 7, { sourceAccountId: '124' }),
      hit('platform contradiction', group, owner, { sourcePlatform: 'telegram' }),
      hit('source contradiction', group, owner, { sourceChatId: -100 }),
      hit('invalid present source', group, owner, { sourceChatId: String(group) }),
      hit('no valid source', group, owner, { chatId: undefined, sourceChatId: undefined }),
      hit('missing role', group, owner, { role: undefined }),
      hit('unknown role', group, owner, { role: 'system' }),
      hit('bot in a group', group, bot, { role: 'assistant' }),
      hit('unknown reserved mapping', -(2 ** 52 + 99999), owner),
      hit('wrong user', group, qqUser('9')),
    ];
    expect((await searchOwnerMemory(owner, 'history', 10)).map(row => row.textContent)).toEqual(['permitted control']);
  });

  it('keeps the ordinary injection boundary closed even for an owner-author record', async () => {
    state.honorFilter = false;
    state.hits = [hit('private cross-platform owner data', owner, owner, { visibility: 'private' })];
    expect((await searchOwnerMemory(7, 'history')).map(row => row.textContent)).toEqual(['private cross-platform owner data']);
    expect(await searchMemoryForInjection(-100, 'history', 5, 1000)).toEqual([]);
  });

  it('requires relevance, deduplicates cross-branch hits and enforces the caller budget', async () => {
    state.honorFilter = false;
    state.hits = [hit('low score', -100, 7, {}, 0.49), hit('best', -100, 7, { messageId: 123 }, 0.9),
      hit('same message lower score', -100, 7, { messageId: 123 }, 0.6), hit('second', group, owner, {}, 0.8)];
    const result = await searchOwnerMemory(7, 'history', 1);
    expect(result.map(row => row.textContent)).toEqual(['best']);
  });

  it('fails softly on backend errors and bounded timeouts without exporting or rewriting data', async () => {
    state.search.mockRejectedValue(new Error('unavailable'));
    expect(await searchOwnerMemory(7, 'private query')).toEqual([]);
    state.search.mockImplementation(() => new Promise(() => {}));
    expect(await searchOwnerMemory(7, 'private query', 5, 50)).toEqual([]);
    expect(state.upsert).not.toHaveBeenCalled();
  });
});
