// ────────────────────────────────────────
// Telegram Update → FormattedMessage 转换
// ────────────────────────────────────────

import type { FormattedMessage, UpdateLike } from '../shared/types.js';

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TgSticker {
  file_id: string;
  file_unique_id: string;
  emoji?: string;
  set_name?: string;
  is_animated?: boolean;
  is_video?: boolean;
}

interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

interface TgAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_name?: string;
}

interface TgDocument {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  file_name?: string;
}

interface TgVideo {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
}

interface TgVideoNote {
  file_id: string;
  file_unique_id: string;
  duration: number;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  sender_chat?: TgChat;
  sender_tag?: string;
  date: number;
  edit_date?: number;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  sticker?: TgSticker;
  photo?: TgPhotoSize[];
  audio?: TgAudio;
  voice?: TgAudio;
  document?: TgDocument;
  video?: TgVideo;
  video_note?: TgVideoNote;
  reply_to_message?: TgMessage;
  forward_from?: TgUser;
  forward_sender_name?: string;
  forward_from_chat?: { id: number; title?: string; type: string };
  forward_date?: number;
}

function buildFullName(user: TgUser): string {
  return user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name;
}

function extractReplyTo(replyMsg: TgMessage): FormattedMessage['replyTo'] {
  const from = replyMsg.from;
  const text = replyMsg.text ?? replyMsg.caption ?? '';
  const doc = replyMsg.document as { file_id?: string; mime_type?: string; file_name?: string } | undefined;
  const photo = replyMsg.photo as Array<{ file_id: string }> | undefined;
  return {
    messageId: replyMsg.message_id,
    uid: from?.id ?? 0,
    fullName: from ? buildFullName(from) : 'Unknown',
    textSnippet: text.slice(0, 80),
    ...(doc?.file_id && { documentFileId: doc.file_id, documentMimeType: doc.mime_type, documentFileName: doc.file_name }),
    ...(photo?.length && { imageFileId: photo[photo.length - 1]!.file_id }),
  };
}

function getForwardFrom(msg: TgMessage): string | undefined {
  if (msg.forward_from) {
    return buildFullName(msg.forward_from);
  }
  if (msg.forward_sender_name) {
    return msg.forward_sender_name;
  }
  if (msg.forward_from_chat?.title) {
    return msg.forward_from_chat.title;
  }
  return undefined;
}

function getLargestPhoto(photos: TgPhotoSize[]): string | undefined {
  if (photos.length === 0) return undefined;
  // Sort by size descending, pick largest
  const sorted = [...photos].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return sorted[0]?.file_id;
}

function getLargestPhotoUnique(photos: TgPhotoSize[]): string | undefined {
  if (photos.length === 0) return undefined;
  const sorted = [...photos].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return sorted[0]?.file_unique_id;
}

export function formatMessage(update: UpdateLike): FormattedMessage | null {
  const candidate =
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post;
  if (!candidate || typeof candidate !== 'object') return null;
  const msg = candidate as TgMessage;

  const from = msg.from;
  const senderChat = msg.sender_chat;

  // 必须有发送者（普通用户 或 sender_chat，匿名管理员/频道）
  if (!from && !senderChat) return null;

  const isForwarded = !!(msg.forward_from ?? msg.forward_sender_name ?? msg.forward_from_chat ?? msg.forward_date);

  // 匿名管理员：from 是 GroupAnonymousBot (id: 1087968824)，sender_chat 是真实群
  // 频道消息：from 为空，sender_chat 是频道
  // 新版 API 频道代发：from 是 Channel_Bot (is_bot=true)，sender_chat 是频道
  const isAnonymousAdmin = from?.id === 1087968824;
  const isChannelBot = !!(from?.is_bot && senderChat);
  const effectiveSenderChat = (isAnonymousAdmin || !from || isChannelBot) ? senderChat : undefined;

  const uid = effectiveSenderChat ? effectiveSenderChat.id : from!.id;
  const username = effectiveSenderChat
    ? (effectiveSenderChat.username ?? '')
    : (from!.username ?? '');
  const fullName = effectiveSenderChat
    ? (effectiveSenderChat.title ?? effectiveSenderChat.username ?? 'Channel')
    : buildFullName(from!);
  const isBot = effectiveSenderChat ? false : (from!.is_bot ?? false);
  const isAnonymous = !!effectiveSenderChat;
  const anonymousType = effectiveSenderChat
    ? (isAnonymousAdmin ? 'admin' : 'channel')
    : undefined;

  const formatted: FormattedMessage = {
    role: 'user',
    uid,
    username,
    fullName,
    // 编辑事件用 edit_date:date 是原始发送时间,陈年消息的 typo 修正若按
    // 原时间入册,上下文里会把几小时前的行当成"刚发的"渲染(review #0)
    timestamp: msg.edit_date ?? msg.date,
    messageId: msg.message_id,
    textContent: msg.text ?? '',
    isForwarded,
    isBot,
    ...(isAnonymous && { isAnonymous, anonymousType }),
    ...(msg.sender_tag && { senderTag: msg.sender_tag }),
  };

  if (msg.caption) {
    formatted.captionContent = msg.caption;
  }

  if (msg.sticker) {
    formatted.sticker = {
      emoji: msg.sticker.emoji ?? '',
      fileId: msg.sticker.file_id,
      fileUniqueId: msg.sticker.file_unique_id,
      setName: msg.sticker.set_name,
      isAnimated: msg.sticker.is_animated,
      isVideo: msg.sticker.is_video,
    };
  }

  if (msg.reply_to_message) {
    formatted.replyTo = extractReplyTo(msg.reply_to_message);
  }

  if (isForwarded) {
    formatted.forwardFrom = getForwardFrom(msg);
  }

  if (msg.photo && msg.photo.length > 0) {
    formatted.imageFileId = getLargestPhoto(msg.photo);
    formatted.imageFileUniqueId = getLargestPhotoUnique(msg.photo);
  }

  if (msg.audio) {
    formatted.audioFileId = msg.audio.file_id;
  }

  if (msg.voice) {
    formatted.voiceFileId = msg.voice.file_id;
  }

  if (msg.document) {
    formatted.documentFileId = msg.document.file_id;
    formatted.documentMimeType = msg.document.mime_type;
    formatted.documentFileName = msg.document.file_name;
  }

  if (msg.video) {
    formatted.videoFileId = msg.video.file_id;
  }

  if (msg.video_note) {
    formatted.videoNoteFileId = msg.video_note.file_id;
  }

  return formatted;
}
