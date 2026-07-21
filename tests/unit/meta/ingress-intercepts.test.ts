import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/env.js', () => ({
  env: () => ({
    MASTER_UID: 1,
    BOT_USERNAME: 'hunhebi_bot',
    META_SUBAGENT_ENABLED: true,
    META_SUBAGENT_CHAT_IDS: [] as number[],
  }),
}));

vi.mock('../../../src/tracking/user-profile.js', () => ({
  getMuteState: vi.fn(),
}));

import { getMuteState } from '../../../src/tracking/user-profile.js';
import {
  metaNeedsLegacyPipeline,
  metaMuteBlocksReply,
} from '../../../src/meta/ingress-intercepts.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

const baseMsg = (over: Partial<FormattedMessage> = {}): FormattedMessage => ({
  role: 'user',
  uid: 42,
  username: 'u',
  fullName: 'U',
  timestamp: 1,
  messageId: 1,
  textContent: 'hi',
  isForwarded: false,
  ...over,
});

describe('meta ingress classify', () => {
  beforeEach(() => {
    vi.mocked(getMuteState).mockReset();
  });

  it('routes slash and checkin/stats NL to legacy', () => {
    expect(metaNeedsLegacyPipeline(-100, '/cards', true)).toBe(true);
    expect(metaNeedsLegacyPipeline(-100, '帮我签到', true)).toBe(true);
    expect(metaNeedsLegacyPipeline(-100, '签到排行榜', true)).toBe(true);
    expect(metaNeedsLegacyPipeline(-100, '看看图鉴', true)).toBe(false);
    expect(metaNeedsLegacyPipeline(-100, '看看图鉴', false)).toBe(false);
    expect(metaNeedsLegacyPipeline(123, '看看图鉴', false)).toBe(false);
  });

  it('blocks hard-mute and soft-mute non-direct', () => {
    vi.mocked(getMuteState).mockReturnValue({ level: 2, temporary: false });
    expect(metaMuteBlocksReply(-100, baseMsg(), true)).toBe(true);

    vi.mocked(getMuteState).mockReturnValue({ level: 1, temporary: false });
    expect(metaMuteBlocksReply(-100, baseMsg(), false)).toBe(true);
    expect(metaMuteBlocksReply(-100, baseMsg(), true)).toBe(false);
  });
});
