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
  chatId: number,
  text: string,
  replyToId?: number,
  messageThreadId?: number,
): Promise<number> {
  // round 60：同群同文本 30 秒内去重（见上面 dedupKey 的注释）。
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      // ioredis 的 set 重载对 'NX' + 'EX' 组合有类型歧义，用 opts 形式
      const ok = await getRedis().set(dedupKey(chatId, trimmed), '1', 'EX', DEDUP_TTL_SEC, 'NX');
      if (ok !== 'OK') {
        // 最近发过同一句 —— 跳过，但**不返回 0**（0 在调用方语义里是"发送失败"）。
        // 打点后照常返回一个非零 id 的替代：用 replyToId 或 0 会让上层以为失败而重试。
        _dedupSkipped += 1;
        logger.debug({ chatId, chars: trimmed.length, text: trimmed.slice(0, 40) }, 'sendMessage: duplicate text within 30s, skipped');
        incrCounter('send_duplicate_skipped_total', { chat: chatId });
        return -1;
      }
    } catch {
      // Redis 不可用 → 放行（去重是优化，不是正确性前提）
    }
  }
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
    recordBotReply(chatId);
    recordConnectivityWindow(chatId, first, Math.floor(Date.now() / 1000));
    // 同上：分片路径的第一片也带 anchor，一样要标。
    if (replyToId && replyToId > 0) {
      void import('../../meta/answered.js')
        .then(({ markMessageAnswered }) => markMessageAnswered(chatId, replyToId))
        .catch(() => { /* telemetry never breaks the send path */ });
    }
    return first;
  }
  const messageId = await sendMarkdownOnce(chatId, shards[0]!, text, replyToId, messageThreadId);
  recordSpeech();
  recordBotReply(chatId);
  recordConnectivityWindow(chatId, messageId, Math.floor(Date.now() / 1000));
  // round 52（新 goal）：**发出去就把锚点标记为"回过"**。
  //
  // 这是 round 4 那个病的另一半。round 4 修好了"读"的那端（心流的 prompt 里
  // 注入"这条你已经回过 N 次"），但 markMessageAnswered 全仓 7 处调用**全在
  // subagent / gate=no_action 路径上**——心流产出 reply 的主路径一次都没标。
  // 于是"这条我回过"这个事实对心流下一次决策不可见。
  //
  // 今早实测的后果：两条跨任务重复
  //   -1003821093564:180091  00:09 "认命吧" → 00:17 "熊大熊二都出来了"（隔 8 分钟）
  //   -1004430867819:13331   00:12 "谁查你岗了" → 00:14 "紧张什么"（隔 2.5 分钟）
  // 重复率从全天 1.9% 跳到今早 12.5%。
  //
  // 放在这里是因为 sendMessage 是所有回复的公共出口（legacy pipeline、
  // 心流、subagent failsafe 全走它），补一处覆盖全部路径。
  // 顺序 import：telegram.ts 被 sender 自己引用，顶层 import answered.js
  // 会成环（answered → redis，不环；但保持和其它非关键路径一致）。
  if (replyToId && replyToId > 0) {
    void import('../../meta/answered.js')
      .then(({ markMessageAnswered }) => markMessageAnswered(chatId, replyToId))
      .catch(() => { /* telemetry never breaks the send path */ });
  }
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
        // 带上 Telegram 的原话。2026-09-21：这一处原来只有 { chatId }，
        // 于是"我们的 Markdown 转义哪里写错了"这类问题只能靠猜。
        // Telegram 的报错会指出具体是哪个字符/实体不合法——那是修转义函数的唯一线索。
        // 只截 200 字：它通常是一段带偏移量的 JSON。
        logger.debug(
          { chatId, tgErr: msg.slice(0, 200) },
          'MarkdownV2 parse failed, falling back to plain text',
        );
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
  opts: { caption?: string; replyToId?: number; messageThreadId?: number } = {},
): Promise<{ messageId: number }> {
  const { InputFile } = await import('grammy');
  const { readFile, stat } = await import('node:fs/promises');
  const { basename } = await import('node:path');

  const fstat = await stat(filePath);
  if (!fstat.isFile()) throw new Error(`sendPhoto: not a file: ${filePath}`);
  if (fstat.size > 10 * 1024 * 1024) throw new Error(`sendPhoto: too large (${fstat.size} bytes)`);

  const buffer = await readFile(filePath);
  const bot = getBot();
  const anchor =
    typeof opts.replyToId === 'number' && Number.isFinite(opts.replyToId) && opts.replyToId > 0
      ? Math.floor(opts.replyToId)
      : undefined;
  const threadId =
    typeof opts.messageThreadId === 'number' && Number.isFinite(opts.messageThreadId) && opts.messageThreadId > 1
      ? Math.floor(opts.messageThreadId)
      : undefined;

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
  recordBotReply(chatId);
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
  messageThreadId?: number,
): Promise<void> {
  try {
    const bot = getBot();
    // forum（topic）群必须带 message_thread_id，否则 typing 显示在 General 而不是对应话题里
    await bot.api.sendChatAction(chatId, action, messageThreadId ? { message_thread_id: messageThreadId } : {});
  } catch (err) {
    // Chat actions are best-effort, don't throw on failure
    logger.debug({ chatId, action, err }, 'sendChatAction failed (non-critical)');
  }
}
