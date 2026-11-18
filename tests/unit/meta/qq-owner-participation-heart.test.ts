import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';
import type { OneBotAssignment } from '../../../src/platform/onebot-assignment-store.js';

const f = vi.hoisted(() => ({
  heart: vi.fn(), active: vi.fn(), cooling: vi.fn(), suppressed: vi.fn(), monologue: vi.fn(),
  ingest: vi.fn(), redisSet: vi.fn(), wait: vi.fn(), reaction: vi.fn(), missed: vi.fn(),
  config: { HEART_ENABLED: true, QQ_ASSIGNMENTS_ENABLED: true, TIMING_WAIT_MIN_SEC: 8, DURABLE_INGRESS_ENABLED: false },
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotDisplayName: () => '猫', getBotUid: () => 2 }));
vi.mock('../../../src/platform/identity-store.js', () => ({ isPlatformInternalId: (id: number) => Math.abs(id) > 10_000 }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: () => false }));
vi.mock('../../../src/platform/onebot-assignment-store.js', () => ({ activeOneBotAssignment: f.active }));
vi.mock('../../../src/pipeline/correction-cooldown.js', () => ({ isCorrectionCooling: f.cooling }));
vi.mock('../../../src/pipeline/heart/decision.js', () => ({ heartDecision: f.heart }));
vi.mock('../../../src/pipeline/heart/self-state.js', () => ({ composeSelfState: async () => ({ narration: '' }) }));
vi.mock('../../../src/pipeline/heart/engagement.js', () => ({
  computeEngagement: () => ({ budget: 0.8, note: null }), HARD_PASS_BUDGET: 0.12, isBotMonologueTrail: f.monologue,
}));
vi.mock('../../../src/pipeline/heart/mind.js', () => ({ noteThought: vi.fn() }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: async () => [] }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({
  getChatState: async () => ({ lastBotReplyAt: 0 }), getGateCooldownRemainingMs: async () => 0,
  isInContinuation: () => false, transitionToWait: async () => {},
}));
vi.mock('../../../src/pipeline/timing/state-store.js', () => ({ recordGateNoAction: vi.fn() }));
vi.mock('../../../src/meta/heart-refractory.js', () => ({
  shouldSuppressMetaHeartElevate: f.suppressed,
  shouldSuppressMetaHeartDispatch: async () => false,
  armMetaHeartRefractory: async () => true,
}));
vi.mock('../../../src/meta/pending-intent.js', () => ({ assertInputBatchCurrent: vi.fn() }));
vi.mock('../../../src/meta/index.js', () => ({ getAttentionAccumulator: () => ({ ingestAsync: f.ingest }) }));
vi.mock('../../../src/meta/flags.js', () => ({ isMetaSubagentChat: () => true }));
vi.mock('../../../src/meta/ingress-intercepts.js', () => ({ metaMuteBlocksReply: () => false }));
vi.mock('../../../src/meta/speaker-burst.js', () => ({ isInFlightCodeActForUser: () => false }));
vi.mock('../../../src/meta/missed.js', () => ({ noteMissed: f.missed }));
vi.mock('../../../src/pipeline/reactions.js', () => ({ pickReactionEmoji: () => '👀' }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ reactToMessage: f.reaction }));
vi.mock('../../../src/subagent/task-store.js', () => ({ isCodeActBusy: async () => false }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ set: f.redisSet }) }));
vi.mock('../../../src/agent/agency-wait-dispatch.js', () => ({ dispatchWaitViaAgency: f.wait }));

import { evaluateMetaHeart } from '../../../src/meta/heart-adapter.js';
import { processQqHeartBatch } from '../../../src/meta/qq-heart-processor.js';

const GROUP = -10_001;
const message = (): FormattedMessage => ({ role: 'user', uid: 10_003, username: '', fullName: '群友',
  timestamp: Math.floor(Date.now() / 1000), messageId: 10_004, textContent: '这次旅行的风景很好', isForwarded: false });
const grant = (): OneBotAssignment => ({ id: 'grant', accountId: '42', ownerId: '99', controllerChatId: 10_002,
  targetChatId: GROUP, targetGroupId: '123', createdAt: Date.now() - 5000, expiresAt: Date.now() + 600_000,
  mode: 'participate', maxMessages: 4, reservedMessages: 1, acknowledgedMessages: 1, minIntervalMs: 60_000,
  publicText: '只讨论本群的旅行安排', state: 'active' });
const evaluate = () => evaluateMetaHeart({ chatId: GROUP, formatted: message(), layer: 'L2' });

beforeEach(() => {
  vi.clearAllMocks(); f.config.QQ_ASSIGNMENTS_ENABLED = true;
  f.config.DURABLE_INGRESS_ENABLED = false;
  f.heart.mockResolvedValue({ act: 'reply', path: 'chat', why: '接旅行话题' });
  f.active.mockReturnValue(grant()); f.cooling.mockResolvedValue(false);
  f.suppressed.mockResolvedValue(false); f.monologue.mockReturnValue(false);
  f.redisSet.mockResolvedValue('OK'); f.wait.mockResolvedValue({ attempted: false });
});

