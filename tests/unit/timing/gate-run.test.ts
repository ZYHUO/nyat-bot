import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── collaborators ──
const { callWithFallbackMock, checkTalkValueMock, appendHistMock, getHistMock } = vi.hoisted(() => ({
  callWithFallbackMock: vi.fn(async (): Promise<{ content: string }> => ({ content: '{"action":"continue","reason":"ok"}' })),
  checkTalkValueMock: vi.fn(async (): Promise<unknown> => ({ pass: true, threshold: 1, count: 1, equivalent: 1 })),
  appendHistMock: vi.fn(async () => {}),
  getHistMock: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: callWithFallbackMock }));
vi.mock('../../../src/pipeline/timing/talk-value.js', () => ({ checkTalkValueThreshold: checkTalkValueMock }));
vi.mock('../../../src/pipeline/timing/gate-history.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/pipeline/timing/gate-history.js')>();
  return { ...orig, appendGateHistory: appendHistMock, getGateHistory: getHistMock };
});
vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: () => '节奏判断 {bot_name} {bot_persona} {wait_min_sec} {wait_max_sec} {mode_block}',
}));
vi.mock('../../../src/pipeline/context/slim.js', () => ({ slimContextForAI: () => 'ctx' }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// chat-runtime:getChatState / cooldown 可控
const { getChatStateMock, cooldownRemainingMock } = vi.hoisted(() => ({
  getChatStateMock: vi.fn(async (): Promise<unknown> => ({ state: 'RUNNING' })),
  cooldownRemainingMock: vi.fn(async () => 0),
}));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/pipeline/timing/chat-runtime.js')>();
  return {
    ...orig,
    getChatState: getChatStateMock,
    getGateCooldownRemainingMs: cooldownRemainingMock,
  };
});

const envValues: Record<string, unknown> = {};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

import { runTimingGate, type GateInput } from '../../../src/pipeline/timing/gate.js';
import type { FormattedMessage, JudgeResult } from '../../../src/shared/types.js';

function baseEnv(): void {
  for (const k of Object.keys(envValues)) delete envValues[k];
  Object.assign(envValues, {
    TIMING_GATE_ENABLED: true,
    TIMING_GATE_USAGE: 'judge',
    TIMING_GATE_TIMEOUT_MS: 8000,
    TIMING_WAIT_MIN_SEC: 5,
    TIMING_WAIT_MAX_SEC: 120,
    TIMING_GATE_COOLDOWN_SEC: 15,
    TURN_GATE_DEFER_COOLDOWN: true,
    TURN_GATE_CONTINUATION: false,
    TIMING_CONTINUATION_WINDOW_SEC: 180,
    TIMING_GATE_HISTORY_ENABLED: false,
    TIMING_GATE_FAIL_CLOSED: true,
  });
}

function input(over?: Partial<GateInput>): GateInput {
  return {
    chatId: -100,
    message: { messageId: 1, uid: 7 } as unknown as FormattedMessage,
    recentMessages: [],
    judgeResult: { action: 'reply' } as unknown as JudgeResult,
    botUid: 42,
    botName: '小小病',
    botPersona: 'p',
    isDirectInteraction: false,
    triggerUid: 7,
    ...over,
  };
}

beforeEach(() => {
  baseEnv();
  callWithFallbackMock.mockReset();
  callWithFallbackMock.mockResolvedValue({ content: '{"action":"continue","reason":"ok"}' });
  checkTalkValueMock.mockReset();
  checkTalkValueMock.mockResolvedValue({ pass: true, threshold: 1, count: 1, equivalent: 1 });
  appendHistMock.mockClear();
  getHistMock.mockReset();
  getHistMock.mockResolvedValue([]);
  getChatStateMock.mockReset();
  getChatStateMock.mockResolvedValue({ state: 'RUNNING' });
  cooldownRemainingMock.mockReset();
  cooldownRemainingMock.mockResolvedValue(0);
});

describe('runTimingGate — P2-E fail-closed', () => {
  it('解析失败(重试后)→ fail-closed no_action', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '???not json???' });
    const d = await runTimingGate(input());
    expect(d.action).toBe('no_action');
    expect(d.reason).toBe('parse_failed_closed');
    // 首次 + 纠正重试 = 2 次调用
    expect(callWithFallbackMock).toHaveBeenCalledTimes(2);
  });

  it('flag 关时保留旧 fail-open continue', async () => {
    envValues['TIMING_GATE_FAIL_CLOSED'] = false;
    callWithFallbackMock.mockResolvedValue({ content: '???not json???' });
    const d = await runTimingGate(input());
    expect(d.action).toBe('continue');
    expect(d.reason).toBe('parse_failed');
  });

  it('LLM 调用失败(基础设施)仍 fail-open continue', async () => {
    callWithFallbackMock.mockRejectedValue(new Error('network'));
    const d = await runTimingGate(input());
    expect(d.action).toBe('continue');
    expect(d.reason).toBe('llm_call_failed');
  });

  it('合成 no_action(fail-closed)不写决策历史', async () => {
    envValues['TIMING_GATE_HISTORY_ENABLED'] = true;
    callWithFallbackMock.mockResolvedValue({ content: '???not json???' });
    await runTimingGate(input());
    expect(appendHistMock).not.toHaveBeenCalled();
  });
});

