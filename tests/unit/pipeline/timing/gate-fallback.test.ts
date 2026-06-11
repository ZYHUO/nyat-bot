import { describe, it, expect, vi, beforeEach } from 'vitest';

// #34 信号中毒回归测试(gate 侧):gate.ts 与 heart/decision.ts 有同款
// 病灶 —— 把 AbortSignal.timeout(8000) 烧进共享 signal,主标签超时后所有
// backup DOA。gate 是 fail-open,所以症状更隐蔽:看似"裁决过 continue",
// 实为全链 DOA 后的假裁决。修复后:fail-open 只在 backup 真正穷尽后发生。

const { callModelMock } = vi.hoisted(() => ({ callModelMock: vi.fn() }));

vi.mock('../../../../src/ai/provider.js', () => ({
  callModel: callModelMock,
}));
vi.mock('../../../../src/ai/labels.js', () => ({
  getUsage: vi.fn(() => ({ label: 'primary', backups: ['lite'], timeout: 30000 })),
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
  },
}));
vi.mock('../../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../../src/env.js', () => ({
  env: () => ({
    TIMING_GATE_ENABLED: true,
    TIMING_GATE_USAGE: 'judge',
    TIMING_GATE_TIMEOUT_MS: 8000,
    TIMING_WAIT_MIN_SEC: 10,
    TIMING_WAIT_MAX_SEC: 600,
    TURN_GATE_DEFER_COOLDOWN: false,
    HEDGE_DELAY_MS: 0,
  }),
}));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/pipeline/context/slim.js', () => ({
  slimContextForAI: vi.fn(() => 'CTX'),
}));
vi.mock('../../../../src/shared/config.js', () => ({
  loadCachedPrompt: vi.fn(() => 'g {bot_name} {bot_persona} {wait_min_sec} {wait_max_sec} {mode_block}'),
}));
vi.mock('../../../../src/pipeline/timing/chat-runtime.js', () => ({
  isInGateCooldown: vi.fn(async () => false),
}));

import { runTimingGate } from '../../../../src/pipeline/timing/gate.js';
import type { GateInput } from '../../../../src/pipeline/timing/gate.js';
import type { FormattedMessage, JudgeResult } from '../../../../src/shared/types.js';

const timeoutError = (): Error =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

const ok = (content: string) => ({
  content,
  tokenUsage: { prompt: 1, completion: 1, total: 2 },
  model: 'm',
  label: 'l',
  latencyMs: 1,
});

const baseInput = (): GateInput => ({
  chatId: -1,
  message: {
    role: 'user', uid: 1, messageId: 9, fullName: 'A', username: 'a',
    textContent: 'hi', timestamp: 0, isForwarded: false,
  } as FormattedMessage,
  recentMessages: [],
  judgeResult: { action: 'REPLY', level: 'L1_MICRO', confidence: 0.9, latencyMs: 0 } as JudgeResult,
  botUid: 9,
  botName: 'x',
  botPersona: 'p',
  isDirectInteraction: false,
});

beforeEach(() => {
  callModelMock.mockReset();
});

describe('gate fallback signal hygiene (#34)', () => {
  it('primary TimeoutError → backup verdict wins (not fake fail-open continue)', async () => {
    callModelMock
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(ok('{"action":"no_action","reason":"backup verdict"}'));

    const d = await runTimingGate(baseInput());

    expect(callModelMock).toHaveBeenCalledTimes(2);
    expect(callModelMock.mock.calls[1]![0].name).toBe('lite');
    expect(d.action).toBe('no_action'); // backup 的真实裁决
    expect(d.reason).toBe('backup verdict');
    expect(d.shortCircuited).toBe(false);
  });

  it('per-attempt 8s cap + unpoisoned signal on every attempt', async () => {
    callModelMock
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(ok('{"action":"continue","reason":"r"}'));

    await runTimingGate(baseInput());

    for (const call of callModelMock.mock.calls) {
      const opts = call[2] as { timeout?: number; signal?: AbortSignal };
      expect(opts.timeout).toBe(8000);
      expect(opts.signal).toBeUndefined();
    }
  });

  it('fail-open continue ONLY after backups are genuinely exhausted', async () => {
    callModelMock.mockRejectedValue(timeoutError());

    const d = await runTimingGate(baseInput());

    expect(callModelMock).toHaveBeenCalledTimes(2); // primary + lite 都试过
    expect(d.action).toBe('continue');
    expect(d.reason).toBe('llm_call_failed');
    expect(d.shortCircuited).toBe(true);
  });
});
