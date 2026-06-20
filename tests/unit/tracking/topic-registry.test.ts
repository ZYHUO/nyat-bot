import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`CREATE TABLE chat_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, label TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', msg_count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL DEFAULT 0, last_active INTEGER NOT NULL DEFAULT 0);
  CREATE UNIQUE INDEX idx_u ON chat_topics(chat_id, label);`);

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));

import { observeTopic, tickLifecycle, getActiveTopics, getTopicLine } from '../../../src/tracking/topic-registry.js';

const C = -100;
const T0 = 1_000_000;
const MIN = 60;

describe('topic-registry lifecycle', () => {
  beforeEach(() => { db.exec('DELETE FROM chat_topics'); });

  it('creates an active topic and bumps msg_count on re-observe', () => {
    observeTopic(C, '装机配置', T0);
    observeTopic(C, '装机配置', T0 + 10);
    const t = getActiveTopics(C);
    expect(t).toHaveLength(1);
    expect(t[0]!.state).toBe('active');
    expect(t[0]!.msg_count).toBe(2);
  });

  it('active → cooling → dead → pruned by tickLifecycle', () => {
    observeTopic(C, '显卡', T0);
    tickLifecycle(C, T0 + 21 * MIN);        // >20min idle → cooling
    expect(getActiveTopics(C)[0]!.state).toBe('cooling');
    tickLifecycle(C, T0 + 91 * MIN);        // >90min idle → dead
    expect(getActiveTopics(C)).toHaveLength(0); // dead is not "live"
    tickLifecycle(C, T0 + 25 * 3600);       // >24h → pruned
    const remaining = db.prepare('SELECT COUNT(*) c FROM chat_topics WHERE chat_id=?').get(C) as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('re-observing a cooling topic reactivates it', () => {
    observeTopic(C, '火锅', T0);
    tickLifecycle(C, T0 + 21 * MIN);
    expect(getActiveTopics(C)[0]!.state).toBe('cooling');
    observeTopic(C, '火锅', T0 + 22 * MIN); // mentioned again
    expect(getActiveTopics(C)[0]!.state).toBe('active');
  });

  it('getActiveTopics returns newest first; getTopicLine marks cooling', () => {
    observeTopic(C, '旧话题', T0);
    observeTopic(C, '新话题', T0 + 100);
    tickLifecycle(C, T0 + 100); // nothing crosses cooling yet
    const t = getActiveTopics(C);
    expect(t[0]!.label).toBe('新话题');
    // make 旧话题 cool
    tickLifecycle(C, T0 + 21 * MIN);
    observeTopic(C, '新话题', T0 + 21 * MIN); // keep 新话题 active
    const line = getTopicLine(C);
    expect(line).toContain('新话题');
    expect(line).toContain('旧话题(渐冷)');
  });

  it('caps live topics per chat (oldest demoted)', () => {
    for (let i = 0; i < 9; i++) observeTopic(C, `话题${i}`, T0 + i);
    tickLifecycle(C, T0 + 10);
    expect(getActiveTopics(C, 20).length).toBeLessThanOrEqual(6);
  });
});
