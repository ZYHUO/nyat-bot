import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ set: vi.fn().mockResolvedValue('OK') }) }));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotUid: () => 999,
  getBotIdentity: () => ({ uid: 999, username: 'hunhebi_bot', displayName: '啾咪囝', nicknames: ['啾咪囝', '啾咪'] }),
  getBotDisplayName: () => '啾咪囝',
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { parseRewardResponse } = await import('../../../src/pipeline/reward/reward-model.js');

describe('parseRewardResponse', () => {
  it('parses accept:true / false', () => {
    expect(parseRewardResponse('{"accept": true, "reasoning": "ok"}').accept).toBe(true);
    expect(parseRewardResponse('{"accept": false, "reasoning": "bad"}').accept).toBe(false);
  });

  it('parses ProactiveAgent-style judgement strings', () => {
    expect(parseRewardResponse('{"judgement":"accepted"}').accept).toBe(true);
    expect(parseRewardResponse('{"judgement":"rejected","reasoning":"interrupts"}').accept).toBe(false);
  });

  it('tolerates code fences and surrounding prose', () => {
    expect(parseRewardResponse('好的\n```json\n{"accept": false}\n```').accept).toBe(false);
  });

  it('fails OPEN (accept) on unparseable input', () => {
    expect(parseRewardResponse('not json at all').accept).toBe(true);
    expect(parseRewardResponse('').accept).toBe(true);
  });

  it('extracts reasoning when present', () => {
    expect(parseRewardResponse('{"accept": false, "reasoning": "群里在认真讨论"}').reasoning).toBe('群里在认真讨论');
  });
});
