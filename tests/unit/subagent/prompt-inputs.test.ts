/**
 * prompt-inputs.test.ts — CodeAct prompt 准备的并行化回归。
 *
 * 锁死三件事（2026-09-22 段⑤整治，executor 原先 ~20 个串行 await）：
 *  ① **依赖顺序**：getRecent 的结果必须流进 targetBlock / memoryBlock 查询词 /
 *     workspace 查询词。谁把 memoryBlock 提前到 getRecent 之前，这条红。
 *  ② **真并行**：互不依赖的段落必须并发（总耗时 << 串行和）。
 *  ③ **fail-soft 不变**：任何一段抛异常只把自己降级为空串，prompt 照常产出。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';
import type { HostApi } from '../../../src/subagent/host-api.js';

// ── env ────────────────────────────────────────────────────────────────────
const envMock: Record<string, unknown> = {
  BOT_USERNAME: 'hunhebi_bot',
  EXPERIENCE_SHARE_ENABLED: false,
  RECALL_BUDGET_ENABLED: false,
  RECALL_MAX_EXPERIENCE: 3,
  WORLD_STATE_ENABLED: true,
  LOOP_POLICY_ENABLED: true,
  LOOP_POLICY_MAX: 4,
};
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

// ── 被 prompt-inputs 动态 import 的各段（可逐测试换行为） ──────────────────
const dream = {
  readRecentDreamSnippet: vi.fn(async () => 'DIARY'),
  getJournalChannelInfo: vi.fn(async () => ({ link: 'https://t.me/j', chatId: 123 })),
};
vi.mock('../../../src/cron/dream-journal.js', () => ({
  readRecentDreamSnippet: (...a: unknown[]) => dream.readRecentDreamSnippet(...(a as [number])),
  getJournalChannelInfo: () => dream.getJournalChannelInfo(),
}));

const scratch = {
  warmScratchCache: vi.fn(async () => undefined),
  scratchPromptBlockSync: vi.fn(() => 'SCRATCH'),
};
vi.mock('../../../src/tracking/scratchpad.js', () => ({
  warmScratchCache: (...a: unknown[]) => scratch.warmScratchCache(...(a as [number])),
  scratchPromptBlockSync: (...a: unknown[]) => scratch.scratchPromptBlockSync(...(a as [number])),
}));

const chatStyle = {
  getChatStyle: vi.fn(async () => ({})),
  chatStylePromptLine: vi.fn(() => 'STYLE_LINE'),
};
vi.mock('../../../src/tracking/chat-style.js', () => ({
  getChatStyle: () => chatStyle.getChatStyle(),
  chatStylePromptLine: (...a: unknown[]) => chatStyle.chatStylePromptLine(...(a as [unknown])),
}));

vi.mock('../../../src/pipeline/reply/prompt-builder.js', () => ({
  buildCodeActIdentityPrompt: () => 'IDENTITY',
}));
vi.mock('../../../src/shared/master-identity.js', () => ({
  buildMasterIdentityBlock: () => 'MASTER',
}));

// 注意：真实 loadCachedPrompt 是**同步**的（executor 里直接 .slice(0,1600)），
// mock 也必须同步——写成 async 会返回 Promise，.slice 抛异常被 catch 成 ''。
const config = {
  loadCachedPrompt: vi.fn((name: string) => (name === 'knowledge/permanent.md' ? 'PERM' : '')),
};
vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: (...a: unknown[]) => config.loadCachedPrompt(...(a as [string])),
}));

const memberCache = {
  getCachedRoster: vi.fn(() => 'ROSTER_CACHED'),
  setCachedRoster: vi.fn(),
};
vi.mock('../../../src/pipeline/reply/member-cache.js', () => ({
  getCachedRoster: (...a: unknown[]) => memberCache.getCachedRoster(...(a as [number])),
  setCachedRoster: (...a: unknown[]) => memberCache.setCachedRoster(...(a as [number, string])),
}));

const ctxManager = {
  getRecent: vi.fn(async () => [] as unknown[]),
  getGroupMembers: vi.fn(async () => [] as unknown[]),
};
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: (...a: unknown[]) => ctxManager.getRecent(...(a as [number, number])),
  getGroupMembers: (...a: unknown[]) => ctxManager.getGroupMembers(...(a as [number])),
}));

const selfState = { composeSelfState: vi.fn(async () => ({ narration: 'SELF_STATE' })) };
vi.mock('../../../src/pipeline/heart/self-state.js', () => ({
  composeSelfState: (...a: unknown[]) => selfState.composeSelfState(...(a as [number])),
}));

const episodes = {
  findRelevantExperience: vi.fn(() => [{ id: 11, kind: 'lesson', content: 'exp-content' }] as unknown[]),
};
vi.mock('../../../src/agent/episodes.js', () => ({
  findRelevantExperience: (...a: unknown[]) => episodes.findRelevantExperience(...(a as [string, number])),
}));
vi.mock('../../../src/agent/recall-budget.js', () => ({
  applyRecallBudget: (hints: unknown[]) => hints,
}));

const skills = {
  findRelevantSkills: vi.fn(() => [
    { id: 22, name: 'sk-name', summary: 'sk-sum', triggerWhen: 'sk-trig', steps: 'sk-steps', pitfalls: '' },
  ] as unknown[]),
};
vi.mock('../../../src/agent/skills.js', () => ({
  findRelevantSkills: (...a: unknown[]) => skills.findRelevantSkills(...(a as [string, number])),
}));

const worldState = { buildWorldStateBlock: vi.fn(() => 'WORLD_BLOCK') };
vi.mock('../../../src/agent/world-state.js', () => ({
  buildWorldStateBlock: (...a: unknown[]) => worldState.buildWorldStateBlock(...(a as [string, number])),
}));

const loopPolicy = {
  listActivePolicies: vi.fn(() => [{ id: 33, rule: 'pol-rule' }] as unknown[]),
};
vi.mock('../../../src/agent/loop-policy.js', () => ({
  listActivePolicies: (...a: unknown[]) => loopPolicy.listActivePolicies(...(a as [number])),
}));

const grounding = { takeGroundingBlock: vi.fn(async () => 'GROUND_BLOCK') };
vi.mock('../../../src/meta/grounding.js', () => ({
  takeGroundingBlock: (...a: unknown[]) => grounding.takeGroundingBlock(...(a as [unknown])),
}));

const relationship = {
  getRelationship: vi.fn(() => ({ bucket: 'close', affinity: 5, count: 9 })),
  relationshipPromptHint: vi.fn(() => 'REL_HINT'),
  newcomerPromptHint: vi.fn(() => 'REL_NEW'),
};
vi.mock('../../../src/tracking/relationship.js', () => ({
  getRelationship: (...a: unknown[]) => relationship.getRelationship(...(a as [number, number])),
  relationshipPromptHint: (...a: unknown[]) => relationship.relationshipPromptHint(...(a as [unknown])),
  newcomerPromptHint: (...a: unknown[]) => relationship.newcomerPromptHint(...(a as [unknown])),
}));

const botCmds = {
  listReplyInvocableCommands: vi.fn(() => [
    { command: '/spam', bot: 'nmnmfunbot', usageSyntax: '' },
  ] as unknown[]),
};
vi.mock('../../../src/learners/bot-command-store.js', () => ({
  listReplyInvocableCommands: () => botCmds.listReplyInvocableCommands(),
}));

const memoryCtx = {
  calls: [] as Array<{ query: string; excludeMessageIds?: ReadonlySet<number> }>,
  buildSubagentMemoryBlock: vi.fn(async (input: { query: string; excludeMessageIds?: ReadonlySet<number> }) => {
    memoryCtx.calls.push(input);
    return 'MEM_BLOCK';
  }),
};
vi.mock('../../../src/subagent/memory-context.js', () => ({
  buildSubagentMemoryBlock: (...a: unknown[]) => memoryCtx.buildSubagentMemoryBlock(...(a as [never])) as never,
}));

const workspaceCalls: Array<{ queryText: string }> = [];
const cognitiveWorkspace = {
  buildCognitiveWorkspace: vi.fn(async (input: { queryText: string }) => {
    workspaceCalls.push(input);
    return {} as never;
  }),
  renderCognitiveWorkspace: vi.fn(() => 'WS_BLOCK'),
};
vi.mock('../../../src/agent/cognitive-workspace.js', () => ({
  buildCognitiveWorkspace: (...a: unknown[]) => cognitiveWorkspace.buildCognitiveWorkspace(...(a as [never])) as never,
  renderCognitiveWorkspace: (...a: unknown[]) => cognitiveWorkspace.renderCognitiveWorkspace(...(a as [never])),
}));

vi.mock('../../../src/meta/reply-context.js', () => ({
  isShortFollowUpText: () => false,
  isBarePingText: () => false,
}));

// 静态 import 的两个依赖也要 mock（sandbox-prompt 用恒等，避免引入真终端能力）
vi.mock('../../../src/sandbox/terminal.js', () => ({ getSandboxCapability: () => ({ terminalAvailable: true }) }));
vi.mock('../../../src/subagent/sandbox-prompt.js', () => ({ applySandboxAvailabilityNotes: (s: string) => s }));

const { collectPromptInputs } = await import('../../../src/subagent/prompt-inputs.js');

// ── fixtures ───────────────────────────────────────────────────────────────
const EXECUTOR_BASE = 'EXECUTOR_BASE（当前 = /spam@nmnmfunbot，回复那条广告发出去）TAIL';

function makeTask(over: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id: 'task-1',
    chatId: -100,
    targetUserId: 555,
    contentDirection: 'greet the user',
    ...over,
  } as unknown as DispatchTask;
}

function makeHost(): HostApi {
  return { memory: { recentContext: vi.fn(async () => 'RECENT_CTX') } } as unknown as HostApi;
}

/** 带锚点的 getRecent 返回值：999 是本条，1000/1001 是上下文。 */
function recentWithAnchor() {
  return ctxManager.getRecent.mockResolvedValue([
    { messageId: 1000, role: 'user', username: 'a', fullName: 'A', textContent: '别的消息', timestamp: 1 },
    { messageId: 999, role: 'user', username: 'u', fullName: 'U', textContent: '锚点正文', timestamp: 2 },
    { messageId: 1001, role: 'assistant', username: '', fullName: 'bot', textContent: '机器人说的', timestamp: 3 },
  ] as never);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.clearAllMocks();
  memoryCtx.calls.length = 0;
  workspaceCalls.length = 0;
  envMock.RECALL_BUDGET_ENABLED = false;
  // 复位各 mock 的默认行为（clearAllMocks 会清实现，逐个补回）
  dream.readRecentDreamSnippet.mockResolvedValue('DIARY');
  dream.getJournalChannelInfo.mockResolvedValue({ link: 'https://t.me/j', chatId: 123 });
  scratch.warmScratchCache.mockResolvedValue(undefined);
  scratch.scratchPromptBlockSync.mockReturnValue('SCRATCH');
  chatStyle.getChatStyle.mockResolvedValue({});
  chatStyle.chatStylePromptLine.mockReturnValue('STYLE_LINE');
  config.loadCachedPrompt.mockImplementation((name: string) => (name === 'knowledge/permanent.md' ? 'PERM' : ''));
  ctxManager.getRecent.mockResolvedValue([] as never);
  ctxManager.getGroupMembers.mockResolvedValue([] as never);
  memberCache.getCachedRoster.mockReturnValue('ROSTER_CACHED');
  memberCache.setCachedRoster.mockReturnValue(undefined);
  selfState.composeSelfState.mockResolvedValue({ narration: 'SELF_STATE' });
  episodes.findRelevantExperience.mockReturnValue([{ id: 11, kind: 'lesson', content: 'exp-content' }] as never);
  skills.findRelevantSkills.mockReturnValue([
    { id: 22, name: 'sk-name', summary: 'sk-sum', triggerWhen: 'sk-trig', steps: 'sk-steps', pitfalls: '' },
  ] as never);
  loopPolicy.listActivePolicies.mockReturnValue([{ id: 33, rule: 'pol-rule' }] as never);
  worldState.buildWorldStateBlock.mockReturnValue('WORLD_BLOCK');
  grounding.takeGroundingBlock.mockResolvedValue('GROUND_BLOCK');
  relationship.getRelationship.mockReturnValue({ bucket: 'close', affinity: 5, count: 9 });
  relationship.relationshipPromptHint.mockReturnValue('REL_HINT');
  relationship.newcomerPromptHint.mockReturnValue('REL_NEW');
  botCmds.listReplyInvocableCommands.mockReturnValue([
    { command: '/spam', bot: 'nmnmfunbot', usageSyntax: '' },
  ] as never);
  memoryCtx.buildSubagentMemoryBlock.mockImplementation(async (input: never) => {
    memoryCtx.calls.push(input);
    return 'MEM_BLOCK';
  });
  cognitiveWorkspace.buildCognitiveWorkspace.mockImplementation(async (input: never) => {
    workspaceCalls.push(input);
    return {} as never;
  });
  cognitiveWorkspace.renderCognitiveWorkspace.mockReturnValue('WS_BLOCK');
});

