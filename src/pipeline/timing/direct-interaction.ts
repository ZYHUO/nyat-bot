// ────────────────────────────────────────
// Direct-interaction detection (cheap, text-based)
// 用于 debounce / chat-runtime 判断哪些消息要 bypass 节奏控制
// ────────────────────────────────────────

import type { UpdateLike } from '../../shared/types.js';

interface UpdateMessage {
  text?: unknown;
  caption?: unknown;
  chat?: { type?: unknown };
  reply_to_message?: {
    from?: { id?: unknown };
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsStandaloneToken(text: string, token: string): boolean {
  if (!token) return false;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(token)}([^\\p{L}\\p{N}_]|$)`, 'iu');
  return pattern.test(text);
}

function pickMessage(update: UpdateLike): {
  msg: UpdateMessage | undefined;
  isEdit: boolean;
} {
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

export type DirectInteractionKind =
  | 'private_chat'
  | 'command'
  | 'mention'
  | 'nickname'
  | 'reply_to_bot'
  | 'edit';

export interface DirectInteractionContext {
  botUid: number;
  botUsername: string;
  botNicknames: string[];
  editByContentOnly?: boolean;
}

function mentionsBotNickname(text: string, nicknames: string[]): boolean {
  const lower = text.toLowerCase();
  // Longer nicknames first so「啾咪囝」优先于「啾咪」
  const nicks = [...nicknames].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const nick of nicks) {
    const nickLower = nick.toLowerCase();
    if (!nickLower) continue;
    // ASCII / 数字昵称：要词边界，避免误伤
    if (/[a-z0-9_]/i.test(nickLower)) {
      if (containsStandaloneToken(lower, nickLower)) return true;
      continue;
    }
    // 中文昵称：中文无空格，词边界会把「叫啾咪」判失败 —— 用 includes（与 judge 一致）
    if (lower.includes(nickLower)) return true;
  }
  return false;
}

export function detectDirectInteraction(
  update: UpdateLike,
  ctx: DirectInteractionContext,
): DirectInteractionKind | null {
  const { msg, isEdit } = pickMessage(update);
  if (!msg) return null;
  if (isEdit && !ctx.editByContentOnly) return 'edit';

  const chatType =
    typeof msg.chat?.type === 'string' ? (msg.chat.type as string) : '';
  if (chatType === 'private') return 'private_chat';

  const text =
    (typeof msg.text === 'string' ? msg.text : '') ||
    (typeof msg.caption === 'string' ? msg.caption : '');

  if (text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) return 'command';

    const lower = trimmed.toLowerCase();
    const usernameLower = ctx.botUsername.toLowerCase();
    if (usernameLower && lower.includes(`@${usernameLower}`)) return 'mention';
    if (mentionsBotNickname(trimmed, ctx.botNicknames)) return 'nickname';
  }

  const replyFromId = msg.reply_to_message?.from?.id;
  if (typeof replyFromId === 'number' && replyFromId === ctx.botUid) {
    return 'reply_to_bot';
  }

  return null;
}

export function looksLikeDirectInteraction(
  update: UpdateLike,
  ctx: DirectInteractionContext,
): boolean {
  return detectDirectInteraction(update, ctx) !== null;
}
