import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let db: Database.Database;
const hashes = new Map<string, Map<string, string>>();
const locks = new Map<string, string>();
let failCleanup = false;
const config = { BOT_TOKEN: '12345:test-only', MOOD_ENABLED: true, MOOD_DECAY_RATE_PER_HOUR: 0.1,
  RELATIONSHIP_ENABLED: true, RELATIONSHIP_QUANT_ENABLED: true, RELATIONSHIP_ASYMMETRY_ENABLED: false,
  SELF_HISTORY_ENABLED: true, COGNITIVE_CLOCK_ENABLED: false, ASI_SAMPLE_RATE: 0 };
const effects = vi.hoisted(() => ({ route: vi.fn(() => true), score: vi.fn(async () => {}), echo: vi.fn(async () => {}) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/agent/cognitive-route-observations.js', () => ({ recordCognitiveRouteFeedback: effects.route }));
vi.mock('../../../src/tracking/asi-scoring.js', () => ({ ASI_ENABLED: true, ASI_SAMPLE_RATE: 0, persistReplyOutcomeScores: effects.score }));
vi.mock('../../../src/agent/echo.js', () => ({ settleEcho: effects.echo }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({
  hset: async (key: string, field: string, value: string) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    hashes.get(key)!.set(field, value);
  },
  expire: async () => 1,
  hgetall: async (key: string) => Object.fromEntries(hashes.get(key) ?? []),
  set: async (key: string, value: string) => { if (locks.has(key)) return null; locks.set(key, value); return 'OK'; },
  eval: async (script: string, _keys: number, key: string, ...args: string[]) => {
    if (!script.includes('HGET')) {
      if (locks.get(key) !== args[0]) return 0;
      locks.delete(key); return 1;
    }
    if (failCleanup) throw new Error('synthetic Redis cleanup outage');
    if (hashes.get(key)?.get(args[0]!) !== args[1]) return 0;
    if (args[2] === '') hashes.get(key)!.delete(args[0]!);
    else hashes.get(key)!.set(args[0]!, args[2]!);
    return 1;
  },
}) }));

const { recordReply, checkOutcome } = await import('../../../src/tracking/outcome.js');
const { drainReplyFeedbackEffects } = await import('../../../src/tracking/reply-feedback.js');
const { recordSelfReply } = await import('../../../src/tracking/self-history.js');
const { getChatMood } = await import('../../../src/tracking/mood.js');
const { getRelationship } = await import('../../../src/tracking/relationship.js');
const chat = -123;
const source = (id = 901, uid = 22, textContent = '谢谢，有用', target: number | null = 800) => ({
  messageId: id, uid, textContent, ...(target === null ? {} : { replyTo: { messageId: target } }),
});
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
async function seed(mid = 800, asker = 11): Promise<void> {
  db.prepare(`INSERT OR IGNORE INTO cognitive_route_observations
    (id, chat_id, trigger_message_id, route, score, created_at) VALUES (7, ?, 700, 'fast', 1, 1)`).run(chat);
  recordSelfReply(chat, asker, 700, '合成回答', mid);
  await recordReply(chat, mid, 700, asker, '合成问题', '合成回答', 'reply', 7);
}
async function flush(): Promise<void> {
  await drainReplyFeedbackEffects(chat);
  await vi.waitFor(() => expect((db.prepare("SELECT COUNT(*) AS n FROM reply_feedback_effects WHERE state='claimed'").get() as { n: number }).n).toBe(0));
}
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const name of ['0002_phase3', '0017_chat_mood', '0018_self_history_relationship', '0069_relationship_quant',
    '0106_cognitive_route_observations', '0112_self_reply_outcomes', '0116_self_reply_task_id', '0121_reply_feedback_events']) {
    db.exec(readFileSync(resolve('migrations', `${name}.sql`), 'utf8'));
  }
  hashes.clear(); locks.clear(); failCleanup = false;
  config.BOT_TOKEN = '12345:test-only'; config.ASI_SAMPLE_RATE = 0;
  vi.clearAllMocks(); effects.score.mockResolvedValue(undefined);
});
afterEach(async () => { await flush(); db.close(); });

