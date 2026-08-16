import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;

vi.mock('../../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

vi.mock('../../../../src/env.js', () => ({
  env: () => ({ GOAL_MAX_ACTIVE: 5 }),
}));

const sendDirectMock = vi.fn();

// sender 来自 pipeline/shared.js 聚合模块 —— mock 那个。
vi.mock('../../../../src/pipeline/shared.js', () => ({
  sender: {
    sendDirect: (...args: unknown[]) => sendDirectMock(...args),
    sendMessage: vi.fn(async () => ({ messageId: 1 })),
  },
  ADDRESSED_RULES: new Set(),
}));

const { dispatchCommand } = await import('../../../../src/pipeline/stages/intercepts.js');
const { createGoal, listGoals } = await import('../../../../src/agent/goals.js');

const formatted = {
  uid: 6251541967,
  messageId: 100,
  textContent: '追踪比特币',
} as never;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../../migrations/0055_goals.sql'), 'utf8'));
  db.exec(readFileSync(join(__dirname, '../../../../migrations/0012_topic_watches.sql'), 'utf8'));
  sendDirectMock.mockReset();
});

describe('dispatchCommand /watch 分流', () => {
  it('DM(chatId>0)→ createGoal 落 goals 表(origin=master)', async () => {
    const handled = await dispatchCommand(6251541967, formatted, '/watch', '比特币');
    expect(handled).toBe(true);

    const goals = listGoals('active');
    expect(goals).toHaveLength(1);
    expect(goals[0]!.topic).toBe('比特币');
    expect(goals[0]!.origin).toBe('master');
    expect(goals[0]!.chat_id).toBe(6251541967);

    expect(sendDirectMock).toHaveBeenCalledOnce();
    expect(String(sendDirectMock.mock.calls[0]![1])).toContain('比特币');
  });

  it('群聊(chatId<0)→ 不落 goals 表(老 addWatch 路径)', async () => {
    // 群聊 watch 不 import goals 的 createGoal —— 用 spy 确认 goals 表没行。
    const handled = await dispatchCommand(-100123, formatted, '/watch', '显卡');
    expect(handled).toBe(true);
    expect(listGoals('active')).toHaveLength(0);
    expect(sendDirectMock).toHaveBeenCalledOnce();
  });

  it('重复 topic 不重复建 goal(createGoal 去重)', async () => {
    await dispatchCommand(6251541967, formatted, '/watch', '比特币');
    await dispatchCommand(6251541967, formatted, '/watch', '比特币');
    expect(listGoals('active')).toHaveLength(1);
  });

  it('超过 GOAL_MAX_ACTIVE 时拒绝并提示', async () => {
    for (let i = 0; i < 5; i++) {
      await dispatchCommand(6251541967, formatted, '/watch', `话题 ${i}`);
    }
    await dispatchCommand(6251541967, formatted, '/watch', '第六个');
    expect(listGoals('active')).toHaveLength(5);
    expect(String(sendDirectMock.mock.calls.at(-1)![1])).toContain('没立上');
  });
});
