import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';
import type { MetaWaitAnchor } from '../../../src/meta/timing-adapter.js';
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
const f = vi.hoisted(() => ({
  config: { HEART_ENABLED: true, META_HEART_ENABLED: true, META_HEART_BYPASS_CHAT_IDS: [],
    TIMING_GATE_ENABLED: true, META_PENDING_INTENT_ENABLED: false, META_ACTIVATED_AT_SEC: 100,
    ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: 'bot-1', ONEBOT_ALLOWED_GROUP_IDS: '' },
  scope: { platform: 'telegram', accountId: 'bot-1', chatId: -42, conversationKind: 'group', threadId: 9 },
  generation: 'generation-1' as string | undefined,
  recent: [] as FormattedMessage[], heart: vi.fn(), timing: vi.fn(), ingest: vi.fn(),
  answered: vi.fn(), recalled: vi.fn(), muted: vi.fn(), allowed: vi.fn(), sleep: vi.fn(), bypass: vi.fn(), pending: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/allowlist/allowlist.js', () => ({ isGroupAllowed: f.allowed }));
vi.mock('../../../src/allowlist/bot-flow.js', () => ({ configFromEnv: () => ({}) }));
vi.mock('../../../src/shared/privacy-scope.js', () => ({ resolveConversationScope: () => f.scope }));
vi.mock('../../../src/platform/identity-store.js', () => ({ findConversationRef: () => ({ idNamespace: 'qq-number', id: 'group-123' }),
  findMessageRef: (_chatId: number, messageId: number) => ({ id: String(messageId) }), PLATFORM_INTERNAL_ID_BASE: 2 ** 50 }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: vi.fn(async () => f.recent) }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ getChatState: vi.fn(async () => ({ state: 'RUNNING', waitGeneration: f.generation })) }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: f.recalled }));
vi.mock('../../../src/subagent/activation-policy.js', () => ({ checkCodeActActivation: () => ({ allowed: true }) }));
vi.mock('../../../src/tracking/sleep.js', () => ({ getSleepPhase: f.sleep }));
vi.mock('../../../src/meta/wait-recheck-slot.js', () => ({ withWaitRecheckSlot: async (_candidate: unknown, work: () => Promise<void>) => work() }));
vi.mock('../../../src/meta/speaker-burst.js', () => ({ isInFlightCodeActForUser: () => false }));
vi.mock('../../../src/meta/index.js', () => ({ getAttentionAccumulator: () => ({ ingestAsync: f.ingest }) }));
vi.mock('../../../src/meta/answered.js', () => ({ isMessageAnswered: f.answered }));
vi.mock('../../../src/meta/ingress-intercepts.js', () => ({ metaMuteBlocksReply: f.muted }));
vi.mock('../../../src/meta/pending-intent.js', () => ({ assertInputBatchCurrent: f.pending, hasUnansweredIntentRevision: () => false }));
vi.mock('../../../src/meta/heart-route.js', async importOriginal => ({ ...await importOriginal<object>(), hasTimedBypass: f.bypass }));
vi.mock('../../../src/meta/heart-adapter.js', () => ({ evaluateMetaHeart: f.heart }));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ evaluateMetaTiming: f.timing }));
import { recheckMetaWaitAnchor } from '../../../src/meta/wait-recheck.js';
const makeMessage = (messageId = 7, uid = 5): FormattedMessage => ({ role: 'user', messageId, uid,
  username: 'synthetic', fullName: 'Synthetic', textContent: 'synthetic question', timestamp: 101,
  messageThreadId: 9, isForwarded: false,
  eventIdentity: createMessageEventIdentity({ ref: { conversation: { platform: 'telegram', accountId: 'bot-1',
    conversationKind: 'group', idNamespace: 'telegram', id: '-42', threadId: '9' }, id: String(messageId) },
  occurredAt: 101_000, receivedAt: 101_000 }) });
