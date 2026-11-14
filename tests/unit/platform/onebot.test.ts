import { describe, expect, it } from 'vitest';
import { createOneBotCodec } from '../../../src/platform/onebot.js';
import { conversationKey, qqOfficialConversation } from '../../../src/platform/identity.js';
import { UnsupportedCapabilityError } from '../../../src/platform/types.js';
import type { MessageSegment } from '../../../src/platform/types.js';
import { groupEvent, privateEvent } from './fixtures.js';

describe('OneBot minimal codec', () => {
  const codec = createOneBotCodec('80001');

  it('normalizes a positive QQ group separately from a private chat with the same ID', () => {
    const group = codec.normalize(groupEvent)!;
    const direct = codec.normalize(privateEvent)!;
    expect(group.ref.conversation).toMatchObject({ platform: 'qq', id: '70001', conversationKind: 'group' });
    expect(direct.ref.conversation).toMatchObject({ id: '70001', conversationKind: 'private' });
    expect(conversationKey(group.ref.conversation)).not.toBe(conversationKey(direct.ref.conversation));
    expect(group.sender.id).toBe('60001');
    expect(group.senderName).toBe('Fixture member');
    expect(group.timestampMs).toBe(groupEvent.time * 1000);
    expect(group.ref.id).toBe('-90001');
  });

  it('maps incoming mentions and quoted messages into scoped references', () => {
    const message = codec.normalize(groupEvent)!;
    expect(message.segments[0]).toEqual({ type: 'reply', message: { conversation: message.ref.conversation, id: '-90000' } });
    expect(message.segments[1]).toEqual({ type: 'mention', user: { ...codec.account, id: '80001' } });
  });

  it('decodes CQ strings and escapes without treating escaped CQ text as a mention', () => {
    const message = codec.normalize({ ...groupEvent,
      message: 'literal &#91;CQ:at,qq=all&#93; &amp; [CQ:at,qq=60002][CQ:reply,id=-90000]',
    })!;
    expect(message.segments).toEqual([
      { type: 'text', text: 'literal [CQ:at,qq=all] & ' },
      { type: 'mention', user: { ...codec.account, id: '60002' } },
      { type: 'reply', message: { conversation: message.ref.conversation, id: '-90000' } },
    ]);
  });

  it('retains media including video as opaque references', () => {
    const message = codec.normalize({ ...groupEvent, message: [
      { type: 'image', data: { file: 'platform-asset' } },
      { type: 'record', data: { file: 'voice-asset' } },
      { type: 'file', data: { file: 'file-asset' } },
      { type: 'video', data: { file: 'unhandled' } },
    ] })!;
    expect(message.segments).toEqual([
      { type: 'image', assetRef: 'platform-asset' }, { type: 'voice', assetRef: 'voice-asset' },
      { type: 'file', assetRef: 'file-asset' }, { type: 'video', assetRef: 'unhandled' },
    ]);
  });

  it('ignores non-message events and own-message echoes', () => {
    expect(codec.normalize({ post_type: 'notice' })).toBeNull();
    expect(codec.normalize({ ...groupEvent, post_type: 'message_sent' })).toBeNull();
    expect(codec.normalize({ ...groupEvent, user_id: 80001 })).toBeNull();
  });

  it('rejects another account, malformed timestamps and lossy numeric IDs', () => {
    expect(() => codec.normalize({ ...groupEvent, self_id: 80002 })).toThrow('another OneBot account');
    expect(() => codec.normalize({ ...groupEvent, time: Infinity })).toThrow();
    expect(() => codec.normalize({ ...groupEvent, group_id: Number.MAX_SAFE_INTEGER + 1 })).toThrow('precision');
    expect(() => codec.normalize({ ...groupEvent, message: { text: 'wrong shape' } })).toThrow();
  });

  it('preserves large incoming string IDs and refuses a lossy outbound numeric conversion', () => {
    const message = codec.normalize({ ...groupEvent, group_id: '9007199254740993' })!;
    expect(message.ref.conversation.id).toBe('9007199254740993');
    expect(() => codec.encode({ action: 'send', conversation: message.ref.conversation,
      segments: [{ type: 'text', text: 'hello' }] })).toThrow('JSON numeric API');
  });

  it('encodes group text, mentions and a reply with the quote first', () => {
    const incoming = codec.normalize(groupEvent)!;
    const command = codec.encode({ action: 'send', conversation: incoming.ref.conversation, segments: [
      { type: 'text', text: 'Here is the answer.' },
      { type: 'mention', user: incoming.sender },
      { type: 'reply', message: incoming.ref },
    ] });
    expect(command).toEqual({ action: 'send_group_msg', params: { group_id: 70001, message: [
      { type: 'reply', data: { id: '-90001' } },
      { type: 'text', data: { text: 'Here is the answer.' } },
      { type: 'at', data: { qq: '60001' } },
    ] } });
  });

  it('uses private actions and keeps literal outbound CQ text as a text segment', () => {
    const command = codec.encode({ action: 'send', conversation: codec.normalize(privateEvent)!.ref.conversation,
      segments: [{ type: 'text', text: '[CQ:at,qq=all]' }] });
    expect(command).toEqual({ action: 'send_private_msg', params: { user_id: 70001,
      message: [{ type: 'text', data: { text: '[CQ:at,qq=all]' } }] } });
  });

  it('rejects cross-chat reply targets, cross-account mentions and official OpenIDs', () => {
    const incoming = codec.normalize(groupEvent)!;
    const send = (segments: MessageSegment[]) => codec.encode({ action: 'send', conversation: incoming.ref.conversation, segments });
    expect(() => send([{ type: 'reply', message: codec.normalize(privateEvent)!.ref }])).toThrow('another conversation');
    expect(() => send([{ type: 'mention', user: { ...incoming.sender, accountId: '80002' } }])).toThrow('another account');
    expect(() => codec.encode({ action: 'send', conversation: qqOfficialConversation('80001', 'group', '70001'),
      segments: [{ type: 'text', text: 'hello' }] })).toThrow('namespace');
  });

  it('does not pretend to support media sends, mass mentions, moderation or reactions', () => {
    const incoming = codec.normalize(groupEvent)!;
    for (const segment of [{ type: 'image', assetRef: 'asset' }, { type: 'mention-all' }] as MessageSegment[]) {
      expect(() => codec.encode({ action: 'send', conversation: incoming.ref.conversation, segments: [segment] }))
        .toThrow(UnsupportedCapabilityError);
    }
    expect(() => codec.encode({ action: 'react', message: incoming.ref, reaction: 'like' })).toThrow(UnsupportedCapabilityError);
    expect(() => codec.encode({ action: 'delete', message: incoming.ref })).toThrow(UnsupportedCapabilityError);
    expect(codec.capabilities.actions).toEqual(['send']);
    expect(codec.capabilities.outboundSegments).not.toContain('image');
  });

  it('rejects multiple reply targets and empty sends before reaching any transport', () => {
    const incoming = codec.normalize(groupEvent)!;
    expect(() => codec.encode({ action: 'send', conversation: incoming.ref.conversation, segments: [] })).toThrow('empty');
    expect(() => codec.encode({ action: 'send', conversation: incoming.ref.conversation, segments: [
      { type: 'reply', message: incoming.ref }, { type: 'reply', message: incoming.ref },
    ] })).toThrow('multiple reply');
  });
});
