import { describe, it, expect, vi } from 'vitest';

// 只测称呼注入(nicknameHint/fallbackGreeting)。mock 掉 env/DB/redis/sender 等
// 重依赖,让 dm-proactive.ts 能干净导入。

vi.mock('../../../src/env.js', () => ({
  env: () => ({
    MASTER_UID: 6251541967,
    MASTER_UID_EXTRA: [] as number[],
    SLEEP_DM_ENABLED: true,
    DM_PROACTIVE_COOLDOWN_HOURS: 20,
    DM_GREET_AFFINITY_MIN: 40,
    DM_GREET_MAX_USERS: 2,
  }),
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotUid: vi.fn(() => 1),
  getBotIdentity: () => ({ uid: 1, username: 'hunhebi_bot', displayName: '啾咪囝', nicknames: ['啾咪囝', '啾咪'] }),
  getBotDisplayName: () => '啾咪囝',
}));
vi.mock('../../../src/pipeline/shared.js', () => ({ sender: { sendDirect: vi.fn() } }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/tracking/dm-state.js', () => ({
  hasDmEver: vi.fn(() => true),
  listDmEverUids: vi.fn(() => []),
}));
vi.mock('../../../src/tracking/dm-pending.js', () => ({
  peekDmPending: vi.fn(() => []),
  markDmPendingFlushed: vi.fn(),
}));
vi.mock('../../../src/tracking/user-affinity.js', () => ({
  getAggregatedAffinity: vi.fn(() => ({ affinity: 50 })),
}));
vi.mock('../../../src/tracking/user-profile.js', () => ({
  // 主人的 sender_tag 被学成了「妹妹」(真实数据),验证主人关系压过外号。
  getAggregatedUserTag: vi.fn((uid: number) => (uid === 6251541967 ? '妹妹' : '阿强')),
  // uid=222 设了 bot_tag「猫哥」(私聊"叫我猫哥"纠正过),验证 bot_tag 优先于群里外号。
  getBotTagForAddressing: vi.fn((chatId: number, uid: number) => (uid === 222 ? '猫哥' : null)),
}));

import { nicknameHint, fallbackGreeting } from '../../../src/pipeline/dm-proactive.js';

describe('DM 问候称呼:主人关系优先于学来的外号', () => {
  it('nicknameHint:主人 → 「主人」,不被学来的「妹妹」盖过', () => {
    const hint = nicknameHint(6251541967);
    expect(hint).toContain('主人');
    expect(hint).not.toContain('妹妹');
  });

  it('nicknameHint:其他人 → 用跨群外号', () => {
    expect(nicknameHint(999)).toBe('(对方你私下叫TA「阿强」)');
  });

  it('nicknameHint:bot_tag(bot 对他的称呼)优先于群里外号', () => {
    // uid=222:群里外号是「阿强」,但 bot_tag 是「猫哥」(私聊纠正过)→ 用猫哥。
    expect(nicknameHint(222)).toBe('(对方你私下叫TA「猫哥」)');
  });

  it('fallbackGreeting:主人 → 前缀「主人」', () => {
    const out = fallbackGreeting('morning', 6251541967);
    expect(out.startsWith('主人,')).toBe(true);
    expect(out).not.toContain('妹妹');
  });

  it('fallbackGreeting:其他人 → 前缀外号', () => {
    expect(fallbackGreeting('goodnight', 999).startsWith('阿强,')).toBe(true);
  });
});
