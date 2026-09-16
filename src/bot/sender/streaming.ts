// ────────────────────────────────────────
// Streaming Sender — editMessage-based streaming
// ────────────────────────────────────────

import { sendMessage, editMessage } from './telegram.js';
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
  ): Promise<{ messageId: number; text: string }> {
    // 1. Send placeholder message
    const messageId = await sendMessage(chatId, this.config.placeholder, replyToId);
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
      }

      // If buffer is empty, replace placeholder
      if (!buffer) {
        buffer = '…';
        await editMessage(chatId, messageId, buffer);
      }
    } catch (err) {
      logger.error({ chatId, messageId, err }, 'Stream send error');
      // Try to finalize with whatever we have
      if (buffer && buffer.length !== lastEditLength) {
        try {
          await editMessage(chatId, messageId, buffer);
        } catch {
          // Best effort
        }
      }
    }

    return { messageId, text: buffer };
  }

  /**
   * Non-streaming fallback: just send a complete message.
   */
  async sendDirect(
    chatId: number,
    text: string,
    replyToId?: number,
  ): Promise<{ messageId: number }> {
    const messageId = await sendMessage(chatId, text, replyToId);
    return { messageId };
  }
}
