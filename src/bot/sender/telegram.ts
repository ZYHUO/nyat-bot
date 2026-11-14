import { randomUUID } from 'node:crypto';
import { deliveryFailureStatus, requireSentDelivery, type DeliveryIdentity, type DeliveryResult, type ConfirmedDeliveryPart } from '../../shared/delivery-result.js';
// ────────────────────────────────────────
// Telegram Sender — API wrapper with retry
// ────────────────────────────────────────

import { getBot } from '../bot.js';
import { toMarkdownV2 } from './markdown.js';
import { shardMarkdownV2, TG_TEXT_LIMIT } from './shard.js';
import { recordSpeech } from '../../tracking/speech-meter.js';
import { recordBotReply } from '../../tracking/reply-activity.js';
import { recordBotMessageForConnectivity } from '../../agent/reverse-valve.js';
import { logger } from '../../shared/logger.js';
import { getRedis } from '../../db/redis.js';
import { incrCounter } from '../../metrics/registry.js';
import {
  deletePlatformMessage, platformChatAction, platformConversation,
  rejectUnsupportedPlatformAction, sendPlatformText, sendPlatformMedia, reactPlatformMessage,
} from '../../platform/outbound.js';
import { assertTelegramPayload } from '../../platform/telegram-guard.js';
import { UnsupportedCapabilityError } from '../../platform/types.js';
import { env } from '../../env.js';
import { assertOutboundText, assertOutboundFile, assertSameConversationForward } from '../../shared/outbound-privacy.js';

const MAX_RETRIES = 3;

// AGI L6 Phase 14: 连接率埋点 —— 只记群聊(chatId < 0),DM 不记。
// fire-and-forget,失败不影响发送。
function recordConnectivityWindow(chatId: number, mid: number, ts: number): void {
  if (chatId >= 0 || !mid) return;
  void recordBotMessageForConnectivity(chatId, mid, '', ts).catch((err) => {
    logger.debug({ err, chatId }, 'connectivity record failed');
  });
}
const BASE_BACKOFF_MS = 1000;

