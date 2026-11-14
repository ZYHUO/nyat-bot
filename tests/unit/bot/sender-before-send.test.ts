import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRef, MessageRef } from '../../../src/platform/types.js';
const f = vi.hoisted(() => ({
  api: { sendMessage: vi.fn(), sendDocument: vi.fn(), sendPhoto: vi.fn(), sendVoice: vi.fn(), sendSticker: vi.fn() },
  read: vi.fn(), stat: vi.fn(), redis: vi.fn(), speech: vi.fn(), answered: vi.fn(),
  findConversation: vi.fn(), findMessage: vi.fn(), resolveMedia: vi.fn(), sourceAvailable: vi.fn(),
}));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: () => ({ api: f.api }) }));
vi.mock('node:fs/promises', () => ({ readFile: f.read, stat: f.stat }));
vi.mock('grammy', () => ({ InputFile: class { constructor(readonly bytes: Buffer, readonly name: string) {} } }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ ONEBOT_MEDIA_ENABLED: true }) }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ set: f.redis }) }));
vi.mock('../../../src/tracking/speech-meter.js', () => ({ recordSpeech: f.speech }));
vi.mock('../../../src/tracking/reply-activity.js', () => ({ recordBotReply: vi.fn() }));
vi.mock('../../../src/agent/reverse-valve.js', () => ({ recordBotMessageForConnectivity: vi.fn(async () => {}) }));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: f.answered }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/shared/outbound-privacy.js', () => ({ assertOutboundText: vi.fn(), assertOutboundFile: vi.fn() }));
vi.mock('../../../src/platform/telegram-guard.js', () => ({ assertTelegramPayload: vi.fn() }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ getOneBotGroupNoticeState: () => null, isOneBotMessageRecalled: () => false }));
vi.mock('../../../src/platform/onebot-media.js', () => ({ resolveOneBotMedia: f.resolveMedia }));
vi.mock('../../../src/platform/identity-store.js', () => ({
  isPlatformInternalId: (id: number | string) => Math.abs(Number(id)) >= 2 ** 52,
  findConversationRef: f.findConversation, findMessageRef: f.findMessage,
  findUserRef: () => null, getOrCreateMessageId: () => 2 ** 52 + 2,
}));
import { clearOneBotSender, registerOneBotSender } from '../../../src/platform/outbound.js';
import { sendMessage, sendMessageDetailed, sendFile, sendPhoto, sendVoice, sendSticker } from '../../../src/bot/sender/telegram.js';
const qqId = -(2 ** 52 + 1);
const conversation: ConversationRef = { platform: 'qq', accountId: '80001', idNamespace: 'qq-number', conversationKind: 'group', id: '70001' };
const receipt: MessageRef = { conversation, id: 'confirmed' };
const cancelled = () => { throw new Error('task_revision_changed'); };

beforeEach(() => {
  vi.clearAllMocks(); clearOneBotSender();
  f.redis.mockResolvedValue('OK');
  f.stat.mockResolvedValue({ isFile: () => true, size: 10 });
  f.read.mockResolvedValue(Buffer.from('synthetic'));
  f.findConversation.mockReturnValue(conversation);
  f.resolveMedia.mockResolvedValue({ bytes: Buffer.from('image'), mimeType: 'image/png', fileName: 'image.png', assertAvailable: f.sourceAvailable });
  for (const api of Object.values(f.api)) api.mockResolvedValue({ message_id: 71, text: 'actual first shard' });
});
afterEach(() => { clearOneBotSender(); vi.useRealTimers(); });

