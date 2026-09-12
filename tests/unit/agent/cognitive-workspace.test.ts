import { describe, expect, it, vi } from 'vitest';

const getScratch = vi.fn(async () => [{ text: '等文件', at: 1 }]);
const all = vi.fn(() => [{ goal: '查资料', state: 'running', progress: '["搜索中"]' }]);
const get = vi.fn(() => ({ assessment: 'unverified', reasons: 'not_checked' }));

vi.mock('../../../src/tracking/scratchpad.js', () => ({ getScratch }));
vi.mock('../../../src/agent/cognitive-debts.js', () => ({
  listOpenDebts: vi.fn(() => [{ id: 1, kind: 'promise', statement: '答应主人查 nyatdb 更新', priority: 8 }]),
}));
vi.mock('../../../src/tracking/self-model.js', () => ({
  getActiveSelfNotes: vi.fn(() => [{ id: 1, note: '最近在这个群解释过多，用户更喜欢先给结论' }]),
}));
vi.mock('../../../src/subagent/task-store.js', () => ({
  loadCodeActTask: vi.fn(async () => ({
    id: 'task-1', chatId: -100, contentDirection: '查资料', status: 'running', checkpointKey: 'cp-1',
  })),
}));
vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: (sql: string) => ({ all: () => all(sql), get: () => get(sql) }) }),
}));
vi.mock('../../../src/context-engine/index.js', () => ({
  getContextEngine: () => ({ assemble: async (providers: Array<{ provide: () => unknown }>) => ({ prompt: providers.map((p) => String((p.provide() as { text: string }).text)).join('\n') }) }),
}));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

const { buildCognitiveWorkspace } = await import('../../../src/agent/cognitive-workspace.js');

describe('cognitive workspace', () => {
  it('combines scoped scratch, task and evidence without creating a new store', async () => {
    const snapshot = await buildCognitiveWorkspace({ chatId: -100, taskId: 'task-1', userId: 7 });
    expect(snapshot.scope).toEqual({ chatId: -100, taskId: 'task-1', userId: 7 });
    expect(snapshot.activeGoals).toEqual(['查资料']);
    expect(snapshot.currentTask?.state).toBe('running');
    expect(snapshot.currentTask?.evidence).toBe('unverified');
    expect(snapshot.parts.map((p) => p.text).join('\n')).toContain('等文件');
    expect(snapshot.parts.map((p) => p.text).join('\n')).toContain('答应主人查 nyatdb 更新');
    expect(snapshot.parts.map((p) => p.text).join('\n')).toContain('先给结论');
    expect(snapshot.openQuestions.some((q) => q.includes('nyatdb'))).toBe(true);
    expect(snapshot.uncertainties.join('\n')).toContain('尚未通过外部验收');
  });
});
