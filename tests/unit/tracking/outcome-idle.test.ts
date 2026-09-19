import { describe, expect, it, vi, beforeEach } from 'vitest';

// 时间感知的 ignored：原来只有"再过 5 条消息"，在新消息不密的群里永远达不到，
// 条目 TTL 一到就过期 → outcome 永远 unknown → 系统"从来没去问过"。
// 新判据：过了 OUTCOME_MAX_WAIT_SEC 且期间至少有 1 条人类消息来过又走了。

const store = new Map<string, Map<string, string>>();
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    hset: async (k: string, f: string, v: string) => { if (!store.has(k)) store.set(k, new Map()); store.get(k)!.set(f, v); },
    hgetall: async (k: string) => Object.fromEntries(store.get(k) ?? new Map()),
    hdel: async (k: string, ...fs: string[]) => { const m = store.get(k); for (const f of fs) m?.delete(f); },
    expire: async () => {},
    set: async (k: string, v: string) => { store.set('lock:' + k, new Map([[v, v]])); return 'OK'; },
    del: async (k: string) => { store.delete('lock:' + k); },
  }),
}));

vi.mock('../../../src/db/sqlite.js', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE self_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, trigger_uid INTEGER DEFAULT 0, trigger_msg_id INTEGER, reply_text TEXT, ts INTEGER, bot_message_id INTEGER, outcome TEXT DEFAULT 'unknown', outcome_at INTEGER)`);
  db.exec(`CREATE TABLE reply_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, ts INTEGER, trigger_text TEXT, reply_text TEXT, outcome TEXT, signal TEXT, action TEXT)`);
  return { getDb: () => db };
});
vi.mock('../../../src/env.js', () => ({
  env: () => ({ OUTCOME_TRACKING_ENABLED: true, ASI_ENABLED: false, SELF_HISTORY_ENABLED: true, LEARNER_ENABLED: false, MOOD_ENABLED: false, BOT_USERNAME: 'b', BOT_NICKNAMES: [] }),
}));

const { recordReply, checkOutcome } = await import('../../../src/tracking/outcome.js');
const { recordSelfReply } = await import('../../../src/tracking/self-history.js');
const { getDb } = await import('../../../src/db/sqlite.js');

beforeEach(() => { store.clear(); getDb().exec('DELETE FROM self_replies'); getDb().exec('DELETE FROM reply_outcomes'); });

const neutral = { isBot: false, textContent: '随便聊聊' } as never;

describe('时间感知的 ignored', () => {
  it('10 分钟外 + 1 条人类消息 → 判 ignored（不再等 5 条）', async () => {
    const chat = -200;
    // 造一个 11 分钟前的 pending 条目
    const past = Math.floor(Date.now() / 1000) - 11 * 60;
    recordSelfReply(chat, 0, 1, '我说的话', 900);
    await recordReply(chat, 900, 1, 0, '', '我说的话', 'codeact_speak');
    const key = [...store.keys()].find((k) => k.includes('outcome:pending'))!;
    const entry = JSON.parse(store.get(key)!.get('900')!);
    entry.timestamp = past;                       // 把时间拨到 11 分钟前
    store.get(key)!.set('900', JSON.stringify(entry));

    await checkOutcome(chat, neutral, 'hunhebi_bot');   // 只来 1 条人类消息
    const row = getDb().prepare('select outcome from self_replies where bot_message_id=900').get() as { outcome: string };
    expect(row.outcome).toBe('ignored');
  });

  it('刚过 1 分钟 + 1 条消息 → 不判（还没到等的下限）', async () => {
    const chat = -201;
    recordSelfReply(chat, 0, 1, '我说的话', 901);
    await recordReply(chat, 901, 1, 0, '', '我说的话', 'codeact_speak');
    const key = [...store.keys()].find((k) => k.includes('outcome:pending'))!;
    const entry = JSON.parse(store.get(key)!.get('901')!);
    entry.timestamp = Math.floor(Date.now() / 1000) - 60;   // 1 分钟前
    store.get(key)!.set('901', JSON.stringify(entry));
    await checkOutcome(chat, neutral, 'hunhebi_bot');
    const row = getDb().prepare('select outcome from self_replies where bot_message_id=901').get() as { outcome: string };
    expect(row.outcome).toBe('unknown');   // 继续等
  });

  it('5 条消息仍然照原样闭合（老判据不受影响）', async () => {
    const chat = -202;
    recordSelfReply(chat, 0, 1, '我说的话', 902);
    await recordReply(chat, 902, 1, 0, '', '我说的话', 'codeact_speak');
    for (let i = 0; i < 5; i++) await checkOutcome(chat, neutral, 'hunhebi_bot');
    const row = getDb().prepare('select outcome from self_replies where bot_message_id=902').get() as { outcome: string };
    expect(row.outcome).toBe('ignored');
  });
});
