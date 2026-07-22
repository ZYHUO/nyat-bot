import { beforeEach, describe, expect, it, vi } from 'vitest';

const duplicateMock = vi.fn(async () => false);
const rateLimitMock = vi.fn(async () => false);
const isTurnActorChatMock = vi.fn(() => true);
const formatMessageMock = vi.fn();
const getActiveObligationIdMock = vi.fn(async () => 'active-1');
const getObligationMock = vi.fn(async () => ({
  id: 'active-1',
  chatId: -100,
  anchorMessageId: 1,
  anchorUid: 1,
  anchorFullName: 'A',
  targetUid: 1,
  targetFullName: 'A',
  kind: 'mention',
  state: 'pending',
  priority: 100,
  createdAt: 1,
  updatedAt: 1,
  directInteraction: true,
  mustReplyStrong: true,
  relatedMessageIds: [1],
  triggerUids: [1],
}));
const updateObligationStateMock = vi.fn(async () => null);
const detectReplyObligationMock = vi.fn(() => ({
  id: 'new-obl',
  chatId: -100,
  targetUid: 1,
  mustReplyStrong: true,
}));
const saveObligationMock = vi.fn(async () => {});
const supersedeActiveObligationMock = vi.fn(async () => {});
const setActiveObligationMock = vi.fn(async () => {});
const appendPendingMock = vi.fn(async () => ({ count: 1, firstPendingAt: 0 }));
const scheduleTurnMock = vi.fn(async () => {});
const isCancelMock = vi.fn(() => true);

vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    })),
  },
}));
vi.mock('../../../src/bot/middleware/dedup.js', () => ({ isDuplicate: (...args: unknown[]) => duplicateMock(...args) }));
vi.mock('../../../src/bot/middleware/rate-limit.js', () => ({ isRateLimited: (...args: unknown[]) => rateLimitMock(...args) }));
vi.mock('../../../src/queue/producer.js', () => ({ enqueue: vi.fn(async () => {}) }));
vi.mock('../../../src/pipeline/timing/direct-interaction.js', () => ({ detectDirectInteraction: vi.fn(() => 'mention') }));
vi.mock('../../../src/pipeline/turn/actor.js', () => ({ isTurnActorChat: (...args: unknown[]) => isTurnActorChatMock(...args) }));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({ appendPending: (...args: unknown[]) => appendPendingMock(...args) }));
vi.mock('../../../src/pipeline/turn/abort-registry.js', () => ({ interruptGeneration: vi.fn() }));
vi.mock('../../../src/pipeline/turn/focus.js', () => ({ bumpFocus: vi.fn(async () => {}) }));
vi.mock('../../../src/queue/turn-scheduler.js', () => ({ scheduleTurn: (...args: unknown[]) => scheduleTurnMock(...args) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ BOT_USERNAME: 'xxb_bot', BOT_NICKNAMES: ['xxb'] }) }));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotUid: () => 9,
  getBotIdentity: () => ({ uid: 9, username: 'hunhebi_bot', displayName: '啾咪囝', nicknames: ['啾咪囝', '啾咪'] }),
}));
vi.mock('../../../src/pipeline/formatter.js', () => ({ formatMessage: (...args: unknown[]) => formatMessageMock(...args) }));
vi.mock('../../../src/pipeline/turn/obligation-detect.js', () => ({
  detectReplyObligation: (...args: unknown[]) => detectReplyObligationMock(...args),
  isObligationCancelMessage: (...args: unknown[]) => isCancelMock(...args),
}));
vi.mock('../../../src/pipeline/turn/obligation-store.js', () => ({
  saveObligation: (...args: unknown[]) => saveObligationMock(...args),
  setActiveObligation: (...args: unknown[]) => setActiveObligationMock(...args),
  supersedeActiveObligation: (...args: unknown[]) => supersedeActiveObligationMock(...args),
  getActiveObligationId: (...args: unknown[]) => getActiveObligationIdMock(...args),
  getObligation: (...args: unknown[]) => getObligationMock(...args),
  updateObligationState: (...args: unknown[]) => updateObligationStateMock(...args),
}));

import { registerMessageHandlers } from '../../../src/bot/handlers/message.js';

function makeBot() {
  const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
  return {
    handlers,
    on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void>) => {
      handlers.set(event, handler);
    }),
  };
}

describe('message obligation cancel handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    formatMessageMock.mockReturnValue({
      role: 'user',
      uid: 1,
      username: 'a',
      fullName: 'A',
      timestamp: 0,
      messageId: 2,
      textContent: '算了不用回了',
      isForwarded: false,
    });
  });

  it('drops active obligation without creating a replacement obligation', async () => {
    const bot = makeBot();
    registerMessageHandlers(bot as never);
    const handler = bot.handlers.get('message');
    expect(handler).toBeDefined();

    await handler!({
      message: {
        chat: { id: -100 },
        message_id: 2,
        from: { id: 1, username: 'a', first_name: 'A' },
        text: '算了不用回了',
      },
      update: {
        message: {
          chat: { id: -100, type: 'group' },
          message_id: 2,
          from: { id: 1, username: 'a', first_name: 'A' },
          text: '算了不用回了',
        },
      },
    });

    expect(updateObligationStateMock).toHaveBeenCalledWith(-100, 'active-1', 'dropped', { reason: 'user_cancelled' });
    expect(detectReplyObligationMock).not.toHaveBeenCalled();
    expect(saveObligationMock).not.toHaveBeenCalled();
  });
});