describe('collectPromptInputs — 各段产物', () => {
  it('全部就绪时产出完整原料', async () => {
    recentWithAnchor();
    const inputs = await collectPromptInputs({
      task: makeTask(),
      host: makeHost(),
      isSelfPlay: false,
      replyAnchor: 999,
      executorSystem: EXECUTOR_BASE,
    });

    expect(inputs.journal).toBe('DIARY');
    expect(inputs.journalChannelLink).toBe('https://t.me/j');
    expect(inputs.journalChatId).toBe(123);
    expect(inputs.scratchBlock).toBe('SCRATCH');
    expect(inputs.chatStyleLine).toBe('STYLE_LINE');
    expect(inputs.identity).toBe('IDENTITY');
    expect(inputs.masterBlock).toBe('MASTER');
    expect(inputs.recentCtx).toBe('RECENT_CTX');
    expect(inputs.permanent).toBe('PERM');
    expect(inputs.roster).toBe('ROSTER_CACHED');
    expect(inputs.selfStateLine).toBe('SELF_STATE');
    expect(inputs.memoryBlock).toBe('MEM_BLOCK');
    expect(inputs.workspaceBlock).toBe('WS_BLOCK');
    expect(inputs.groundingBlock).toBe('GROUND_BLOCK');
    expect(inputs.relationshipBlock).toContain('和对方的关系');
    expect(inputs.relationshipBlock).toContain('REL_HINT');
    expect(inputs.relationshipBlock).toContain('REL_NEW');
    expect(inputs.targetBlock).toContain('锚点正文');
    expect(inputs.anchorText).toBe('锚点正文');

    // 追加顺序与原实现一致：经验 → 技能 → 世界状态 → 循环策略
    const sp = inputs.systemPrompt;
    expect(sp.startsWith('EXECUTOR_BASE')).toBe(true);
    expect(sp).toContain('[过往经验]');
    expect(sp).toContain('exp-content');
    expect(sp).toContain('[可用技能]');
    expect(sp).toContain('sk-name');
    expect(sp).toContain('WORLD_BLOCK');
    expect(sp).toContain('[循环策略]');
    expect(sp).toContain('pol-rule');
    expect(sp.indexOf('[过往经验]')).toBeLessThan(sp.indexOf('[可用技能]'));
    expect(sp.indexOf('[可用技能]')).toBeLessThan(sp.indexOf('WORLD_BLOCK'));
    expect(sp.indexOf('WORLD_BLOCK')).toBeLessThan(sp.indexOf('[循环策略]'));
    // 回复式命令清单替换生效，原写死散文被换掉
    expect(sp).toContain('当前真过得去闸的回复式命令：/spam@nmnmfunbot');
    expect(sp).not.toContain('（当前 = /spam@nmnmfunbot，回复那条广告发出去）');

    expect(inputs.injectedExperienceIds).toEqual([11]);
    expect(inputs.injectedSkillIds).toEqual([22]);
    expect(inputs.injectedPolicyIds).toEqual([33]);
  });

  it('依赖顺序：getRecent 的锚点正文流进 memory/workspace 的查询词（改并行顺序会红）', async () => {
    recentWithAnchor();
    await collectPromptInputs({
      task: makeTask(),
      host: makeHost(),
      isSelfPlay: false,
      replyAnchor: 999,
      executorSystem: EXECUTOR_BASE,
    });

    expect(memoryCtx.calls).toHaveLength(1);
    const memInput = memoryCtx.calls[0]!;
    // 查询词 = 锚点正文 + 任务方向（缺任一都说明依赖被破坏）
    expect(memInput.query).toContain('锚点正文');
    expect(memInput.query).toContain('greet the user');
    // excludeMessageIds = 同一次 getRecent 的全部 id（去重注入）
    expect(memInput.excludeMessageIds).toBeInstanceOf(Set);
    expect([...memInput.excludeMessageIds!].sort((a, b) => a - b)).toEqual([999, 1000, 1001]);

    expect(workspaceCalls).toHaveLength(1);
    expect(workspaceCalls[0]!.queryText).toContain('锚点正文');
  });

  it('grounding 单次 take：带锚点调用，块原样带回', async () => {
    await collectPromptInputs({
      task: makeTask(),
      host: makeHost(),
      isSelfPlay: false,
      replyAnchor: 999,
      executorSystem: EXECUTOR_BASE,
    });
    expect(grounding.takeGroundingBlock).toHaveBeenCalledWith({ chatId: -100, messageId: 999, taskId: 'task-1' });
  });

  it('grounding 拿不到（空串）也正常走', async () => {
    grounding.takeGroundingBlock.mockResolvedValue('');
    const inputs = await collectPromptInputs({
      task: makeTask(),
      host: makeHost(),
      isSelfPlay: false,
      replyAnchor: 999,
      executorSystem: EXECUTOR_BASE,
    });
    expect(inputs.groundingBlock).toBe('');
    expect(inputs.systemPrompt).toContain('EXECUTOR_BASE');
  });
});