describe('runTimingGate — P0-A 连续对话免检', () => {
  it('bot 刚回复过 → 短路 continue(continuation_window),不烧 LLM', async () => {
    envValues['TURN_GATE_CONTINUATION'] = true;
    const d = await runTimingGate(input({
      prefetchedState: { state: 'RUNNING', lastBotReplyAt: Date.now() - 10_000 },
    }));
    expect(d.action).toBe('continue');
    expect(d.reason).toBe('continuation_window');
    expect(d.continuation).toBe(true);
    expect(d.shortCircuited).toBe(true);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('更新的 no_action 负向决策杀免检 → 走 LLM', async () => {
    envValues['TURN_GATE_CONTINUATION'] = true;
    const d = await runTimingGate(input({
      prefetchedState: {
        state: 'RUNNING',
        lastBotReplyAt: Date.now() - 60_000,
        lastGateAt: Date.now() - 5_000,
        lastGateAction: 'no_action',
      },
    }));
    expect(d.reason).not.toBe('continuation_window');
  });

  it('窗口过期 → 走 LLM', async () => {
    envValues['TURN_GATE_CONTINUATION'] = true;
    const d = await runTimingGate(input({
      prefetchedState: { state: 'RUNNING', lastBotReplyAt: Date.now() - 181_000 },
    }));
    expect(d.reason).not.toBe('continuation_window');
    expect(callWithFallbackMock).toHaveBeenCalled();
  });

  it('proactiveMode 不享受免检', async () => {
    envValues['TURN_GATE_CONTINUATION'] = true;
    const d = await runTimingGate(input({
      proactiveMode: true,
      prefetchedState: { state: 'RUNNING', lastBotReplyAt: Date.now() - 10_000 },
    }));
    expect(d.reason).not.toBe('continuation_window');
  });

  it('flag 关 → 不免检', async () => {
    const d = await runTimingGate(input({
      prefetchedState: { state: 'RUNNING', lastBotReplyAt: Date.now() - 10_000 },
    }));
    expect(d.reason).not.toBe('continuation_window');
  });
});

describe('runTimingGate — P0-B cooldown defer 带 retryAfterMs', () => {
  it('冷却中 + defer flag → deferOnly + retryAfterMs', async () => {
    cooldownRemainingMock.mockResolvedValue(12_345);
    const d = await runTimingGate(input());
    expect(d.action).toBe('no_action');
    expect(d.deferOnly).toBe(true);
    expect(d.retryAfterMs).toBe(12_345);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('冷却中 + defer flag 关 → legacy 放行 continue', async () => {
    envValues['TURN_GATE_DEFER_COOLDOWN'] = false;
    cooldownRemainingMock.mockResolvedValue(12_345);
    const d = await runTimingGate(input());
    expect(d.action).toBe('continue');
    expect(d.reason).toBe('cooldown_bypass');
  });

  it('skipShortCircuits(多锚点兄弟)跳过冷却短路', async () => {
    cooldownRemainingMock.mockResolvedValue(12_345);
    const d = await runTimingGate(input({ skipShortCircuits: true }));
    expect(d.deferOnly).toBeUndefined();
    expect(callWithFallbackMock).toHaveBeenCalled();
  });
});

describe('runTimingGate — P1-C talk_value 阈值层', () => {
  it('canDefer + 未达阈值 → deferOnly + talk_value_below_threshold', async () => {
    checkTalkValueMock.mockResolvedValue({ pass: false, threshold: 2, count: 1, equivalent: 1.2, retryAfterMs: 30_000 });
    const d = await runTimingGate(input({ canDefer: true }));
    expect(d.action).toBe('no_action');
    expect(d.deferOnly).toBe(true);
    expect(d.reason).toBe('talk_value_below_threshold');
    expect(d.retryAfterMs).toBe(30_000);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('canDefer=false → 阈值层不生效,直接走 LLM', async () => {
    checkTalkValueMock.mockResolvedValue({ pass: false, threshold: 2, count: 1, equivalent: 1, retryAfterMs: 30_000 });
    const d = await runTimingGate(input({ canDefer: false }));
    expect(d.action).toBe('continue');
    expect(checkTalkValueMock).not.toHaveBeenCalled();
  });

  it('达到阈值 → 走 LLM', async () => {
    checkTalkValueMock.mockResolvedValue({ pass: true, threshold: 2, count: 2, equivalent: 2 });
    const d = await runTimingGate(input({ canDefer: true }));
    expect(d.action).toBe('continue');
    expect(callWithFallbackMock).toHaveBeenCalled();
  });

  it('连续免检优先于阈值层', async () => {
    envValues['TURN_GATE_CONTINUATION'] = true;
    checkTalkValueMock.mockResolvedValue({ pass: false, threshold: 3, count: 1, equivalent: 1, retryAfterMs: 60_000 });
    const d = await runTimingGate(input({
      canDefer: true,
      prefetchedState: { state: 'RUNNING', lastBotReplyAt: Date.now() - 10_000 },
    }));
    expect(d.reason).toBe('continuation_window');
    expect(checkTalkValueMock).not.toHaveBeenCalled();
  });
});

describe('runTimingGate — P1-D 决策历史', () => {
  it('历史注入 userMsg + 真实决策落库', async () => {
    envValues['TIMING_GATE_HISTORY_ENABLED'] = true;
    getHistMock.mockResolvedValue([
      { action: 'no_action', reason: '群友在自己聊', ts: Date.now() - 38_000 },
    ]);
    const d = await runTimingGate(input());
    expect(d.action).toBe('continue');
    const userMsg = (callWithFallbackMock.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> })
      .messages.find((m) => m.role === 'user')!.content;
    expect(userMsg).toContain('[最近节奏决策]');
    expect(userMsg).toContain('群友在自己聊');
    expect(appendHistMock).toHaveBeenCalledWith(-100, expect.objectContaining({ action: 'continue' }));
  });

  it('短路决策不落历史', async () => {
    envValues['TIMING_GATE_HISTORY_ENABLED'] = true;
    const d = await runTimingGate(input({ isDirectInteraction: true }));
    expect(d.shortCircuited).toBe(true);
    expect(appendHistMock).not.toHaveBeenCalled();
  });
});
