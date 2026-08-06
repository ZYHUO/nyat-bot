// ────────────────────────────────────────
// Telegram Sender — API wrapper with retry
// ────────────────────────────────────────

import { getBot } from '../bot.js';
import { toMarkdownV2 } from './markdown.js';
import { shardMarkdownV2, TG_TEXT_LIMIT } from './shard.js';
import { recordSpeech } from '../../tracking/speech-meter.js';
import { logger } from '../../shared/logger.js';

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

/** React to a message with a single emoji (Telegram setMessageReaction). Best-effort. */
export async function reactToMessage(chatId: number, messageId: number, emoji: string): Promise<boolean> {
  try {
    const bot = getBot();
    // emoji must be one of Telegram's allowed reaction emojis; callers supply only those.
    const reaction = [{ type: 'emoji', emoji }] as Parameters<typeof bot.api.setMessageReaction>[2];
    await bot.api.setMessageReaction(chatId, messageId, reaction);
    return true;
  } catch (err) {
    logger.debug({ err, chatId, messageId, emoji }, 'setMessageReaction failed (non-critical)');
    return false;
  }
}

/**
 * @param idempotent 该操作重放一次是否安全。
 *
 * **非幂等操作(sendMessage / sendSticker)绝不能对网络错误重试。** Telegram Bot API 没有
 * idempotency key,客户端侧的 ECONNRESET/ETIMEDOUT **无法区分**"没送达"和"已送达但响应
 * 丢了" —— 重试就是群里出现两条一模一样的回复(最多 3 条)。而且只有最后一次成功返回的
 * message_id 会进 sentMessages,前面那条重复消息从不进 addAssistant,所以下一轮的
 * isDuplicateReply / checkNearDuplicate 看不到它,recordSelfReply / outcome 也漏记 ——
 * bot 对自己刚刷了屏毫不知情。
 *
 * 429 不在此列:Telegram 明确告知"未发送",重试是正确的。
 * editMessage / deleteMessage / sendChatAction 是幂等的,保留原有重试。
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  idempotent = true,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const message = lastError.message;

      // Rate limit (429) — backoff
      if (message.includes('429') || message.includes('Too Many Requests')) {
        const retryAfter = extractRetryAfter(message);
        const waitMs = retryAfter ? retryAfter * 1000 : BASE_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn({ attempt, waitMs, operation }, 'Telegram rate limited, backing off');
        await sleep(waitMs);
        continue;
      }

      // Transient network errors — retry only when replaying is safe.
      if (
        message.includes('ETIMEDOUT') ||
        message.includes('ECONNRESET') ||
        message.includes('ECONNREFUSED') ||
        message.includes('network')
      ) {
        if (!idempotent) {
          logger.warn(
            { attempt, operation, err: message },
            'Transient network error on a non-idempotent send — NOT retrying (may already be delivered)',
          );
          throw lastError;
        }
        const waitMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn({ attempt, waitMs, operation }, 'Telegram transient error, retrying');
        await sleep(waitMs);
        continue;
      }

      // Non-retryable error
      throw lastError;
    }
  }

  throw lastError ?? new Error(`${operation} failed after ${MAX_RETRIES} retries`);
}

function extractRetryAfter(message: string): number | null {
  const match = message.match(/retry after (\d+)/i);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a text message to a chat.
 */
export async function sendMessage(
  chatId: number,
  text: string,
  replyToId?: number,
  messageThreadId?: number,
): Promise<number> {
  const shards = shardMarkdownV2(toMarkdownV2(text));
  if (shards.length > 1) {
    logger.info({ chatId, shards: shards.length, chars: text.length }, 'Reply exceeded Telegram limit, sharding');
    let first = 0;
    for (let i = 0; i < shards.length; i++) {
      // 只有第一片挂 reply anchor + topic thread id,其余顺序追加。
      const id = await sendMarkdownOnce(
        chatId,
        shards[i]!,
        text,
        i === 0 ? replyToId : undefined,
        i === 0 ? messageThreadId : undefined,
      );
      if (i === 0) first = id;
    }
    recordSpeech();
    return first;
  }
  const messageId = await sendMarkdownOnce(chatId, shards[0]!, text, replyToId, messageThreadId);
  recordSpeech();
  return messageId;
}

/** 单片发送 + 既有的 anchor / parse 降级逻辑。 */
async function sendMarkdownOnce(
  chatId: number,
  md: string,
  plainFallback: string,
  replyToId?: number,
  messageThreadId?: number,
): Promise<number> {
  return withRetry(async () => {
    const bot = getBot();
    const anchor =
      typeof replyToId === 'number' && Number.isFinite(replyToId) && replyToId > 0
        ? Math.floor(replyToId)
        : undefined;
    // Prefer modern reply_parameters; also set deprecated reply_to_message_id for
    // older Bot API relays that ignore reply_parameters.
    const replyParams = anchor
      ? { message_id: anchor, allow_sending_without_reply: true as const }
      : undefined;
    const legacyReply = anchor ? { reply_to_message_id: anchor } : {};
    // Telegram forum topic: only meaningful when > 1 (General topic = 1 = default).
    const threadId =
      typeof messageThreadId === 'number' && Number.isFinite(messageThreadId) && messageThreadId > 1
        ? Math.floor(messageThreadId)
        : undefined;
    const threadParam = threadId ? { message_thread_id: threadId } : {};

    try {
      const result = await bot.api.sendMessage(chatId, md, {
        parse_mode: 'MarkdownV2',
        reply_parameters: replyParams,
        ...legacyReply,
        ...threadParam,
      });
      return result.message_id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (anchor && (msg.includes('replied message not found') || msg.includes('message to be replied not found'))) {
        logger.warn({ chatId, replyToId: anchor }, 'sendMessage: reply anchor missing, send plain');
        try {
          const result = await bot.api.sendMessage(chatId, md, { parse_mode: 'MarkdownV2', ...threadParam });
          return result.message_id;
        } catch {
          const result = await bot.api.sendMessage(chatId, plainFallback, { ...threadParam });
          return result.message_id;
        }
      }
      if (msg.includes("can't parse entities") || msg.includes('parse')) {
        logger.debug({ chatId }, 'MarkdownV2 parse failed, falling back to plain text');
        const result = await bot.api.sendMessage(chatId, plainFallback, {
          reply_parameters: replyParams,
          ...legacyReply,
          ...threadParam,
        });
        return result.message_id;
      }
      // "message is too long" 走到这里说明分片没算准(例如上游又拼了内容)。降级:
      // 去掉 parse_mode 直接发纯文本的前 4096 字符,至少别让用户只收到一句故障文案。
      if (msg.includes('too long') || msg.includes('MESSAGE_TOO_LONG')) {
        logger.warn({ chatId, mdLen: md.length }, 'sendMessage: still too long after sharding, sending plain truncated');
        const result = await bot.api.sendMessage(chatId, plainFallback.slice(0, TG_TEXT_LIMIT), {
          reply_parameters: replyParams,
          ...legacyReply,
          ...threadParam,
        });
        return result.message_id;
      }
      throw err;
    }
  }, 'sendMessage', /* idempotent */ false);
}