describe('collectPromptInputs — 真并行', () => {
  it('互不依赖的段落并发执行（总耗时应≈最慢一段，而非各段之和）', async () => {
    const D = 50;
    dream.readRecentDreamSnippet.mockImplementation(async () => { await delay(D); return 'DIARY'; });
    scratch.warmScratchCache.mockImplementation(async () => { await delay(D); });
    chatStyle.getChatStyle.mockImplementation(async () => { await delay(D); return {}; });
    selfState.composeSelfState.mockImplementation(async () => { await delay(D); return { narration: 'S' }; });
    episodes.findRelevantExperience.mockImplementation(() => { return [{ id: 1, kind: 'k', content: 'c' }] as never; });
    relationship.getRelationship.mockImplementation(() => ({ bucket: 'b', affinity: 1, count: 1 }));
    ctxManager.getRecent.mockImplementation(async () => { await delay(D); return [] as never; });
    memoryCtx.buildSubagentMemoryBlock.mockImplementation(async () => { await delay(D); return 'MEM_BLOCK'; });
    cognitiveWorkspace.buildCognitiveWorkspace.mockImplementation(async () => { await delay(D); return {} as never; });

    const t0 = Date.now();
    await collectPromptInputs({
      task: makeTask(),
      host: makeHost(),
      isSelfPlay: false,
      replyAnchor: 999,
      executorSystem: EXECUTOR_BASE,
    });
    const elapsed = Date.now() - t0;
    // 串行会 ≥ 8×50ms；并行应 ≈ 2×50ms（第一阶段 + 第二阶段）
    expect(elapsed).toBeLessThan(200);
  });
});

