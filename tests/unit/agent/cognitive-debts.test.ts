import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  createDebt, listOpenDebts, listOpenDebtsScoped, listDueDebtsScoped, findRelatedDebts, resolveDebt,
  findRelatedDebtsScoped, findRelatedDebtsScopedWithSemantic, supersedeDebt, snoozeDebt, expireStaleDebts,
} = await import('../../../src/agent/cognitive-debts.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0087_cognitive_debts.sql', 'utf8'));
});

describe('cognitive debts', () => {
  it('creates and lists scoped open debts by priority', () => {
    const low = createDebt({ chatId: -100, kind: 'uncertainty', statement: '服务是否跑路尚未确认', priority: 3 });
    const high = createDebt({ chatId: -100, kind: 'promise', statement: '答应主人查项目更新', priority: 8 });
    const other = createDebt({ chatId: -200, kind: 'promise', statement: '别的群的债务' });
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(other).not.toBeNull();
    const open = listOpenDebts(-100);
    expect(open.map((d) => d.id)).toEqual([high, low]);
  });

  it('matches related debts by gram overlap and resolves them', () => {
    createDebt({ chatId: -100, kind: 'promise', statement: '答应帮主人查 nyatdb 项目更新' });
    const hits = findRelatedDebts(-100, 'nyatdb 项目更新查到了吗');
    expect(hits).toHaveLength(1);
    expect(resolveDebt(hits[0]!.id, '已确认最新版本并回复主人')).toBe(true);
    expect(listOpenDebts(-100)).toHaveLength(0);
    expect(findRelatedDebts(-100, 'nyatdb 项目更新查到了吗')).toHaveLength(0);
  });

  it('supersedes stale beliefs and snoozes retries', () => {
    const old = createDebt({ chatId: -100, kind: 'correction', statement: '主人环境是 Ubuntu 的旧判断' });
    const fresh = createDebt({ chatId: -100, kind: 'stale_belief', statement: '主人环境已改为 Windows，需要重查' });
    expect(supersedeDebt(old!, fresh, '用户已纠正环境')).toBe(true);
    expect(snoozeDebt(fresh!, 3600)).toBe(true);
    const open = listOpenDebts(-100);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(fresh);
    expect(open[0]!.nextCheckAt).not.toBeNull();
  });

  it('expires overdue open debts', () => {
    const ts = Math.floor(Date.now() / 1000);
    createDebt({ chatId: -100, kind: 'uncertainty', statement: '临时传闻待核', ttlSec: 60 });
    db.prepare(`UPDATE cognitive_debts SET expires_at = ? WHERE chat_id = -100`).run(ts - 120);
    expect(expireStaleDebts()).toBe(1);
    expect(listOpenDebts(-100)).toHaveLength(0);
  });

  it('deduplicates event-derived debts after scope migration', () => {
    db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    const first = createDebt({
      chatId: -100,
      taskId: 'task-1',
      kind: 'correction',
      statement: '需要重新核实',
      sourceEventIds: ['event-1'],
      dedupeKey: 'event-1:correction',
    });
    const duplicate = createDebt({
      chatId: -100,
      taskId: 'task-1',
      kind: 'correction',
      statement: '不同文本不应新增',
      sourceEventIds: ['event-1'],
      dedupeKey: 'event-1:correction',
    });
    expect(duplicate).toBe(first);
    const row = db.prepare('SELECT scope_key, visibility FROM cognitive_debts WHERE id = ?').get(first) as {
      scope_key: string; visibility: string;
    };
    expect(row.scope_key).toBe('task:task-1@chat:-100');
    expect(row.visibility).toBe('task');
    expect(db.prepare('SELECT COUNT(*) AS n FROM cognitive_debts').get()).toEqual({ n: 1 });
  });

  it('does not expose another task debt through a scoped workspace', () => {
    db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    const chatDebt = createDebt({ chatId: -100, kind: 'promise', statement: '群级待办' });
    const taskOne = createDebt({ chatId: -100, taskId: 'task-1', kind: 'unfinished_task', statement: '任务一未完成' });
    createDebt({ chatId: -100, taskId: 'task-2', kind: 'unfinished_task', statement: '任务二不可见' });
    const visible = listOpenDebtsScoped({ visibility: 'task', chatId: -100, taskId: 'task-1' });
    expect(visible.map((debt) => debt.id)).toContain(chatDebt);
    expect(visible.map((debt) => debt.id)).toContain(taskOne);
    expect(visible.some((debt) => debt.statement.includes('任务二'))).toBe(false);
    const chatView = listOpenDebtsScoped({ visibility: 'chat', chatId: -100 });
    expect(chatView.some((debt) => debt.statement.includes('任务一'))).toBe(false);
  });

  it('keeps due-debt scans scoped for chat and task actors', () => {
    db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    const chatDebt = createDebt({ chatId: -100, kind: 'promise', statement: '群级到期事项', nextCheckInSec: 60 });
    const taskDebt = createDebt({ chatId: -100, taskId: 'task-1', kind: 'unfinished_task', statement: '任务一到期事项', nextCheckInSec: 60 });
    const otherTask = createDebt({ chatId: -100, taskId: 'task-2', kind: 'unfinished_task', statement: '任务二不可见', nextCheckInSec: 60 });
    db.prepare('UPDATE cognitive_debts SET next_check_at = 0').run();
    const chatDue = listDueDebtsScoped({ visibility: 'chat', chatId: -100 });
    expect(chatDue.map((debt) => debt.id)).toContain(chatDebt);
    expect(chatDue.map((debt) => debt.id)).not.toContain(taskDebt);
    const taskDue = listDueDebtsScoped({ visibility: 'task', chatId: -100, taskId: 'task-1' });
    expect(taskDue.map((debt) => debt.id)).toContain(chatDebt);
    expect(taskDue.map((debt) => debt.id)).toContain(taskDebt);
    expect(taskDue.map((debt) => debt.id)).not.toContain(otherTask);
  });

  it('matches debts with deterministic scope and source anchors before text overlap', () => {
    db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    const chatDebt = createDebt({
      chatId: -100,
      kind: 'promise',
      statement: '答应查 nyatdb 项目更新',
      sourceEventIds: ['event-nyatdb'],
      priority: 5,
    });
    const taskOne = createDebt({ chatId: -100, taskId: 'task-1', kind: 'unfinished_task', statement: '任务一等待验收', priority: 4 });
    const taskTwo = createDebt({ chatId: -100, taskId: 'task-2', kind: 'unfinished_task', statement: '任务二等待验收', priority: 10 });

    const taskMatches = findRelatedDebtsScoped(
      { visibility: 'task', chatId: -100, taskId: 'task-1' },
      'nyatdb 更新查了吗',
      { limit: 10 },
    );
    expect(taskMatches.map((match) => match.debt.id)).toContain(chatDebt);
    expect(taskMatches.map((match) => match.debt.id)).toContain(taskOne);
    expect(taskMatches.map((match) => match.debt.id)).not.toContain(taskTwo);
    expect(taskMatches.find((match) => match.debt.id === taskOne)?.kind).toBe('scope');

    const sourceMatches = findRelatedDebtsScoped(
      { visibility: 'chat', chatId: -100 },
      '',
      { anchors: { sourceEventId: 'event-nyatdb' } },
    );
    expect(sourceMatches[0]?.debt.id).toBe(chatDebt);
    expect(sourceMatches[0]?.kind).toBe('source_event');
  });

  it('keeps user-scoped deterministic matches isolated from another owner and chat', () => {
    db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    const ownerOne = createDebt({ chatId: -100, ownerUid: 7, kind: 'correction', statement: 'uid7 的配置需要复核' });
    const ownerTwo = createDebt({ chatId: -100, ownerUid: 8, kind: 'correction', statement: 'uid8 的配置需要复核' });
    const otherChat = createDebt({ chatId: -200, ownerUid: 7, kind: 'correction', statement: '另一个群的配置需要复核' });
    const matches = findRelatedDebtsScoped(
      { visibility: 'user', chatId: -100, userId: 7 },
      '完全无关的当前消息',
      { limit: 10 },
    );
    expect(matches.map((match) => match.debt.id)).toContain(ownerOne);
    expect(matches.map((match) => match.debt.id)).not.toContain(ownerTwo);
    expect(matches.map((match) => match.debt.id)).not.toContain(otherChat);
  });

  it('replays debt status from append-only revisions at an event timestamp', () => {
    db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    db.exec(readFileSync('migrations/0094_debt_resolution_provenance.sql', 'utf8'));
    db.exec(readFileSync('migrations/0099_cognitive_debt_revisions.sql', 'utf8'));
    const id = createDebt({ chatId: -100, taskId: 'task-history', kind: 'promise', statement: '等待历史验收' });
    const first = db.prepare('SELECT snapshot_at FROM cognitive_debt_revisions WHERE debt_id = ? AND revision = 1').get(id) as { snapshot_at: number };
    db.prepare('UPDATE cognitive_debts SET status = \'resolved\', resolution = ?, updated_at = ? WHERE id = ?')
      .run('已由 host 证据解决', first.snapshot_at + 10, id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cognitive_debt_revisions WHERE debt_id = ?').get(id)).toEqual({ n: 2 });
    expect(listOpenDebtsScoped({ visibility: 'task', chatId: -100, taskId: 'task-history' }, 5, { asOf: first.snapshot_at + 5 }).map((debt) => debt.id)).toEqual([id]);
    expect(listOpenDebtsScoped({ visibility: 'task', chatId: -100, taskId: 'task-history' }, 5, { asOf: first.snapshot_at + 20 })).toEqual([]);
  });

  it('runs a bounded host-owned semantic pass after deterministic matches', async () => {
    db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    createDebt({ chatId: -100, kind: 'promise', statement: '同步项目状态', priority: 8 });
    createDebt({ chatId: -100, kind: 'uncertainty', statement: '等待外部服务核实', priority: 7 });
    let calls = 0;
    const matches = await findRelatedDebtsScopedWithSemantic(
      { visibility: 'chat', chatId: -100 },
      '完全不同的说法',
      {
        limit: 2,
        maxCandidates: 20,
        maxSemanticCandidates: 1,
        minSemanticScore: 0.6,
        semanticScore: async ({ debt }) => {
          calls++;
          return debt.statement.includes('项目') ? 0.9 : 0.2;
        },
      },
    );
    expect(calls).toBe(1);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ kind: 'semantic', debt: { statement: '同步项目状态' } });
    expect(matches[0]?.reasons).toEqual(['semantic_score:0.90']);
  });

  it('keeps deterministic source matches and fails soft on invalid semantic scores', async () => {
    db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    const id = createDebt({
      chatId: -100,
      kind: 'promise',
      statement: '等待项目验收',
      sourceEventIds: ['event-source'],
    });
    let calls = 0;
    const matches = await findRelatedDebtsScopedWithSemantic(
      { visibility: 'chat', chatId: -100 },
      '',
      {
        limit: 2,
        anchors: { sourceEventId: 'event-source' },
        maxSemanticCandidates: 4,
        semanticScore: () => {
          calls++;
          return Number.NaN;
        },
      },
    );
    expect(matches[0]).toMatchObject({ debt: { id }, kind: 'source_event' });
    expect(calls).toBe(0);
  });
});
