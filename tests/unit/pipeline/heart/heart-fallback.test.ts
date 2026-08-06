import { describe, it, expect, vi, beforeEach } from 'vitest';

// #34 信号中毒回归测试:心流的 8s 预算必须是 per-attempt cap,不能烧进
// 共享 AbortSignal。旧 bug:mergeAbortSignals(8000, signal) 被 fallback 链
// 每次尝试复用 → 主标签超时后所有 backup 的信号天生 aborted → 心流在慢主
// 模型下没有任何可用 fallback → fail-closed pass(静默吞回复)。
// 这里 mock 到 provider.callModel 层,让真实的 callWithFallback 链路跑通。

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
    recordSuccess = async (): Promise<void> => {};
    recordFailure = async (): Promise<boolean> => false;
  },
}));
vi.mock('../../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../../src/env.js', () => ({
  env: () => ({ TIMING_GATE_USAGE: 'judge', TIMING_GATE_TIMEOUT_MS: 8000, HEDGE_DELAY_MS: 0 }),
}));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/pipeline/context/slim.js', () => ({
  slimContextForAI: vi.fn(() => 'CTX'),
}));
vi.mock('../../../../src/shared/config.js', () => ({
  loadCachedPrompt: vi.fn(() => 'x {bot_name} {persona_core} {self_state}'),
}));

import { heartDecision } from '../../../../src/pipeline/heart/decision.js';
import type { FormattedMessage } from '../../../../src/shared/types.js';

const timeoutError = (): Error =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

const ok = (content: string) => ({
  content,
  tokenUsage: { prompt: 1, completion: 1, total: 2 },
  model: 'm',
  label: 'l',
  latencyMs: 1,
});

const baseInput = (signal?: AbortSignal) => ({
  chatId: -1,
  message: {
    role: 'user', uid: 1, messageId: 9, fullName: 'A', username: 'a',
    textContent: 'hi', timestamp: 0, isForwarded: false,
  } as FormattedMessage,
  recentMessages: [],
  botUid: 9,
  botName: 'x',
  selfState: { narration: 'n', narrationNoThought: 'n', energy: 1 },
  signal,
});

beforeEach(() => {
  callModelMock.mockReset();
});

describe('heart fallback signal hygiene (#34)', () => {
  it('primary TimeoutError → fallback REACHES and SUCCEEDS on the backup (not fail-closed pass)', async () => {
    callModelMock
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(ok('{"act":"reply","path":"chat","why":"backup ok"}'));

    const d = await heartDecision(baseInput());

    expect(callModelMock).toHaveBeenCalledTimes(2);
    expect(callModelMock.mock.calls[1]![0].name).toBe('lite'); // 真到了 backup
    expect(d.act).toBe('reply'); // backup 的裁决,不是 fail-closed pass
    expect(d.why).toBe('backup ok');
    expect(d.judgeResult.action).toBe('REPLY');
  });

  it('empty primary response is treated as failure and backup can recover it', async () => {
    callModelMock
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(ok('{"act":"reply","path":"chat","why":"backup ok"}'));

    const d = await heartDecision(baseInput());

    expect(callModelMock).toHaveBeenCalledTimes(2);
    expect(callModelMock.mock.calls[1]![0].name).toBe('lite');
    expect(d.act).toBe('reply');
    expect(d.why).toBe('backup ok');
  });

  it('every attempt gets the 8s budget as a per-attempt timeout cap, with an unpoisoned signal', async () => {
    callModelMock
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(ok('{"act":"pass","why":"q"}'));

    await heartDecision(baseInput());

    for (const call of callModelMock.mock.calls) {
      const opts = call[2] as { timeout?: number; signal?: AbortSignal };
      expect(opts.timeout).toBe(8000); // min(usage 30000, maxTimeoutMs 8000)
      // 共享 signal 里不允许烧超时:无外部打断时必须是 undefined
      expect(opts.signal).toBeUndefined();
    }
  });

  it('caller interrupt signal passes through RAW (identity) — no baked timeout merge', async () => {
    const controller = new AbortController();
    callModelMock.mockResolvedValueOnce(ok('{"act":"reply","path":"chat","why":"w"}'));

    await heartDecision(baseInput(controller.signal));

    const opts = callModelMock.mock.calls[0]![2] as { signal?: AbortSignal };
    expect(opts.signal).toBe(controller.signal); // 同一个对象,没有 AbortSignal.any 包裹
    expect(opts.signal!.aborted).toBe(false);
  });

  it('fail-closed pass happens ONLY after the whole chain is exhausted', async () => {
    callModelMock.mockRejectedValue(timeoutError());

    const d = await heartDecision(baseInput());

    expect(callModelMock).toHaveBeenCalledTimes(2); // primary + lite 都试过了
    expect(d.act).toBe('pass');
    expect(d.why).toBe('llm_failed');
  });

  it('TurnInterrupt abort short-circuits the chain (no backup burn) and re-throws for replan', async () => {
    const controller = new AbortController();
    callModelMock.mockImplementationOnce(async () => {
      controller.abort(Object.assign(new Error('turn interrupt'), { name: 'TurnInterrupt' }));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    // 调用方打断 ≠ LLM 故障:heart 上抛 AI_ABORTED 交给 actor 重规划,
    // 不再 fail-closed pass 吞掉本该 replan 的回合(并消除最大 warn 噪音源)。
    await expect(heartDecision(baseInput(controller.signal))).rejects.toMatchObject({ code: 'AI_ABORTED' });
    expect(callModelMock).toHaveBeenCalledTimes(1); // 打断不进 fallback,不烧 backup
  });
});
