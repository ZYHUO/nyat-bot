import { describe, it, expect, vi, beforeEach } from 'vitest';

// gacha pickRarity 真实复用(纯函数,无副作用),其余依赖在 detect 测试里用不到
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ get: vi.fn(async () => null), set: vi.fn(async () => 'OK') }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ STICKER_BATTLE_ENABLED: true }) }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: vi.fn(), addAssistant: vi.fn() }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: vi.fn(), sendSticker: vi.fn() }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getReadyStickersByIntent: vi.fn(() => []), recordStickerSent: vi.fn() }));
vi.mock('../../../src/queue/chat-lock.js', () => ({ acquireChatLock: vi.fn(async () => vi.fn()) }));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: vi.fn(async () => false) }));

const { detectStickerWar } = await import('../../../src/pipeline/games/sticker-battle.js');
import type { FormattedMessage } from '../../../src/shared/types.js';

function sm(uid: number, isBot = false, sticker = true): FormattedMessage {
  return {
    role: isBot ? 'user' : 'user', uid, username: 'u' + uid, fullName: 'U', timestamp: uid, messageId: uid,
    textContent: sticker ? '' : 'hi', isForwarded: false, isBot,
    sticker: sticker ? { emoji: '😺', fileId: 'f' + uid, fileUniqueId: 'u' + uid } : undefined,
  } as FormattedMessage;
}

describe('detectStickerWar', () => {
  it('≥3 张贴纸来自 ≥2 人 → 是贴纸战', () => {
    expect(detectStickerWar([sm(1), sm(2), sm(1)])).toBe(true);
    expect(detectStickerWar([sm(7, false, false), sm(1), sm(2), sm(3)])).toBe(true);
  });

  it('贴纸够多但只有 1 个人 → 不算(自嗨不算战)', () => {
    expect(detectStickerWar([sm(1), sm(1), sm(1)])).toBe(false);
  });

  it('贴纸不够 3 张 → 不算', () => {
    expect(detectStickerWar([sm(1), sm(2), sm(3, false, false)])).toBe(false);
  });

  it('bot/自己发的贴纸不计入', () => {
    const botSticker = { ...sm(9), isBot: true };
    const selfSticker = { ...sm(8), role: 'assistant' as const };
    expect(detectStickerWar([botSticker, selfSticker, sm(1)])).toBe(false); // 只 1 张真人贴纸
  });

  it('只看最近窗口(早的贴纸战滚出窗口不算)', () => {
    const old = [sm(1), sm(2), sm(3)];
    const recentText = Array.from({ length: 6 }, (_, k) => sm(20 + k, false, false));
    expect(detectStickerWar([...old, ...recentText])).toBe(false);
  });
});
