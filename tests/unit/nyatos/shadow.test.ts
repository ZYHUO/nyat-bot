import { describe, expect, it, vi, beforeEach } from 'vitest';

// The shadow runs the single decision point on real traffic, sends nothing, and
// records what it would have done versus what the live path did. Its value is
// the comparison, so these tests pin the parts that could silently corrupt it:
//   - a failed model call must NOT default to "speak" (that would inflate its
//     own agreement rate)
//   - parsing must reject a "speak" with no usable text
//   - nothing is ever sent

const envValues: Record<string, unknown> = {
  COGNITIVE_EVENTS_ENABLED: true,
  NYATOS_SHADOW_TIMEOUT_MS: 20_000,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const callWithFallback = vi.fn();
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: (...a: unknown[]) => callWithFallback(...a) }));

// The ingress shadow reads the bot's identity so the Frame can tell the model
// which @name refers to itself; stub it here.
vi.mock('../../../src/bot/bot.js', () => ({
  getBotIdentity: () => ({ uid: 8392759490, username: 'hunhebi_bot', nicknames: [] }),
  getBotDisplayName: () => '啾咪囝',
}));

const appendCognitiveEvent = vi.fn(() => ({ inserted: true, event: { id: 'e1' } }));
vi.mock('../../../src/agent/cognitive-events.js', () => ({
  appendCognitiveEvent: (...a: unknown[]) => appendCognitiveEvent(...a),
}));

import {
  decideShadow,
  liveActionToVerdict,
  isNyatosShadowChat,
  parseShadow,
  recordShadowComparison,
} from '../../../src/nyatos/shadow.js';
import type { Frame } from '../../../src/nyatos/frame.js';

function frame(): Frame {
  return {
    schema: 'frame.v1',
    scope: { visibility: 'chat', chatId: -100 },
    asOf: 1000,
    clock: { nowIso: '2026-09-18 10:00', weekday: '周五', triggerAgeSec: 5 },
    field: null,
    inner: null,
    capability: null,
    self: { recentActs: [] },
    recentLines: ['[10:00 #1] 阿伟: 在吗'],
    unknowns: [],
  };
}

beforeEach(() => {
  callWithFallback.mockReset();
  appendCognitiveEvent.mockClear();
});

describe('shadow decision', () => {
  it('parses a speak verdict with bubbles', () => {
    const r = parseShadow(JSON.stringify({ act: 'speak', bubbles: ['在的', '怎么了'], why: '他在叫我' }));
    expect(r).toMatchObject({ verdict: 'speak', why: '他在叫我' });
    expect(r?.bubbles).toEqual(['在的', '怎么了']);
  });

  it('parses silent and wait', () => {
    expect(parseShadow('{"act":"silent","why":"接不上"}')?.verdict).toBe('silent');
    const w = parseShadow('{"act":"wait","waitSec":300,"why":"等话题过去"}');
    expect(w?.verdict).toBe('wait');
    expect(w?.waitSec).toBe(300);
  });

  it('rejects a speak with no usable text instead of counting it as speaking', () => {
    expect(parseShadow('{"act":"speak","bubbles":[],"why":"x"}')).toBeNull();
    expect(parseShadow('{"act":"speak","bubbles":["   "],"why":"x"}')).toBeNull();
  });

  it('clamps waitSec into a sane window', () => {
    expect(parseShadow('{"act":"wait","waitSec":1}')?.waitSec).toBe(30);
    expect(parseShadow('{"act":"wait","waitSec":999999}')?.waitSec).toBe(86400);
  });

  it('fails closed to silent when the model errors', async () => {
    callWithFallback.mockRejectedValueOnce(new Error('provider down'));
    const d = await decideShadow(frame());
    // Must NOT be 'speak': a shadow that guesses "speak" on failure would
    // inflate its own agreement rate and corrupt the comparison.
    expect(d.verdict).toBe('silent');
    expect(d.failed).toBe(true);
  });

  it('fails closed when the model returns unparseable output', async () => {
    callWithFallback.mockResolvedValueOnce({ content: 'I think we should talk' });
    const d = await decideShadow(frame());
    expect(d.verdict).toBe('silent');
    expect(d.failed).toBe(true);
    expect(d.why).toBe('shadow_unparsed');
  });

  it('returns the parsed decision on success and never sends', async () => {
    callWithFallback.mockResolvedValueOnce({
      content: '{"act":"speak","bubbles":["在的"],"why":"被点名"}',
    });
    const d = await decideShadow(frame());
    expect(d).toMatchObject({ verdict: 'speak', failed: false });
    expect(d.bubbles).toEqual(['在的']);
    expect(typeof d.latencyMs).toBe('number');
    // The module has no sender import at all; this asserts the contract that it
    // only ever calls the model.
    expect(callWithFallback).toHaveBeenCalledTimes(1);
  });
});

