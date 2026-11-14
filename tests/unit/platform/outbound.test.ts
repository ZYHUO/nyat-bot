import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRef, MessageRef, PlatformAction } from '../../../src/platform/types.js';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(), getBot: vi.fn(), redisSet: vi.fn(), speech: vi.fn(), reply: vi.fn(),
  connectivity: vi.fn(async () => {}), answered: vi.fn(async () => {}),
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: mocks.getDb }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ set: mocks.redisSet }) }));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: mocks.getBot }));
vi.mock('../../../src/tracking/speech-meter.js', () => ({ recordSpeech: mocks.speech }));
vi.mock('../../../src/tracking/reply-activity.js', () => ({ recordBotReply: mocks.reply }));
vi.mock('../../../src/agent/reverse-valve.js', () => ({ recordBotMessageForConnectivity: mocks.connectivity }));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: mocks.answered }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
import {
  clearOneBotSender, registerOneBotSender, sendPlatformText, sendPlatformSegments,
  deletePlatformMessage, platformChatAction,
} from '../../../src/platform/outbound.js';
import {
  getOrCreateConversationId, getOrCreateUserId, getOrCreateMessageId, findMessageRef,
} from '../../../src/platform/identity-store.js';
import * as sender from '../../../src/bot/sender/telegram.js';

const group: ConversationRef = { platform: 'qq', accountId: '80001', idNamespace: 'qq-number', conversationKind: 'group', id: '70001' };
const other: ConversationRef = { ...group, id: '70002' };
const receipt: MessageRef = { conversation: group, id: 'send-receipt' };
const client = {
  send: vi.fn<(action: PlatformAction) => Promise<MessageRef>>(),
  delete: vi.fn<(message: MessageRef) => Promise<void>>(),
};
let db: Database.Database;
let chatId: number;
beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0118_platform_identity.sql', 'utf8'));
  mocks.getDb.mockReturnValue(db);
  chatId = getOrCreateConversationId(group);
  client.send.mockReset().mockResolvedValue(receipt);
  client.delete.mockReset().mockResolvedValue(undefined);
  clearOneBotSender();
  registerOneBotSender(client, group.accountId);
});
afterEach(() => { clearOneBotSender(); db.close(); });

