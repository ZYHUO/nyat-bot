import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ db: vi.fn(), values: new Map<string, string>(), model: vi.fn(),
  config: { BOT_TOKEN: '123:synthetic-test-token', MEMORY_SENSITIVE_CHAT_IDS: [] as number[], HOBBY_DISTILL_USAGE: 'judge' },
  writes: vi.fn(),
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: fixture.db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({
  get: async (key: string) => fixture.values.get(key) ?? null,
  set: async (key: string, value: string, ...extra: unknown[]) => {
    fixture.writes(key, value, ...extra); fixture.values.set(key, value); return 'OK';
  },
}) }));
vi.mock('../../../src/env.js', () => ({ env: () => fixture.config }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: fixture.model }));
vi.mock('../../../src/shared/config.js', () => ({ loadCachedPrompt: () => 'Synthetic hobby extraction.' }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
import { distillHobbies, getHobbies, getHobbyFlavor } from '../../../src/tracking/hobbies.js';

let db: Database.Database;
const key = (chatId: number) => `xxb:hobbies:scoped:telegram:123:${chatId}`;
function topics(chatId: number, prefix: string) {
  const insert = db.prepare('INSERT INTO chat_topics(chat_id,label) VALUES (?,?)');
  for (let i = 0; i < 3; i++) insert.run(chatId, `${prefix}_${i}`);
}
beforeEach(() => {
  db = new Database(':memory:'); db.exec(readFileSync('migrations/0045_chat_topics.sql', 'utf8'));
  fixture.db.mockReturnValue(db); fixture.values.clear(); fixture.writes.mockClear();
  fixture.config.BOT_TOKEN = '123:synthetic-test-token'; fixture.config.MEMORY_SENSITIVE_CHAT_IDS = [];
  fixture.model.mockReset().mockImplementation(async (input: { messages: Array<{ content: string }> }) => ({
    content: JSON.stringify({ hobbies: [{ topic: '兴趣', flavor: input.messages[1]!.content }] }),
  }));
});
afterEach(() => db.close());

describe('derived hobbies preserve source disclosure scope', () => {
  it('never mixes a private marker or unproven global interests into another chat', async () => {
    topics(42, 'PRIVATE_CANARY'); topics(-100, 'PUBLIC_CHAT');
    db.exec("CREATE TABLE person_identity(interests TEXT); INSERT INTO person_identity VALUES ('[\"GLOBAL_PRIVATE_CANARY\"]')");
    await distillHobbies(42); await distillHobbies(-100);
    expect(await getHobbyFlavor(42)).toContain('PRIVATE_CANARY');
    expect(await getHobbyFlavor(-100)).toContain('PUBLIC_CHAT');
    expect(await getHobbyFlavor(-100)).not.toContain('PRIVATE_CANARY');
    expect(JSON.stringify(fixture.model.mock.calls)).not.toContain('GLOBAL_PRIVATE_CANARY');
    expect(fixture.model.mock.calls[1]![0].messages[1].content).not.toContain('PRIVATE_CANARY');
    expect(JSON.parse(fixture.values.get(key(42))!)).toMatchObject({ sourceChatId: 42, visibility: 'private', kind: 'inferred_interest' });
  });

  it('ignores legacy global projections and refuses forged source/account metadata', async () => {
    fixture.values.set('xxb:hobbies:current', JSON.stringify([{ topic: 'old', flavor: 'LEGACY_PRIVATE_CANARY' }]));
    expect(await getHobbies(-100)).toEqual([]);
    topics(42, 'PRIVATE_CANARY'); await distillHobbies(42);
    fixture.values.set(key(-100), fixture.values.get(key(42))!);
    expect(await getHobbies(-100)).toEqual([]);
    const record = JSON.parse(fixture.values.get(key(42))!);
    fixture.values.set(key(42), JSON.stringify({ ...record, sourceAccountId: '999' }));
    expect(await getHobbies(42)).toEqual([]);
  });

  it('preserves scoped interests across refresh failures instead of expiring them', async () => {
    topics(-100, 'KNOWN'); await distillHobbies(-100);
    const record = JSON.parse(fixture.values.get(key(-100))!);
    expect(fixture.writes.mock.calls.find(call => call[0] === key(-100))).toHaveLength(2);
    fixture.values.set(key(-100), JSON.stringify({ ...record, derivedAt: Date.now() - 4 * 86400_000 }));
    fixture.model.mockRejectedValueOnce(new Error('synthetic provider offline'));
    expect(await distillHobbies(-100)).toBeNull();
    expect(await getHobbyFlavor(-100)).toContain('KNOWN');
  });

  it('does not invent account provenance for old labels after a bot account change', async () => {
    topics(-100, 'HISTORICAL_LABEL');
    fixture.config.BOT_TOKEN = '999:another-synthetic-account';
    await distillHobbies(-100);
    const record = JSON.parse(fixture.values.get('xxb:hobbies:scoped:telegram:999:-100')!);
    expect(record).toMatchObject({ sourceAccountId: null, consumerAccountId: '999', inputKind: 'legacy_chat_topic_labels' });
    expect(fixture.model.mock.calls[0]![0].messages[1].content).toContain('采集账号未知');
    fixture.config.BOT_TOKEN = '123:synthetic-test-token';
    fixture.values.set(key(-100), JSON.stringify(record));
    expect(await getHobbies(-100)).toEqual([]);
    await distillHobbies(-100);
    expect(JSON.parse(fixture.values.get(key(-100))!).consumerAccountId).toBe('123');
    expect(await getHobbyFlavor(-100)).toContain('HISTORICAL_LABEL');
  });

  it('sweeps bounded scopes with a cursor without repeatedly starving later chats', async () => {
    for (let id = 1; id <= 10; id++) topics(id, `CHAT_${id}`);
    await distillHobbies(); expect(fixture.model).toHaveBeenCalledTimes(8);
    await distillHobbies(); expect(fixture.model).toHaveBeenCalledTimes(10);
    await distillHobbies(); await distillHobbies();
    expect(fixture.model).toHaveBeenCalledTimes(10);
    expect(await getHobbyFlavor(10)).toContain('CHAT_10');
    expect(fixture.values.has('xxb:hobbies:current')).toBe(false);
  });
});
