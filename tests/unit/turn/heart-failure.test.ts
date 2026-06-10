import { it, expect, vi } from 'vitest';

// LLM 抛错 → fail-closed pass。独立成文件:与其他用例同文件时,
// vitest 会把已被 heartDecision 内部 catch 的 rejection 误判为
// unhandled error 而判挂(探针证明返回值正确、无异常逃逸)。

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
import type { FormattedMessage } from '../../../src/shared/types.js';

it('heart: LLM failure → fail-closed pass (never throws)', async () => {
  callMock.mockImplementation(async () => {
    throw new Error('boom');
  });
  const d = await heartDecision({
    chatId: -1,
    message: { role: 'user', uid: 1, messageId: 9, fullName: 'A', username: 'a', textContent: 'hi', timestamp: 0, isForwarded: false } as FormattedMessage,
    recentMessages: [],
    botUid: 9,
    botName: 'x',
    selfState: { narration: 'n', energy: 1 },
  });
  expect(d.act).toBe('pass');
  expect(d.why).toBe('llm_failed');
  expect(d.judgeResult.action).toBe('IGNORE');
});
