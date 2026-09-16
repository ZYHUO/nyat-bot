import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const db = new Database(':memory:');
db.exec(readFileSync(resolve(process.cwd(), 'migrations/0081_topic_scores.sql'), 'utf-8'));

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { recordPull, recordReward, pickTopic, getTopicScores } from '../../../src/tracking/topic-bandit.js';

const CHAT = -100999;

beforeEach(() => { db.prepare('DELETE FROM topic_scores').run(); });

describe('topic-bandit (H4)', () => {
  it('epsilon-greedy: pulls unseen topic first (exploration)', () => {
    recordPull(CHAT, 'vps');
    recordReward(CHAT, 'vps', 0.8);
    recordPull(CHAT, 'vps');
    recordReward(CHAT, 'vps', 0.8);
    // '美食' 从没试过 → 探索优先
    expect(pickTopic(CHAT, ['vps', '美食'], 0)).toBe('美食');
  });

  it('epsilon-greedy: exploits best mean when all seen (eps=0)', () => {
    recordPull(CHAT, 'vps');
    recordReward(CHAT, 'vps', 0.9);
    recordPull(CHAT, '美食');
    recordReward(CHAT, '美食', 0.1);
    expect(pickTopic(CHAT, ['vps', '美食'], 0)).toBe('vps');
  });

  it('negative reward topics avoided (eps=0)', () => {
    recordPull(CHAT, '政治');
    recordReward(CHAT, '政治', -0.8);
    recordPull(CHAT, 'vps');
    recordReward(CHAT, 'vps', 0.5);
    expect(pickTopic(CHAT, ['政治', 'vps'], 0)).toBe('vps');
  });

  it('empty candidates → null; DM → null', () => {
    expect(pickTopic(CHAT, [], 0)).toBeNull();
    expect(pickTopic(12345, ['vps'], 0)).toBeNull();
  });

  it('scores accumulate pulls+reward', () => {
    recordPull(CHAT, 'vps');
    recordReward(CHAT, 'vps', 0.6);
    recordReward(CHAT, 'vps', 0.2);
    const rows = getTopicScores(CHAT);
    expect(rows[0]!.pulls).toBe(1);
    expect(rows[0]!.reward).toBeCloseTo(0.8);
  });
});
