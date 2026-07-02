import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callModelMock } = vi.hoisted(() => ({ callModelMock: vi.fn() }));

vi.mock('../../../../src/ai/provider.js', () => ({ callModel: callModelMock }));
vi.mock('../../../../src/ai/labels.js', () => ({
  getUsage: vi.fn(() => ({ label: 'primary', backups: ['lite'], timeout: 30000 })),
  getLabel: vi.fn((name: string) => ({ name, endpoint: 'http://test', apiKeys: ['k'], model: `${name}-model` })),
}));
vi.mock('../../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = async (): Promise<boolean> => false;
    setCooldown = async (): Promise<void> => {};
  },
}));
vi.mock('../../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../../src/env.js', () => ({
  env: () => ({
    TIMING_GATE_ENABLED: true,
    TIMING_GATE_USAGE: 'judge',
    TIMING_GATE_TIMEOUT_MS: 8000,
    TIMING_WAIT_MIN_SEC: 5,
    TIMING_WAIT_MAX_SEC: 120,
    TURN_GATE_DEFER_COOLDOWN: false,
    HEDGE_DELAY_MS: 0,
  }),
}));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../src/pipeline/context/slim.js', () => ({ slimContextForAI: vi.fn(() => 'CTX') }));
vi.mock('../../../../src/shared/config.js', () => ({ loadCachedPrompt: vi.fn(() => 'g {bot_name} {bot_persona} {wait_min_sec} {wait_max_sec} {mode_block}') }));
vi.mock('../../../../src/pipeline/timing/chat-runtime.js', () => ({ isInGateCooldown: vi.fn(async () => false) }));

import { runTimingGate } from '../../../../src/pipeline/timing/gate.js';
import type { GateInput } from '../../../../src/pipeline/timing/gate.js';
import type { FormattedMessage, JudgeResult } from '../../../../src/shared/types.js';

const ok = (content: string) => ({ content, tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });
const baseInput = (): GateInput => ({
  chatId: -1,
  message: { role: 'user', uid: 1, messageId: 9, fullName: 'A', username: 'a', textContent: 'hi', timestamp: 0, isForwarded: false } as FormattedMessage,
  recentMessages: [],
  judgeResult: { action: 'REPLY', level: 'L1_MICRO', confidence: 0.9, latencyMs: 0 } as JudgeResult,
  botUid: 9,
  botName: 'x',
  botPersona: 'p',
  isDirectInteraction: false,
  obligationId: 'obl-1',
  obligationTargetUid: 1,
  obligationStrong: true,
});

beforeEach(() => { callModelMock.mockReset(); });

describe('gate strong obligation protection', () => {
  it('converts no_action into wait when strong obligation is active', async () => {
    callModelMock.mockResolvedValueOnce(ok('{"action":"no_action","reason":"ambient people chatting"}'));
    const d = await runTimingGate(baseInput());
    expect(d.action).toBe('wait');
    expect(d.reason).toContain('protected_strong_obligation');
  });
});
