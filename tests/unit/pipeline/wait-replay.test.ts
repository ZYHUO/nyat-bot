import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatJob, FormattedMessage } from '../../../src/shared/types.js';

const f = vi.hoisted(() => ({
  anchor: vi.fn(async () => {}),
  transition: vi.fn(async () => {}),
  agency: vi.fn(async () => ({ attempted: false, accepted: false })),
  heart: vi.fn(async () => ({ act: 'wait', why: 'still listening' })),
  gate: vi.fn(async () => ({ action: 'wait', waitSec: 9, reason: 'still listening' })),
  config: {
    HEART_ENABLED: true, TIMING_GATE_ENABLED: true, TIMING_WAIT_MIN_SEC: 5,
    TIMING_WAIT_MAX_SEC: 120, TURN_WAIT_RESUME_ENABLED: true,
  },
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/pipeline/judge/judge.js', () => ({ l0Rule: () => null, judge: vi.fn() }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: vi.fn(async () => []) }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({
  getChatState: vi.fn(async () => ({ state: 'RUNNING' })), getGateCooldownRemainingMs: vi.fn(async () => 0),
  isInContinuation: () => false, transitionToWait: f.transition, transitionToStop: vi.fn(),
  transitionToRunning: vi.fn(), recordGateContinue: vi.fn(),
}));
vi.mock('../../../src/pipeline/timing/gate.js', () => ({ runTimingGate: f.gate }));
vi.mock('../../../src/pipeline/turn/flags.js', () => ({ isTurnActorChat: () => true }));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({ setWaitAnchor: f.anchor }));
vi.mock('../../../src/pipeline/turn/obligation-store.js', () => ({ updateObligationState: vi.fn() }));
vi.mock('../../../src/pipeline/timing/defer.js', () => ({ scheduleGateDeferReeval: vi.fn(), hasDeferBudget: () => false }));
vi.mock('../../../src/pipeline/timing/state-store.js', () => ({ recordGateNoAction: vi.fn(async () => {}) }));
vi.mock('../../../src/pipeline/heart/engagement.js', () => ({
  computeEngagement: () => ({ budget: 1, factors: {} }), filterForTurnStart: () => [],
  HARD_PASS_BUDGET: 0.1, isBotMonologueTrail: () => false,
}));
vi.mock('../../../src/pipeline/heart/self-state.js', () => ({ composeSelfState: vi.fn(async () => ({ narration: '', energy: 1 })) }));
vi.mock('../../../src/pipeline/heart/decision.js', () => ({ heartDecision: f.heart }));
vi.mock('../../../src/pipeline/heart/mind.js', () => ({ noteThought: vi.fn() }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotDisplayName: () => 'fixture' }));
vi.mock('../../../src/agent/agency-wait-dispatch.js', () => ({ dispatchWaitViaAgency: f.agency }));
vi.mock('../../../src/tracking/self-history.js', () => ({ getSelfActSummary: vi.fn(), renderSelfActSummary: vi.fn() }));
vi.mock('../../../src/agent/cognitive-clock.js', () => ({ nextSelfWake: vi.fn(), renderPendingWake: vi.fn() }));
vi.mock('../../../src/tracking/repair.js', () => ({ findUnrepairedActs: vi.fn(), renderUnrepairedActs: vi.fn() }));
vi.mock('../../../src/pipeline/shared.js', () => ({
  TEMP_MUTE_CLEAR_RULES: new Set(), DIRECT_INTERACTION_RULES: new Set(), buildDeferEntry: vi.fn(),
}));
vi.mock('../../../src/pipeline/path-policy.js', () => ({ applyChatPathPolicy: vi.fn(async () => ({ replyPath: 'direct' })) }));
vi.mock('../../../src/pipeline/stages/intercepts.js', () => ({
  tryCorrectionIntercept: vi.fn(async () => false), tryMuteCommandIntercepts: vi.fn(async () => false),
  tryPreMuteIntercepts: vi.fn(async () => false), tryPostMuteIntercepts: vi.fn(async () => false),
}));
vi.mock('../../../src/pipeline/stages/deliver.js', () => ({ generateAndSendReplies: vi.fn() }));
vi.mock('../../../src/tracking/user-profile.js', () => ({ getMuteState: () => ({ level: 0 }), unmuteUser: vi.fn() }));
vi.mock('../../../src/shared/config.js', () => ({ loadCachedPrompt: () => '' }));
vi.mock('../../../src/tracking/sleep.js', () => ({ getSleepPhase: vi.fn(async () => 'awake'), sleepWakeDecision: vi.fn() }));
vi.mock('../../../src/tracking/sleep-queue.js', () => ({ clearSleepPending: vi.fn(), pushSleepPending: vi.fn() }));
vi.mock('../../../src/agent/cognitive-routing.js', () => ({ classifyCognitiveRoute: vi.fn(), shouldApplyCognitiveRoute: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/agent/cognitive-route-observations.js', () => ({ recordCognitiveRouteDecision: vi.fn() }));
vi.mock('../../../src/agent/cognitive-turn-runtime.js', () => ({ cognitiveTurnRuntime: {} }));

import { runHeartBranch } from '../../../src/pipeline/heart/heart.js';
import { runPostJudge } from '../../../src/pipeline/stages/post-judge.js';

async function run(branch: 'heart' | 'gate', replay = false, sleepCatchup = false) {
  const job: ChatJob = {
    type: 'message', chatId: -100, enqueuedAt: 100, update: {} as ChatJob['update'],
    turnContext: { isWaitReplay: replay, sleepCatchup, obligationId: 'obligation' },
  };
  const formatted = { messageId: 42, chatId: -100, uid: 7, textContent: 'hello', messageThreadId: 10 } as FormattedMessage;
  const e = f.config as Parameters<typeof runHeartBranch>[0]['e'];
  if (branch === 'heart') {
    return runHeartBranch({
      job, formatted, e, botUid: 99, botIdentity: { username: 'fixture', nicknames: [] },
      recentMessages: [], messagesLast5Min: 1, messagesLast1Hour: 1, focusLevel: undefined,
    });
  }
  return runPostJudge({
    job, formatted, e, botUid: 99, recentMessages: [], start: performance.now(), timings: {}, sleepBypass: true,
    judgeResult: { action: 'REPLY', level: 'L1_MICRO', replyPath: 'direct', latencyMs: 0 },
    lockState: { held: false, release: vi.fn(async () => {}) }, releaseHeldChatLock: vi.fn(async () => {}),
  });
}

beforeEach(() => vi.clearAllMocks());

describe.each(['heart', 'gate'] as const)('%s wait recovery', (branch) => {
  it('reevaluates once and does not rearm a timer when the result is still wait', async () => {
    await run(branch, true);
    expect(branch === 'heart' ? f.heart : f.gate).toHaveBeenCalledOnce();
    expect(f.anchor).not.toHaveBeenCalled();
    expect(f.agency).not.toHaveBeenCalled();
    expect(f.transition).not.toHaveBeenCalled();
  });

  it.each([false, true])('gives a fresh wait its own shared anchor and transport generation (sleep=%s)', async (sleep) => {
    await run(branch, sleep, sleep);
    const anchorCall = f.anchor.mock.calls[0] as unknown as [number, unknown, number, string];
    const generation = anchorCall[3];
    expect(generation).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.agency).toHaveBeenCalledWith(expect.objectContaining({ waitGeneration: generation, messageThreadId: 10 }));
    expect(f.transition).toHaveBeenCalledWith(-100, expect.any(Number), 42, 7, 'obligation', {
      waitGeneration: generation, messageThreadId: 10,
    });
    expect(f.anchor.mock.invocationCallOrder[0]).toBeLessThan(f.agency.mock.invocationCallOrder[0]!);
  });
});
