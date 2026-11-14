import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), send: vi.fn() }));
vi.mock('../../../src/platform/onebot-media.js', () => ({ resolveOneBotMedia: mocks.resolve }));
vi.mock('../../../src/platform/outbound.js', () => ({
  sendPlatformMedia: mocks.send,
  PlatformOutboundError: class extends Error { readonly delivery = 'not_sent'; constructor(readonly code: string) { super(code); } },
}));
import { createQQAttachmentApi } from '../../../src/subagent/qq-attachments.js';

function setup() {
  const guard = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const delivered = vi.fn(async () => {});
  const assertOpen = vi.fn();
  const api = createQQAttachmentApi({ chatId: 4503599627370599, replyToId: 34, assertOpen, guard, delivered, maxSends: 2 });
  return { api, guard, delivered, assertOpen };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ bytes: Buffer.from('hello'), fileName: 'note.txt', mimeType: 'text/plain', assertAvailable() {} });
  mocks.send.mockResolvedValue(45);
});
describe('QQ attachment capabilities', () => {
  it('binds every opaque handle read to the task conversation and bounds RPC text', async () => {
    mocks.resolve.mockResolvedValue({ bytes: Buffer.from('a'.repeat(13000)), fileName: 'note.txt', mimeType: 'text/plain', assertAvailable() {} });
    const { api } = setup();
    const result = await api.readFile('qq-media:handle');
    expect(mocks.resolve).toHaveBeenCalledWith('qq-media:handle', 4503599627370599, { maxBytes: 1024 * 1024 });
    expect(result).toMatchObject({ truncated: true, fileName: 'note.txt' });
    expect(result.text).toHaveLength(12000);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('refuses binary, invalid UTF8 and image masquerading as text', async () => {
    const { api } = setup();
    mocks.resolve.mockResolvedValue({ bytes: Buffer.from([255]), fileName: 'bad.txt', mimeType: 'text/plain', assertAvailable() {} });
    await expect(api.readFile('handle')).rejects.toMatchObject({ code: 'qq_attachment_not_utf8' });
    mocks.resolve.mockResolvedValue({ bytes: Buffer.from('binary'), fileName: 'image.png', mimeType: 'image/png', assertAvailable() {} });
    await expect(api.readFile('handle')).rejects.toMatchObject({ code: 'qq_attachment_not_text' });
  });
  it('does not return text if the task closes during the download', async () => {
    const { api, assertOpen } = setup();
    mocks.resolve.mockImplementation(async () => {
      assertOpen.mockImplementation(() => { throw new Error('closed'); });
      return { bytes: Buffer.from('private text'), fileName: 'note.txt', mimeType: 'text/plain', assertAvailable() {} };
    });
    await expect(api.readFile('handle')).rejects.toThrow('closed');
  });
  it('sends generated text bytes with sanitized filename and a real receipt', async () => {
    const { api, guard, delivered } = setup();
    expect(await api.sendTextFile('../../report.txt', '报告内容')).toEqual({ messageId: 45 });
    expect(mocks.send).toHaveBeenCalledWith(4503599627370599, 'file', Buffer.from('报告内容'), 'report.txt',
      { caption: undefined, replyToId: 34, beforeSend: expect.any(Function) });
    expect(guard).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledWith(45, '[file] report.txt');
  });
  it('resolves content before claiming delivery, and propagates unknown without retry or success bookkeeping', async () => {
    const { api, guard, delivered } = setup();
    mocks.resolve.mockRejectedValueOnce(new Error('expired'));
    await expect(api.sendFile('expired')).rejects.toThrow('expired');
    expect(guard).not.toHaveBeenCalled();
    const unknown = Object.assign(new Error('unknown'), { delivery: 'unknown' });
    mocks.send.mockRejectedValueOnce(unknown);
    await expect(api.sendFile('current')).rejects.toBe(unknown);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(delivered).not.toHaveBeenCalled();
  });
  it('refuses nonimages before upload and enforces the send budget across concurrent calls', async () => {
    const { api } = setup();
    await expect(api.sendPhoto('text')).rejects.toMatchObject({ code: 'qq_attachment_not_image' });
    await api.sendTextFile('one.txt', 'one');
    await expect(api.sendTextFile('two.txt', 'two')).rejects.toMatchObject({ code: 'qq_attachment_limit' });
    expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('does not resend an acknowledged attachment when optional bookkeeping fails', async () => {
    const { api, delivered } = setup();
    delivered.mockRejectedValue(new Error('context unavailable'));
    await expect(api.sendTextFile('ok.txt', 'ok')).resolves.toEqual({ messageId: 45 });
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});
