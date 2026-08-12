import { describe, expect, it } from 'vitest';
import { isBotMonologueTrail } from '../../../../src/pipeline/heart/engagement.js';
import type { FormattedMessage } from '../../../../src/shared/types.js';

function msg(
  partial: Partial<FormattedMessage> & { role: 'user' | 'assistant'; uid: number; messageId: number },
): FormattedMessage {
  return {
    username: '',
    fullName: '',
    timestamp: Math.floor(Date.now() / 1000),
    textContent: 'x',
    isForwarded: false,
    ...partial,
  };
}

describe('isBotMonologueTrail', () => {
  const bot = 1;

  it('true when prior trail is bot-dominated and ends with bot', () => {
    // After collapse: U B U B U B B(end) → 6 rounds, bot=4 ≥ half and ≥3, ends with bot
    const recent = [
      msg({ role: 'user', uid: 9, messageId: 1 }),
      msg({ role: 'assistant', uid: bot, messageId: 2 }),
      msg({ role: 'user', uid: 8, messageId: 3 }),
      msg({ role: 'assistant', uid: bot, messageId: 4 }),
      msg({ role: 'user', uid: 7, messageId: 5 }),
      msg({ role: 'assistant', uid: bot, messageId: 6 }),
      msg({ role: 'assistant', uid: bot, messageId: 7 }),
      msg({ role: 'user', uid: 6, messageId: 99 }), // current — excluded
    ];
    expect(isBotMonologueTrail(recent, bot, 8, 99)).toBe(true);
  });

  it('false when last prior message is a human', () => {
    const recent = [
      msg({ role: 'assistant', uid: bot, messageId: 1 }),
      msg({ role: 'assistant', uid: bot, messageId: 2 }),
      msg({ role: 'user', uid: 9, messageId: 3 }),
      msg({ role: 'user', uid: 8, messageId: 99 }),
    ];
    expect(isBotMonologueTrail(recent, bot, 8, 99)).toBe(false);
  });

  it('false when window too short', () => {
    const recent = [
      msg({ role: 'assistant', uid: bot, messageId: 1 }),
      msg({ role: 'user', uid: 9, messageId: 99 }),
    ];
    expect(isBotMonologueTrail(recent, bot, 8, 99)).toBe(false);
  });
});
