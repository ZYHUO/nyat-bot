import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type { FormattedMessage } from '../../../src/shared/types.js';

const f = vi.hoisted(() => ({ db: null as unknown as Database.Database,
  points: new Map<string, { id: string; payload: Record<string, unknown> }>(), upsert: vi.fn(), remove: vi.fn(), embed: vi.fn(),
  semanticEnabled: true, created: vi.fn(),
  cfg: { BOT_TOKEN: '12345:synthetic', MEMORY_PROJECTION_OUTBOX_ENABLED: true, MEMORY_EMBED_MODEL: 'test-model',
    MEMORY_COLLECTION: 'test-vectors', MEMORY_MIN_SCORE: 0, MEMORY_HYBRID_ENABLED: true, MEMORY_DEDUP_ENABLED: true,
    MEMORY_SENSITIVE_CHAT_IDS: [] as number[], ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: '2451779635',
    ONEBOT_ALLOWED_GROUP_IDS: '', ONEBOT_ALLOWED_USER_IDS: '', META_ACTIVATED_AT_SEC: 1 },
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => { throw new Error('unexpected Redis access'); } }));
vi.mock('../../../src/env.js', () => ({ env: () => f.cfg }));
vi.mock('../../../src/shared/logger.js', () => {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger); return { logger };
});
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/memory/importance.js', () => ({ recordMemoryCreated: f.created, deleteMeta: vi.fn() }));
vi.mock('@xenova/transformers', () => ({ env: { cacheDir: '/synthetic-model-cache' }, pipeline: async () => f.embed }));
vi.mock('@qdrant/js-client-rest', () => ({ QdrantClient: class {
  getCollections = async () => ({ collections: [{ name: 'test-vectors' }] });
  createPayloadIndex = async () => ({});
  upsert = f.upsert; delete = f.remove;
  search = async (_collection: string, opts: { filter: { must: Array<{ key: string; match: { value: unknown } }> } }) =>
    (f.semanticEnabled ? [...f.points.values()] : []).filter(point => opts.filter.must.every(filter => point.payload[filter.key] === filter.match.value))
      .map(point => ({ ...point, score: 0.99 }));
  retrieve = async (_collection: string, { ids }: { ids: string[] }) => ids.map(id => f.points.get(id)).filter(Boolean);
} }));

import { memorizeMessage, memorizeAcknowledgedDelivery, drainMemoryProjectionOutbox, searchMemory, deleteMemories } from '../../../src/memory/chroma.js';
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
import { fromTelegramChatId } from '../../../src/platform/identity.js';
import { getOrCreateConversationId, getOrCreateMessageId } from '../../../src/platform/identity-store.js';
import { ingestOneBotNotice } from '../../../src/platform/onebot-notices.js';
import { authoritativeMemoryPayload, getMemorySource, persistMemorySource } from '../../../src/memory/source-store.js';

function message(text: string, id: number, edit = 0): FormattedMessage {
  return { role: 'user', uid: 123, username: 'u', fullName: 'User', timestamp: 1000, messageId: id,
    textContent: text, isForwarded: false,
    eventIdentity: createMessageEventIdentity({ ref: { conversation: fromTelegramChatId('12345', -100), id: String(id) },
      occurredAt: 1000_000, editedAt: edit || null, receivedAt: 1000_000 + edit, edit: edit > 0, content: text }),
  } as FormattedMessage;
}
beforeEach(() => {
  vi.clearAllMocks(); f.points.clear(); f.cfg.MEMORY_PROJECTION_OUTBOX_ENABLED = true; f.semanticEnabled = true;
  f.db = new Database(':memory:');
  for (const name of ['0118_platform_identity.sql', '0120_onebot_notices.sql', '0126_memory_projection.sql', '0051_memory_fts.sql']) {
    f.db.exec(readFileSync('migrations/' + name, 'utf8'));
  }
  f.embed.mockResolvedValue({ data: new Float32Array(384).fill(0.1) });
  f.upsert.mockImplementation(async (_collection, options) => {
    for (const point of options.points) f.points.set(point.id, point);
    return { status: 'completed' };
  });
  // Deliberately retain stale vectors to test read-side version/revoke guards.
  f.remove.mockResolvedValue({ status: 'completed' });
});
afterEach(() => f.db.close());

