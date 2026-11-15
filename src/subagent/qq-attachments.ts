import { resolveOneBotMedia } from '../platform/onebot-media.js';
import { sendPlatformMedia, PlatformOutboundError } from '../platform/outbound.js';
import { sanitizeOneBotFileName } from '../platform/onebot-media-stream.js';

export interface QQAttachmentOptions {
  chatId: number;
  replyToId?: number;
  assertOpen(): void;
  guard<T>(operation: () => Promise<T>): Promise<T>;
  delivered(messageId: number, description: string): Promise<void>;
  maxSends: number;
}

/** Opaque, conversation-bound assets only. No model-selected server paths or URLs. */
export function createQQAttachmentApi(options: QQAttachmentOptions) {
  let attempts = 0;
  const begin = () => {
    options.assertOpen();
    if (++attempts > Math.min(4, options.maxSends)) throw new PlatformOutboundError('qq_attachment_limit');
  };
  const deliver = async (bytes: Buffer, name: string, kind: 'file' | 'image', caption?: string, assertAvailable: () => void = () => {}) => {
    options.assertOpen();
    assertAvailable();
    const fileName = sanitizeOneBotFileName(name);
    const messageId = await options.guard(() => sendPlatformMedia(options.chatId, kind, bytes, fileName,
      { caption: caption?.slice(0, 1000), replyToId: options.replyToId,
        beforeSend: () => { options.assertOpen(); assertAvailable(); } }));
    // The external receipt is authoritative even if optional context bookkeeping fails.
    try { await options.delivered(messageId, `[${kind}] ${fileName}`); } catch { /* No resend after an acknowledged delivery. */ }
    return { messageId };
  };
  return {
    async readFile(handle: string): Promise<{ fileName: string; mimeType: string; text: string; truncated: boolean }> {
      options.assertOpen();
      const file = await resolveOneBotMedia(handle, options.chatId, { maxBytes: 1024 * 1024 });
      options.assertOpen();
      file.assertAvailable();
      if (!/^(?:text\/|application\/(?:json|xml|javascript|x-yaml))/i.test(file.mimeType) &&
        !/\.(?:txt|md|csv|json|jsonl|ya?ml|xml|log|ts|js|py|sh|ini|toml)$/i.test(file.fileName)) {
        throw new PlatformOutboundError('qq_attachment_not_text');
      }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
      catch { throw new PlatformOutboundError('qq_attachment_not_utf8'); }
      if (text.includes('\0')) throw new PlatformOutboundError('qq_attachment_not_text');
      return { fileName: file.fileName, mimeType: file.mimeType, text: text.slice(0, 12000), truncated: text.length > 12000 };
    },
    async sendFile(handle: string, caption?: string): Promise<{ messageId: number }> {
      begin();
      const file = await resolveOneBotMedia(handle, options.chatId, { maxBytes: 50 * 1024 * 1024 });
      return deliver(file.bytes, file.fileName, 'file', caption, file.assertAvailable);
    },
    async sendPhoto(handle: string, caption?: string): Promise<{ messageId: number }> {
      begin();
      const file = await resolveOneBotMedia(handle, options.chatId, { maxBytes: 10 * 1024 * 1024 });
      if (!/^image\/(?:png|jpeg|gif|webp)$/.test(file.mimeType)) throw new PlatformOutboundError('qq_attachment_not_image');
      return deliver(file.bytes, file.fileName, 'image', caption, file.assertAvailable);
    },
    async sendTextFile(name: string, text: string): Promise<{ messageId: number }> {
      begin();
      if (typeof name !== 'string' || typeof text !== 'string' || !text.length || Buffer.byteLength(text) > 512 * 1024) {
        throw new PlatformOutboundError('qq_text_file_invalid');
      }
      return deliver(Buffer.from(text, 'utf8'), name, 'file');
    },
  };
}
