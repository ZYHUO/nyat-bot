import { describe, expect, it } from 'vitest';

// Before this change, proactive speech never entered the outcome ledger at all.
// Verified: 2828 self_replies rows, 34 with outcome<>'unknown', and all 34 were
// reactive (trigger_uid<>0). The 7 proactive rows (trigger_uid=0) were all unknown.
// And msgs_after counted EVERY inbound message, including other bots' chatter, so
// in a dual-bot room a proactive send could never resolve to 'ignored'.
//
// Both are pure host-side bookkeeping - zero tokens.

const redisStore = new Map<string, Map<string, string>>();
const ttl = new Map<string, number>();
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    hset: async (k: string, f: string, v: string) => {
      if (!redisStore.has(k)) redisStore.set(k, new Map());
      redisStore.get(k)!.set(f, v);
    },
    hgetall: async (k: string) => Object.fromEntries(redisStore.get(k) ?? new Map()),
    hdel: async (k: string, ...fs: string[]) => { const m = redisStore.get(k); for (const f of fs) m?.delete(f); },
    expire: async (k: string, s: number) => { ttl.set(k, s); },
    set: async (k: string, v: string) => { redisStore.set('lock:' + k, new Map([[v, v]])); return 'OK'; },
    del: async (k: string) => { redisStore.delete('lock:' + k); },
  }),
}));

// 真实的 memory 库 + 真实建表（测试与生产隔离由 VITEST 下的 getDb() 强制 :memory: 保证）
vi.mock('../../../src/db/sqlite.js', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE reply_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, ts INTEGER,
    trigger_text TEXT, reply_text TEXT, outcome TEXT, signal TEXT, action TEXT)`);
  return { getDb: () => db };
});

vi.mock('../../../src/env.js', () => ({
  env: () => ({ OUTCOME_TRACKING_ENABLED: true, OUTCOME_CHECK_WINDOW: 3, SELF_HISTORY_ENABLED: true, MOOD_ENABLED: false, LEARNER_ENABLED: false }),
}));

const { recordReply, checkOutcome } = await import('../../../src/tracking/outcome.js');

describe('proactive speech enters the outcome ledger', () => {
  it('records a proactive send with the no-trigger sentinels and a resolvable pending entry', async () => {
    // 0/0 = "no triggering message / no triggering user" — the repo's existing notation
    await recordReply(-100, 555, 0, 0, '', '群里沉默好久，随口提一句', 'group_speak');
    const key = [...redisStore.keys()].find((k) => k.includes('outcome:pending'))!;
    const entry = JSON.parse(redisStore.get(key)!.get('555')!);
    expect(entry).toMatchObject({
      bot_message_id: 555,
      trigger_message_id: 0,
      trigger_user_id: 0,
      action: 'group_speak',
      msgs_after: 0,
    });
  });

  it('counts only HUMAN messages toward being ignored', async () => {
    await recordReply(-100, 777, 0, 0, '', '主动开口的一句话', 'group_speak');
    const key = [...redisStore.keys()].find((k) => k.includes('outcome:pending'))!;
    const read = () => JSON.parse(redisStore.get(key)!.get('777')!);

    // 5 bot messages: nobody is listening, so the counter must not move
    for (let i = 0; i < 5; i++) await checkOutcome(-100, { isBot: true, textContent: '广告' }, 'nyatbot');
    expect(read().msgs_after).toBe(0);

    // 2 human messages: real audience present, counter advances
    for (let i = 0; i < 2; i++) await checkOutcome(-100, { isBot: false, textContent: '别的' }, 'nyatbot');
    expect(read().msgs_after).toBe(2);
  });
});
