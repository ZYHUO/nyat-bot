/**
 * 「学来的东西」接进 Meta 路径（learned-context.ts）。
 *
 * 为什么存在：expression-learner / dialect-exemplar / group-norms / self-reflect /
 * person-identity 的写侧一直在跑，读侧只有 legacy 的 buildMessages（~0.17% 发送），
 * Meta 主路径 98% 的发送从不读——学了不用。这里锁三件事：
 *   ① 总闸关 → 恒为空（默认 OFF，不改变现有行为）
 *   ② 总闸开 → 五块各自按自己的条件出现，且各自 fail-soft
 *   ③ collectPromptInputs 真的把它带出来、executor 真的把它传进 prompt（接线，不只是函数存在）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const envMock: Record<string, unknown> = {
  META_INJECT_LEARNED_ENABLED: true,
  EXPRESSION_INJECT_ENABLED: true,
  EXPRESSION_INJECT_COUNT: 3,
  GROUP_NORMS_ENABLED: true,
  PERSON_IDENTITY_ENABLED: true,
};
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const reinforce = vi.fn();
const expr = { getTopExpressions: vi.fn(), reinforceExpressions: reinforce };
vi.mock('../../../src/learners/expression-learner.js', () => ({
  getTopExpressions: (...a: unknown[]) => expr.getTopExpressions(...a),
  reinforceExpressions: (...a: unknown[]) => expr.reinforceExpressions(...a),
}));
const dialect = { getExemplars: vi.fn() };
vi.mock('../../../src/learners/dialect-exemplar.js', () => ({
  getExemplars: (...a: unknown[]) => dialect.getExemplars(...a),
}));
const norms = { buildNormsBlock: vi.fn() };
vi.mock('../../../src/agent/group-norms.js', () => ({
  buildNormsBlock: (...a: unknown[]) => norms.buildNormsBlock(...a),
}));
const selfModel = { getActiveSelfNotes: vi.fn() };
vi.mock('../../../src/tracking/self-model.js', () => ({
  getActiveSelfNotes: (...a: unknown[]) => selfModel.getActiveSelfNotes(...a),
}));
const identity = { buildCrossGroupInjection: vi.fn() };
vi.mock('../../../src/tracking/person-identity.js', () => ({
  buildCrossGroupInjection: (...a: unknown[]) => identity.buildCrossGroupInjection(...a),
}));

const { buildLearnedContext } = await import('../../../src/subagent/learned-context.js');

const GROUP = -1001;
const DM = 42;

function seedAll(): void {
  expr.getTopExpressions.mockReturnValue([
    { id: 7, style: '草，真的假的', situation: 'x' },
    { id: 9, style: '确实', situation: 'y' },
  ]);
  dialect.getExemplars.mockReturnValue(['笑死', '别吵了']);
  norms.buildNormsBlock.mockReturnValue('\n\n[群氛围]\n这个群的隐性规则：\n- 短句\n回复时自然地贴合这个群的氛围。');
  selfModel.getActiveSelfNotes.mockReturnValue([{ note: '别连发三条' }]);
  identity.buildCrossGroupInjection.mockReturnValue('[跨群印象] 他在别的群爱聊显卡');
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.META_INJECT_LEARNED_ENABLED = true;
  envMock.EXPRESSION_INJECT_ENABLED = true;
  envMock.GROUP_NORMS_ENABLED = true;
  envMock.PERSON_IDENTITY_ENABLED = true;
  seedAll();
});

describe('buildLearnedContext', () => {
  it('① 总闸关 → 空，且一个读侧都没碰', async () => {
    envMock.META_INJECT_LEARNED_ENABLED = false;
    const r = await buildLearnedContext({ chatId: GROUP, targetUserId: 5 });
    expect(r.block).toBe('');
    expect(r.parts).toEqual([]);
    expect(expr.getTopExpressions).not.toHaveBeenCalled();
    expect(dialect.getExemplars).not.toHaveBeenCalled();
    expect(norms.buildNormsBlock).not.toHaveBeenCalled();
    expect(selfModel.getActiveSelfNotes).not.toHaveBeenCalled();
    expect(identity.buildCrossGroupInjection).not.toHaveBeenCalled();
  });

  it('② 群聊 + 总闸开 → 五块都在，内容来自各自的读侧', async () => {
    const r = await buildLearnedContext({ chatId: GROUP, targetUserId: 5 });
    expect(r.parts).toEqual(['expressions', 'exemplars', 'norms', 'selfNotes', 'crossGroup']);
    expect(r.block).toContain('「草，真的假的」');
    expect(r.block).toContain('「笑死」');
    expect(r.block).toContain('[群氛围]');
    expect(r.block).toContain('别连发三条');
    expect(r.block).toContain('他在别的群爱聊显卡');
    expect(r.expressionIds).toEqual([7, 9]);
    expect(reinforce).toHaveBeenCalledWith([7, 9]);
    expect(identity.buildCrossGroupInjection).toHaveBeenCalledWith(5, GROUP);
    expect(selfModel.getActiveSelfNotes).toHaveBeenCalledWith(5, undefined, GROUP);
  });

  it('③ DM：群味/方言/norms 不取（它们只对群有意义），自我提醒与跨群身份照常', async () => {
    const r = await buildLearnedContext({ chatId: DM, targetUserId: DM });
    expect(r.parts).toEqual(['selfNotes', 'crossGroup']);
    expect(expr.getTopExpressions).not.toHaveBeenCalled();
    expect(dialect.getExemplars).not.toHaveBeenCalled();
    expect(norms.buildNormsBlock).not.toHaveBeenCalled();
    expect(selfModel.getActiveSelfNotes).toHaveBeenCalledWith(5, undefined, DM);
  });

  it('④ 各块仍受自己原有开关约束（总闸只是总闸）', async () => {
    envMock.EXPRESSION_INJECT_ENABLED = false;
    envMock.GROUP_NORMS_ENABLED = false;
    envMock.PERSON_IDENTITY_ENABLED = false;
    const r = await buildLearnedContext({ chatId: GROUP, targetUserId: 5 });
    expect(r.parts).toEqual(['exemplars', 'selfNotes']);
    expect(expr.getTopExpressions).not.toHaveBeenCalled();
    expect(norms.buildNormsBlock).not.toHaveBeenCalled();
    expect(identity.buildCrossGroupInjection).not.toHaveBeenCalled();
  });

  it('⑤ 没有 targetUserId → 不查跨群身份', async () => {
    const r = await buildLearnedContext({ chatId: GROUP });
    expect(r.parts).not.toContain('crossGroup');
    expect(identity.buildCrossGroupInjection).not.toHaveBeenCalled();
  });

  it('⑥ 一块抛 → 只丢这一块，其余照常（fail-soft）', async () => {
    dialect.getExemplars.mockImplementation(() => { throw new Error('boom'); });
    norms.buildNormsBlock.mockImplementation(() => { throw new Error('boom'); });
    const r = await buildLearnedContext({ chatId: GROUP, targetUserId: 5 });
    expect(r.parts).toEqual(['expressions', 'selfNotes', 'crossGroup']);
  });

  it('⑦ 全都读不到东西 → 空串（不产出只有标题的空壳）', async () => {
    expr.getTopExpressions.mockReturnValue([]);
    dialect.getExemplars.mockReturnValue([]);
    norms.buildNormsBlock.mockReturnValue('');
    selfModel.getActiveSelfNotes.mockReturnValue([]);
    identity.buildCrossGroupInjection.mockReturnValue(null);
    const r = await buildLearnedContext({ chatId: GROUP, targetUserId: 5 });
    expect(r.block).toBe('');
    expect(r.parts).toEqual([]);
  });
});

describe('接线：这个函数真的在生产路径上被调用', () => {
  it('prompt-inputs 调用 buildLearnedContext 并把结果放进 learnedBlock', () => {
    const src = readFileSync('src/subagent/prompt-inputs.ts', 'utf8');
    expect(src).toContain("import('./learned-context.js')");
    expect(src).toMatch(/learnedBlock:\s*learned/);
  });

  it('executor 把 learnedBlock 作为 ephemeral 段传进 engine.assemble', () => {
    const src = readFileSync('src/subagent/executor.ts', 'utf8');
    expect(src).toMatch(/ephemeralText\('sub-learned',\s*learnedBlock\)/);
  });
});
