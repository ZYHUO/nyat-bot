import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';
import { MetaRedisFixture } from '../../helpers/meta-redis.js';

const f = vi.hoisted(() => ({ redis: vi.fn(), send: vi.fn(), stop: vi.fn(),
  config: { QQ_ASSIGNMENTS_ENABLED: true },
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: f.redis }));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/pipeline/shared.js', () => ({
  sender: { sendDirect: f.send }, ADDRESSED_RULES: new Set(['mention_self', 'reply_to_self', 'turn_replan']),
}));
vi.mock('../../../src/tracking/user-profile.js', () => ({ muteUser: vi.fn(), unmuteUser: vi.fn() }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ lookupSentSticker: vi.fn(), recordStickerDislike: vi.fn(), getStickerScore: vi.fn() }));
vi.mock('../../../src/tracking/mood.js', () => ({ applyMoodEvent: vi.fn() }));
vi.mock('../../../src/pipeline/games/manager.js', () => ({ startGame: vi.fn(), stopGame: vi.fn() }));
vi.mock('../../../src/pipeline/games/guess-number.js', () => ({ createGuessNumberGame: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/platform/owner-context.js', () => ({ isConversationOwner: vi.fn(() => false) }));
vi.mock('../../../src/platform/identity-store.js', () => ({ isPlatformInternalId: (id: number) => id < -900_000 }));
vi.mock('../../../src/platform/onebot-assignment-store.js', () => ({ stopOneBotAssignmentsForChat: f.stop }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotIdentity: () => ({ username: '', nicknames: ['猫', '啾咪囝'] }) }));

import { tryCorrectionIntercept } from '../../../src/pipeline/stages/intercepts.js';
import { isCorrectionCooling, isLocallyCorrectionCooling } from '../../../src/pipeline/correction-cooldown.js';
let redis: MetaRedisFixture;
let chatId = -900_000;
const formatted = (textContent: string): FormattedMessage => ({ role: 'user', uid: 100, username: '', fullName: '群友',
  timestamp: 1, messageId: 8, textContent, isForwarded: false });
const intercept = (text: string, addressed = true) => tryCorrectionIntercept(chatId, formatted(text), { addressedRule: addressed ? 'direct' : 'passive' });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T12:00:00Z')); vi.clearAllMocks();
  chatId--; redis = new MetaRedisFixture(); f.redis.mockReturnValue(redis);
  f.send.mockResolvedValue(9); f.stop.mockReturnValue(1); f.config.QQ_ASSIGNMENTS_ENABLED = true;
});
afterEach(() => { vi.useRealTimers(); });

describe('real correction and participation stop boundary', () => {
  it.each(['@啾咪囝 停', '猫，停止参与', '安静', '别说了', '请闭嘴'])('directed human %s durably stops participation and really cools the group', async text => {
    expect(await intercept(text)).toBe(true);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(chatId);
    expect(await redis.get(`xxb:corrected:${chatId}`)).toBe('1');
    expect(await isCorrectionCooling(chatId)).toBe(true);
    expect(isLocallyCorrectionCooling(chatId)).toBe(true);
    expect(f.send).toHaveBeenCalledOnce();
  });

  it.each(['停', '安静', '你别说了', '他说停一下'])('unaddressed ordinary group text %s never revokes or cools', async text => {
    expect(await intercept(text, false)).toBe(false);
    expect(f.stop).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(await isCorrectionCooling(chatId)).toBe(false);
  });

  it.each(['猫，他说停一下', '猫，不要停下来', '猫，停止参与是什么意思', '猫，好安静，来聊天'])('addressing does not turn %s into a participation stop', async text => {
    await intercept(text);
    expect(f.stop).not.toHaveBeenCalled();
  });

  it('non-owner group members may stop; bots and anonymous inputs may not', async () => {
    expect(await intercept('停')).toBe(true);
    f.stop.mockClear();
    for (const extra of [{ isBot: true }, { isAnonymous: true }]) {
      expect(await tryCorrectionIntercept(chatId, { ...formatted('停'), ...extra }, { addressedRule: 'direct' })).toBe(false);
    }
    expect(f.stop).not.toHaveBeenCalled();
  });

  it('repeated stops do not add acknowledgement messages or extend the cooling window', async () => {
    await intercept('别说了');
    await vi.advanceTimersByTimeAsync(300_000);
    await intercept('停');
    expect(f.send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300_001);
    expect(await isCorrectionCooling(chatId)).toBe(false);
    expect(isLocallyCorrectionCooling(chatId)).toBe(false);
  });

  it('a feature-disabled installation still honors ordinary correction without reading assignments', async () => {
    f.config.QQ_ASSIGNMENTS_ENABLED = false;
    await intercept('别说了');
    expect(f.stop).not.toHaveBeenCalled();
    expect(await isCorrectionCooling(chatId)).toBe(true);
  });

  it('durable revocation failure still establishes temporary cooling without claiming the grant stopped', async () => {
    f.stop.mockImplementationOnce(() => { throw new Error('synthetic unavailable storage'); });
    expect(await intercept('停')).toBe(true);
    expect(await isCorrectionCooling(chatId)).toBe(true);
    expect(f.send).toHaveBeenCalledWith(chatId, '…知道了。本喵安静会儿。', 8);
  });

  it('a Redis outage retains the local send fence and still revokes the grant', async () => {
    vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('synthetic unavailable Redis'));
    expect(await intercept('停')).toBe(true);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(chatId);
    expect(isLocallyCorrectionCooling(chatId)).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  });
});