describe('comparison bookkeeping', () => {
  it('maps live actions onto the shadow vocabulary', () => {
    expect(liveActionToVerdict('REPLY')).toBe('speak');
    expect(liveActionToVerdict('WAIT')).toBe('wait');
    expect(liveActionToVerdict('DEFER')).toBe('wait');
    expect(liveActionToVerdict('IGNORE')).toBe('silent');
    expect(liveActionToVerdict('REJECT')).toBe('silent');
  });

  it('records only verdict/reason, never the proposed text', () => {
    recordShadowComparison({
      chatId: -100,
      messageId: 7,
      liveAction: 'heart:pass',
      shadow: { verdict: 'speak', why: '被点名', bubbles: ['不该被存下来的草稿'], latencyMs: 120, failed: false },
      agree: false,
      at: 1000,
    });
    expect(appendCognitiveEvent).toHaveBeenCalledTimes(1);
    const fact = (appendCognitiveEvent.mock.calls[0]![0] as { fact: Record<string, unknown> }).fact;
    expect(fact).toMatchObject({ liveAction: 'heart:pass', shadowVerdict: 'speak', agree: false });
    expect(fact['bubbleCount']).toBe(1);
    // The ledger must not become a second message store.
    expect(JSON.stringify(fact)).not.toContain('不该被存下来的草稿');
  });

  it('gates the rollout by chat id', () => {
    expect(isNyatosShadowChat(-100, { enabled: false, chatIds: [] })).toBe(false);
    expect(isNyatosShadowChat(-100, { enabled: true, chatIds: [] })).toBe(true);
    expect(isNyatosShadowChat(-100, { enabled: true, chatIds: [-200] })).toBe(false);
    expect(isNyatosShadowChat(-200, { enabled: true, chatIds: [-200] })).toBe(true);
    expect(isNyatosShadowChat(0, { enabled: true, chatIds: [] })).toBe(false);
  });
});

describe('shadow prompt (measured 2026-09-18)', () => {
  // A prompt without the "most messages get scrolled past" framing returned
  // `speak` for EVERY input, including two people in private conversation and
  // idle joking. These assertions keep that framing from being optimised away
  // as "just prompt fluff" — removing it silently destroys discrimination.
  it('states the scroll-past baseline that makes silence reachable', async () => {
    const { shadowSystemPrompt } = await import('../../../src/nyatos/shadow.js');
    const prompt = shadowSystemPrompt();
    expect(prompt).toContain('划过去');
    expect(prompt).toContain('silent');
    expect(prompt).toContain('wait');
    expect(prompt).toContain('speak');
  });

  it('does not smuggle in a rule table', async () => {
    const { shadowSystemPrompt } = await import('../../../src/nyatos/shadow.js');
    const prompt = shadowSystemPrompt();
    // The rewrite's whole point is that behaviour comes from judgement, not rules.
    expect(prompt).not.toMatch(/每\s*\d+\s*条|大约|不要超过|必须|禁止|应该/);
  });
});

