import { describe, it, expect, vi, beforeEach } from 'vitest';

// P0 反馈学习闭环:outcome 追踪蒸馏出的「哪些该接/哪些不该接」规则,
// 过去只注入回复写手(reply.ts),心流(决定**接不接**的那一环)看不到。
// 这里验证规则真的进了心流 system prompt,且 flag 关/无规则时整块塌陷。

const { callModelMock, getReflectionMock, envValues } = vi.hoisted(() => ({
  callModelMock: vi.fn(),
  getReflectionMock: vi.fn((): string | null => null),
  envValues: {
    TIMING_GATE_USAGE: 'judge',
    TIMING_GATE_TIMEOUT_MS: 8000,
    HEDGE_DELAY_MS: 0,
    OUTCOME_TRACKING_ENABLED: true,
  } as Record<string, unknown>,
}));

vi.mock('../../../../src/ai/provider.js', () => ({ callModel: callModelMock }));
vi.mock('../../../../src/ai/labels.js', () => ({
  getUsage: vi.fn(() => ({ label: 'primary', backups: [], timeout: 30000 })),
  getLabel: vi.fn((name: string) => ({
    name,
    endpoint: 'http://test',
    apiKeys: ['k'],
    model: `${name}-model`,
  })),
}));
vi.mock('../../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = async (): Promise<boolean> => false;
    setCooldown = async (): Promise<void> => {};
    recordSuccess = async (): Promise<void> => {};
    recordFailure = async (): Promise<boolean> => false;
  },
}));
vi.mock('../../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/pipeline/context/slim.js', () => ({
  slimContextForAI: vi.fn(() => 'CTX'),
}));
vi.mock('../../../../src/shared/config.js', () => ({
  loadCachedPrompt: vi.fn(() => 'P {bot_name} {persona_core} {self_state}\n{learned_rules}END'),
}));
vi.mock('../../../../src/tracking/outcome.js', () => ({ getReflection: getReflectionMock }));

import { heartDecision } from '../../../../src/pipeline/heart/decision.js';
import type { FormattedMessage } from '../../../../src/shared/types.js';

const ok = (content: string) => ({
  content,
  tokenUsage: { prompt: 1, completion: 1, total: 2 },
  model: 'm',
  label: 'l',
  latencyMs: 1,
});

const baseInput = () => ({
  chatId: -1001,
  message: {
    role: 'user', uid: 1, messageId: 9, fullName: 'A', username: 'a',
    textContent: 'hi', timestamp: 0, isForwarded: false,
  } as FormattedMessage,
  recentMessages: [],
  botUid: 9,
  botName: 'x',
  selfState: { narration: 'n', narrationNoThought: 'n', energy: 1 },
});

function systemPromptOf(callIdx = 0): string {
  const msgs = callModelMock.mock.calls[callIdx]![1] as Array<{ role: string; content: string }>;
  return msgs.find((m) => m.role === 'system')!.content;
}

beforeEach(() => {
  callModelMock.mockReset();
  getReflectionMock.mockReset();
  getReflectionMock.mockReturnValue(null);
  envValues['OUTCOME_TRACKING_ENABLED'] = true;
  callModelMock.mockResolvedValue(ok('{"act":"pass","path":"chat","why":"w"}'));
});

describe('heart learned-rules injection (P0 feedback loop)', () => {
  it('有学到的规则 → 注入心流 system prompt', async () => {
    getReflectionMock.mockReturnValue('- 别接纯表情\n- 深夜少说话');
    await heartDecision(baseInput());
    const sys = systemPromptOf();
    expect(sys).toContain('你之前在这个群学到的经验教训');
    expect(sys).toContain('别接纯表情');
    expect(sys).not.toContain('{learned_rules}');
  });

  it('没有规则 → 占位符塌陷为空,不留空段落', async () => {
    await heartDecision(baseInput());
    const sys = systemPromptOf();
    expect(sys).not.toContain('{learned_rules}');
    expect(sys).not.toContain('经验教训');
  });

  it('OUTCOME_TRACKING_ENABLED=false → 不读库,不注入', async () => {
    envValues['OUTCOME_TRACKING_ENABLED'] = false;
    getReflectionMock.mockReturnValue('- 别接纯表情');
    await heartDecision(baseInput());
    expect(getReflectionMock).not.toHaveBeenCalled();
    expect(systemPromptOf()).not.toContain('别接纯表情');
  });
});
