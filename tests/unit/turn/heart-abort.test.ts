import { it, expect, vi } from 'vitest';

// 调用方打断(AIError/AI_ABORTED 或 caller-abort signal)→ heartDecision 必须
// **上抛**(交给 actor 重规划),不能 fail-closed pass 吞掉。独立成文件:
// 与 heart-failure.test 的"内部已 catch 的 rejection"混在一处会触发 vitest
// 误判(见 heart-failure.test 顶注)。

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));

vi.mock('../../../src/env.js', () => ({ env: () => ({ TIMING_GATE_USAGE: 'judge', TIMING_GATE_TIMEOUT_MS: 8000 }) }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: callMock }));
vi.mock('../../../src/pipeline/context/slim.js', () => ({ slimContextForAI: vi.fn(() => 'CTX') }));
vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: vi.fn(() => 'x {bot_name} {persona_core} {self_state}'),
}));

import { heartDecision } from '../../../src/pipeline/heart/decision.js';
import { AIError } from '../../../src/shared/errors.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

const baseInput = () => ({
  chatId: -1,
  message: { role: 'user', uid: 1, messageId: 9, fullName: 'A', username: 'a', textContent: 'hi', timestamp: 0, isForwarded: false } as FormattedMessage,
  recentMessages: [],
  botUid: 9,
  botName: 'x',
  selfState: { narration: 'n', narrationNoThought: 'n', energy: 1 },
});

it('heart: AIError/AI_ABORTED → re-throws for replan (not fail-closed pass)', async () => {
  callMock.mockImplementation(async () => {
    throw new AIError('Aborted by caller', 'judge', 'm', 'AI_ABORTED');
  });
  await expect(heartDecision(baseInput())).rejects.toMatchObject({ code: 'AI_ABORTED' });
});

it('heart: caller-abort signal (TurnInterrupt reason) → re-throws even if err shape is bare', async () => {
  const ac = new AbortController();
  const reason = new Error('turn_interrupt: test');
  reason.name = 'TurnInterrupt';
  ac.abort(reason);
  callMock.mockImplementation(async () => {
    throw new Error('boom'); // 非 AIError;靠 isCallerAbort(signal) 识别
  });
  await expect(heartDecision({ ...baseInput(), signal: ac.signal })).rejects.toThrow('boom');
});