describe('ingress shadow (Phase 2.4)', () => {
  it('records a verdict even when no gate has run yet', async () => {
    const { runIngressShadow } = await import('../../../src/nyatos/shadow.js');
    callWithFallback.mockResolvedValueOnce({
      content: '{"act":"silent","why":"两人私聊，不插话"}',
    });
    await runIngressShadow({
      chatId: -100,
      message: {
        role: 'user', uid: 1001, username: 'a', fullName: 'A',
        timestamp: Math.floor(Date.now() / 1000), messageId: 77,
        textContent: '在吗', isForwarded: false,
      } as never,
      recent: [],
      botUid: 999,
      enabled: true,
      chatIds: [],
    });
    expect(appendCognitiveEvent).toHaveBeenCalled();
    const call = appendCognitiveEvent.mock.calls.at(-1)![0] as { fact: Record<string, unknown>; dedupeKey: string };
    expect(call.fact).toMatchObject({ shadowVerdict: 'silent', messageId: 77 });
    // The live outcome cannot be known yet — recording a guess here would make
    // the comparison meaningless.
    expect(call.fact['liveOutcome']).toBeNull();
    expect(call.dedupeKey).toContain('shadow-ingress');
  });

  it('does not run for chats outside the canary list', async () => {
    const { runIngressShadow } = await import('../../../src/nyatos/shadow.js');
    callWithFallback.mockClear();
    await runIngressShadow({
      chatId: -999,
      message: { role: 'user', uid: 1, username: '', fullName: '', timestamp: 1, messageId: 1, textContent: 'x', isForwarded: false } as never,
      recent: [],
      botUid: 999,
      enabled: true,
      chatIds: [-100],
    });
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('records the live outcome separately so the ledger stays append-only', async () => {
    const { recordLiveOutcome } = await import('../../../src/nyatos/shadow.js');
    appendCognitiveEvent.mockClear();
    recordLiveOutcome({ chatId: -100, messageId: 77, outcome: 'silent' });
    const call = appendCognitiveEvent.mock.calls[0]![0] as { fact: Record<string, unknown>; dedupeKey: string };
    expect(call.fact).toMatchObject({ messageId: 77, outcome: 'silent' });
    expect(call.dedupeKey).toContain('shadow-live');
  });
});

describe('failed shadow calls are distinguishable in the ledger', () => {
  it('records verdict "failed" rather than folding into "silent"', async () => {
    const { runIngressShadow } = await import('../../../src/nyatos/shadow.js');
    callWithFallback.mockRejectedValueOnce(new Error('provider down'));
    appendCognitiveEvent.mockClear();
    await runIngressShadow({
      chatId: -100,
      message: { role: 'user', uid: 1, username: '', fullName: '', timestamp: Math.floor(Date.now() / 1000), messageId: 88, textContent: 'x', isForwarded: false } as never,
      recent: [],
      botUid: 999,
      enabled: true,
      chatIds: [],
    });
    const fact = (appendCognitiveEvent.mock.calls.at(-1)![0] as { fact: Record<string, unknown> }).fact;
    // Counting verdicts must never be able to mistake a failure for real silence:
    // that would understate how often the shadow wanted to speak and bias the
    // whole comparison toward "the rewrite agrees with the gates".
    expect(fact['shadowVerdict']).toBe('failed');
    expect(fact['failed']).toBe(true);
  });
});

describe('failure reasons are distinguishable (2026-09-18 token-budget bug)', () => {
  // A 600-token budget against a 5×500-char answer budget cut the model off
  // mid-JSON, and every such call was reported as a generic parse failure —
  // ~70% of samples, which silently biased the whole comparison. These tests
  // keep the specific reasons apart so that class of bug stays visible.

  it('reports truncation when JSON is cut off mid-object', async () => {
    callWithFallback.mockResolvedValueOnce({
      content: '{"act":"speak","bubbles":["主人醒了吗喵？刚才摸你的时候都没动静，是不是累到睡着啦🥺","',
    });
    const d = await decideShadow(frame());
    expect(d.why).toBe('shadow_truncated');
    expect(d.failed).toBe(true);
  });

  it('reports empty output separately', async () => {
    callWithFallback.mockResolvedValueOnce({ content: '   ' });
    expect((await decideShadow(frame())).why).toBe('shadow_empty');
  });

  it('reports a genuine parse failure as unparsed', async () => {
    callWithFallback.mockResolvedValueOnce({ content: '我觉得还是算了吧' });
    expect((await decideShadow(frame())).why).toBe('shadow_unparsed');
  });
});
