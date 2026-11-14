import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';

const f = vi.hoisted(() => ({
  tasks: new Map<string, DispatchTask>(),
  todos: [] as Array<{ id: string; text: string; createdAt: number; sourceChatId?: number }>,
  write: vi.fn(async () => ({ wrote: true, path: 'synthetic', slot: 'free' })),
  recent: vi.fn(async () => 'same-chat diary'),
  observation: vi.fn(async () => ({})),
}));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({
  getTask: (id: string) => f.tasks.get(id),
  listTasks: (chatId?: number) => [...f.tasks.values()].filter((task) => chatId === undefined || task.chatId === chatId),
  get todos() { return f.todos; }, set todos(value) { f.todos = value; },
}) }));
vi.mock('../../../src/meta/flags.js', () => ({ isMetaSubagentChat: () => true }));
vi.mock('../../../src/agent/agency-meta-actions.js', () => ({ recordMetaActionObservation: f.observation }));
vi.mock('../../../src/cron/dream-journal.js', () => ({ tryWriteDreamJournal: f.write, readRecentDreamSnippet: f.recent }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } }));
import { buildMetaApiContext } from '../../../src/meta/meta-api.js';

function task(id: string, chatId: number): DispatchTask {
  return { id, chatId, contentDirection: `private-${id}`, createdAt: Date.now(), status: 'queued' };
}
function api(scopeChatId?: number) {
  return buildMetaApiContext({ scopeChatId }) as Record<string, Record<string, (...args: any[]) => any>>;
}
beforeEach(() => {
  vi.clearAllMocks();
  f.tasks.clear();
  f.tasks.set('a', task('a', 42));
  f.tasks.set('b', task('b', -100));
  f.todos = [{ id: 'a', text: 'DM secret', createdAt: 1, sourceChatId: 42 }, { id: 'legacy', text: 'unknown', createdAt: 1 }];
});

describe('Meta API host-owned chat scope', () => {
  it('filters task and agent reads to the current chat', () => {
    const context = api(-100);
    expect(context.dispatch!.getTask!('a')).toBeNull();
    expect(context.dispatch!.getTask!('b')).toMatchObject({ id: 'b' });
    expect(context.dispatch!.listTasks!()).toEqual([f.tasks.get('b')]);
    expect(context.agents!.listStatus!()).toEqual([expect.objectContaining({ taskId: 'b', chatId: -100 })]);
    expect(() => context.dispatch!.listTasks!(42)).toThrow('meta_scope_mismatch');
  });
  it('prevents dispatch and all cognition proposals from selecting another chat', async () => {
    const context = api(-100);
    await expect(context.dispatch!.taskToGroup!(42, { contentDirection: 'leak', interrupt: true })).rejects.toThrow('meta_scope_mismatch');
    for (const method of ['proposeMission', 'proposeSensor', 'proposeValue', 'proposeAffect', 'proposeCircuit']) {
      await expect(context.cognition![method]!({ chatId: 42 })).rejects.toThrow('meta_scope_mismatch');
    }
  });
  it('scopes todo writes, reads and removal; unknown legacy entries remain archived', () => {
    const context = api(-100);
    const added = context.todo!.add!('group only');
    expect(context.todo!.list!()).toEqual([expect.objectContaining({ id: added.id, sourceChatId: -100 })]);
    expect(context.todo!.remove!('a')).toBe(false);
    expect(f.todos.some((t) => t.id === 'a')).toBe(true);
    expect(context.todo!.remove!(added.id)).toBe(true);
    expect(f.todos.map((t) => t.id)).toEqual(['a', 'legacy']);
  });
  it('passes only trusted current source to journal read/write', async () => {
    const context = api(-100);
    await context.journal!.tryWrite!({ slot: 'free', force: true, sourceChatId: 42 });
    await context.journal!.recent!(250);
    expect(f.write).toHaveBeenCalledWith({ slot: 'free', force: true, sourceChatId: -100 });
    expect(f.recent).toHaveBeenCalledWith(280, { sourceChatId: -100 });
    expect(f.recent).toHaveBeenCalledWith(250, { sourceChatId: -100 });
  });
  it('fails closed for missing and ambiguous scopes before invoking journal', async () => {
    const context = api();
    expect(() => context.dispatch!.getTask!('a')).toThrow('meta_scope_required');
    await expect(context.journal!.tryWrite!()).rejects.toThrow('meta_scope_required');
    const ambiguous = buildMetaApiContext({ chatLayer: new Map([[42, 'L1'], [-100, 'L1']]) }) as ReturnType<typeof api>;
    await expect(ambiguous.journal!.recent!()).rejects.toThrow('meta_scope_required');
    expect(f.write).not.toHaveBeenCalled();
    expect(f.recent).not.toHaveBeenCalled();
  });
});
