import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

const mocks = vi.hoisted(() => ({ send: vi.fn(), goal: vi.fn(), owner: vi.fn() }));
vi.mock('../../../src/pipeline/shared.js', () => ({ sender: { sendDirect: mocks.send }, ADDRESSED_RULES: new Set() }));
vi.mock('../../../src/platform/owner-context.js', () => ({ isConversationOwner: mocks.owner }));
vi.mock('../../../src/agent/goals.js', () => ({ createGoal: mocks.goal }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ GOAL_MAX_ACTIVE: 5 }) }));
vi.mock('../../../src/tracking/user-profile.js', () => ({ muteUser: vi.fn(), unmuteUser: vi.fn() }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ lookupSentSticker: vi.fn(), recordStickerDislike: vi.fn(), getStickerScore: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/tracking/mood.js', () => ({ applyMoodEvent: vi.fn() }));
vi.mock('../../../src/pipeline/games/manager.js', () => ({ startGame: vi.fn(), stopGame: vi.fn() }));
vi.mock('../../../src/pipeline/games/guess-number.js', () => ({ createGuessNumberGame: vi.fn() }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
import { dispatchCommand } from '../../../src/pipeline/stages/intercepts.js';

beforeEach(() => { vi.clearAllMocks(); mocks.goal.mockReturnValue('goal-1'); mocks.owner.mockReturnValue(false); });
const formatted = (uid: number): FormattedMessage => ({ role: 'user', uid, username: '', fullName: 'user',
  messageId: 11, timestamp: 1800000000, textContent: '/watch 天气', isForwarded: false });

describe('platform-scoped watch owner permission', () => {
  it.each([123, 2 ** 52 + 1])('requires explicit platform owner permission for private ID %s', async id => {
    expect(await dispatchCommand(id, formatted(id), '/watch', '天气')).toBe(true);
    expect(mocks.goal).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith(id, expect.stringContaining('本平台主人'), 11);
    mocks.owner.mockReturnValue(true);
    expect(await dispatchCommand(id, formatted(id), '/watch', '天气')).toBe(true);
    expect(mocks.owner).toHaveBeenCalledWith(id, id);
    expect(mocks.goal).toHaveBeenCalledWith({ topic: '天气', origin: 'master', chatId: id }, 5);
  });

  it('rejects mismatched private identity, bot/anonymous actors and never expands group scope', async () => {
    mocks.owner.mockReturnValue(true);
    for (const msg of [formatted(124), { ...formatted(123), isBot: true }, { ...formatted(123), isAnonymous: true }]) {
      expect(await dispatchCommand(123, msg, '/watch', '天气')).toBe(true);
    }
    expect(await dispatchCommand(-123, formatted(123), '/watch', '天气')).toBe(false);
    expect(mocks.goal).not.toHaveBeenCalled();
  });
});
