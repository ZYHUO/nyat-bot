import { describe, it, expect, beforeEach, vi } from 'vitest';

interface SelfReplyRow {
  id: number;
  chat_id: number;
  trigger_uid: number;
  trigger_msg_id: number | null;
  reply_text: string;
  ts: number;
}
let nextId = 1;
const store: SelfReplyRow[] = [];

const mockDb = {
  prepare: (sql: string) => {
    if (sql.startsWith('INSERT INTO self_replies')) {
      return {
        run: (
          chatId: number,
          uid: number,
          msgId: number | null,
          text: string,
          ts: number,
        ) => {
          store.push({
            id: nextId++,
            chat_id: chatId,
            trigger_uid: uid,
            trigger_msg_id: msgId,
            reply_text: text,
            ts,
          });
          return { changes: 1 };
        },
      };
    }
    if (sql.startsWith('SELECT reply_text AS text, ts')) {
      return {
        all: (chatId: number, uid: number, cutoff: number, limit: number) => {
          return store
            .filter((r) => r.chat_id === chatId && r.trigger_uid === uid && r.ts >= cutoff)
            .sort((a, b) => b.ts - a.ts || b.id - a.id)
            .slice(0, limit)
            .map((r) => ({ text: r.reply_text, ts: r.ts }));
        },
      };
    }
    if (sql.startsWith('DELETE FROM self_replies WHERE ts <')) {
      return {
        run: (cutoff: number) => {
          const before = store.length;
          for (let i = store.length - 1; i >= 0; i--) {
            if (store[i]!.ts < cutoff) store.splice(i, 1);
          }
          return { changes: before - store.length };
        },
      };
    }
    throw new Error('unexpected sql: ' + sql);
  },
};

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => mockDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = {
  SELF_HISTORY_ENABLED: true,
  SELF_HISTORY_INJECT_LIMIT: 5,
  SELF_HISTORY_WINDOW_DAYS: 30,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

describe('self-history', () => {
  let mod: typeof import('../../../src/tracking/self-history.js');

  beforeEach(async () => {
    store.length = 0;
    nextId = 1;
    vi.resetModules();
    envValues['SELF_HISTORY_ENABLED'] = true;
    envValues['SELF_HISTORY_INJECT_LIMIT'] = 5;
    envValues['SELF_HISTORY_WINDOW_DAYS'] = 30;
    mod = await import('../../../src/tracking/self-history.js');
  });

  it('feature off: recordSelfReply is no-op', () => {
    envValues['SELF_HISTORY_ENABLED'] = false;
    mod.recordSelfReply(-100, 1001, 5, 'hi');
    expect(store.length).toBe(0);
  });

  it('feature off: getRecentSelfReplies returns []', () => {
    envValues['SELF_HISTORY_ENABLED'] = false;
    expect(mod.getRecentSelfReplies(-100, 1001)).toEqual([]);
  });

  it('records and retrieves recent replies', () => {
    mod.recordSelfReply(-100, 1001, 5, 'hello');
    mod.recordSelfReply(-100, 1001, 6, 'world');
    const recent = mod.getRecentSelfReplies(-100, 1001);
    expect(recent.length).toBe(2);
    expect(recent[0]?.text).toBe('world'); // most recent first
    expect(recent[1]?.text).toBe('hello');
  });

  it('filters by chat_id', () => {
    mod.recordSelfReply(-100, 1001, 1, 'a');
    mod.recordSelfReply(-200, 1001, 2, 'b');
    expect(mod.getRecentSelfReplies(-100, 1001)).toHaveLength(1);
    expect(mod.getRecentSelfReplies(-200, 1001)).toHaveLength(1);
  });

  it('filters by uid', () => {
    mod.recordSelfReply(-100, 1001, 1, 'a');
    mod.recordSelfReply(-100, 1002, 2, 'b');
    expect(mod.getRecentSelfReplies(-100, 1001)).toHaveLength(1);
    expect(mod.getRecentSelfReplies(-100, 1002)).toHaveLength(1);
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) mod.recordSelfReply(-100, 1001, i, `r${i}`);
    expect(mod.getRecentSelfReplies(-100, 1001, 3).length).toBe(3);
  });

  it('respects time window', () => {
    const now = Math.floor(Date.now() / 1000);
    // Manually inject an old row
    store.push({
      id: nextId++,
      chat_id: -100,
      trigger_uid: 1001,
      trigger_msg_id: null,
      reply_text: 'old',
      ts: now - 40 * 86400, // 40 days ago
    });
    mod.recordSelfReply(-100, 1001, 5, 'fresh');
    const recent = mod.getRecentSelfReplies(-100, 1001, 10, 30);
    expect(recent.length).toBe(1);
    expect(recent[0]?.text).toBe('fresh');
  });

  it('skips empty / whitespace replies', () => {
    mod.recordSelfReply(-100, 1001, 1, '   ');
    mod.recordSelfReply(-100, 1001, 2, '');
    expect(store.length).toBe(0);
  });

  it('truncates very long reply text to 500 chars', () => {
    const longText = 'x'.repeat(1000);
    mod.recordSelfReply(-100, 1001, 1, longText);
    expect(store[0]!.reply_text.length).toBe(500);
  });

  it('selfHistoryPromptSection formats correctly', () => {
    const replies = [
      { ts: 1700000000, text: 'short' },
      { ts: 1700001000, text: 'x'.repeat(100) },
    ];
    const section = mod.selfHistoryPromptSection(replies);
    expect(section).toContain('你最近对 ta 说过的话');
    expect(section).toContain('short');
    expect(section).toContain('…'); // truncation marker
  });

  it('selfHistoryPromptSection empty for empty input', () => {
    expect(mod.selfHistoryPromptSection([])).toBe('');
  });

  it('pruneOldSelfReplies removes only expired rows', () => {
    const now = Math.floor(Date.now() / 1000);
    store.push({ id: 100, chat_id: -100, trigger_uid: 1001, trigger_msg_id: null, reply_text: 'old', ts: now - 90 * 86400 });
    store.push({ id: 101, chat_id: -100, trigger_uid: 1001, trigger_msg_id: null, reply_text: 'fresh', ts: now });
    const deleted = mod.pruneOldSelfReplies(60);
    expect(deleted).toBe(1);
    expect(store.length).toBe(1);
    expect(store[0]?.reply_text).toBe('fresh');
  });

  it('pruneOldSelfReplies returns 0 when feature off', () => {
    envValues['SELF_HISTORY_ENABLED'] = false;
    store.push({ id: 100, chat_id: -100, trigger_uid: 1001, trigger_msg_id: null, reply_text: 'old', ts: 0 });
    expect(mod.pruneOldSelfReplies(60)).toBe(0);
    expect(store.length).toBe(1); // not deleted
  });
});
