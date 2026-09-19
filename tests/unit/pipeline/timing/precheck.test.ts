import { describe, expect, it } from 'vitest';
import { isClearlyHumanToHuman } from '../../../../src/pipeline/timing/precheck.js';
import type { FormattedMessage } from '../../../../src/shared/types.js';

// The gate's LLM answered `no_action` in 121 of 122 real decisions, all matching
// one explicit prompt rule ("群友们彼此在聊、不是在跟我聊 → no_action，别硬挤").
// This pre-check answers that case structurally.
//
// The failure modes are asymmetric, so the tests are too:
//   - too permissive → an extra LLM call (cheap, safe)
//   - too restrictive → a wanted reply is silently dropped (expensive, silent)
// The conservative direction must win every borderline case.

const BOT_UID = 8392759490;
const BOT_USERNAME = 'hunhebi_bot';

function msg(over: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user',
    uid: 1001,
    username: 'awei',
    fullName: '阿伟',
    timestamp: 1_700_000_000,
    messageId: 1,
    textContent: '家宽怎么优化',
    isForwarded: false,
    ...over,
  } as FormattedMessage;
}

const base = {
  botUid: BOT_UID,
  botUsername: BOT_USERNAME,
  botNicknames: ['啾咪囝', '啾咪'],
};

describe('gate pre-check: clearly human-to-human', () => {
  it('short-circuits when two humans are talking to each other', () => {
    const recent = [
      msg({ messageId: 1, uid: 1001, textContent: '@xiaolin 你看下' }),
      msg({ messageId: 2, uid: 1002, textContent: '好', replyTo: { messageId: 1, uid: 1001, fullName: '阿伟', textSnippet: 'x' } }),
    ];
    expect(isClearlyHumanToHuman({ message: recent[1]!, recentMessages: [recent[0]!], ...base })).toBe(true);
  });

  it('does NOT short-circuit when the bot is @-mentioned', () => {
    const recent = [msg({ messageId: 1, uid: 1001, textContent: '@xiaolin 你看下' })];
    const trigger = msg({ messageId: 2, textContent: `@${BOT_USERNAME} 帮我看下` });
    expect(isClearlyHumanToHuman({ message: trigger, recentMessages: recent, ...base })).toBe(false);
  });

  it('does NOT short-circuit when the bot is called by nickname', () => {
    const recent = [msg({ messageId: 1, uid: 1001, textContent: '@xiaolin 你看下' })];
    const trigger = msg({ messageId: 2, textContent: '啾咪囝 帮我看下' });
    expect(isClearlyHumanToHuman({ message: trigger, recentMessages: recent, ...base })).toBe(false);
  });

  it('does NOT short-circuit when the message replies to the bot', () => {
    const recent = [msg({ messageId: 1, uid: 1001, textContent: '@xiaolin 你看下' })];
    const trigger = msg({
      messageId: 2,
      replyTo: { messageId: 99, uid: BOT_UID, fullName: '啾咪囝', textSnippet: 'x' },
    });
    expect(isClearlyHumanToHuman({ message: trigger, recentMessages: recent, ...base })).toBe(false);
  });

  it('does NOT short-circuit in proactive mode', () => {
    // In proactive mode "nobody addressed me" is the expected starting point and
    // judging whether to insert anyway is the gate's whole job.
    const recent = [msg({ messageId: 1, uid: 1001, textContent: '@xiaolin 你看下' })];
    const trigger = msg({ messageId: 2, textContent: '这游戏好玩吗' });
    expect(isClearlyHumanToHuman({
      message: trigger, recentMessages: recent, proactiveMode: true, ...base,
    })).toBe(false);
  });

  it('does NOT short-circuit a slash command', () => {
    const recent = [msg({ messageId: 1, uid: 1001, textContent: '@xiaolin 你看下' })];
    const trigger = msg({ messageId: 2, textContent: '/checkin' });
    expect(isClearlyHumanToHuman({ message: trigger, recentMessages: recent, ...base })).toBe(false);
  });

  it('does NOT short-circuit when the window shows no human-to-human exchange', () => {
    // A lone unaddressed message is exactly the ambiguous case the gate exists
    // for — it must reach the LLM.
    const trigger = msg({ messageId: 2, textContent: '这游戏好玩吗' });
    expect(isClearlyHumanToHuman({ message: trigger, recentMessages: [], ...base })).toBe(false);
  });

  it('does NOT short-circuit messages from other bots', () => {
    const recent = [msg({ messageId: 1, uid: 1001, textContent: '@xiaolin 你看下' })];
    const trigger = msg({ messageId: 2, uid: 5555, isBot: true, textContent: 'hello' });
    expect(isClearlyHumanToHuman({ message: trigger, recentMessages: recent, ...base })).toBe(false);
  });

  it('does NOT short-circuit empty text', () => {
    const recent = [msg({ messageId: 1, uid: 1001, textContent: '@xiaolin 你看下' })];
    const trigger = msg({ messageId: 2, textContent: '' });
    expect(isClearlyHumanToHuman({ message: trigger, recentMessages: recent, ...base })).toBe(false);
  });

  it('treats an @ to the bot inside the window as NOT human-to-human', () => {
    // The only "human-to-human" evidence is an @handle, and it is the bot's own.
    const recent = [msg({ messageId: 1, uid: 1001, textContent: `@${BOT_USERNAME} 看下` })];
    const trigger = msg({ messageId: 2, textContent: '好的' });
    expect(isClearlyHumanToHuman({ message: trigger, recentMessages: recent, ...base })).toBe(false);
  });
});
