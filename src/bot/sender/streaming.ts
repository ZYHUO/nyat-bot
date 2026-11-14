// ────────────────────────────────────────
// Streaming Sender — editMessage-based streaming
// ────────────────────────────────────────

import { sendMessageDetailed, editMessage } from './telegram.js';
import { deliveryFailureStatus, requireSentDelivery, type DeliveryResult, type SentDelivery } from '../../shared/delivery-result.js';
import { logger } from '../../shared/logger.js';

export interface StreamingConfig {
  minEditInterval: number;
  minCharDelta: number;
  placeholder: string;
}

const DEFAULT_CONFIG: StreamingConfig = {
  minEditInterval: 500,
  minCharDelta: 50,
  placeholder: '💭',
};

export class StreamingSender {
  private readonly config: StreamingConfig;

  constructor(config: Partial<StreamingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Stream AI output to Telegram via progressive editMessage calls.
   */
  async sendStream(
    chatId: number,
    stream: AsyncIterable<string>,
    replyToId?: number,
  ): Promise<DeliveryResult & { messageId?: number; text: string }> {
    // 1. Send placeholder message
    const initial = await sendMessageDetailed(chatId, this.config.placeholder, replyToId, undefined, { markAnswered: false });
    if (initial.status !== 'sent') return { ...initial, text: '' };
    const messageId = requireSentDelivery(initial).messageId;
    let confirmedText = this.config.placeholder;
    let buffer = '';
    let lastEditTime = 0;
    let lastEditLength = 0;

    try {
      // 2. Consume stream chunks
      for await (const chunk of stream) {
        buffer += chunk;

        const now = Date.now();
        const timeDelta = now - lastEditTime;
        const charDelta = buffer.length - lastEditLength;

        // 3. Edit when debounce conditions are met
        if (timeDelta >= this.config.minEditInterval && charDelta >= this.config.minCharDelta) {
          try {
            await editMessage(chatId, messageId, buffer);
            confirmedText = buffer;
            lastEditTime = now;
            lastEditLength = buffer.length;
          } catch (err) {
            // If edit fails (e.g., 429), just continue accumulating
            logger.debug({ chatId, messageId, err }, 'Stream edit failed, continuing');
          }
        }
      }

      // 4. Final edit with complete text
      if (buffer && buffer.length !== lastEditLength) {
        await editMessage(chatId, messageId, buffer);
        confirmedText = buffer;
      }

      // If buffer is empty, replace placeholder
      if (!buffer) {
        buffer = '…';
        await editMessage(chatId, messageId, buffer);
        confirmedText = buffer;
      }
    } catch (err) {
      logger.error({ chatId, messageId, err }, 'Stream send error');
      // The buffer is intent; only the last acknowledged edit is historical fact.
      return { ...initial, status: deliveryFailureStatus(err, true), error: err,
        reason: 'stream_unconfirmed', messageId, text: confirmedText,
        parts: [{ messageId, text: confirmedText, partIndex: 0 }] };
    }

    if (replyToId && replyToId > 0) {
      void import('../../meta/answered.js').then(({ markMessageAnswered }) => markMessageAnswered(chatId, replyToId)).catch(() => {});
    }
    return { ...initial, messageId, text: confirmedText,
      parts: [{ messageId, text: confirmedText, partIndex: 0 }] };
  }

  /**
   * Non-streaming fallback: just send a complete message.
   */
  async sendDirect(
    chatId: number,
    text: string,
    replyToId?: number,
    options?: { markAnswered?: boolean },
  ): Promise<SentDelivery> {
    return requireSentDelivery(await sendMessageDetailed(chatId, text, replyToId, undefined, options));
  }
}
