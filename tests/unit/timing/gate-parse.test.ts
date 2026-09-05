import { describe, it, expect } from 'vitest';
import { parseGateResponse } from '../../../src/pipeline/timing/gate.js';

describe('parseGateResponse', () => {
  it('strict JSON continue', () => {
    const out = parseGateResponse('{"action":"continue","reason":"yes"}');
    expect(out?.action).toBe('continue');
    expect(out?.reason).toBe('yes');
  });

  it('strict JSON wait with seconds', () => {
    const out = parseGateResponse('{"action":"wait","waitSec":30,"reason":"用户还没说完"}');
    expect(out?.action).toBe('wait');
    expect(out?.waitSec).toBe(30);
  });

  it('JSON wrapped in ```json fence', () => {
    const raw = '```json\n{"action":"no_action","reason":"用户在自己聊"}\n```';
    expect(parseGateResponse(raw)?.action).toBe('no_action');
  });

  it('mixed text + JSON object', () => {
    const raw = '我觉得现在不该说话。\n{"action":"no_action","reason":"users互聊"}\n仅供参考';
    expect(parseGateResponse(raw)?.action).toBe('no_action');
  });

  it('snake_case wait_sec accepted', () => {
    const out = parseGateResponse('{"action":"wait","wait_sec":15}');
    expect(out?.action).toBe('wait');
    expect(out?.waitSec).toBe(15);
  });

  it('UPPERCASE ACTION accepted', () => {
    const out = parseGateResponse('{"ACTION":"CONTINUE"}');
    expect(out?.action).toBe('continue');
  });

  it('keyword fallback continue', () => {
    expect(parseGateResponse('I think we should continue here')?.action).toBe('continue');
  });

  it('keyword fallback no_action', () => {
    expect(parseGateResponse('decision: no_action')?.action).toBe('no_action');
  });

  it('keyword fallback wait with seconds', () => {
    const out = parseGateResponse('please wait 45 seconds');
    expect(out?.action).toBe('wait');
    expect(out?.waitSec).toBe(45);
  });

  it('invalid action enum → null', () => {
    expect(parseGateResponse('{"action":"reply"}')).toBeNull();
  });

  it('garbage input → null', () => {
    expect(parseGateResponse('blah blah')).toBeNull();
  });

  it('empty string → null', () => {
    expect(parseGateResponse('')).toBeNull();
  });

  it('truncates long reason', () => {
    const longReason = 'x'.repeat(500);
    const out = parseGateResponse(JSON.stringify({ action: 'continue', reason: longReason }));
    expect(out?.reason.length).toBe(200);
  });
});

describe('gate jsonMode passthrough (H4.1)', () => {
  it('runTimingGate passes jsonMode:true to callWithFallback (both attempts)', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const calls: Array<Record<string, unknown>> = [];
    // 短路层全部走 mock 状态：无 continuation、无 cooldown、无 talk-value，
    // 确保走到 LLM 调用（CI 读写真实 Redis，无预设状态时短路行为不定）。
    vi.doMock('../../../src/pipeline/timing/chat-runtime.js', () => ({
      getChatState: vi.fn(async () => undefined),
      getGateCooldownRemainingMs: vi.fn(async () => 0),
      isInContinuation: vi.fn(() => false),
      recordGateContinue: vi.fn(async () => {}),
      transitionToWait: vi.fn(async () => {}),
    }));
    vi.doMock('../../../src/pipeline/timing/state-store.js', () => ({
      recordGateNoAction: vi.fn(async () => {}),
      isTimingDegraded: vi.fn(() => true), // degraded → talk-value 层跳过，直达 LLM
    }));
    vi.doMock('../../../src/pipeline/timing/gate-history.js', () => ({
      appendGateHistory: vi.fn(async () => {}),
      formatGateHistoryBlock: vi.fn(() => ''),
      getGateHistory: vi.fn(async () => []),
    }));
    vi.doMock('../../../src/ai/fallback.js', () => ({
      callWithFallback: vi.fn(async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return { content: '{"action":"continue","reason":"ok"}', label: 't', model: 'm', latencyMs: 1 };
      }),
    }));
    vi.doMock('../../../src/env.js', () => ({
      env: () => ({
        TIMING_GATE_ENABLED: true, TURN_GATE_CONTINUATION: false, TURN_GATE_DEFER_COOLDOWN: false,
        TIMING_GATE_HISTORY_ENABLED: false, TIMING_GATE_TIMEOUT_MS: 5000,
        TIMING_WAIT_MIN_SEC: 5, TIMING_WAIT_MAX_SEC: 30, TIMING_GATE_FAIL_CLOSED: true,
      }),
    }));
    // prompt/上下文走真文件+真函数（gate-fallback.test.ts 同款 mock prompt 文本）
    vi.doMock('../../../src/shared/config.js', () => ({
      loadCachedPrompt: () => 'g {bot_name} {bot_persona} {wait_min_sec} {wait_max_sec} {mode_block}',
    }));
    const { runTimingGate } = await import('../../../src/pipeline/timing/gate.js');
    await runTimingGate({
      chatId: -1001,
      message: { role: 'user', uid: 1, messageId: 1, textContent: 'hi', timestamp: 0, isForwarded: false } as never,
      recentMessages: [],
      judgeResult: { action: 'REPLY', level: 'L2_AI', rule: 'test', latencyMs: 1 },
      botUid: 9, botName: 'x', botPersona: 'p',
    });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) expect(c['jsonMode']).toBe(true);
    vi.doUnmock('../../../src/ai/fallback.js');
  });
});
