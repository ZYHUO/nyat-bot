import { describe, it, expect } from 'vitest';
import { looksLikeDirectInteraction } from '../../../src/pipeline/timing/direct-interaction.js';
import type { UpdateLike } from '../../../src/shared/types.js';

const ctx = { botUid: 9999, botUsername: 'xxb_bot', botNicknames: ['xxb', '啾咪囝'] };

function update(overrides: Record<string, unknown> = {}): UpdateLike {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: -100, type: 'supergroup' },
      from: { id: 100 },
      ...overrides,
    },
  } as UpdateLike;
}

describe('looksLikeDirectInteraction', () => {
  it('private chat → true', () => {
    const u = { update_id: 1, message: { chat: { type: 'private' }, text: 'hi' } } as UpdateLike;
    expect(looksLikeDirectInteraction(u, ctx)).toBe(true);
  });

  it('edited_message → true', () => {
    const u = { update_id: 1, edited_message: { chat: { type: 'supergroup' }, text: 'fix' } } as UpdateLike;
    expect(looksLikeDirectInteraction(u, ctx)).toBe(true);
  });

  describe('editByContentOnly(turn actor 入口,review #8)', () => {
    const ctxContent = { ...ctx, editByContentOnly: true };

    it('typo 修正编辑 → false(被动入册,不唤醒)', () => {
      const u = { update_id: 1, edited_message: { chat: { type: 'supergroup' }, text: 'fix typo' } } as UpdateLike;
      expect(looksLikeDirectInteraction(u, ctxContent)).toBe(false);
    });

    it('编辑改出 @bot → true(仍算点名)', () => {
      const u = { update_id: 1, edited_message: { chat: { type: 'supergroup' }, text: '改一下 @xxb_bot 看这个' } } as UpdateLike;
      expect(looksLikeDirectInteraction(u, ctxContent)).toBe(true);
    });

    it('编辑的是回复 bot 的消息 → true', () => {
      const u = {
        update_id: 1,
        edited_message: { chat: { type: 'supergroup' }, text: 'fixed', reply_to_message: { from: { id: 9999 } } },
      } as UpdateLike;
      expect(looksLikeDirectInteraction(u, ctxContent)).toBe(true);
    });

    it('非编辑消息不受该开关影响', () => {
      expect(looksLikeDirectInteraction(update({ text: 'hello world' }), ctxContent)).toBe(false);
      expect(looksLikeDirectInteraction(update({ text: 'hey @xxb_bot' }), ctxContent)).toBe(true);
    });
  });

  it('slash command → true', () => {
    expect(looksLikeDirectInteraction(update({ text: '/checkin' }), ctx)).toBe(true);
    expect(looksLikeDirectInteraction(update({ text: '   /help@xxb_bot' }), ctx)).toBe(true);
  });

  it('@bot mention → true (case insensitive)', () => {
    expect(looksLikeDirectInteraction(update({ text: 'hey @XXB_Bot' }), ctx)).toBe(true);
  });

  it('bot nickname mention → true', () => {
    expect(looksLikeDirectInteraction(update({ text: '啾咪囝你来一下' }), ctx)).toBe(true);
    expect(looksLikeDirectInteraction(update({ text: 'xxb 看看' }), ctx)).toBe(true);
  });

  it('reply to bot → true', () => {
    expect(
      looksLikeDirectInteraction(
        update({ text: 'thanks', reply_to_message: { from: { id: 9999 } } }),
        ctx,
      ),
    ).toBe(true);
  });

  it('reply to other user → false', () => {
    expect(
      looksLikeDirectInteraction(
        update({ text: 'thanks', reply_to_message: { from: { id: 200 } } }),
        ctx,
      ),
    ).toBe(false);
  });

  it('plain group chatter → false', () => {
    expect(looksLikeDirectInteraction(update({ text: '今晚吃啥' }), ctx)).toBe(false);
  });

  it('caption with mention → true', () => {
    expect(looksLikeDirectInteraction(update({ text: undefined, caption: '@xxb_bot 看图' }), ctx)).toBe(true);
  });

  it('empty text/caption + group → false', () => {
    expect(looksLikeDirectInteraction(update({ text: undefined }), ctx)).toBe(false);
  });

  it('missing message → false', () => {
    expect(looksLikeDirectInteraction({} as UpdateLike, ctx)).toBe(false);
  });
});
