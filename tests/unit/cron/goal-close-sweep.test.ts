/**
 * goal 的「待关闭」观察期（两段式关闭）。
 *
 * 为什么存在：证据门要 assessment='verified' 才能把 goal 关成 achieved，而 goal 检查任务多半
 * 不发消息、没有 Echo 可观测——模型说「已完成」，goal 也永远 active，占着 GOAL_MAX_ACTIVE
 * （54 次 `goal rejected: max active reached`）。不能放宽证据门（那是让模型自评），所以改成：
 * 声称完成 → pending_close（不占名额）→ 观察期满，看世界的反应。
 *
 * 锁这几件事：
 *   ① 声称完成 → pending_close，且不占活跃名额（createGoal 能继续立新的）
 *   ② 观察期没满 → 不动
 *   ③ 观察期满 + 期间没人再提 → stale，记在 silence_closures / last_evidence='silence_unverified'，
 *      **不**记进 verified_achievements（不把"没人提"冒充成"被验证"）
 *   ④ 观察期满 + 期间有人再提 → 回 active，起点清空
 *   ⑤ 只有「人」的消息算再提；bot 自己的话、观察期之前的话都不算
 *   ⑥ 读不到消息（没 chat_id / 读失败）→ 不下结论，不关不开
 *   ⑦ 重复声称完成不会重置观察期（否则永远关不掉）
 *   ⑧ 接线：executor 在 flag 开时走 requestGoalClose；flag 关时保持 stays active（逐字节原行为）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
const envMock: Record<string, unknown> = {
  GOAL_CLOSE_OBSERVE_ENABLED: true,
  GOAL_CLOSE_OBSERVE_HOURS: 48,
  GOAL_LONG_TERM_ENABLED: false,
};
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/core/migrate.js', () => ({ syncGoal: vi.fn() }));

type Msg = { role: 'user' | 'assistant'; timestamp: number; textContent: string; captionContent?: string };
let recentMsgs: Msg[] = [];
let recentThrows = false;
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: async () => {
    if (recentThrows) throw new Error('redis down');
    return recentMsgs;
  },
}));

const goals = await import('../../../src/agent/goals.js');
const { runGoalCloseSweep } = await import('../../../src/cron/goal-close-sweep.js');

const H = 3600;
const NOW = 2_000_000_000;
const CHAT = -1001;
const TOPIC = '关注 ChatGPT Pro 订阅恢复资格政策调整';

const row = (id: number): Record<string, unknown> =>
  db.prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as Record<string, unknown>;

function newGoal(topic = TOPIC, chatId: number | null = CHAT): number {
  return goals.createGoal({ topic, origin: 'self', chatId }, 50)!;
}
/** 让 goal 的 close_requested_at 落在 NOW 之前 hoursAgo 小时（直接走 requestGoalClose 再改时间）。 */
function pending(id: number, hoursAgo: number): void {
  expect(goals.requestGoalClose(id, '已完成')).toBe(true);
  db.prepare(`UPDATE goals SET close_requested_at = ? WHERE id = ?`).run(NOW - hoursAgo * H, id);
}

beforeEach(() => {
  db = new Database(':memory:');
  for (const m of ['0055_goals.sql', '0059_goal_long_term.sql', '0070_feedback_and_subtasks.sql', '0073_goal_evidence.sql', '0117_goal_pending_close.sql']) {
    db.exec(readFileSync(`migrations/${m}`, 'utf8'));
  }
  recentMsgs = [];
  recentThrows = false;
  envMock.GOAL_CLOSE_OBSERVE_ENABLED = true;
  envMock.GOAL_CLOSE_OBSERVE_HOURS = 48;
});

describe('requestGoalClose', () => {
  it('① 声称完成 → pending_close，且不占活跃名额：满额时 pending_close 的让位给新 goal', () => {
    const a = newGoal('持续关注 AI 模型新版本定价变动');
    const b = newGoal('关注 SpeedTest 机器人的测速结果进展');
    // 上限设成 2：现在满了
    expect(goals.createGoal({ topic: '关注显卡价格走势与新品发布', origin: 'self', chatId: CHAT }, 2)).toBeNull();
    pending(a, 1);
    expect(row(a).status).toBe('pending_close');
    // a 进了观察期，名额让出来
    expect(goals.createGoal({ topic: '关注显卡价格走势与新品发布', origin: 'self', chatId: CHAT }, 2)).not.toBeNull();
    expect(row(b).status).toBe('active');
  });

  it('⑦ 重复声称完成不会重置观察期起点（否则每次检查都把计时清零，永远关不掉）', () => {
    const id = newGoal();
    pending(id, 10);
    const first = row(id).close_requested_at as number;
    expect(goals.requestGoalClose(id, '又说完成了')).toBe(false); // 已不是 active → 不动
    expect(row(id).close_requested_at).toBe(first);
  });
});

