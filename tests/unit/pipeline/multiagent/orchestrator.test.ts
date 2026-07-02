import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/pipeline/reply/reply.js', () => ({ generateReply: vi.fn() }));
vi.mock('../../../../src/pipeline/multiagent/researcher.js', () => ({ runResearcher: vi.fn() }));
vi.mock('../../../../src/pipeline/multiagent/memory-specialist.js', () => ({ runMemorySpecialist: vi.fn() }));
vi.mock('../../../../src/pipeline/multiagent/persona-specialist.js', () => ({ runPersonaSpecialist: vi.fn() }));
vi.mock('../../../../src/pipeline/multiagent/director.js', () => ({ runDirector: vi.fn() }));
vi.mock('../../../../src/pipeline/multiagent/context-digest.js', () => ({ runContextDigest: vi.fn() }));
vi.mock('../../../../src/pipeline/multiagent/fact-checker.js', () => ({ runFactChecker: vi.fn() }));
vi.mock('../../../../src/pipeline/multiagent/critic.js', () => ({ runCritic: vi.fn() }));
vi.mock('../../../../src/pipeline/multiagent/persona-critic.js', () => ({ runPersonaCritic: vi.fn() }));
vi.mock('../../../../src/pipeline/multiagent/draft-selector.js', () => ({ selectBestDraft: vi.fn() }));
vi.mock('../../../../src/knowledge/manager.js', () => ({ searchKnowledge: vi.fn(() => null) }));
vi.mock('../../../../src/env.js', () => ({ env: vi.fn() }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/shared/abort.js', () => ({ isCallerAbort: vi.fn(() => false) }));

import { runMultiAgentReply } from '../../../../src/pipeline/multiagent/orchestrator.js';
import { generateReply } from '../../../../src/pipeline/reply/reply.js';
import { runResearcher } from '../../../../src/pipeline/multiagent/researcher.js';
import { runMemorySpecialist } from '../../../../src/pipeline/multiagent/memory-specialist.js';
import { runPersonaSpecialist } from '../../../../src/pipeline/multiagent/persona-specialist.js';
import { runDirector } from '../../../../src/pipeline/multiagent/director.js';
import { runContextDigest } from '../../../../src/pipeline/multiagent/context-digest.js';
import { runFactChecker } from '../../../../src/pipeline/multiagent/fact-checker.js';
import { runCritic } from '../../../../src/pipeline/multiagent/critic.js';
import { runPersonaCritic } from '../../../../src/pipeline/multiagent/persona-critic.js';
import { selectBestDraft } from '../../../../src/pipeline/multiagent/draft-selector.js';
import { isCallerAbort } from '../../../../src/shared/abort.js';
import { env } from '../../../../src/env.js';

type ReplyResult = Awaited<ReturnType<typeof generateReply>>;
const fakeResult = (overrides: Partial<ReplyResult> = {}): ReplyResult => ({
  replies: [{ replyContent: 'hi', targetMessageId: 1 }],
  toolsUsed: [],
  toolExecutionFailed: false,
  ...overrides,
});

interface EnvOpts {
  memory?: boolean;
  persona?: boolean;
  chatSpecialists?: boolean;
  checker?: boolean;
  critic?: boolean;
  criticOnLookup?: boolean;
  criticMaxRounds?: number;
  // 新工种:测试默认关, dedicated 测试里单独开
  director?: boolean;
  contextDigest?: boolean;
  personaCritic?: boolean;
  bestOfN?: number;
  selectorEnabled?: boolean;
}
const setEnv = (o: EnvOpts = {}): void => {
  (env as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    MULTI_AGENT_MEMORY_ENABLED: o.memory ?? true,
    MULTI_AGENT_PERSONA_ENABLED: o.persona ?? true,
    MULTI_AGENT_CHAT_SPECIALISTS: o.chatSpecialists ?? true,
    MULTI_AGENT_CHECKER_ENABLED: o.checker ?? true,
    MULTI_AGENT_CRITIC_ENABLED: o.critic ?? true,
    MULTI_AGENT_CRITIC_ON_LOOKUP: o.criticOnLookup ?? false,
    MULTI_AGENT_CRITIC_MAX_ROUNDS: o.criticMaxRounds ?? 2,
    MULTI_AGENT_DIRECTOR_ENABLED: o.director ?? false,
    MULTI_AGENT_CONTEXT_DIGEST_ENABLED: o.contextDigest ?? false,
    MULTI_AGENT_CONTEXT_DIGEST_MIN_MSGS: 999,
    MULTI_AGENT_PERSONA_CRITIC_ENABLED: o.personaCritic ?? false,
    MULTI_AGENT_PERSONA_CRITIC_TIMEOUT_MS: 6000,
    MULTI_AGENT_DIRECTOR_TIMEOUT_MS: 5000,
    MULTI_AGENT_CONTEXT_DIGEST_TIMEOUT_MS: 8000,
    WRITER_BEST_OF_N: o.bestOfN ?? 1,
    WRITER_SELECTOR_ENABLED: o.selectorEnabled ?? true,
    WRITER_SELECTOR_TIMEOUT_MS: 6000,
  });
};

const baseInput = (
  replyPath: 'direct' | 'planned' | undefined,
  replyTier: 'normal' | 'pro' | 'max' = 'normal',
) => ({
  message: { textContent: '查下今天天气', captionContent: '', messageId: 1, uid: 100 } as never,
  retrievedContext: { contextStr: 'CTX', merged: [] } as never,
  action: 'REPLY' as never,
  chatId: -100,
  botUid: 9,
  replyPath,
  replyTier,
  segmenterConfig: undefined,
  turnCallOpts: { signal: undefined } as never,
});

const writerOpts = (callIdx = 0): { prebuiltToolResults?: string; memoryFindings?: string; directorHint?: string; contextDigest?: string; toolDecisionHandled?: boolean } =>
  (generateReply as unknown as ReturnType<typeof vi.fn>).mock.calls[callIdx]![8] as {
    prebuiltToolResults?: string;
    memoryFindings?: string;
    directorHint?: string;
    contextDigest?: string;
    toolDecisionHandled?: boolean;
  };

const researcherOk = (block = '[TOOL_RESULTS]\nresearch') => ({ failed: false, toolResultsBlock: block, toolsUsed: ['SEARCH'], steps: 2 });
const memoryOk = (block = '[TOOL_RESULTS]\nrecall') => ({ failed: false, toolResultsBlock: block, toolsUsed: ['RECALL'], steps: 1 });
const personaOk = (block = '[TOOL_RESULTS]\npersona') => ({ failed: false, toolResultsBlock: block, toolsUsed: ['QUERY_PERSON_PROFILE'], steps: 1 });

beforeEach(() => {
  vi.clearAllMocks();
  setEnv();
  (isCallerAbort as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (generateReply as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve(fakeResult()));
  (runPersonaCritic as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ needsRewrite: false });
  (selectBestDraft as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0);
});

describe('runMultiAgentReply (Phase 2-5 + Best-of-N + 人设Critic)', () => {
  it('chat + CHAT_SPECIALISTS 开:跑记忆员+人设员,不跑研究员/核查/Critic', async () => {
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk('MEM'));
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk('PER'));
    await runMultiAgentReply(baseInput('direct'));
    expect(runResearcher).not.toHaveBeenCalled();
    expect(runMemorySpecialist).toHaveBeenCalledTimes(1);
    expect(runPersonaSpecialist).toHaveBeenCalledTimes(1);
    expect(runFactChecker).not.toHaveBeenCalled();
    expect(runCritic).not.toHaveBeenCalled();
    expect(writerOpts().memoryFindings).toContain('MEM');
    expect(writerOpts().toolDecisionHandled).toBe(false);
  });

  it('chat + CHAT_SPECIALISTS 关:不调任何专家', async () => {
    setEnv({ chatSpecialists: false });
    await runMultiAgentReply(baseInput('direct'));
    expect(runResearcher).not.toHaveBeenCalled();
    expect(runMemorySpecialist).not.toHaveBeenCalled();
    expect(writerOpts().memoryFindings).toBeUndefined();
  });

  it('lookup:研究员+记忆员+人设员并行 + 核查员跑;Critic 默认不跑', async () => {
    (runResearcher as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(researcherOk());
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    (runFactChecker as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await runMultiAgentReply(baseInput('planned'));
    expect(runResearcher).toHaveBeenCalledTimes(1);
    expect(runFactChecker).toHaveBeenCalledTimes(1);
    expect(runCritic).not.toHaveBeenCalled();
    expect(writerOpts().toolDecisionHandled).toBe(true);
  });

  it('deep:研究员+记忆员+人设员+核查+Critic 全跑', async () => {
    (runResearcher as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(researcherOk('RES'));
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk('MEM'));
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk('PER'));
    (runFactChecker as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('[核查员]\n第2条可疑');
    (runCritic as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ needsRewrite: false });
    await runMultiAgentReply(baseInput('direct', 'max'));
    expect(runFactChecker).toHaveBeenCalledTimes(1);
    expect(runCritic).toHaveBeenCalledTimes(1);
    expect(writerOpts().prebuiltToolResults).toContain('[核查员]');
  });

  it('导演专家开:有念头时跑(M6 门控),产出注入 directorHint', async () => {
    setEnv({ director: true });
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    (runDirector as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('[导演定调] 拆台语气');
    // M6:chat 路径需 heartWhy / 上下文够长 / lookup 之一才跑导演 → 给 heartWhy
    const input = { ...baseInput('direct'), turnCallOpts: { signal: undefined, heartWhy: '想吐槽他' } as never };
    await runMultiAgentReply(input);
    expect(runDirector).toHaveBeenCalledTimes(1);
    expect(writerOpts().directorHint).toContain('拆台');
  });

  it('M6:导演门控 — chat 路径无念头 + 短上下文 → 不跑导演(省延迟)', async () => {
    setEnv({ director: true });
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    await runMultiAgentReply(baseInput('direct')); // merged=[], 无 heartWhy, 非 lookup
    expect(runDirector).not.toHaveBeenCalled();
  });

  it('Best-of-N=2:写手调 2 次,选择器挑一稿', async () => {
    setEnv({ bestOfN: 2 });
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    (generateReply as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(fakeResult({ replies: [{ replyContent: '稿A', targetMessageId: 1 }] }))
      .mockResolvedValueOnce(fakeResult({ replies: [{ replyContent: '稿B', targetMessageId: 1 }] }));
    (selectBestDraft as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const out = await runMultiAgentReply(baseInput('direct'));
    expect(generateReply).toHaveBeenCalledTimes(2);
    expect(selectBestDraft).toHaveBeenCalledTimes(1);
    expect(out.replies[0]!.replyContent).toBe('稿B');
  });

  it('Best-of-N=2 + 全挂 + turn 打断 → 上抛', async () => {
    setEnv({ bestOfN: 2 });
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    (generateReply as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('aborted'));
    (isCallerAbort as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await expect(runMultiAgentReply(baseInput('direct'))).rejects.toThrow('aborted');
  });

  it('Best-of-N=2 + 一稿空一稿有内容 → 选有内容的(空稿不参与选择,H1)', async () => {
    setEnv({ bestOfN: 2 });
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    (generateReply as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(fakeResult({ replies: [{ replyContent: '', targetMessageId: 1 }] })) // 空稿
      .mockResolvedValueOnce(fakeResult({ replies: [{ replyContent: '有内容', targetMessageId: 1 }] }));
    (selectBestDraft as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0); // 选择器在候选(只有1个)里挑
    const out = await runMultiAgentReply(baseInput('direct'));
    expect(out.replies[0]!.replyContent).toBe('有内容'); // 不会被空稿挤掉
  });

  it('M2:lookup + 研究员失败 + bestOfN=2 → 写手单稿(避免重复搜索)', async () => {
    setEnv({ bestOfN: 2 });
    (runResearcher as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ failed: true, toolResultsBlock: undefined, toolsUsed: [], steps: 0 });
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    (generateReply as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(fakeResult());
    await runMultiAgentReply(baseInput('planned'));
    // writerRunsTools=true(planned+研究员失败)→ best-of-N 降为单稿,写手只调 1 次
    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(selectBestDraft).not.toHaveBeenCalled();
  });

  it('人设Critic 开 + flagged:回炉 1 次,prebuilt 含 [人设反馈]', async () => {
    setEnv({ personaCritic: true });
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    (runPersonaCritic as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ needsRewrite: true, feedback: '把主人叫成妹妹了' });
    await runMultiAgentReply(baseInput('direct'));
    expect(runPersonaCritic).toHaveBeenCalledTimes(1);
    expect(generateReply).toHaveBeenCalledTimes(2); // 初稿 + 回炉
    expect(writerOpts(1).prebuiltToolResults).toContain('[人设反馈]');
    expect(writerOpts(1).prebuiltToolResults).toContain('妹妹');
  });

  it('M1:deep 路径 critic 回炉后人设Critic 又回炉 → prebuilt 同时含 [二审反馈]+[人设反馈]', async () => {
    setEnv({ personaCritic: true, criticMaxRounds: 2 });
    (runResearcher as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(researcherOk('RES'));
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    // critic 第 1 轮:needsRewrite → 回炉;第 2 轮:通过
    (runCritic as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ needsRewrite: true, feedback: '跑题了答天气' })
      .mockResolvedValueOnce({ needsRewrite: false });
    // 人设 critic:needsRewrite → 回炉
    (runPersonaCritic as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ needsRewrite: true, feedback: '把主人叫成妹妹' });
    await runMultiAgentReply(baseInput('direct', 'max'));
    // 初稿 + critic 回炉1次 + 人设回炉1次 = 3 次写手
    expect(generateReply).toHaveBeenCalledTimes(3);
    // 最后一次(人设回炉)的 prebuilt 应同时带两个反馈块(M1:不丢 critic 反馈)
    const lastOpts = writerOpts(2).prebuiltToolResults ?? '';
    expect(lastOpts).toContain('[二审反馈]');
    expect(lastOpts).toContain('跑题了答天气');
    expect(lastOpts).toContain('[人设反馈]');
    expect(lastOpts).toContain('妹妹');
  });

  it('Critic 循环:连续 needsRewrite,回炉到 MAX_ROUNDS=2 后停', async () => {
    setEnv({ criticMaxRounds: 2 });
    (runResearcher as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(researcherOk('RES'));
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    (runCritic as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ needsRewrite: true, feedback: '还是跑题' });
    await runMultiAgentReply(baseInput('direct', 'max'));
    expect(runCritic).toHaveBeenCalledTimes(2); // 两轮都 needsRewrite
    expect(generateReply).toHaveBeenCalledTimes(3); // 初稿 + 2 次回炉
  });

  it('researcher 抛 + turn 打断 → 上抛,不调 writer', async () => {
    (runResearcher as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('aborted'));
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(memoryOk());
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(personaOk());
    (isCallerAbort as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await expect(runMultiAgentReply(baseInput('planned'))).rejects.toThrow('aborted');
    expect(generateReply).not.toHaveBeenCalled();
  });

  it('research 成功 + writer 没自己跑工具 → result.toolsUsed 补专家工具', async () => {
    (runResearcher as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ failed: false, toolResultsBlock: 'X', toolsUsed: ['SEARCH'], steps: 1 });
    (runMemorySpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ failed: false, toolResultsBlock: 'Y', toolsUsed: ['RECALL'], steps: 1 });
    (runPersonaSpecialist as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ failed: false, toolResultsBlock: 'Z', toolsUsed: ['QUERY_PERSON_PROFILE'], steps: 1 });
    (generateReply as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve(fakeResult({ toolsUsed: [] })));
    const out = await runMultiAgentReply(baseInput('planned'));
    expect(out.toolsUsed).toEqual(['SEARCH', 'RECALL', 'QUERY_PERSON_PROFILE']);
  });
});