/** React to a message with a single emoji (Telegram setMessageReaction). Best-effort. */
export async function reactToMessage(chatId: number, messageId: number, emoji: string): Promise<boolean> {
  if (platformConversation(chatId)) return reactPlatformMessage(chatId, messageId, emoji);
  assertTelegramPayload({ chat_id: chatId, message_id: messageId });
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

/** 发起群投票（sendPoll，匿名单选）。返回 messageId；失败返回 0。非幂等不重试。 */
export async function sendPoll(
  chatId: number,
  question: string,
  options: string[],
  messageThreadId?: number,
): Promise<number> {
  assertOutboundText([question, ...options].join('\n'));
  rejectUnsupportedPlatformAction(chatId, 'polls');
  assertTelegramPayload({ chat_id: chatId, message_thread_id: messageThreadId });
  try {
    const bot = getBot();
    const threadParam = messageThreadId ? { message_thread_id: messageThreadId } : {};
    const r = await bot.api.sendPoll(
      chatId,
      question.slice(0, 300),
      options.slice(0, 10).map((o) => ({ text: o.slice(0, 100) })),
      { is_anonymous: true, allows_multiple_answers: false, ...threadParam },
    );
    return r.message_id;
  } catch (err) {
    logger.debug({ err, chatId }, 'sendPoll failed (non-critical)');
    return 0;
  }
}

/** 转发消息（forwardMessage）。返回目标群的 messageId；失败返回 0。非幂等不重试。 */
export async function forwardMessage(
  targetChatId: number,
  fromChatId: number,
  messageId: number,
): Promise<number> {
  rejectUnsupportedPlatformAction(targetChatId, 'forwarding');
  rejectUnsupportedPlatformAction(fromChatId, 'forwarding');
  assertSameConversationForward(targetChatId, fromChatId);
  assertTelegramPayload({ chat_id: targetChatId, from_chat_id: fromChatId, message_id: messageId });
  try {
    const bot = getBot();
    const r = await bot.api.forwardMessage(targetChatId, fromChatId, Math.floor(messageId));
    return r.message_id;
  } catch (err) {
    logger.debug({ err, targetChatId, fromChatId, messageId }, 'forwardMessage failed (non-critical)');
    return 0;
  }
}

/** 临时禁言（restrictChatMember 全权限关闭 + until_date）。失败 false。 */
export async function muteMember(chatId: number, uid: number, minutes: number): Promise<boolean> {
  rejectUnsupportedPlatformAction(chatId, 'member administration');
  assertTelegramPayload({ chat_id: chatId, user_id: uid });
  try {
    const bot = getBot();
    const until = Math.floor(Date.now() / 1000) + Math.floor(minutes) * 60;
    await bot.api.restrictChatMember(
      chatId,
      Math.floor(uid),
      {
        can_send_messages: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_documents: false,
        can_send_audios: false,
        can_send_voice_notes: false,
        can_send_video_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_invite_users: false,
        can_pin_messages: false,
        can_manage_topics: false,
      },
      { until_date: until },
    );
    return true;
  } catch (err) {
    logger.debug({ err, chatId, uid, minutes }, 'muteMember failed');
    return false;
  }
}

/**
 * 踢人（ban 后立即 unban，这样对方能被重新加回来，不是永久封杀）。
 *
 * 为什么是 ban+unban 而不是 banChatMember 单飞：TG 的"踢出群"就是这个语义——
 * 移出当前成员但不禁言，对方还能自己回来。deleteMessages=true 时连对方的
 * 历史消息一起清（TG 只对 48h 内的消息有效）。
 */
export async function kickMember(
  chatId: number,
  uid: number,
  deleteMessages = false,
): Promise<boolean> {
  rejectUnsupportedPlatformAction(chatId, 'member administration');
  assertTelegramPayload({ chat_id: chatId, user_id: uid });
  try {
    const bot = getBot();
    const id = Math.floor(uid);
    await bot.api.banChatMember(chatId, id);
    await bot.api.unbanChatMember(chatId, id, { only_if_banned: true });
    if (deleteMessages) {
      // 失败不影响踢人本身（TG 对老消息会拒绝），故单独 try。
      try {
        // 该 API 在部分 grammY 版本的类型里缺失（运行时有），用窄转换调用。
        const api = bot.api as unknown as {
          deleteChatMemberMessages?: (c: number, u: number) => Promise<unknown>;
        };
        await api.deleteChatMemberMessages?.(chatId, id);
      } catch { /* 老消息/无权限时静默 */ }
    }
    return true;
  } catch (err) {
    logger.debug({ err, chatId, uid, deleteMessages }, 'kickMember failed');
    return false;
  }
}

/** 解除禁言（恢复全权限）。失败 false。 */
export async function unmuteMember(chatId: number, uid: number): Promise<boolean> {
  rejectUnsupportedPlatformAction(chatId, 'member administration');
  assertTelegramPayload({ chat_id: chatId, user_id: uid });
  try {
    const bot = getBot();
    await bot.api.restrictChatMember(chatId, Math.floor(uid), {
      can_send_messages: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_documents: true,
      can_send_audios: true,
      can_send_voice_notes: true,
      can_send_video_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_invite_users: true,
    });
    return true;
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'unmuteMember failed');
    return false;
  }
}