describe('runGoalCloseSweep', () => {
  it('② 观察期没满 → 不动', async () => {
    const id = newGoal();
    pending(id, 47);
    const r = await runGoalCloseSweep(NOW);
    expect(r.checked).toBe(0);
    expect(row(id).status).toBe('pending_close');
  });

  it('③ 观察期满 + 期间没人再提 → 未验证归档，不能标 achieved', async () => {
    const id = newGoal();
    pending(id, 49);
    recentMsgs = [{ role: 'user', timestamp: NOW - 40 * H, textContent: '今天天气不错' }];
    const r = await runGoalCloseSweep(NOW);
    expect(r.closed).toBe(1);
    const g = row(id);
    expect(g.status).toBe('stale');
    expect(g.last_evidence).toBe('silence_unverified');
    expect(g.silence_closures).toBe(1);
    expect(g.verified_achievements).toBe(0);   // 关键：没人提 ≠ 被独立验证
    expect(goals.listGoals('achieved').some(goal => goal.id === id)).toBe(false);
    expect((await runGoalCloseSweep(NOW + H)).closed).toBe(0);
    expect(row(id).silence_closures).toBe(1);
  });

  it('④ 观察期满 + 期间有人再提 → 回 active，起点清空', async () => {
    const id = newGoal();
    pending(id, 49);
    recentMsgs = [{ role: 'user', timestamp: NOW - 10 * H, textContent: 'ChatGPT Pro 订阅恢复资格那个政策又变了，你看看' }];
    const r = await runGoalCloseSweep(NOW);
    expect(r.reopened).toBe(1);
    const g = row(id);
    expect(g.status).toBe('active');
    expect(g.close_requested_at).toBeNull();
  });

  it('⑤ 只有「人」在观察期内的话才算再提：bot 自己的话、观察期之前的话都不算', async () => {
    const id = newGoal();
    pending(id, 49);
    recentMsgs = [
      { role: 'assistant', timestamp: NOW - 5 * H, textContent: 'ChatGPT Pro 订阅恢复资格政策调整我查过了' },        // bot 自己
      { role: 'user', timestamp: NOW - 60 * H, textContent: 'ChatGPT Pro 订阅恢复资格政策调整是什么情况' },          // 观察期开始之前
    ];
    const r = await runGoalCloseSweep(NOW);
    expect(r.closed).toBe(1);
    expect(r.reopened).toBe(0);
  });

  it('⑥a 没有 chat_id 的 goal：读不到消息，不下结论；放到 ×3 观察期才按 stale 收', async () => {
    const id = newGoal(TOPIC, null);
    pending(id, 49);
    let r = await runGoalCloseSweep(NOW);
    expect(r.held).toBe(1);
    expect(row(id).status).toBe('pending_close');
    db.prepare(`UPDATE goals SET close_requested_at = ? WHERE id = ?`).run(NOW - 48 * 3 * H - 1, id);
    r = await runGoalCloseSweep(NOW);
    expect(r.staled).toBe(1);
    expect(row(id).status).toBe('stale');
  });

  it('⑥b 读消息失败 → 不关不开（读失败 ≠ 没人提）', async () => {
    const id = newGoal();
    pending(id, 49);
    recentThrows = true;
    const r = await runGoalCloseSweep(NOW);
    expect(r.held).toBe(1);
    expect(r.closed).toBe(0);
    expect(row(id).status).toBe('pending_close');
  });

  it('没有起点（close_requested_at 为空）的 pending_close 不处理——不能凭空算观察期', async () => {
    const id = newGoal();
    db.prepare(`UPDATE goals SET status = 'pending_close' WHERE id = ?`).run(id);
    const r = await runGoalCloseSweep(NOW);
    expect(r.checked).toBe(0);
    expect(row(id).status).toBe('pending_close');
  });

  it('抽象话题词太少（匹配不出）→ 不会因为一句无关的话就误判成再提', () => {
    const grams = goals.goalTopicGrams(TOPIC);
    expect(goals.mentionsGoalTopic('今天中午吃什么', grams)).toBe(false);
    expect(goals.mentionsGoalTopic('', grams)).toBe(false);
    expect(goals.mentionsGoalTopic('anything', goals.goalTopicGrams('a'))).toBe(false);
  });
});

describe('settleUnverifiedCompletion —— executor 落账的真实分支', () => {
  it('flag 开：active 的 goal → pending_close，且不再占活跃名额', () => {
    const id = newGoal();
    expect(goals.settleUnverifiedCompletion(id, '已完成', true)).toBe('pending_close');
    expect(row(id).status).toBe('pending_close');
    expect(row(id).unverified_completions).toBe(1);
  });

  it('flag 关：保持原行为——goal 仍 active，只记一次未验证完成（逐字节原语义）', () => {
    const id = newGoal();
    expect(goals.settleUnverifiedCompletion(id, '已完成', false)).toBe('stays_active');
    const g = row(id);
    expect(g.status).toBe('active');
    expect(g.close_requested_at).toBeNull();
    expect(g.unverified_completions).toBe(1);
    expect(g.last_evidence).toBe('unverified');
  });

  it('flag 开但 goal 已不是 active（比如已在观察期）：落回原行为，不重置起点', () => {
    const id = newGoal();
    pending(id, 10);
    const first = row(id).close_requested_at as number;
    expect(goals.settleUnverifiedCompletion(id, '又完成了', true)).toBe('stays_active');
    expect(row(id).close_requested_at).toBe(first);
    expect(row(id).status).toBe('pending_close');
  });
});

describe('接线：生产路径真的走到这个函数', () => {
  it('executor 调 settleUnverifiedCompletion 并把 flag 值传进去', () => {
    const src = readFileSync('src/subagent/executor.ts', 'utf8');
    expect(src).toContain('settleUnverifiedCompletion(');
    expect(src).toContain('GOAL_CLOSE_OBSERVE_ENABLED === true');
    expect(src).toMatch(/settleUnverifiedCompletion\(\s*goalId,[\s\S]{0,200}observe,\s*\)/);
  });

  it('scheduler 在 flag 开时注册 goal-close-sweep', () => {
    const src = readFileSync('src/cron/scheduler.ts', 'utf8');
    const i = src.indexOf("name: 'goal-close-sweep'");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, i - 200), i)).toContain('GOAL_CLOSE_OBSERVE_ENABLED');
  });
});