describe('actual memory entry/retrieval and notice lifecycle', () => {
  it('memorize persists first, then real projector/search resolve authoritative body across edits', async () => {
    await memorizeMessage(-100, message('上海的共同经历', 81));
    expect(f.embed).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT text_body FROM memory_sources').get()).toEqual({ text_body: '上海的共同经历' });
    expect(await drainMemoryProjectionOutbox()).toMatchObject({ completed: 1 });
    expect(f.upsert.mock.calls[0]?.[1].wait).toBe(true);
    const original = [...f.points.values()][0]!;
    expect(original.payload['text']).toBeUndefined();
    original.payload['text'] = '恶意投影正文';
    expect((await searchMemory(-100, '上海', 5))[0]?.textContent).toBe('上海的共同经历');
    await memorizeMessage(-100, message('修正为苏州的经历', 81, 2000_000));
    expect(await searchMemory(-100, '上海', 5)).toEqual([]);
    await drainMemoryProjectionOutbox();
    const results = await searchMemory(-100, '苏州', 5);
    expect(results.map(hit => hit.textContent)).toEqual(['修正为苏州的经历']);
    expect(results[0]).toMatchObject({ sourceChatId: -100, sourcePlatform: 'telegram', sourceAccountId: '12345' });
    expect(f.created).toHaveBeenCalledWith('-100_81', -100, 1000);
    f.semanticEnabled = false;
    expect((await searchMemory(-100, '苏州', 5)).map(hit => hit.textContent)).toEqual(['修正为苏州的经历']);
  });

  it('stores an actual ACK through its explicit API but rejects ordinary unproven messages', async () => {
    await expect(memorizeMessage(-100, { ...message('无来源旧正文', 90), eventIdentity: undefined } as FormattedMessage)).rejects.toThrow('event_identity_required');
    await memorizeAcknowledgedDelivery(-100, { messageId: 91, text: '已确认的回答', partIndex: 0 });
    expect(f.db.prepare('SELECT body_json,text_body FROM memory_sources').get()).toMatchObject({ text_body: '已确认的回答' });
    await drainMemoryProjectionOutbox();
    expect((await searchMemory(-100, '回答', 5))[0]).toMatchObject({ role: 'assistant', messageId: 91, textContent: '已确认的回答' });
  });

  it('existing deleteMemories tombstones before unavailable Qdrant and rollback cannot resurrect', async () => {
    await memorizeMessage(-100, message('等待遗忘', 82)); await drainMemoryProjectionOutbox();
    const point = [...f.points.values()][0]!;
    f.remove.mockRejectedValue(new Error('Qdrant offline'));
    await expect(deleteMemories([String(point.payload['mid'])])).resolves.toBe(1);
    expect(await searchMemory(-100, '等待遗忘', 5)).toEqual([]);
    expect(await drainMemoryProjectionOutbox()).toMatchObject({ failed: 1 });
    f.cfg.MEMORY_PROJECTION_OUTBOX_ENABLED = false;
    expect(await searchMemory(-100, '等待遗忘', 5)).toEqual([]);
  });

  it('real OneBot recall transaction revokes queued source and keeps the notice/source atomic', async () => {
    const conversation = { platform: 'qq' as const, idNamespace: 'qq-number' as const,
      accountId: '2451779635', conversationKind: 'group' as const, id: '778899' };
    const ref = { conversation, id: '991122' };
    const chatId = getOrCreateConversationId(conversation), messageId = getOrCreateMessageId(ref);
    const source = persistMemorySource(chatId, { ...message('QQ撤回内容', messageId),
      eventIdentity: createMessageEventIdentity({ ref, occurredAt: Date.now() }) } as FormattedMessage)!;
    await ingestOneBotNotice({ kind: 'group_recall', accountId: conversation.accountId, groupId: conversation.id,
      messageId: ref.id, userId: '123', operatorId: '123', timestampMs: Date.now() });
    expect(getMemorySource(source.source_id)).toMatchObject({ tombstone: 1, text_body: '' });
    await drainMemoryProjectionOutbox();
    expect(f.embed).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
    expect(f.remove).toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) n FROM onebot_message_recalls').get()).toEqual({ n: 1 });
  });

  it('honors a pre-existing QQ recall even if its old notice is never replayed', () => {
    const conversation = { platform: 'qq' as const, idNamespace: 'qq-number' as const,
      accountId: '2451779635', conversationKind: 'group' as const, id: '889900' };
    const ref = { conversation, id: '771122' };
    const chatId = getOrCreateConversationId(conversation), messageId = getOrCreateMessageId(ref);
    f.db.prepare('INSERT INTO onebot_message_recalls VALUES (?,?,?,?)').run(chatId, messageId, conversation.accountId, Date.now());
    const legacy = { chatId, messageId, mid: `${chatId}_${messageId}`, text: '升级前已撤回的正文' };
    expect(authoritativeMemoryPayload(legacy)).toBeNull();
    expect(persistMemorySource(chatId, { ...message('重放撤回消息', messageId), eventIdentity: undefined } as FormattedMessage)).toBeNull();
    expect(f.db.prepare('SELECT text_body,tombstone FROM memory_sources').get()).toEqual({ text_body: '', tombstone: 1 });
  });
});