let anchor: MetaWaitAnchor;
const run = () => recheckMetaWaitAnchor(anchor, { waitGeneration: 'generation-1', anchorMessageId: 7 });
beforeEach(() => {
  vi.clearAllMocks();
  f.scope.platform = 'telegram'; f.scope.accountId = 'bot-1'; f.scope.conversationKind = 'group'; f.generation = 'generation-1';
  f.config.HEART_ENABLED = true; f.config.META_PENDING_INTENT_ENABLED = false;
  f.pending.mockImplementation(() => {}); f.allowed.mockResolvedValue(true); f.sleep.mockResolvedValue('awake');
  f.bypass.mockResolvedValue(false); f.answered.mockResolvedValue(false); f.recalled.mockReturnValue(false); f.muted.mockReturnValue(false);
  f.heart.mockResolvedValue({ verdict: 'allow', layer: 'L1', reason: 'heart:reply', targetMessageIds: [7] });
  f.timing.mockResolvedValue({ verdict: 'allow', reason: 'continue' });
  f.recent = [makeMessage()];
  anchor = { chatId: -42, layer: 'L1', reason: 'heart:wait', createdAt: 101_000, messageId: 7, userId: 5,
    messageThreadId: 9, contextScope: { ...f.scope } as MetaWaitAnchor['contextScope'],
    waitGeneration: 'generation-1', heartMessages: structuredClone(f.recent) };
  f.ingest.mockImplementation(async (_item, options) => await options.beforePersist() ? {} : null);
});
describe('claimed Meta WAIT reconsideration', () => {
  it('rechecks scoped current input then persists only an allowed target with a live fence', async () => {
    await run();
    expect(f.heart).toHaveBeenCalledWith(expect.objectContaining({ waitResume: true, targetMessageIds: [7],
      formatted: anchor.heartMessages![0], isCurrent: expect.any(Function), beforeEffect: expect.any(Function) }));
    expect(f.ingest).toHaveBeenCalledOnce();
    expect(f.ingest).toHaveBeenCalledWith(expect.objectContaining({ chatId: -42, userId: 5, messageId: 7,
      messageThreadId: 9, reason: 'wait_resume:heart:reply' }), expect.objectContaining({ requireDurable: true, beforePersist: expect.any(Function) }));
    expect(f.sleep).toHaveBeenCalledWith(undefined, true, true);
    expect(f.bypass).toHaveBeenCalledWith(-42, true);
  });
  it.each(['wait', 'pass'])('permits %s silence without scheduling another timer or Attention', async act => {
    f.heart.mockResolvedValue({ verdict: 'silence', layer: 'L1', reason: `heart_${act}` });
    await run(); expect(f.heart).toHaveBeenCalledOnce(); expect(f.ingest).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'answered', 'recalled', 'muted', 'sleep', 'disallowed', 'unavailable', 'pending'])('blocks %s before Heart', async kind => {
    if (kind === 'cancel') f.generation = undefined;
    if (kind === 'answered') f.answered.mockResolvedValue(true);
    if (kind === 'recalled') f.recalled.mockReturnValue(true);
    if (kind === 'muted') f.muted.mockReturnValue(true);
    if (kind === 'sleep') f.sleep.mockResolvedValue('deep');
    if (kind === 'disallowed') f.allowed.mockResolvedValue(false);
    if (kind === 'unavailable') f.sleep.mockRejectedValue(new Error('offline'));
    if (kind === 'pending') f.pending.mockImplementation(() => { throw Error('cancelled'); });
    await run(); expect(f.heart).not.toHaveBeenCalled(); expect(f.ingest).not.toHaveBeenCalled();
  });
  it.each(['account', 'thread', 'private', 'edited', 'missing', 'mixed_context'])('rejects stale or mixed %s provenance', async kind => {
    if (kind === 'account') f.scope.accountId = 'new-account';
    if (kind === 'thread') anchor.heartMessages![0]!.messageThreadId = 10;
    if (kind === 'private') f.scope.conversationKind = 'private';
    if (kind === 'edited') f.recent[0] = { ...f.recent[0]!, textContent: 'edited question' };
    if (kind === 'missing') f.recent = [];
    if (kind === 'mixed_context') f.recent.push({ ...makeMessage(8), messageThreadId: 10 });
    await run(); expect(f.heart).not.toHaveBeenCalled(); expect(f.ingest).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'new_message', 'edit', 'answered'])('discards a model reply after %s during evaluation', async kind => {
    f.heart.mockImplementation(async () => {
      if (kind === 'cancel') f.generation = 'new-generation';
      if (kind === 'new_message') f.recent.push(makeMessage(8));
      if (kind === 'edit') f.recent[0] = { ...f.recent[0]!, textContent: 'edited' };
      if (kind === 'answered') f.answered.mockResolvedValue(true);
      return { verdict: 'allow', layer: 'L1', reason: 'heart:reply', targetMessageIds: [7] };
    });
    await run(); expect(f.heart).toHaveBeenCalledOnce(); expect(f.ingest).not.toHaveBeenCalled();
  });
  it('checks again inside Attention before persistence', async () => {
    let persisted = false;
    f.ingest.mockImplementation(async (_item, options) => {
      f.generation = undefined; if (await options.beforePersist()) persisted = true; return null;
    });
    await run(); expect(f.ingest).toHaveBeenCalledOnce(); expect(persisted).toBe(false);
  });
  it('Heart off reuses the timing gate and never treats expiry as direct bypass', async () => {
    f.config.HEART_ENABLED = false; anchor.layer = 'L0'; await run();
    expect(f.heart).not.toHaveBeenCalled();
    expect(f.timing).toHaveBeenCalledWith(expect.objectContaining({ waitResume: true, isDirect: false, layer: 'L0' }));
    expect(f.ingest).toHaveBeenCalledOnce();
  });
  it.each([undefined, [], [999]])('does not guess a multi-author target from %j', async targetMessageIds => {
    const earlier = makeMessage(6, 4); f.recent.unshift(earlier); anchor.heartMessages!.unshift(structuredClone(earlier));
    f.heart.mockResolvedValue({ verdict: 'allow', layer: 'L1', reason: 'heart:reply', targetMessageIds });
    await run(); expect(f.heart).toHaveBeenCalledOnce(); expect(f.ingest).not.toHaveBeenCalled();
  });
  it('honors selected author instead of assigning the last speaker', async () => {
    const earlier = makeMessage(6, 4); f.recent.unshift(earlier); anchor.heartMessages!.unshift(structuredClone(earlier));
    f.heart.mockResolvedValue({ verdict: 'allow', layer: 'L1', reason: 'heart:reply', targetMessageIds: [6] });
    await run(); expect(f.ingest).toHaveBeenCalledWith(expect.objectContaining({ messageId: 6, userId: 4 }), expect.anything());
  });
  it('preserves an earlier distinct quote using only the latest frozen author revision', async () => {
    const ref = { laneKey: 'lane', intentId: 'intent', revision: 1, platform: 'telegram' as const,
      accountId: 'bot-1', chatId: -42, senderId: 5, threadId: 9 };
    const earlier = { ...makeMessage(6), pendingIntent: ref,
      replyTo: { messageId: 2, uid: 8, fullName: 'A', textSnippet: 'question A' } };
    const latest = { ...makeMessage(7), pendingIntent: { ...ref, revision: 2 },
      replyTo: { messageId: 3, uid: 9, fullName: 'B', textSnippet: 'question B' } };
    f.recent = [earlier, latest]; anchor.heartMessages = structuredClone(f.recent); anchor.targetMessageIds = [6, 7];
    f.heart.mockResolvedValue({ verdict: 'allow', layer: 'L1', reason: 'heart:reply', targetMessageIds: [6] });
    await run();
    expect(f.heart).toHaveBeenCalledWith(expect.objectContaining({ targetMessageIds: [6, 7] }));
    expect(f.ingest).toHaveBeenCalledWith(expect.objectContaining({ messageId: 6, pendingIntent: { ...ref, revision: 2 },
      waitRecovery: { generation: 'generation-1', chatId: -42, platform: 'telegram', accountId: 'bot-1', threadId: 9 },
      payload: expect.objectContaining({ heartBatchTarget: true, replyTo: earlier.replyTo }) }), expect.anything());
  });
  it('does not retain direct privilege after the referenced ongoing conversation ends', async () => {
    anchor.addressed = true; anchor.ongoingFollowup = true;
    await run(); expect(f.heart).not.toHaveBeenCalled(); expect(f.ingest).not.toHaveBeenCalled();
  });

  it('QQ reconsideration keeps its latest anchor contract without a Telegram-only selector', async () => {
    f.scope.platform = 'qq';
    f.recent = [makeMessage(6, 4), makeMessage(7, 5)].map(message => ({ ...message,
      eventIdentity: createMessageEventIdentity({ ref: { conversation: { platform: 'qq', accountId: 'bot-1',
        conversationKind: 'group', idNamespace: 'qq-number', id: 'group-123', threadId: '9' }, id: String(message.messageId) },
        occurredAt: 101_000, receivedAt: 101_000 }) }));
    anchor.contextScope = { ...f.scope } as MetaWaitAnchor['contextScope']; anchor.heartMessages = structuredClone(f.recent);
    f.heart.mockResolvedValue({ verdict: 'allow', layer: 'L1', reason: 'heart:reply' });
    await run();
    expect(f.heart).toHaveBeenCalledWith(expect.objectContaining({ targetMessageIds: undefined, batchMessages: anchor.heartMessages }));
    expect(f.ingest).toHaveBeenCalledOnce();
    expect(f.ingest).toHaveBeenCalledWith(expect.objectContaining({ messageId: 7, userId: 5 }), expect.anything());
  });

});
