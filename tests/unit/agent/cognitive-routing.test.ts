import { describe, expect, it } from 'vitest';
import { classifyCognitiveRoute, shouldApplyCognitiveRoute } from '../../../src/agent/cognitive-routing.js';

describe('cognitive routing', () => {
  it('keeps ordinary direct chat on the fast route', () => {
    const decision = classifyCognitiveRoute({ text: '晚上好', action: 'REPLY', replyPath: 'direct' });
    expect(decision.route).toBe('fast');
    expect(decision.shouldUseWorkspace).toBe(false);
    expect(decision.signals).toEqual([]);
  });

  it('routes explicit goals and open debt to deep with stable reasons', () => {
    const decision = classifyCognitiveRoute({ text: '请把这个目标持续关注下去', openDebtCount: 1 });
    expect(decision.route).toBe('deep');
    expect(decision.signals).toEqual(['open_debt', 'explicit_goal']);
    expect(decision.primarySignal).toBe('open_debt');
    expect(decision.reason).toBe('open_debt,explicit_goal');
  });

  it('treats planned lookup as a signal but does not overroute it alone', () => {
    const decision = classifyCognitiveRoute({ text: '查一下天气', replyPath: 'planned' });
    expect(decision.route).toBe('fast');
    expect(decision.signals).toEqual(['external_lookup']);
  });

  it('routes multi-step tools, recovery, and abnormal prediction errors deep', () => {
    const decision = classifyCognitiveRoute({
      requestedToolCount: 3,
      taskRecovery: true,
      predictionError: -0.7,
    });
    expect(decision.route).toBe('deep');
    expect(decision.signals).toEqual(['task_recovery', 'prediction_error', 'multi_step_tool']);
  });

  it('detects correction/conflict and high-risk side effects from text', () => {
    const decision = classifyCognitiveRoute({ text: '你搞错了，删掉这个并重新发布' });
    expect(decision.route).toBe('deep');
    expect(decision.signals).toContain('conflict_or_correction');
    expect(decision.signals).toContain('high_risk_side_effect');
    expect(decision.primarySignal).toBe('high_risk_side_effect');
  });

  it('keeps low-risk scheduler work in background', () => {
    const decision = classifyCognitiveRoute({ background: true, action: 'IGNORE' });
    expect(decision.route).toBe('background');
    expect(decision.shouldUseWorkspace).toBe(true);
  });

  it('never hides a high-risk background request', () => {
    const decision = classifyCognitiveRoute({ background: true, action: 'IGNORE', text: 'delete the file' });
    expect(decision.route).toBe('deep');
    expect(decision.primarySignal).toBe('high_risk_side_effect');
  });

  it('ignores non-finite counters and prediction errors', () => {
    const decision = classifyCognitiveRoute({ openDebtCount: Number.NaN, requestedToolCount: Number.POSITIVE_INFINITY, predictionError: Number.NaN, contextTokens: Number.NaN });
    expect(decision.route).toBe('fast');
    expect(decision.signals).toEqual([]);
    expect(decision.score).toBe(0);
  });

  it('keeps route behavior behind an explicit, chat-scoped rollout gate', () => {
    const deep = classifyCognitiveRoute({ explicitGoal: true });
    expect(shouldApplyCognitiveRoute(deep, { enabled: false }, -100)).toBe(false);
    expect(shouldApplyCognitiveRoute(deep, { enabled: true, chatIds: [-200] }, -100)).toBe(false);
    expect(shouldApplyCognitiveRoute(deep, { enabled: true, chatIds: [-100] }, -100)).toBe(true);
    expect(shouldApplyCognitiveRoute(deep, { enabled: true }, -100)).toBe(true);
    const fast = classifyCognitiveRoute({ text: '晚上好' });
    expect(shouldApplyCognitiveRoute(fast, { enabled: true }, -100)).toBe(false);
    expect(shouldApplyCognitiveRoute(deep, { enabled: true }, 0)).toBe(false);
  });
});
