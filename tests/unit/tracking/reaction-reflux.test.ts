import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

const { recordReaction, recordReplySentiment, QUOTE_FOLLOWUP_BONUS } = await import(
  '../../../src/tracking/feedback.js'
);
import { getTopicScores } from '../../../src/tracking/topic-bandit.js';

const CHAT = -100999;
const SRC = -100111;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0045_chat_topics.sql', 'utf8'));
  db.exec(readFileSync('migrations/0070_feedback_and_subtasks.sql', 'utf8'));
  db.exec(readFileSync('migrations/0080_taste_forwards.sql', 'utf8'));
  db.exec(readFileSync('migrations/0081_topic_scores.sql', 'utf8'));
  db.exec(readFileSync('migrations/0082_taste_forward_landing.sql', 'utf8'));
  // chat_topics 需要 last_active fresh（getActiveTopics 按 last_active 排序取 live）——
  // 直接插行保证 deterministic，不走 observeTopic（其 now 参数默认值在 mock 环境下难控）。
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO chat_topics (chat_id, label, state, msg_count, first_seen, last_active)
     VALUES (?, 'vps', 'active', 5, ?, ?)`,
  ).run(CHAT, now, now);
  db.prepare(
    `INSERT INTO chat_topics (chat_id, label, state, msg_count, first_seen, last_active)
     VALUES (?, 'vps', 'active', 5, ?, ?)`,
  ).run(SRC, now, now);
});

describe('reaction→bandit reflux (H4.2)', () => {
  it('recordReaction writes feedback_events + splits reward to live topics', () => {
    recordReaction({ userId: 1, botMessageId: 11, chatId: CHAT, emoji: '👍' });
    const ev = db.prepare(`SELECT sentiment FROM feedback_events`).get() as { sentiment: number };
    expect(ev.sentiment).toBeCloseTo(0.6, 2);
    const rows = getTopicScores(CHAT);
    expect(rows[0]!.label).toBe('vps');
    expect(rows[0]!.reward).toBeCloseTo(0.6, 2); // 单 live topic，全额
  });

  it('negative reaction gives negative reward', () => {
    recordReaction({ userId: 1, botMessageId: 11, chatId: CHAT, emoji: '👎' });
    const rows = getTopicScores(CHAT);
    expect(rows[0]!.reward).toBeCloseTo(-0.6, 2);
  });

  it('neutral emoji records nothing', () => {
    recordReaction({ userId: 1, botMessageId: 11, chatId: CHAT, emoji: '🤔' });
    expect(db.prepare(`SELECT COUNT(*) c FROM feedback_events`).get()).toEqual({ c: 0 });
    expect(getTopicScores(CHAT)).toEqual([]);
  });

  it('quote followup bonus: plain statement still rewards (+1 engagement)', () => {
    expect(QUOTE_FOLLOWUP_BONUS).toBe(1.0);
    recordReplySentiment({ userId: 1, botMessageId: 11, chatId: CHAT, userText: '收到，明天联系' });
    const rows = getTopicScores(CHAT);
    expect(rows[0]!.reward).toBeCloseTo(1.0, 2); // 文本中性 0 + 追问 1
  });

  it('quote followup: positive text stacks (0.7 + 1)', () => {
    recordReplySentiment({ userId: 1, botMessageId: 11, chatId: CHAT, userText: '哈哈太棒了' });
    const rows = getTopicScores(CHAT);
    expect(rows[0]!.reward).toBeCloseTo(1.7, 2);
  });

  it('taste loop: reaction on forwarded landing rewards SOURCE chat topics', async () => {
    const { recordForward } = await import('../../../src/pipeline/rhythm/taste.js');
    // 源群 SRC 的消息 100 被转到 CHAT，落点 200
    recordForward(SRC, 100, 0.7, { toChatId: CHAT, toMessageId: 200 });
    // 目标群有人给落点点赞 → reward 回源群
    recordReaction({ userId: 2, botMessageId: 200, chatId: CHAT, emoji: '❤' });
    const srcRows = getTopicScores(SRC);
    expect(srcRows[0]!.label).toBe('vps');
    expect(srcRows[0]!.reward).toBeCloseTo(0.9, 2);
    // 目标群自己不吃这份 reward
    expect(getTopicScores(CHAT)).toEqual([]);
  });
});