describe('actual sender checks cancellation at platform RPC boundaries', () => {
  it('legacy numeric text API forwards the check and makes zero Telegram calls', async () => {
    await expect(sendMessage(-100, 'not sent', undefined, undefined, { beforeSend: cancelled }))
      .rejects.toMatchObject({ delivery: 'not_sent', result: { parts: [] } });
    expect(f.api.sendMessage).not.toHaveBeenCalled(); expect(f.speech).not.toHaveBeenCalled();
  });
  it('checks every shard and preserves the already acknowledged prefix', async () => {
    const beforeSend = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(cancelled);
    const result = await sendMessageDetailed(-100, '甲'.repeat(5000), 10, 8, { beforeSend, revision: 2 });
    expect(result).toMatchObject({ status: 'failed', revision: 2,
      parts: [{ messageId: 71, text: 'actual first shard', partIndex: 0 }], plannedPartCount: 2 });
    expect(f.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.speech).toHaveBeenCalledTimes(1); expect(f.answered).not.toHaveBeenCalled();
  });
  it('rechecks before a Markdown fallback after an explicit rejection', async () => {
    f.api.sendMessage.mockRejectedValueOnce(new Error("400 Bad Request: can't parse entities"));
    const beforeSend = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(cancelled);
    const result = await sendMessageDetailed(-100, 'text', undefined, undefined, { beforeSend });
    expect(result.status).toBe('failed'); expect(result.parts).toEqual([]);
    expect(f.api.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('rechecks after rate-limit backoff before retrying the real request', async () => {
    vi.useFakeTimers();
    f.api.sendMessage.mockRejectedValueOnce(new Error('429 Too Many Requests: retry after 1'));
    const beforeSend = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(cancelled);
    const result = sendMessageDetailed(-100, 'text', undefined, undefined, { beforeSend });
    await vi.advanceTimersByTimeAsync(1001);
    expect((await result).status).toBe('failed'); expect(f.api.sendMessage).toHaveBeenCalledTimes(1);
  });
  it.each(['file', 'photo'] as const)('cancellation during %s read prevents Telegram transport', async kind => {
    let stopped = false;
    f.read.mockImplementation(async () => { stopped = true; return Buffer.from('synthetic'); });
    const beforeSend = () => { if (stopped) cancelled(); };
    const send = kind === 'file' ? sendFile : sendPhoto;
    await expect(send(-100, '/synthetic/file', { beforeSend })).rejects.toThrow('task_revision_changed');
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.api.sendDocument).not.toHaveBeenCalled(); expect(f.api.sendPhoto).not.toHaveBeenCalled();
    expect(f.speech).not.toHaveBeenCalled();
  });
  it('voice checks immediately before Telegram RPC and preserves normal ACK behavior', async () => {
    await expect(sendVoice(-100, Buffer.from('OggS'), { beforeSend: cancelled })).rejects.toThrow('task_revision_changed');
    expect(f.api.sendVoice).not.toHaveBeenCalled();
    const allow = vi.fn();
    expect(await sendVoice(-100, Buffer.from('OggS'), { beforeSend: allow })).toEqual({ messageId: 71 });
    expect(allow).toHaveBeenCalledTimes(1); expect(f.api.sendVoice).toHaveBeenCalledTimes(1);
  });
  it('Telegram sticker also checks before the real RPC', async () => {
    await expect(sendSticker(-100, 'synthetic-sticker', { beforeSend: cancelled })).rejects.toThrow('task_revision_changed');
    expect(f.api.sendSticker).not.toHaveBeenCalled(); expect(f.speech).not.toHaveBeenCalled();
  });
  it('QQ text is checked before reaching the registered OneBot client', async () => {
    const send = vi.fn(async () => receipt);
    registerOneBotSender({ send, delete: vi.fn() }, conversation.accountId);
    await expect(sendMessage(qqId, 'text', undefined, undefined, { beforeSend: cancelled }))
      .rejects.toMatchObject({ delivery: 'not_sent' });
    expect(send).not.toHaveBeenCalled(); expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it.each(['file', 'photo', 'voice', 'sticker'] as const)('QQ %s rechecks after upload, before the message RPC', async kind => {
    let stopped = false;
    const messageRpc = vi.fn(async () => receipt);
    const sendMedia = vi.fn(async (input: { beforeSend?: () => void }) => {
      await Promise.resolve(); // The client uploaded a temporary asset, not a delivered message.
      stopped = true; input.beforeSend?.();
      return messageRpc();
    });
    registerOneBotSender({ send: vi.fn(), delete: vi.fn(), sendMedia }, conversation.accountId);
    const beforeSend = () => { if (stopped) cancelled(); };
    const sent = kind === 'sticker' ? sendSticker(qqId, 'same-chat-image-handle', { beforeSend })
      : kind === 'voice' ? sendVoice(qqId, Buffer.from('OggS'), { beforeSend })
      : (kind === 'file' ? sendFile : sendPhoto)(qqId, '/synthetic/file', { beforeSend });
    await expect(sent).rejects.toThrow('task_revision_changed');
    expect(sendMedia).toHaveBeenCalledTimes(1); expect(messageRpc).not.toHaveBeenCalled();
    if (kind === 'sticker') expect(f.sourceAvailable).toHaveBeenCalledTimes(1);
    for (const api of Object.values(f.api)) expect(api).not.toHaveBeenCalled();
    expect(f.speech).not.toHaveBeenCalled();
  });
});
