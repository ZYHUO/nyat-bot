import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const f = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  enqueue: vi.fn(),
  llm: vi.fn(),
  slot: vi.fn(),
  mark: vi.fn(),
  redis: vi.fn(),
  send: vi.fn(),
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/env.js', () => ({
  env: () => ({
    BOT_TOKEN: '12345:synthetic',
    MASTER_UID: 20,
    META_SUBAGENT_ENABLED: true,
    BACKGROUND_PUBLICATION_ENABLED: true,
    UNIFIED_TICK_ENABLED: true,
    UNIFIED_TICK_USAGE: 'test',
    SELF_PLAY_COOLDOWN_SEC: 14400,
  }),
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async () => null,
    zrevrange: async () => [],
    zrange: async () => [],
    keys: async () => [],
    set: f.redis,
  }),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: async () => [],
}));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: f.llm }));
vi.mock('../../../src/cron/active-hours.js', () => ({
  isWithinActiveHours: () => true,
}));
vi.mock('../../../src/tracking/sleep.js', () => ({
  isAsleep: async () => false,
}));
vi.mock('../../../src/cron/activation-policy.js', () => ({
  checkProactiveActivation: async () => ({ allowed: true }),
}));
vi.mock('../../../src/cron/proactive-coordinator.js', () => ({
  tryAcquireProactiveSlot: f.slot,
  markProactiveSent: f.mark,
}));
vi.mock('../../../src/subagent/queue.js', () => ({
  enqueueCodeActJob: f.enqueue,
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: f.send }));
vi.mock('../../../src/agent/goals.js', () => ({
  listDueGoals: () => f.db.prepare('SELECT * FROM goals').all(),
  listGoals: () => f.db.prepare('SELECT * FROM goals').all(),
  listSubtasks: () => [],
  recordCheck: (id: number) =>
    f.db
      .prepare(
        'UPDATE goals SET check_count=check_count+1,last_check_at=? WHERE id=?',
      )
      .run(Math.floor(Date.now() / 1000), id),
}));
import { runUnifiedTick } from '../../../src/cron/unified-tick.js';
import { beginBackgroundTask } from '../../../src/agent/background-publication.js';
beforeEach(() => {
  vi.clearAllMocks();
  f.db = new Database(':memory:');
  f.db.exec(
    readFileSync('migrations/0131_background_publications.sql', 'utf8'),
  );
  f.db.exec(
    'CREATE TABLE goals(id INTEGER PRIMARY KEY,topic TEXT,origin TEXT,chat_id INTEGER,status TEXT,check_count INTEGER,last_check_at INTEGER,last_finding TEXT,created_at INTEGER)',
  );
  f.db
    .prepare(
      "INSERT INTO goals VALUES(1,'合成目标','operator',20,'active',0,NULL,NULL,?)",
    )
    .run(Math.floor(Date.now() / 1000) - 100);
  f.enqueue.mockResolvedValue(undefined);
  f.slot.mockResolvedValue(true);
});
afterEach(() => f.db.close());
it.each(['check_goal', 'self_play'])(
  '%s is explicitly registered before enqueue and consumes no notification budget',
  async (action) => {
    f.llm.mockResolvedValue({
      content: JSON.stringify(
        action === 'check_goal'
          ? { action, goalId: 1, reason: 'synthetic' }
          : { action, idea: '合成检查', plan: [], reason: 'synthetic' },
      ),
    });
    f.enqueue.mockImplementation(async (task) => {
      expect(
        f.db
          .prepare('SELECT state FROM background_checks WHERE task_id=?')
          .get(task.id),
      ).toEqual({ state: 'pending' });
    });
    await runUnifiedTick();
    expect(f.enqueue).toHaveBeenCalledOnce();
    const task = f.enqueue.mock.calls[0]![0];
    expect(task).toMatchObject({
      executionMode: 'background',
      backgroundOrigin: {
        kind: action === 'check_goal' ? 'goal' : 'self_play',
      },
    });
    expect(task.contentDirection).not.toContain('sendText');
    expect(() => beginBackgroundTask(task)).not.toThrow();
    expect(f.slot).not.toHaveBeenCalled();
    expect(f.mark).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  },
);
