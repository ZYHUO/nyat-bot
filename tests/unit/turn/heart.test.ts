import { describe, it, expect, vi, beforeEach } from 'vitest';

const envState = {
  TIMING_GATE_USAGE: 'judge',
  TIMING_GATE_TIMEOUT_MS: 8000,
};

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));

vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: callMock }));
vi.mock('../../../src/pipeline/context/slim.js', () => ({ slimContextForAI: vi.fn(() => 'CTX') }));
vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: vi.fn((p: string) =>
    p.includes('heart') ? '心流 {bot_name} {persona_core} {self_state}' : '猫娘人格'),
}));

import { heartDecision, parseHeart } from '../../../src/pipeline/heart/decision.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

function msg(text: string): FormattedMessage {
  return {
    role: 'user', uid: 1, messageId: 9, fullName: 'A', username: 'a',
    textContent: text, timestamp: 0, isForwarded: false,
  } as FormattedMessage;
}

const baseInput = {
  chatId: -100,
  message: msg('随便聊聊'),
  recentMessages: [],
  botUid: 9,
  botName: 'xxb',
  selfState: { narration: '你状态正常。', energy: 0.8 },
};

beforeEach(() => callMock.mockReset());

describe('heart decision (S13 心流)', () => {
  it('parses reply/wait/pass with path and why', () => {
    expect(parseHeart('{"act":"reply","path":"chat","why":"这梗我能接"}')).toEqual({ act: 'reply', path: 'chat', why: '这梗我能接' });
    expect(parseHeart('```json\n{"act":"pass","why":"俩人聊得火热"}\n```')!.act).toBe('pass');
    expect(parseHeart('{"act":"reply","path":"lookup","why":"得查"}')!.path).toBe('lookup');
    expect(parseHeart('我觉得应该回复')).toBeNull();
    expect(parseHeart('{"act":"destroy"}')).toBeNull();
  });

  it('reply/chat → JudgeResult REPLY direct', async () => {
    callMock.mockResolvedValue({ content: '{"act":"reply","path":"chat","why":"想接"}' });
    const d = await heartDecision(baseInput);
    expect(d.act).toBe('reply');
    expect(d.judgeResult).toMatchObject({ action: 'REPLY', rule: 'heart', replyPath: 'direct' });
  });

  it('reply/lookup → planned path', async () => {
    callMock.mockResolvedValue({ content: '{"act":"reply","path":"lookup","why":"要查价格"}' });
    const d = await heartDecision(baseInput);
    expect(d.judgeResult.replyPath).toBe('planned');
  });

  it('pass → IGNORE, never throws', async () => {
    callMock.mockResolvedValue({ content: '{"act":"pass","why":"没我事"}' });
    const d = await heartDecision(baseInput);
    expect(d.judgeResult.action).toBe('IGNORE');
  });

  // 注:LLM 抛错 → fail-closed pass 的用例在 heart-failure.test.ts 单独文件
  // (同文件多用例时 vitest 把已被 catch 的 rejection 误判为 unhandled)。

  it('garbage output → fail-closed pass', async () => {
    callMock.mockResolvedValue({ content: '喵喵喵?' });
    const d = await heartDecision(baseInput);
    expect(d.act).toBe('pass');
  });

  it('presence line included when bot spoke recently', async () => {
    callMock.mockResolvedValue({ content: '{"act":"reply","path":"chat","why":"还在聊"}' });
    await heartDecision({ ...baseInput, lastSpokeSecAgo: 45 });
    const userMsg = callMock.mock.calls[0]![0].messages[1].content as string;
    expect(userMsg).toContain('45 秒前');
    expect(userMsg).toContain('正处于对话中');
  });

  it('self-state narration lands in the system prompt', async () => {
    callMock.mockResolvedValue({ content: '{"act":"pass","why":"x"}' });
    await heartDecision({ ...baseInput, selfState: { narration: '你困得不行。', energy: 0.1 } });
    const sys = callMock.mock.calls[0]![0].messages[0].content as string;
    expect(sys).toContain('你困得不行。');
  });
});
