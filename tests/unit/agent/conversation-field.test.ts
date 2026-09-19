import { describe, expect, it } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';
import {
  buildConversationField,
  deriveInnerStateFromConversationField,
} from '../../../src/agent/conversation-field.js';

function message(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user',
    uid: 42,
    username: 'user',
    fullName: 'User',
    timestamp: 1_700_000_000,
    messageId: 1,
    textContent: 'hello',
    isForwarded: false,
    isBot: false,
    ...overrides,
  } as FormattedMessage;
}

describe('ConversationField projection', () => {
  it('keeps floor, unresolved question and media opportunity as metadata', () => {
    const field = buildConversationField({
      chatId: -100,
      botUid: 99,
      nowSec: 1_700_000_010,
      botAddressed: true,
      groupPaceSec: 2,
      recent: [
        message({ uid: 7, messageId: 8, timestamp: 1_700_000_005, textContent: '你怎么看？' }),
        message({ uid: 99, messageId: 9, timestamp: 1_700_000_006, role: 'assistant', isBot: true, textContent: '我在想' }),
        message({ uid: 7, messageId: 10, timestamp: 1_700_000_009, textContent: '看这个', imageFileId: 'photo-1' }),
      ],
    });

    expect(field.scope).toEqual({ visibility: 'chat', chatId: -100 });
    expect(field.floorOwner).toBe(7);
    expect(field.unresolvedQuestions).toContain('latest_user_question');
    expect(field.mediaOpportunities).toContain('inbound_photo');
    expect(field.memberNeeds).toEqual([{ userId: 7, need: 'feedback', confidence: 0.65 }]);
    expect(field.messageCount).toBe(3);
    expect(field.temperature).toBeGreaterThan(0);
    expect(JSON.stringify(field)).not.toContain('你怎么看？');
  });

  it('derives a bounded inner state without turning it into external fact', () => {
    const field = buildConversationField({
      chatId: -100,
      botUid: 99,
      nowSec: 1_700_000_010,
      botSocialNeed: 0.9,
      recent: [message({ timestamp: 1_700_000_009, textContent: '还在吗？' })],
    });
    const state = deriveInnerStateFromConversationField(field);
    expect(state.schema).toBe('inner_state.v1');
    expect(state.currentNeed).toBe('feedback');
    expect(state.attention).toBeGreaterThanOrEqual(0);
    expect(state.attention).toBeLessThanOrEqual(1);
    expect(state.aversions).toEqual([]);
    expect(state.commitments).toEqual([]);
  });
});