/** 置顶/取消置顶。失败 false。 */
export async function pinMessage(chatId: number, messageId: number, unpin = false): Promise<boolean> {
  rejectUnsupportedPlatformAction(chatId, 'pins');
  assertTelegramPayload({ chat_id: chatId, message_id: messageId });
  try {
    const bot = getBot();
    if (unpin) await bot.api.unpinChatMessage(chatId, Math.floor(messageId));
    else await bot.api.pinChatMessage(chatId, Math.floor(messageId), { disable_notification: true });
    return true;
  } catch (err) {
    logger.debug({ err, chatId, messageId, unpin }, 'pinMessage failed');
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
/**
 * round 60（新 goal，用户："前言不搭后语"）：同群 30 秒内**同文本**去重。
 *
 * 实测（2026-09-23，近 2 小时）：同一句话在 30 秒内被发两遍 2 次 ——
 *   -1003931124139  "能用 刚还在跑"          隔 7s
 *   -1004449419602  "确实，扫两眼也懒得翻了"  隔 19s
 *
 * 成因不是同一次任务内的分句重复（那个由 repliedAnchors 去重，round 1 就有），
 * 而是**两次独立回合**给出了同一句话——通常是同一波消息被评估了两次，
 * 或者 humanizer 的 delete-and-resend 之外又发了一遍。
 *
 * 判据故意很窄：同群 + 同文本 + 30 秒内。窄是为了不误伤——
 *  · 不同群可以同文本（不同人问同一问题）
 *  · 超过 30 秒同文本是合理的（别人又问了一遍）
 *  · 同一次任务的多气泡本来就不是同文本
 *
 * Redis SET NX（chatId + hash(text)），TTL 30 秒。NX 失败 = 最近发过 → 跳过。
 */
const DEDUP_TTL_SEC = 30;
/**
 * **前缀去重**（round 65，2026-09-23 部署后回测校）。
 *
 * round 60 第一版按全文 hash，round 65 实测漏了这些
 * （-1004451430063，06:33-06:41，dedup 已生效后）：
 *   zz lll / zz lll 的 / zz lll / zz lll 的节点 / zz lll / zz lll
 * 用户看到的就是"同一句话反复说"——和 round 61 那个 14 连发同形。
 *
 * ⚠️ **round 66 修正归因**：round 65 我断定这是"模型抽风输出垃圾字符串"，
 * **错了**。`zz lll` 是那个群里一个群友的昵称（入群验证消息：
 * "zz lll 已通过入群验证"）。所以这不是乱码，是 bot 在 66 秒内
 * **反复叫同一个人的名字 6 次**。
 *
 * 性质不同但教训同一个：先用数据定性再动手。我 round 65 看到一堆
 * 无意义的 Latin 字母就当成了乱码——而它只是在喊人。
 *
 * ⚠️ 长度参数试了三轮才对，记下来防再犯：
 *   · 全文 hash（round 60）        → 完全漏（六条互不相同）
 *   · 前 12 字（round 65 v1）      → 漏（6 字文本的前 12 字就是全文）
 *   · 前 8 字 + 短文本全文（v2）   → 仍漏（'zz lll' 与 'zz lll 的' 全文仍不同）
 *
 * 病根：**这个家族的成员互为"加长版"，任何基于"取前 N 字再 hash"
 * 的方案，只要 N >= 短的那个的长度，就会把它们区分开。**
 *
 * 最终判据：**剥掉尾部空白后取前 4 字**作 hash 基准。
 *
 * 4 字 + 剥尾空白，两个细节都是被真实数据教出来的：
 *   · 剥尾空白：'zz lll' 的前 6 字 'zz lll' vs 'zz lll 的' 的前 6 字
 *     'zz lll '——差一个空格，前缀判据就失效了
 *   · 4 字而不是 6 字：6 字时那两个还是不同（前者全文只有 6 字、后者是
 *     'zz lll '），4 字才让它们落到同一个 'zz l'
 *
 * 实测（真实日志那 6 条 + 两个构造用例）：
 *   "zz lll" vs "zz lll 的"          → 同 ✓
 *   "zz lll" vs "zz lll 的节点"      → 同 ✓
 *   "节点全红了快看看" vs "节点全红了别哭" → 同 ✓
 *
 * 已知代价（诚实记录，测试 ③d 锁着）：前 4 字相同但语义不同的回复会被误判，
 * 如 "今天天气不错我们出去玩" 与 "今天天气不行在家躺着"。缓解是 30s TTL +
 * 同群——30 秒内同一群连发这两句本身就很异常。语义相似度更准但要
 * embedding，在发送路径上太贵；4 字前缀是便宜且够用的折中。
 */
const DEDUP_PREFIX_CHARS = 4;

const dedupKey = (chatId: number, text: string): string => {
  // 尾部空白也剥掉再切——否则 'zz lll'(6) 的前 6 字 'zz lll'
  // 与 'zz lll 的'(7) 的前 6 字 'zz lll ' 差一个空格，前缀判据失效。
  const basis = text.trim().replace(/\s+$/, '').slice(0, DEDUP_PREFIX_CHARS);
  let h = 0;
  for (let i = 0; i < basis.length; i++) h = (h * 31 + basis.charCodeAt(i)) | 0;
  return `xxb:send:dedup:${chatId}:${h}`;
};

let _dedupSkipped = 0;

/** round 60：因同群同文本 30s 内重复而被跳过的次数（可观测）。 */
export function dedupSkippedCount(): number {
  return _dedupSkipped;
}

export async function sendMessage(
  chatId: number, text: string, replyToId?: number, messageThreadId?: number,
  options?: Partial<DeliveryIdentity> & { onReceipt?: (result: DeliveryResult) => void; markAnswered?: boolean; beforeSend?: () => void },
): Promise<number> {
  const result = await sendMessageDetailed(chatId, text, replyToId, messageThreadId, options);
  options?.onReceipt?.(result);
  return requireSentDelivery(result).messageId;
}

/** One logical send, including acknowledged shards when a later shard fails. */
export async function sendMessageDetailed(
  chatId: number, text: string, replyToId?: number, messageThreadId?: number,
  identity?: Partial<DeliveryIdentity> & { beforeSend?: () => void; markAnswered?: boolean },
): Promise<DeliveryResult> {
  const base = {
    intentId: identity?.intentId ?? randomUUID(), revision: identity?.revision ?? 0,
    chatId, ...(replyToId === undefined ? {} : { targetMessageId: replyToId }),
    ...(messageThreadId === undefined ? {} : { messageThreadId }),
  };
  const parts: ConfirmedDeliveryPart[] = [];
  let attempted = false;
  let plannedPartCount = 1;
  const beforeSend = () => { attempted = false; identity?.beforeSend?.(); attempted = true; };
  try {
    assertOutboundText(text);
    if (!text.trim()) return { ...base, status: 'suppressed', reason: 'empty_text', parts, plannedPartCount: 0 };
    if (platformConversation(chatId)) {
      if (messageThreadId !== undefined) throw new UnsupportedCapabilityError('topics');
      beforeSend();
      // Preserve OneBot's typed unknown/not_sent errors. Never fall back to Telegram.
      const messageId = await sendPlatformText(chatId, text, replyToId);
      if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('invalid_platform_receipt');
      parts.push({ messageId, text, partIndex: 0 });
    } else {
      assertTelegramPayload({ chat_id: chatId, reply_to_message_id: replyToId, message_thread_id: messageThreadId });
      let duplicate = false;
      try {
        duplicate = await getRedis().set(dedupKey(chatId, text.trim()), '1', 'EX', DEDUP_TTL_SEC, 'NX') !== 'OK';
      } catch { /* Text similarity suppression is best-effort, not a delivery claim. */ }
      if (duplicate) {
        _dedupSkipped += 1;
        // Keep this at info: the gate-evidence reader runs with LOG_LEVEL=info.
        logger.info({ chatId, chars: text.trim().length }, 'sendMessage: duplicate text within 30s, skipped');
        incrCounter('send_duplicate_skipped_total', { chat: chatId });
        return { ...base, status: 'suppressed', reason: 'duplicate_text', parts, plannedPartCount };
      }
      const shards = shardMarkdownV2(toMarkdownV2(text));
      plannedPartCount = shards.length;
      for (const [partIndex, md] of shards.entries()) {
        // A rejected shard must fall back to THIS shard, never to the whole plan.
        const fallback = shards.length === 1 ? text : md.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
        const part = await sendMarkdownOnce(chatId, md, fallback, partIndex === 0 ? replyToId : undefined,
          messageThreadId, beforeSend);
        parts.push({ ...part, partIndex });
      }
    }
    return { ...base, status: 'sent', parts, plannedPartCount };
  } catch (error) {
    return { ...base, status: deliveryFailureStatus(error, attempted), reason: 'transport_unconfirmed',
      parts, plannedPartCount, error };
  } finally {
    // Metrics/anchor state reflect ACKs, not the planned count or a suppression sentinel.
    if (parts.length > 0) {
      recordSpeech(); recordBotReply(chatId);
      recordConnectivityWindow(chatId, parts[0]!.messageId, Math.floor(Date.now() / 1000));
      if (identity?.markAnswered !== false && parts.length === plannedPartCount && replyToId && replyToId > 0) {
        void import('../../meta/answered.js')
          .then(({ markMessageAnswered }) => markMessageAnswered(chatId, replyToId))
          .catch(() => { /* telemetry never breaks the send path */ });
      }
    }
  }
}

/** Explicit API rejection alone permits a format/anchor fallback; uncertainty never does. */
async function sendMarkdownOnce(
  chatId: number, md: string, plainFallback: string, replyToId?: number,
  messageThreadId?: number, beforeSend?: () => void,
): Promise<{ messageId: number; text: string }> {
  return withRetry(async () => {
    const bot = getBot();
    const anchor = typeof replyToId === 'number' && Number.isFinite(replyToId) && replyToId > 0
      ? Math.floor(replyToId) : undefined;
    const threadParam = messageThreadId && messageThreadId > 1 ? { message_thread_id: Math.floor(messageThreadId) } : {};
    const replyParams = anchor ? { message_id: anchor, allow_sending_without_reply: true as const } : undefined;
    const request = async (content: string, markdown: boolean, withAnchor: boolean) => {
      beforeSend?.();
      const result = await bot.api.sendMessage(chatId, content, {
        ...(markdown ? { parse_mode: 'MarkdownV2' as const } : {}), ...threadParam,
        ...(withAnchor && anchor ? { reply_parameters: replyParams, reply_to_message_id: anchor } : {}),
      });
      if (!Number.isSafeInteger(result.message_id) || result.message_id <= 0) throw new Error('invalid_platform_receipt');
      return { messageId: result.message_id, text: result.text ?? (markdown ? plainFallback : content) };
    };
    const parseRejected = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("can't parse entities") || message.includes('ENTITY_BOUNDS_INVALID');
    };
    try { return await request(md, true, true); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (anchor && (message.includes('replied message not found') || message.includes('message to be replied not found'))) {
        try { return await request(md, true, false); }
        catch (fallbackError) {
          if (!parseRejected(fallbackError)) throw fallbackError;
          return request(plainFallback, false, false);
        }
      }
      if (parseRejected(error)) return request(plainFallback, false, true);
      if (message.includes('too long') || message.includes('MESSAGE_TOO_LONG')) {
        if (plainFallback.length <= TG_TEXT_LIMIT) return request(plainFallback, false, true);
        throw error; // Never acknowledge an intentionally truncated planned shard.
      }
      throw error;
    }
  }, 'sendMessage', false);
}

/**
 * Edit an existing message's text.
 */
export async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  assertOutboundText(text);
  rejectUnsupportedPlatformAction(chatId, 'editing');
  assertTelegramPayload({ chat_id: chatId, message_id: messageId });
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
  opts: { beforeSend?: () => void } = {},
): Promise<number> {
  if (platformConversation(chatId)) {
    if (!env().ONEBOT_MEDIA_ENABLED) throw new UnsupportedCapabilityError('stickers');
    const { resolveOneBotMedia } = await import('../../platform/onebot-media.js');
    const file = await resolveOneBotMedia(stickerId, chatId);
    if (!file.mimeType.startsWith('image/')) throw new UnsupportedCapabilityError('nonimage sticker');
    const messageId = await sendPlatformMedia(chatId, 'image', file.bytes, file.fileName, { beforeSend: () => {
      file.assertAvailable(); opts.beforeSend?.();
    } });
    recordSpeech(); recordBotReply(chatId);
    return messageId;
  }
  assertTelegramPayload({ chat_id: chatId, sticker: stickerId });
  return withRetry(async () => {
    const bot = getBot();
    opts.beforeSend?.();
    const result = await bot.api.sendSticker(chatId, stickerId);
    recordBotReply(chatId);
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
  opts: { caption?: string; replyToId?: number; messageThreadId?: number; filename?: string; beforeSend?: () => void } = {},
): Promise<{ messageId: number }> {
  const qq = platformConversation(chatId);
  if (qq && !env().ONEBOT_MEDIA_ENABLED) throw new UnsupportedCapabilityError('files');
  if (!qq) assertTelegramPayload({ chat_id: chatId, reply_to_message_id: opts.replyToId, message_thread_id: opts.messageThreadId });
  const { InputFile } = await import('grammy');
  const { readFile, stat } = await import('node:fs/promises');
  const { basename } = await import('node:path');

  const fstat = await stat(filePath);
  if (!fstat.isFile()) throw new Error(`sendFile: not a file: ${filePath}`);
  if (fstat.size > 50 * 1024 * 1024) throw new Error(`sendFile: too large (${fstat.size} bytes)`);

  const buffer = await readFile(filePath);
  const filename = opts.filename ?? basename(filePath);
  assertOutboundFile(buffer, filename, opts.caption);
  if (qq) {
    const messageId = await sendPlatformMedia(chatId, 'file', buffer, filename, opts);
    recordSpeech(); recordBotReply(chatId);
    return { messageId };
  }
  const bot = getBot();
  const anchor =
    typeof opts.replyToId === 'number' && Number.isFinite(opts.replyToId) && opts.replyToId > 0
      ? Math.floor(opts.replyToId)
      : undefined;
  const threadId =
    typeof opts.messageThreadId === 'number' && Number.isFinite(opts.messageThreadId) && opts.messageThreadId > 1
      ? Math.floor(opts.messageThreadId)
      : undefined;

  opts.beforeSend?.();
  const result = await bot.api.sendDocument(chatId, new InputFile(buffer, filename), {
    caption: opts.caption ? opts.caption.slice(0, 1000) : undefined,
    reply_parameters: anchor ? { message_id: anchor, allow_sending_without_reply: true as const } : undefined,
    message_thread_id: threadId,
  });
  recordSpeech();
  recordBotReply(chatId);
  return { messageId: result.message_id };
}

/**
 * Send a local image file as a photo (inline display). 发图首选——照片直接展开在
 * 聊天里，sendDocument 要点下载，真人发图都是照片。Non-idempotent.
 */
export async function sendPhoto(
  chatId: number,
  filePath: string,
  opts: { caption?: string; replyToId?: number; messageThreadId?: number; beforeSend?: () => void } = {},
): Promise<{ messageId: number }> {
  if (opts.caption) assertOutboundText(opts.caption);
  const qq = platformConversation(chatId);
  if (qq && !env().ONEBOT_MEDIA_ENABLED) throw new UnsupportedCapabilityError('photos');
  if (!qq) assertTelegramPayload({ chat_id: chatId, reply_to_message_id: opts.replyToId, message_thread_id: opts.messageThreadId });
  const { InputFile } = await import('grammy');
  const { readFile, stat } = await import('node:fs/promises');
  const { basename } = await import('node:path');

  const fstat = await stat(filePath);
  if (!fstat.isFile()) throw new Error(`sendPhoto: not a file: ${filePath}`);
  if (fstat.size > 10 * 1024 * 1024) throw new Error(`sendPhoto: too large (${fstat.size} bytes)`);

  const buffer = await readFile(filePath);
  if (qq) {
    const messageId = await sendPlatformMedia(chatId, 'image', buffer, basename(filePath), opts);
    recordSpeech(); recordBotReply(chatId);
    return { messageId };
  }
  const bot = getBot();
  const anchor =
    typeof opts.replyToId === 'number' && Number.isFinite(opts.replyToId) && opts.replyToId > 0
      ? Math.floor(opts.replyToId)
      : undefined;
  const threadId =
    typeof opts.messageThreadId === 'number' && Number.isFinite(opts.messageThreadId) && opts.messageThreadId > 1
      ? Math.floor(opts.messageThreadId)
      : undefined;

  opts.beforeSend?.();
  const result = await bot.api.sendPhoto(chatId, new InputFile(buffer, basename(filePath)), {
    caption: opts.caption ? opts.caption.slice(0, 1000) : undefined,
    reply_parameters: anchor ? { message_id: anchor, allow_sending_without_reply: true as const } : undefined,
    message_thread_id: threadId,
  });
  recordSpeech();
  recordBotReply(chatId);
  return { messageId: result.message_id };
}

/**
 * Send an OGG/Opus voice message (from TTS). Non-idempotent.
 */
export async function sendVoice(
  chatId: number,
  oggBuffer: Buffer,
  opts: { replyToId?: number; messageThreadId?: number; beforeSend?: () => void } = {},
): Promise<{ messageId: number }> {
  if (platformConversation(chatId)) {
    if (!env().ONEBOT_MEDIA_ENABLED) throw new UnsupportedCapabilityError('voice');
    const messageId = await sendPlatformMedia(chatId, 'voice', oggBuffer, 'voice.ogg', opts);
    recordSpeech(); recordBotReply(chatId);
    return { messageId };
  }
  assertTelegramPayload({ chat_id: chatId, reply_to_message_id: opts.replyToId, message_thread_id: opts.messageThreadId });
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

  opts.beforeSend?.();
  const result = await bot.api.sendVoice(chatId, new InputFile(oggBuffer, 'voice.ogg'), {
    reply_parameters: anchor ? { message_id: anchor, allow_sending_without_reply: true as const } : undefined,
    message_thread_id: threadId,
  });
  recordSpeech();
  recordBotReply(chatId);
  return { messageId: result.message_id };
}

/**
 * Delete a message. Fails silently if already deleted or not found.
 */
export async function deleteMessage(chatId: number, messageId: number): Promise<void> {
  if (platformConversation(chatId)) return deletePlatformMessage(chatId, messageId);
  assertTelegramPayload({ chat_id: chatId, message_id: messageId });
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
  messageThreadId?: number,
): Promise<void> {
  if (platformChatAction(chatId)) {
    logger.debug({ chatId, action, available: false }, 'Platform chat action unavailable');
    return;
  }
  assertTelegramPayload({ chat_id: chatId, message_thread_id: messageThreadId });
  try {
    const bot = getBot();
    // forum（topic）群必须带 message_thread_id，否则 typing 显示在 General 而不是对应话题里
    await bot.api.sendChatAction(chatId, action, messageThreadId ? { message_thread_id: messageThreadId } : {});
  } catch (err) {
    // Chat actions are best-effort, don't throw on failure
    logger.debug({ chatId, action, err }, 'sendChatAction failed (non-critical)');
  }
}
