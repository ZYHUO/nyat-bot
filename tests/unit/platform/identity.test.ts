import { describe, expect, it } from 'vitest';
import {
  conversationKey, fromTelegramChatId, messageKey, qqOfficialConversation,
  qqOfficialUser, toTelegramChatId, toTelegramTarget, userKey,
} from '../../../src/platform/identity.js';
import type { ConversationRef } from '../../../src/platform/types.js';

describe('platform identity isolation', () => {
  const qqGroup: ConversationRef = {
    platform: 'qq', accountId: '80001', idNamespace: 'qq-number', conversationKind: 'group', id: '70001',
  };

  it('separates equal numeric IDs across platforms, accounts, kinds and namespaces', () => {
    const refs = [
      qqGroup,
      { ...qqGroup, conversationKind: 'private' as const },
      { ...qqGroup, accountId: '80002' },
      qqOfficialConversation('80001', 'group', '70001'),
      fromTelegramChatId('80001', 70001),
      fromTelegramChatId('80001', -70001),
    ];
    expect(new Set(refs.map(conversationKey)).size).toBe(refs.length);
  });

  it('cannot collide by moving delimiter-like content between opaque fields', () => {
    const first = qqOfficialConversation('a:b', 'group', 'c');
    const second = qqOfficialConversation('a', 'group', 'b:c');
    expect(conversationKey(first)).not.toBe(conversationKey(second));
    expect(conversationKey(qqOfficialConversation('a', 'group', 'AbC/"[x]')))
      .not.toBe(conversationKey(qqOfficialConversation('a', 'group', 'abc/"[x]')));
  });

  it('preserves legacy Telegram signs and topic IDs on a round trip', () => {
    for (const id of [123456, -1001234567890]) {
      const ref = fromTelegramChatId('bot', id);
      expect(toTelegramChatId(ref)).toBe(id);
      expect(ref.conversationKind).toBe(id < 0 ? 'group' : 'private');
    }
    const topic = fromTelegramChatId('bot', -1001234567890, 12);
    expect(toTelegramTarget(topic)).toEqual({ chatId: -1001234567890, messageThreadId: 12 });
    expect(conversationKey(topic)).not.toBe(conversationKey({ ...topic, threadId: '13' }));
  });

  it('rejects QQ refs at the legacy Telegram boundary even with numeric IDs', () => {
    expect(() => toTelegramChatId(qqGroup)).toThrow('Only Telegram');
    expect(() => toTelegramChatId(qqOfficialConversation('80001', 'private', '70001'))).toThrow('Only Telegram');
  });

  it('rejects Telegram precision loss and a chat-kind sign mismatch', () => {
    expect(() => fromTelegramChatId('bot', Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => fromTelegramChatId('bot', 0)).toThrow();
    expect(() => toTelegramChatId({ ...fromTelegramChatId('bot', 123), conversationKind: 'group' })).toThrow();
    expect(() => toTelegramTarget({ ...fromTelegramChatId('bot', -123), threadId: '0' })).toThrow();
  });

  it('keeps OpenIDs opaque and isolates messages and users by their full origin', () => {
    const ref = qqOfficialConversation('app-A', 'private', '001/opaque:UPPER');
    expect(ref.id).toBe('001/opaque:UPPER');
    expect(messageKey({ conversation: qqGroup, id: '1' }))
      .not.toBe(messageKey({ conversation: { ...qqGroup, id: '70002' }, id: '1' }));
    expect(userKey(qqOfficialUser('app-A', '123')))
      .not.toBe(userKey({ platform: 'qq', idNamespace: 'qq-number', accountId: 'app-A', id: '123' }));
  });

  it('rejects empty opaque IDs and mismatched platform namespaces', () => {
    expect(() => qqOfficialConversation('app', 'group', '')).toThrow();
    expect(() => conversationKey({ ...qqGroup, idNamespace: 'telegram' })).toThrow();
  });
});
