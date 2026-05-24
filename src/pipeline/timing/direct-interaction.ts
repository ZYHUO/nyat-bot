// ────────────────────────────────────────
// Direct-interaction detection (cheap, text-based)
// 用于 debounce / chat-runtime 判断哪些消息要 bypass 节奏控制
// ────────────────────────────────────────
//
// "直接交互" 指的是用户明确在和 bot 说话的消息：
//   - 私聊
//   - 斜杠命令 (/xxx)
//   - @bot 或包含 bot 昵称
//   - 回复 bot 的消息
//   - 编辑消息（独立事件，不参与去抖）
//
// 命中任一条件即视作直接交互，应当：
//   1. 立刻冲刷该 chat 的 debounce 缓冲区（让在等的旧消息先走）
//   2. 自身 bypass 后续 timing gate（直接交给 judge → reply）
//   3. 把 chat-runtime 状态从 STOP/WAIT 唤回 RUNNING
//
// 这套规则与 src/pipeline/judge/rules.ts 中 mention/reply_to_self/
// whitelisted_command/private_chat 等"直接 REPLY"分支对齐，避免被
// 节奏控制误屏蔽。

import type { UpdateLike } from '../../shared/types.js';

interface UpdateMessage {
  text?: unknown;
  caption?: unknown;
  chat?: { type?: unknown };
  reply_to_message?: {
    from?: { id?: unknown };
  };
}

function pickMessage(update: UpdateLike): {
  msg: UpdateMessage | undefined;
  isEdit: boolean;
} {
  // edited_message / edited_channel_post → independent event, treat as direct
  if (update.edited_message)
    return { msg: update.edited_message as UpdateMessage, isEdit: true };
  if (update.edited_channel_post)
    return { msg: update.edited_channel_post as UpdateMessage, isEdit: true };
  if (update.message)
    return { msg: update.message as UpdateMessage, isEdit: false };
  if (update.channel_post)
    return { msg: update.channel_post as UpdateMessage, isEdit: false };
  return { msg: undefined, isEdit: false };
}

export interface DirectInteractionContext {
  botUid: number;
  botUsername: string;
  botNicknames: string[];
}

/**
 * Cheap, text-based check for whether an update represents direct interaction
 * with the bot. Does not require LLM or DB access.
 *
 * Returns true on:
 *   - editing existing message
 *   - private chat (chatId > 0 in payload)
 *   - text/caption starts with '/'
 *   - text/caption mentions @bot_username (case-insensitive)
 *   - text/caption contains any bot nickname (case-insensitive)
 *   - reply_to_message.from.id === botUid
 */
export function looksLikeDirectInteraction(
  update: UpdateLike,
  ctx: DirectInteractionContext,
): boolean {
  const { msg, isEdit } = pickMessage(update);
  if (!msg) return false;
  if (isEdit) return true;

  const chatType =
    typeof msg.chat?.type === 'string' ? (msg.chat.type as string) : '';
  if (chatType === 'private') return true;

  const text =
    (typeof msg.text === 'string' ? msg.text : '') ||
    (typeof msg.caption === 'string' ? msg.caption : '');

  if (text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) return true;

    const lower = trimmed.toLowerCase();
    const usernameLower = ctx.botUsername.toLowerCase();
    if (usernameLower && lower.includes(`@${usernameLower}`)) return true;
    for (const nick of ctx.botNicknames) {
      if (!nick) continue;
      const nickLower = nick.toLowerCase();
      if (nickLower && lower.includes(nickLower)) return true;
    }
  }

  const replyFromId = msg.reply_to_message?.from?.id;
  if (typeof replyFromId === 'number' && replyFromId === ctx.botUid)
    return true;

  return false;
}