describe('OneBot outbound boundary', () => {
  it('sends mapped mention + exact same-chat reply, persists a real receipt', async () => {
    const uid = getOrCreateUserId({ ...group, id: '12345' });
    const reply: MessageRef = { conversation: group, id: 'incoming' };
    const anchor = getOrCreateMessageId(reply);
    const mid = await sendPlatformText(chatId, `你好 @${uid}，请看 [CQ:at,qq=all] @12345`, anchor);
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0]![0]).toEqual({ action: 'send', conversation: group, segments: [
      { type: 'reply', message: reply }, { type: 'text', text: '你好 ' },
      { type: 'mention', user: { platform: 'qq', accountId: '80001', idNamespace: 'qq-number', id: '12345' } },
      { type: 'text', text: '，请看 [CQ:at,qq=all] @12345' },
    ] });
    expect(mid).toBeGreaterThan(2 ** 52);
    expect(findMessageRef(chatId, mid)).toEqual(receipt);
  });

  it('supports private text and mapped deletion without Telegram', async () => {
    const dm: ConversationRef = { ...group, conversationKind: 'private', id: '12345' };
    const dmId = getOrCreateConversationId(dm);
    client.send.mockResolvedValue({ conversation: dm, id: 'dm-receipt' });
    const mid = await sender.sendMessage(dmId, '私聊回复');
    await sender.deleteMessage(dmId, mid);
    expect(client.delete).toHaveBeenCalledWith({ conversation: dm, id: 'dm-receipt' });
    expect(mocks.getBot).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(dmId);
  });

  it('does not convert raw CQ commands or ordinary QQ numbers into actions', async () => {
    await sendPlatformText(chatId, '[CQ:at,qq=all] @12345');
    expect(client.send.mock.calls[0]![0]).toMatchObject({ segments: [{ type: 'text', text: '[CQ:at,qq=all] @12345' }] });
  });

  it('refuses missing routes, unknown reserved IDs, cross-chat anchors and cross-account mentions', async () => {
    const otherMid = getOrCreateMessageId({ conversation: other, id: 'private-other' });
    await expect(sendPlatformText(chatId, 'text', otherMid)).rejects.toMatchObject({ code: 'unresolved_platform_reply' });
    const otherUid = getOrCreateUserId({ ...group, accountId: '90001', id: '12345' });
    await expect(sendPlatformText(chatId, `@${otherUid}`)).rejects.toMatchObject({ code: 'unresolved_platform_mention' });
    await expect(sender.sendMessage(-(2 ** 52 + 999), 'text')).rejects.toMatchObject({ code: 'unresolved_platform_chat' });
    clearOneBotSender();
    await expect(sender.sendMessage(chatId, 'text')).rejects.toMatchObject({ code: 'onebot_sender_unavailable' });
    expect(client.send).not.toHaveBeenCalled();
    expect(mocks.getBot).not.toHaveBeenCalled();
  });

  it.each(['not_sent', 'unknown', 'rejected'])('propagates %s delivery without retries, TG fallback or success bookkeeping', async (delivery) => {
    const error = Object.assign(new Error('network 429 retry after 1'), { delivery });
    client.send.mockRejectedValue(error);
    const anchor = getOrCreateMessageId({ conversation: group, id: 'incoming' });
    await expect(sender.sendMessage(chatId, 'text', anchor)).rejects.toBe(error);
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(mocks.getBot).not.toHaveBeenCalled();
    expect(mocks.redisSet).not.toHaveBeenCalled();
    expect(mocks.speech).not.toHaveBeenCalled();
    expect(mocks.answered).not.toHaveBeenCalled();
  });

  it('marks reply anchors only after an acknowledged QQ send', async () => {
    const anchor = getOrCreateMessageId({ conversation: group, id: 'incoming' });
    const mid = await sender.sendMessage(chatId, '回复', anchor);
    await vi.waitFor(() => expect(mocks.answered).toHaveBeenCalledWith(chatId, anchor));
    expect(mocks.connectivity).toHaveBeenCalledWith(chatId, mid, '', expect.any(Number));
    expect(mocks.speech).toHaveBeenCalledTimes(1);
    expect(mocks.getBot).not.toHaveBeenCalled();
  });

  it('classifies a foreign receipt as unknown and never synthesizes a successful ID', async () => {
    client.send.mockResolvedValue({ conversation: other, id: 'receipt' });
    await expect(sender.sendMessage(chatId, 'text')).rejects.toMatchObject({ delivery: 'unknown', code: 'onebot_receipt_unavailable' });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it('fails closed for unsupported sender methods before reading files or obtaining the Telegram bot', async () => {
    const calls = [
      () => sender.reactToMessage(chatId, 1, '👍'), () => sender.sendPoll(chatId, 'q', ['a', 'b']),
      () => sender.forwardMessage(chatId, 1, 1), () => sender.forwardMessage(1, chatId, 1),
      () => sender.muteMember(chatId, 1, 1), () => sender.kickMember(chatId, 1),
      () => sender.unmuteMember(chatId, 1), () => sender.pinMessage(chatId, 1),
      () => sender.editMessage(chatId, 1, 'text'), () => sender.sendSticker(chatId, 'file'),
      () => sender.sendFile(chatId, '/does-not-exist'), () => sender.sendPhoto(chatId, '/does-not-exist'),
      () => sender.sendVoice(chatId, Buffer.from('ogg')), () => sender.sendMessage(chatId, 'text', undefined, 1),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(mocks.getBot).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it('guards Telegram wrappers against QQ user/message IDs even when chat is native Telegram', async () => {
    const uid = getOrCreateUserId({ ...group, id: '12345' });
    for (const call of [() => sender.muteMember(-100, uid, 1), () => sender.sendMessage(-100, 'x', uid),
      () => sender.deleteMessage(-100, uid), () => sender.editMessage(-100, uid, 'x')]) {
      await expect(call()).rejects.toMatchObject({ code: 'telegram_platform_id_blocked' });
    }
    expect(mocks.getBot).not.toHaveBeenCalled();
  });

  it('typing truthfully reports unavailable with no RPC or delivery bookkeeping', async () => {
    expect(platformChatAction(chatId)).toEqual({ available: false });
    await sender.sendChatAction(chatId, 'typing');
    expect(mocks.getBot).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it('does not retry unknown deletion and rejects foreign or unsupported segments', async () => {
    const mid = getOrCreateMessageId(receipt);
    const error = Object.assign(new Error('network'), { delivery: 'unknown' });
    client.delete.mockRejectedValue(error);
    await expect(sender.deleteMessage(chatId, mid)).rejects.toBe(error);
    expect(client.delete).toHaveBeenCalledTimes(1);
    const otherMid = getOrCreateMessageId({ conversation: other, id: 'foreign' });
    await expect(deletePlatformMessage(chatId, otherMid)).rejects.toMatchObject({ code: 'unresolved_platform_message' });
    await expect(sendPlatformSegments(chatId, [{ type: 'image', assetRef: 'qq:image' }])).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(mocks.getBot).not.toHaveBeenCalled();
  });
});
