import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// world-facts.ts is the missing producer for `world_change`. The projector
// already consumed that event type, but nothing emitted it, so `world_entities`
// stayed empty. These tests pin the producer's contract:
//   - host-observable facts only (Telegram reports them)
//   - idempotent per (chat, value): a repeated observation must not create a
//     new revision, but a genuine change must
//   - entity-shaped names, so the 2026-09-18 pollution cannot return

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = {
  COGNITIVE_EVENTS_ENABLED: true,
  COGNITIVE_OUTBOX_ENABLED: false,
  WORLD_FACTS_ENABLED: true,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

/** Minimal getChat stub so the probe path is exercised without network. */
let chatResponse: Record<string, unknown> | null = null;
vi.mock('../../../src/bot/bot.js', () => ({
  tryGetBot: () => ({
    api: {
      getChat: async () => {
        if (!chatResponse) throw new Error('getChat failed');
        return chatResponse;
      },
    },
  }),
}));

const CHAT = -1003184176508;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  chatResponse = {
    title: 'Uzumaru公群 | 音游交流群版 🔥东南亚上押1920U 不灵不开 灵车狂欢',
    type: 'supergroup',
    username: 'alpine_1337',
    description: '上压凭证',
    linked_chat_id: -1002766103007,
  };
});

const load = async () => {
  vi.resetModules();
  return await import('../../../src/agent/world-facts.js');
};

describe('world facts producer', () => {
  it('records Telegram-reported chat facts as a world_change event', async () => {
    const m = await load();
    const facts = await m.observeChatFacts(CHAT);
    expect(facts?.title).toContain('Uzumaru');
    expect(m.recordChatFactsAsWorldChange(CHAT, facts!)).toBe(1);

    const row = db
      .prepare("SELECT fact_json FROM cognitive_events WHERE type = 'world_change'")
      .get() as { fact_json: string };
    const fact = JSON.parse(row.fact_json) as Record<string, unknown>;
    expect(fact['entityKind']).toBe('place');
    expect(fact['properties']).toMatchObject({ type: 'supergroup', username: '@alpine_1337' });
  });

  it('is idempotent: re-observing the same facts writes nothing new', async () => {
    const m = await load();
    const facts = await m.observeChatFacts(CHAT);
    expect(m.recordChatFactsAsWorldChange(CHAT, facts!)).toBe(1);
    expect(m.recordChatFactsAsWorldChange(CHAT, facts!)).toBe(0);
    const count = db
      .prepare("SELECT count(*) c FROM cognitive_events WHERE type = 'world_change'")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('records a new event when a fact genuinely changes', async () => {
    const m = await load();
    expect(m.recordChatFactsAsWorldChange(CHAT, { title: '旧标题', type: 'group' })).toBe(1);
    expect(m.recordChatFactsAsWorldChange(CHAT, { title: '新标题', type: 'group' })).toBe(1);
    const count = db
      .prepare("SELECT count(*) c FROM cognitive_events WHERE type = 'world_change'")
      .get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('uses the host source so the projector accepts it', async () => {
    const m = await load();
    m.recordChatFactsAsWorldChange(CHAT, { title: '群', type: 'group' });
    const row = db
      .prepare("SELECT source, visibility, chat_id FROM cognitive_events WHERE type = 'world_change'")
      .get() as { source: string; visibility: string; chat_id: number };
    // model-authored facts must be rejected by the projector, so source matters.
    expect(row.source).toBe('host');
    expect(row.visibility).toBe('chat');
    expect(row.chat_id).toBe(CHAT);
  });

  it('skips the write when Telegram reported nothing usable', async () => {
    const m = await load();
    expect(m.recordChatFactsAsWorldChange(CHAT, {})).toBe(0);
  });

  it('returns null and does not throw when getChat fails', async () => {
    const m = await load();
    chatResponse = null;
    m.clearChatFactsCache();
    expect(await m.observeChatFacts(CHAT)).toBeNull();
    expect(m.recordChatFactsAsWorldChange(CHAT, { title: 'x', type: 'group' })).toBe(1);
  });

  it('is a no-op when the feature flag is off', async () => {
    const m = await load();
    chatResponse = { title: '群', type: 'group' };
    expect(await m.observeAndRecordChatFacts(CHAT, false)).toBe(0);
    const count = db
      .prepare("SELECT count(*) c FROM cognitive_events WHERE type = 'world_change'")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('ignores invalid chat ids', async () => {
    const m = await load();
    expect(await m.observeChatFacts(0)).toBeNull();
    expect(m.recordChatFactsAsWorldChange(0, { title: 'x', type: 'group' })).toBe(0);
  });
});

describe('username normalisation', () => {
  it('does not double the @ when Telegram already includes it', async () => {
    // Observed in production 2026-09-18: a chat rendered as "@@NekoCloud1".
    const m = await load();
    chatResponse = { title: '群', type: 'supergroup', username: '@NekoCloud1' };
    m.clearChatFactsCache();
    const facts = await m.observeChatFacts(CHAT);
    expect(facts?.username).toBe('NekoCloud1');
    m.recordChatFactsAsWorldChange(CHAT, facts!);
    const row = db
      .prepare("SELECT fact_json FROM cognitive_events WHERE type = 'world_change'")
      .get() as { fact_json: string };
    const props = (JSON.parse(row.fact_json) as { properties: Record<string, string> }).properties;
    expect(props['username']).toBe('@NekoCloud1');
    expect(props['username']).not.toContain('@@');
  });

  it('adds the @ when Telegram omits it', async () => {
    const m = await load();
    chatResponse = { title: '群', type: 'supergroup', username: 'NekoCloud1' };
    m.clearChatFactsCache();
    const facts = await m.observeChatFacts(CHAT);
    expect(facts?.username).toBe('NekoCloud1');
  });
});