describe('durable feedback attribution through recordReply → checkOutcome', () => {
  it('does not attribute a reply to another human to the pending bot reply', async () => {
    await seed();
    await checkOutcome(chat, source(901, 22, '@nyatbot 你说错了', 799), 'nyatbot');
    expect(count('reply_outcomes')).toBe(0);
    expect(getChatMood(chat).valence).toBe(0);
    expect(getRelationship(chat, 11).count).toBe(0);
    expect(getRelationship(chat, 22).count).toBe(0);
  });
  it('keeps bare positive and negative language unattributed', async () => {
    await seed();
    await checkOutcome(chat, source(901, 22, '谢谢', null), 'nyatbot');
    await checkOutcome(chat, source(902, 22, '不对', null), 'nyatbot');
    expect(count('reply_outcomes')).toBe(0);
    expect(getChatMood(chat).valence).toBe(0);
  });
  it('records the real actor separately from the original asker and exact target', async () => {
    await seed();
    await checkOutcome(chat, source(), 'nyatbot'); await flush();
    expect(db.prepare('SELECT actor_uid, trigger_uid, source_message_id, bot_message_id, attribution, confidence FROM reply_feedback_events').get())
      .toEqual({ actor_uid: 22, trigger_uid: 11, source_message_id: 901, bot_message_id: 800, attribution: 'reply_to_bot_message', confidence: 1 });
    expect(getRelationship(chat, 22).count).toBe(1);
    expect(getRelationship(chat, 11).count).toBe(0);
    expect(getChatMood(chat).valence).toBeCloseTo(5, 4);
    expect(db.prepare('SELECT outcome FROM self_replies').get()).toEqual({ outcome: 'reacted' });
    expect(effects.route).toHaveBeenCalledTimes(1);
  });
  it('treats a correction as answer-quality evidence, not hostility by either human', async () => {
    await seed();
    await checkOutcome(chat, source(901, 22, '不对，我是说另一件事'), 'nyatbot');
    expect(db.prepare('SELECT actor_uid, signal FROM reply_feedback_events').get()).toEqual({ actor_uid: 22, signal: 'repair_loop' });
    expect(getRelationship(chat, 11).count).toBe(0);
    expect(getRelationship(chat, 22).count).toBe(0);
    expect(getChatMood(chat).valence).toBeCloseTo(-8, 4);
  });
  it('accepts a unique explicitly mentioned candidate but not ambiguous candidates or username substrings', async () => {
    await seed(); await seed(801);
    await checkOutcome(chat, source(901, 22, '@nyatbot 谢谢', null), 'nyatbot');
    expect(count('reply_outcomes')).toBe(0);
    hashes.get(`xxb:reply_outcome:pending:${chat}`)!.delete('801');
    await checkOutcome(chat, source(902, 22, '@nyatbot_other 谢谢', null), 'nyatbot');
    expect(count('reply_outcomes')).toBe(0);
    await checkOutcome(chat, source(903, 22, '@nyatbot 谢谢', null), 'nyatbot');
    expect(db.prepare('SELECT attribution, confidence FROM reply_feedback_events').get())
      .toEqual({ attribution: 'explicit_mention_single_candidate', confidence: 0.7 });
  });
  it('replays after Redis cleanup failure without repeating mood, affinity, counter or optional effects', async () => {
    await seed(); failCleanup = true;
    await checkOutcome(chat, source(), 'nyatbot'); await flush();
    expect(hashes.get(`xxb:reply_outcome:pending:${chat}`)!.has('800')).toBe(true);
    failCleanup = false;
    await checkOutcome(chat, source(), 'nyatbot');
    await checkOutcome(chat, source(902), 'nyatbot'); await flush();
    expect(count('reply_feedback_events')).toBe(1); expect(count('reply_outcomes')).toBe(1);
    expect(getRelationship(chat, 22).count).toBe(1);
    expect(getChatMood(chat).valence).toBeCloseTo(5, 4);
    expect(db.prepare('SELECT total_outcomes FROM outcome_meta').get()).toEqual({ total_outcomes: 1 });
    expect(effects.route).toHaveBeenCalledTimes(1); expect(effects.echo).toHaveBeenCalledTimes(1);
    expect(hashes.get(`xxb:reply_outcome:pending:${chat}`)!.size).toBe(0);
  });
  it('settles concurrent replies to two different bot messages without a lock dropping one', async () => {
    await seed(); await seed(801);
    await Promise.all([
      checkOutcome(chat, source(901, 22, '谢谢', 800), 'nyatbot'),
      checkOutcome(chat, source(902, 23, '谢谢', 801), 'nyatbot'),
    ]);
    expect(count('reply_feedback_events')).toBe(2);
    expect(getRelationship(chat, 22).count).toBe(1); expect(getRelationship(chat, 23).count).toBe(1);
    expect(getRelationship(chat, 11).count).toBe(0);
  });
  it('rolls back outcome, observations and mood if relationship persistence fails, then retries once', async () => {
    await seed();
    db.exec("CREATE TRIGGER fail_relation BEFORE INSERT ON chat_relationships BEGIN SELECT RAISE(ABORT, 'synthetic'); END;");
    await checkOutcome(chat, source(), 'nyatbot');
    expect(count('reply_feedback_events')).toBe(0); expect(count('reply_outcomes')).toBe(0);
    expect(count('reply_feedback_observations')).toBe(0); expect(count('chat_mood')).toBe(0);
    expect(count('reply_feedback_effects')).toBe(0);
    db.exec('DROP TRIGGER fail_relation');
    await checkOutcome(chat, source(), 'nyatbot');
    expect(count('reply_feedback_events')).toBe(1); expect(getRelationship(chat, 22).count).toBe(1);
  });
  it('also rolls back if the quantized relationship sidecar fails', async () => {
    await seed();
    db.exec("CREATE TRIGGER fail_quant BEFORE UPDATE OF quant_quality_pending ON chat_relationships BEGIN SELECT RAISE(ABORT, 'synthetic'); END;");
    await checkOutcome(chat, source(), 'nyatbot');
    expect(count('reply_outcomes')).toBe(0); expect(count('chat_mood')).toBe(0); expect(count('chat_relationships')).toBe(0);
    db.exec('DROP TRIGGER fail_quant');
  });
  it('deduplicates repeated observations and does not assign silence to a human or affect relationships', async () => {
    await seed();
    const unrelated = source(901, 22, '旁边的话题', 799);
    for (let i = 0; i < 5; i++) await checkOutcome(chat, unrelated, 'nyatbot');
    expect(count('reply_outcomes')).toBe(0);
    for (let id = 902; id <= 905; id++) await checkOutcome(chat, source(id, 22, '旁边的话题', 799), 'nyatbot');
    expect(db.prepare('SELECT attribution, actor_uid, confidence FROM reply_feedback_events').get())
      .toEqual({ attribution: 'no_followup_observed', actor_uid: 0, confidence: 0 });
    expect(getChatMood(chat).valence).toBe(0); expect(count('chat_relationships')).toBe(0);
    expect(effects.route).not.toHaveBeenCalled();
  });
  it('does not apply human emotional or relationship effects for bot feedback', async () => {
    await seed(); await checkOutcome(chat, { ...source(), isBot: true }, 'nyatbot');
    expect(count('reply_outcomes')).toBe(1); expect(count('chat_mood')).toBe(0); expect(count('chat_relationships')).toBe(0);
  });
  it('does not reuse pending feedback after account switch or without verified provenance', async () => {
    await seed(); config.BOT_TOKEN = '67890:test-only';
    await checkOutcome(chat, source(), 'nyatbot'); expect(count('reply_outcomes')).toBe(0);
    config.BOT_TOKEN = '12345:test-only';
    const map = hashes.get(`xxb:reply_outcome:pending:${chat}`)!;
    const raw = JSON.parse(map.get('800')!); delete raw.scope_key; map.set('800', JSON.stringify(raw));
    await checkOutcome(chat, source(), 'nyatbot'); expect(count('reply_outcomes')).toBe(0);
  });
  it('requires an inbound message identity and a positive confirmed bot message id', async () => {
    await recordReply(chat, -1, 700, 11, 'question', 'suppressed', 'reply');
    expect(hashes.size).toBe(0);
    await seed(); await checkOutcome(chat, { uid: 22, textContent: '谢谢', replyTo: { messageId: 800 } }, 'nyatbot');
    expect(count('reply_outcomes')).toBe(0);
  });
  it('does not apply a routing observation from a different chat', async () => {
    await seed(); db.prepare('UPDATE cognitive_route_observations SET chat_id = ? WHERE id = 7').run(-999);
    await checkOutcome(chat, source(), 'nyatbot'); await flush();
    expect(effects.route).not.toHaveBeenCalled();
    expect(db.prepare("SELECT state FROM reply_feedback_effects WHERE kind = 'route'").get()).toEqual({ state: 'failed' });
    expect(count('reply_feedback_events')).toBe(1);
  });
  it('keeps settlement receipts after narrative retention so stale pending cannot repeat effects', async () => {
    await seed(); failCleanup = true;
    await checkOutcome(chat, source(), 'nyatbot'); await flush();
    db.prepare('DELETE FROM reply_outcomes').run();
    expect(db.prepare('SELECT outcome_id FROM reply_feedback_events').get()).toEqual({ outcome_id: null });
    failCleanup = false; await checkOutcome(chat, source(), 'nyatbot');
    expect(count('reply_outcomes')).toBe(0); expect(getRelationship(chat, 22).count).toBe(1);
  });
  it('retains an optional effect failure without retrying an ambiguous consumer', async () => {
    config.ASI_SAMPLE_RATE = 1; effects.score.mockRejectedValue(new Error('synthetic scorer failure'));
    await seed(); await checkOutcome(chat, source(), 'nyatbot'); await flush();
    expect(db.prepare("SELECT state, last_error FROM reply_feedback_effects WHERE kind='asi'").get())
      .toEqual({ state: 'failed', last_error: 'consumer_unconfirmed' });
    await drainReplyFeedbackEffects(chat); expect(effects.score).toHaveBeenCalledTimes(1);
    expect(count('reply_feedback_events')).toBe(1); expect(getRelationship(chat, 22).count).toBe(1);
  });
});