describe('QQ bounded participation remains a scoped Heart decision', () => {
  it('ordinary unmentioned input gets only grant facts and remains L1, not addressed', async () => {
    f.active.mockReturnValue({ ...grant(), controllerPrivateText: '不得进入目标群的私聊原文' });
    expect(await evaluate()).toMatchObject({ verdict: 'allow', layer: 'L1', qqAssignmentId: 'grant' });
    const input = f.heart.mock.calls[0]![0];
    expect(input.addressed).toBe(false);
    expect(input.ownerParticipation).toEqual({ expiresAt: expect.any(Number), remainingMessages: 3, minIntervalMs: 60_000,
      publicTopic: '只讨论本群的旅行安排' });
    expect(JSON.stringify(input)).not.toContain('不得进入目标群的私聊原文');
    expect(f.active).toHaveBeenCalledWith(GROUP);
  });

  it.each(['pass', 'wait', 'react'])('the owner grant may choose %s, with no out-of-budget reaction or scheduled continuation', async act => {
    f.heart.mockResolvedValue({ act, path: 'chat', why: '不抢话' });
    expect(await evaluate()).toMatchObject({ verdict: 'silence', reason: `heart_assignment_${act}` });
    expect(f.wait).not.toHaveBeenCalled(); expect(f.redisSet).not.toHaveBeenCalled();
    expect(f.reaction).not.toHaveBeenCalled(); expect(f.missed).not.toHaveBeenCalled();
  });

  it('preserves refractory and monologue filters with an active grant', async () => {
    f.suppressed.mockResolvedValue(true);
    expect(await evaluate()).toMatchObject({ reason: 'heart_refractory' });
    expect(f.heart).not.toHaveBeenCalled();
    f.suppressed.mockResolvedValue(false); f.monologue.mockReturnValue(true);
    expect(await evaluate()).toMatchObject({ reason: 'heart_bot_monologue' });
    expect(f.heart).not.toHaveBeenCalled();
  });

  it('no grant or disabled feature keeps ordinary participation without assignment facts', async () => {
    f.active.mockReturnValue(null);
    expect(await evaluate()).toMatchObject({ verdict: 'allow', layer: 'L1' });
    expect(f.heart.mock.calls[0]![0].ownerParticipation).toBeUndefined();
    vi.clearAllMocks(); f.config.QQ_ASSIGNMENTS_ENABLED = false;
    await evaluate(); expect(f.active).not.toHaveBeenCalled();
  });

  it('reconsiders a saved ordinary WAIT without acquiring a current grant or its public topic', async () => {
    const result = await evaluateMetaHeart({ chatId: GROUP, formatted: message(), layer: 'L2', waitResume: true });
    expect(f.active).not.toHaveBeenCalled();
    expect(f.heart).toHaveBeenCalledOnce();
    expect(f.heart.mock.calls[0]![0].ownerParticipation).toBeUndefined();
    expect(result).toMatchObject({ verdict: 'allow', layer: 'L1' });
    expect(result.qqAssignmentId).toBeUndefined();
  });

  it.each(['expired', 'exhausted', 'before_grant', 'old_message'])('does not inject %s participation', async reason => {
    const assignment = grant();
    if (reason === 'expired') assignment.expiresAt = Date.now() - 1;
    if (reason === 'exhausted') assignment.reservedMessages = assignment.maxMessages;
    if (reason === 'before_grant') assignment.createdAt = Date.now() + 1000;
    f.active.mockReturnValue(assignment);
    const formatted = message();
    if (reason === 'old_message') formatted.timestamp -= 301;
    await evaluateMetaHeart({ chatId: GROUP, formatted, layer: 'L2' });
    expect(f.heart.mock.calls[0]![0].ownerParticipation).toBeUndefined();
  });

  it('discards an in-flight decision when the grant stops or expires, without another input', async () => {
    f.active.mockReturnValueOnce(grant()).mockReturnValue(null);
    expect(await evaluate()).toMatchObject({ verdict: 'silence', reason: 'heart_assignment_changed' });
    expect(await evaluate()).toMatchObject({ verdict: 'allow', layer: 'L1' });
    expect(f.heart.mock.calls[1]![0].ownerParticipation).toBeUndefined();
  });

  it('correction cooling suppresses before Heart and after an already-started model call', async () => {
    f.cooling.mockResolvedValue(true);
    expect(await evaluate()).toMatchObject({ verdict: 'silence', reason: 'heart_correction_cooling' });
    expect(f.heart).not.toHaveBeenCalled();
    f.cooling.mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await evaluate()).toMatchObject({ verdict: 'silence', reason: 'heart_correction_cooling' });
    expect(f.heart).toHaveBeenCalledOnce();
  });

  it('the durable QQ batch processor preserves the host assignment marker on Attention', async () => {
    f.config.DURABLE_INGRESS_ENABLED = true;
    const formatted = message();
    await processQqHeartBatch([{ chatId: GROUP, formatted, layer: 'L2', addressed: false }], new AbortController().signal);
    expect(f.ingest).toHaveBeenCalledWith(expect.objectContaining({ chatId: GROUP, messageId: formatted.messageId,
      layer: 'L1', qqAssignmentId: 'grant' }), { requireDurable: true });
  });
});
