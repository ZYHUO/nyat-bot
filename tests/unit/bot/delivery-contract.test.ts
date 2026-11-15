import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  send: vi.fn(), edit: vi.fn(), set: vi.fn(), markAnswered: vi.fn(), speech: vi.fn(),
  qq: vi.fn(), platform: vi.fn(),
}));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: () => ({ api: { sendMessage: mocks.send, editMessageText: mocks.edit } }) }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ set: mocks.set }) }));
vi.mock('../../../src/tracking/speech-meter.js', () => ({ recordSpeech: mocks.speech }));
vi.mock('../../../src/tracking/reply-activity.js', () => ({ recordBotReply: vi.fn() }));
vi.mock('../../../src/agent/reverse-valve.js', () => ({ recordBotMessageForConnectivity: vi.fn(async () => {}) }));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: mocks.markAnswered }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/platform/outbound.js', () => ({
  platformConversation: mocks.platform, sendPlatformText: mocks.qq,
  rejectUnsupportedPlatformAction: vi.fn(),
}));
vi.mock('../../../src/platform/telegram-guard.js', () => ({ assertTelegramPayload: vi.fn() }));
vi.mock('../../../src/shared/outbound-privacy.js', () => ({ assertOutboundText: vi.fn() }));
import { sendMessage, sendMessageDetailed } from '../../../src/bot/sender/telegram.js';
import { StreamingSender } from '../../../src/bot/sender/streaming.js';
import { DeliveryError } from '../../../src/shared/delivery-result.js';

describe('real sender → streaming delivery contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.set.mockResolvedValue('OK'); mocks.platform.mockReturnValue(null);
    mocks.send.mockResolvedValue({ message_id: 51 }); mocks.edit.mockResolvedValue(true);
    mocks.markAnswered.mockResolvedValue(undefined);
  });

  it('same-prefix different plans: suppressed output has no message ID or assistant text', async () => {
    const seen = new Set<string>();
    mocks.set.mockImplementation(async (key: string) => { if (seen.has(key)) return null; seen.add(key); return 'OK'; });
    const sender = new StreamingSender();
    expect((await sender.sendDirect(-100, '今天天气很好', 10)).messageId).toBe(51);
    const error = await sender.sendDirect(-100, '今天天气很坏', 20).catch(error => error);
    expect(error).toBeInstanceOf(DeliveryError);
    expect(error.result).toMatchObject({ status: 'suppressed', targetMessageId: 20, parts: [] });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mocks.markAnswered).toHaveBeenCalledWith(-100, 10));
    expect(mocks.markAnswered).not.toHaveBeenCalledWith(-100, 20);
  });

  it('legacy numeric API never returns a suppression sentinel', async () => {
    mocks.set.mockResolvedValue(null);
    await expect(sendMessage(-100, 'same')).rejects.toMatchObject({ delivery: 'not_sent', result: { status: 'suppressed' } });
    expect(mocks.speech).not.toHaveBeenCalled();
  });

  it('a late shard rejection retains only earlier actual content and does not settle the target', async () => {
    mocks.send.mockResolvedValueOnce({ message_id: 60, text: '已确认的第一片' })
      .mockRejectedValueOnce(Object.assign(new Error('400 Bad Request: rejected'), { error_code: 400 }));
    const result = await sendMessageDetailed(-100, '甲'.repeat(5000), 42, 7, { intentId: 'task:a', revision: 3 });
    expect(result).toMatchObject({ status: 'failed', intentId: 'task:a', revision: 3, targetMessageId: 42,
      parts: [{ messageId: 60, text: '已确认的第一片', partIndex: 0 }], plannedPartCount: 2 });
    expect(mocks.markAnswered).not.toHaveBeenCalled();
    expect(mocks.send.mock.calls[1]?.[2]).toMatchObject({ message_thread_id: 7 });
  });

  it('timeout is unknown and causes no network retry or plain-text fallback', async () => {
    mocks.send.mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await sendMessageDetailed(-100, 'uncertain');
    expect(result).toMatchObject({ status: 'unknown', parts: [] });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('missing-anchor fallback followed by timeout does not send a third copy', async () => {
    mocks.send.mockRejectedValueOnce(new Error('400 Bad Request: replied message not found'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    expect((await sendMessageDetailed(-100, 'reply', 1)).status).toBe('unknown');
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('preserves typed QQ unknown errors and never reaches Telegram', async () => {
    mocks.platform.mockReturnValue({ platform: 'qq' });
    mocks.qq.mockRejectedValue(Object.assign(new Error('timeout'), { delivery: 'unknown', code: 'action_timeout' }));
    await expect(sendMessage(2 ** 52 + 1, 'qq')).rejects.toMatchObject({ delivery: 'unknown', code: 'action_timeout' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('cancel check runs before every shard, retaining the acknowledged prefix', async () => {
    const beforeSend = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('cancelled'); });
    const result = await sendMessageDetailed(-100, '甲'.repeat(5000), undefined, undefined,
      { intentId: 'cancel-test', revision: 1, beforeSend });
    expect(result.status).toBe('failed'); expect(result.parts).toHaveLength(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('failed final streaming edit returns confirmed prefix, never the complete generated buffer', async () => {
    const sender = new StreamingSender({ minEditInterval: 0, minCharDelta: 1 });
    mocks.edit.mockResolvedValueOnce(true).mockRejectedValue(new Error('response lost'));
    async function* chunks() { yield 'visible'; yield ' not confirmed'; }
    const result = await sender.sendStream(-100, chunks());
    expect(result.status).toBe('unknown');
    expect(result.text).toBe('visible');
    expect(result.parts).toEqual([{ messageId: 51, text: 'visible', partIndex: 0 }]);
    expect(mocks.markAnswered).not.toHaveBeenCalled();
  });
});