describe('collectPromptInputs — fail-soft（异常只降级自己）', () => {
  const cases: Array<[string, () => void, (i: Record<string, unknown>) => void]> = [
    ['getRecent 抛', () => ctxManager.getRecent.mockRejectedValue(new Error('redis down')), (i) => {
      expect(i.targetBlock).toContain('messageId=#999');
      expect(i.anchorText).toBe('');
    }],
    ['memory block 抛', () => memoryCtx.buildSubagentMemoryBlock.mockRejectedValue(new Error('qdrant down')), (i) => {
      expect(i.memoryBlock).toBe('');
    }],
    ['self-state 抛', () => selfState.composeSelfState.mockRejectedValue(new Error('db down')), (i) => {
      expect(i.selfStateLine).toBe('');
    }],
    ['experience 抛', () => episodes.findRelevantExperience.mockImplementation(() => { throw new Error('boom'); }), (i) => {
      expect(i.injectedExperienceIds).toEqual([]);
      expect(i.systemPrompt).not.toContain('[过往经验]');
    }],
    ['skills 抛', () => skills.findRelevantSkills.mockImplementation(() => { throw new Error('boom'); }), (i) => {
      expect(i.injectedSkillIds).toEqual([]);
      expect(i.systemPrompt).not.toContain('[可用技能]');
    }],
    ['loop policies 抛', () => loopPolicy.listActivePolicies.mockImplementation(() => { throw new Error('boom'); }), (i) => {
      expect(i.injectedPolicyIds).toEqual([]);
      expect(i.systemPrompt).not.toContain('[循环策略]');
    }],
    ['grounding 抛', () => grounding.takeGroundingBlock.mockRejectedValue(new Error('redis down')), (i) => {
      expect(i.groundingBlock).toBe('');
    }],
    ['relationship 抛', () => relationship.getRelationship.mockImplementation(() => { throw new Error('boom'); }), (i) => {
      expect(i.relationshipBlock).toBe('');
    }],
    ['chat-style 抛', () => chatStyle.getChatStyle.mockRejectedValue(new Error('boom')), (i) => {
      expect(i.chatStyleLine).toBe('');
    }],
    ['journal 抛', () => dream.readRecentDreamSnippet.mockRejectedValue(new Error('io down')), (i) => {
      expect(i.journal).toBe('');
    }],
    ['roster 抛（缓存脱靶后取成员表失败）', () => {
      memberCache.getCachedRoster.mockReturnValue('');
      ctxManager.getGroupMembers.mockRejectedValue(new Error('db down'));
    }, (i) => {
      expect(i.roster).toBe('');
    }],
    ['workspace 抛', () => cognitiveWorkspace.buildCognitiveWorkspace.mockRejectedValue(new Error('boom')), (i) => {
      expect(i.workspaceBlock).toBe('');
    }],
    ['命令清单读不到 → 保留原句（与旧 catch 语义一致）', () => botCmds.listReplyInvocableCommands.mockImplementation(() => { throw new Error('boom'); }), (i) => {
      expect(i.systemPrompt).toContain('（当前 = /spam@nmnmfunbot，回复那条广告发出去）');
    }],
  ];

  for (const [name, breakIt, assert] of cases) {
    it(`${name} → 其余段落照常`, async () => {
      recentWithAnchor();
      breakIt();
      const inputs = await collectPromptInputs({
        task: makeTask(),
        host: makeHost(),
        isSelfPlay: false,
        replyAnchor: 999,
        executorSystem: EXECUTOR_BASE,
      });
      assert(inputs as unknown as Record<string, unknown>);
      // 无论哪段挂掉，prompt 主体必须还在
      expect(inputs.systemPrompt).toContain('EXECUTOR_BASE');
    });
  }

  it('全部同时抛 → 仍能给出最小可用 prompt', async () => {
    dream.readRecentDreamSnippet.mockRejectedValue(new Error('x'));
    dream.getJournalChannelInfo.mockRejectedValue(new Error('x'));
    scratch.warmScratchCache.mockRejectedValue(new Error('x'));
    chatStyle.getChatStyle.mockRejectedValue(new Error('x'));
    selfState.composeSelfState.mockRejectedValue(new Error('x'));
    episodes.findRelevantExperience.mockImplementation(() => { throw new Error('x'); });
    skills.findRelevantSkills.mockImplementation(() => { throw new Error('x'); });
    loopPolicy.listActivePolicies.mockImplementation(() => { throw new Error('x'); });
    worldState.buildWorldStateBlock.mockImplementation(() => { throw new Error('x'); });
    grounding.takeGroundingBlock.mockRejectedValue(new Error('x'));
    relationship.getRelationship.mockImplementation(() => { throw new Error('x'); });
    botCmds.listReplyInvocableCommands.mockImplementation(() => { throw new Error('x'); });
    ctxManager.getRecent.mockRejectedValue(new Error('x'));
    memoryCtx.buildSubagentMemoryBlock.mockRejectedValue(new Error('x'));
    cognitiveWorkspace.buildCognitiveWorkspace.mockRejectedValue(new Error('x'));

    const inputs = await collectPromptInputs({
      task: makeTask(),
      host: makeHost(),
      isSelfPlay: false,
      replyAnchor: 999,
      executorSystem: EXECUTOR_BASE,
    });
    expect(inputs.systemPrompt).toBe('EXECUTOR_BASE（当前 = /spam@nmnmfunbot，回复那条广告发出去）TAIL');
    expect(inputs.targetBlock).toContain('messageId=#999');
    expect(inputs.memoryBlock).toBe('');
  });
});