/**
 * Edit an existing message's text.
 */
export async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  await withRetry(async () => {
    const bot = getBot();
    try {
      await bot.api.editMessageText(chatId, messageId, toMarkdownV2(text), { parse_mode: 'MarkdownV2' });
    } catch {
      await bot.api.editMessageText(chatId, messageId, text);
    }
  }, 'editMessage');
}

/**
 * Send a sticker to a chat.
 */
export async function sendSticker(
  chatId: number,
  stickerId: string,
): Promise<number> {
  return withRetry(async () => {
    const bot = getBot();
    const result = await bot.api.sendSticker(chatId, stickerId);
    return result.message_id;
  }, 'sendSticker', /* idempotent */ false);
}

/**
 * Send a file (document) to a chat — used by CodeAct to deliver sandbox artifacts.
 * Non-idempotent: no retry on transient network errors (may already be delivered).
 */
export async function sendFile(
  chatId: number,
  filePath: string,
  opts: { caption?: string; replyToId?: number; messageThreadId?: number; filename?: string } = {},
): Promise<{ messageId: number }> {
  const { InputFile } = await import('grammy');
  const { readFile, stat } = await import('node:fs/promises');
  const { basename } = await import('node:path');

  const fstat = await stat(filePath);
  if (!fstat.isFile()) throw new Error(`sendFile: not a file: ${filePath}`);
  if (fstat.size > 50 * 1024 * 1024) throw new Error(`sendFile: too large (${fstat.size} bytes)`);

  const buffer = await readFile(filePath);
  const filename = opts.filename ?? basename(filePath);
  const bot = getBot();
  const anchor =
    typeof opts.replyToId === 'number' && Number.isFinite(opts.replyToId) && opts.replyToId > 0
      ? Math.floor(opts.replyToId)
      : undefined;
  const threadId =
    typeof opts.messageThreadId === 'number' && Number.isFinite(opts.messageThreadId) && opts.messageThreadId > 1
      ? Math.floor(opts.messageThreadId)
      : undefined;

  const result = await bot.api.sendDocument(chatId, new InputFile(buffer, filename), {
    caption: opts.caption ? opts.caption.slice(0, 1000) : undefined,
    reply_parameters: anchor ? { message_id: anchor, allow_sending_without_reply: true as const } : undefined,
    message_thread_id: threadId,
  });
  recordSpeech();
  return { messageId: result.message_id };
}

/**
 * Send an OGG/Opus voice message (from TTS). Non-idempotent.
 */
export async function sendVoice(
  chatId: number,
  oggBuffer: Buffer,
  opts: { replyToId?: number; messageThreadId?: number } = {},
): Promise<{ messageId: number }> {
  const { InputFile } = await import('grammy');
  const bot = getBot();
  const anchor =
    typeof opts.replyToId === 'number' && Number.isFinite(opts.replyToId) && opts.replyToId > 0
      ? Math.floor(opts.replyToId)
      : undefined;
  const threadId =
    typeof opts.messageThreadId === 'number' && Number.isFinite(opts.messageThreadId) && opts.messageThreadId > 1
      ? Math.floor(opts.messageThreadId)
      : undefined;

  const result = await bot.api.sendVoice(chatId, new InputFile(oggBuffer, 'voice.ogg'), {
    reply_parameters: anchor ? { message_id: anchor, allow_sending_without_reply: true as const } : undefined,
    message_thread_id: threadId,
  });
  recordSpeech();
  return { messageId: result.message_id };
}

/**
 * Delete a message. Fails silently if already deleted or not found.
 */
export async function deleteMessage(chatId: number, messageId: number): Promise<void> {
  try {
    const bot = getBot();
    await bot.api.deleteMessage(chatId, messageId);
  } catch (err) {
    logger.warn({ chatId, messageId, err }, 'deleteMessage failed (non-critical)');
  }
}
export async function sendChatAction(
  chatId: number,
  action: 'typing' | 'upload_photo' | 'upload_document' | 'record_voice',
): Promise<void> {
  try {
    const bot = getBot();
    await bot.api.sendChatAction(chatId, action);
  } catch (err) {
    // Chat actions are best-effort, don't throw on failure
    logger.debug({ chatId, action, err }, 'sendChatAction failed (non-critical)');
  }
}
