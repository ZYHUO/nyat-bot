import { describe, expect, it, vi } from 'vitest';

const getScratch = vi.fn(async () => [{ text: '等文件', at: 1 }]);
const all = vi.fn(() => [{ goal: '查资料', state: 'running', progress: '["搜索中"]' }]);
const get = vi.fn(() => ({ assessment: 'unverified', reasons: 'not_checked' }));
const semanticMatcher = vi.fn(async () => []);

vi.mock('../../../src/tracking/scratchpad.js', () => ({ getScratch }));
vi.mock('../../../src/agent/cognitive-debts.js', () => ({
  listOpenDebtsScoped: vi.fn(() => [{ id: 1, kind: 'promise', statement: '答应主人查 nyatdb 更新', priority: 8 }]),
  findRelatedDebtsScoped: vi.fn(() => []),
  findRelatedDebtsScopedWithSemantic: semanticMatcher,
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

const { buildCognitiveWorkspace, renderCognitiveWorkspace } = await import('../../../src/agent/cognitive-workspace.js');

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

  it('renders a bounded scope and uncertainty footer for prompt consumers', () => {
    const text = renderCognitiveWorkspace({
      scope: { chatId: -100, taskId: 'task-1' },
      parts: [{ id: 'p', tier: 'delta', text: '任务背景' }],
      provenance: [],
      beliefs: [],
      worldEntities: [],
      predictions: [],
      pendingActions: [],
      uncertainties: ['结果尚未验收'],
      activeGoals: [],
      openQuestions: [],
    });
    expect(text).toContain('scope=task:task-1@chat:-100');
    expect(text).toContain('任务背景');
    expect(text).toContain('结果尚未验收');
  });

  it('accepts an optional host-owned semantic debt matcher without making it implicit', async () => {
    semanticMatcher.mockResolvedValueOnce([
      {
        debt: { id: 2, kind: 'uncertainty', statement: '等待外部核实', priority: 6 },
        score: 110,
        overlap: 0,
        kind: 'semantic',
        reasons: ['semantic_score:0.90'],
      },
    ]);
    const scorer = vi.fn(async () => 0.9);
    const snapshot = await buildCognitiveWorkspace({
      chatId: -100,
      userId: 7,
      queryText: '外部核实进展',
      semanticDebt: { semanticScore: scorer, maxCandidates: 2, minScore: 0.7 },
    });
    expect(semanticMatcher).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: -100, userId: 7 }),
      '外部核实进展',
      expect.objectContaining({ maxSemanticCandidates: 2, minSemanticScore: 0.7 }),
    );
    expect(snapshot.parts.map((part) => part.text).join('\n')).toContain('等待外部核实');
    expect(snapshot.provenance.some((item) => item.provider === 'cognitive-debts:semantic-matcher')).toBe(true);
  });
});