describe('collectPromptInputs — 条件分支', () => {
  it('self-play → systemPrompt 整体换成 self-play.md（经验等仍追加在后）', async () => {
    config.loadCachedPrompt.mockImplementation((name: string) =>
      name === 'task/self-play.md' ? 'SELFPLAY_PROMPT' : name === 'knowledge/permanent.md' ? 'PERM' : '');
    const inputs = await collectPromptInputs({
      task: makeTask({ contentDirection: '[selfplay] 练习' }),
      host: makeHost(),
      isSelfPlay: true,
      replyAnchor: undefined,
      executorSystem: EXECUTOR_BASE,
    });
    expect(inputs.systemPrompt.startsWith('SELFPLAY_PROMPT')).toBe(true);
    expect(inputs.systemPrompt).not.toContain('EXECUTOR_BASE');
    expect(inputs.systemPrompt).toContain('[过往经验]');
  });

  it('命令清单为空 → 删掉写死括号，不留不存在命令', async () => {
    botCmds.listReplyInvocableCommands.mockReturnValue([] as never);
    const inputs = await collectPromptInputs({
      task: makeTask(),
      host: makeHost(),
      isSelfPlay: false,
      replyAnchor: 999,
      executorSystem: EXECUTOR_BASE,
    });
    expect(inputs.systemPrompt).not.toContain('（当前 =');
    expect(inputs.systemPrompt).not.toContain('回复式命令');
  });

  it('无锚点 → 不查 getRecent，targetBlock 空，查询词只剩任务方向', async () => {
    const inputs = await collectPromptInputs({
      task: makeTask(),
      host: makeHost(),
      isSelfPlay: false,
      replyAnchor: undefined,
      executorSystem: EXECUTOR_BASE,
    });
    expect(ctxManager.getRecent).not.toHaveBeenCalled();
    expect(inputs.targetBlock).toBe('');
    expect(memoryCtx.calls[0]!.query).toBe('greet the user');
    expect(workspaceCalls[0]!.queryText).toBe('greet the user');
    // 无锚点不取 grounding
    expect(grounding.takeGroundingBlock).toHaveBeenCalledWith({ chatId: -100, messageId: undefined, taskId: 'task-1' });
  });

  it('DM：不取群风格、不取 roster', async () => {
    const inputs = await collectPromptInputs({
      task: makeTask({ chatId: 6251541967 }),
      host: makeHost(),
      isSelfPlay: false,
      replyAnchor: undefined,
      executorSystem: EXECUTOR_BASE,
    });
    expect(chatStyle.getChatStyle).not.toHaveBeenCalled();
    expect(inputs.chatStyleLine).toBe('');
    expect(ctxManager.getGroupMembers).not.toHaveBeenCalled();
    expect(inputs.roster).toBe('');
  });

  it('relationship 段落：无 targetUserId 时跳过', async () => {
    const inputs = await collectPromptInputs({
      task: makeTask({ targetUserId: undefined as unknown as number }),
      host: makeHost(),
      isSelfPlay: false,
      replyAnchor: 999,
      executorSystem: EXECUTOR_BASE,
    });
    expect(relationship.getRelationship).not.toHaveBeenCalled();
    expect(inputs.relationshipBlock).toBe('');
  });

  it('recentContext 抛 → 空串，不冒泡', async () => {
    const host = { memory: { recentContext: vi.fn(async () => { throw new Error('redis down'); }) } } as unknown as HostApi;
    const inputs = await collectPromptInputs({
      task: makeTask(),
      host,
      isSelfPlay: false,
      replyAnchor: 999,
      executorSystem: EXECUTOR_BASE,
    });
    expect(inputs.recentCtx).toBe('');
  });
});
