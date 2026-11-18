/**
 * ChatLog body packing — store enough message fields for slimContext / prompts.
 * Wire: codec algo 0/1 = plain text (legacy); 2/3 = JSON (±zstd).
 * Host FormattedMessage is structurally compatible with ChatLogLikeMessage.
 */
import { encodeChatTuple } from './format/codec.js';

export const CHAT_JSON_MAX_BYTES = 2800;

/** Host ingress fields only. The package has no dependency on the bot's identity store. */
interface ChatLogEventIdentity {
  eventId: string;
  revision: string;
  messageKey: string;
  ref: {
    id: string;
    conversation: {
      platform: 'telegram' | 'qq'; idNamespace: 'telegram' | 'qq-number' | 'qq-openid';
      accountId: string; conversationKind: 'private' | 'group'; id: string; threadId?: string;
    };
  };
  occurredAt: number | null;
  editedAt: number | null;
  receivedAt: number;
  processedAt: number | null;
}

function copySourceEvent(identity: ChatLogEventIdentity): ChatLogEventIdentity {
  const { eventId, revision, messageKey, occurredAt, editedAt, receivedAt, processedAt } = identity;
  const { platform, accountId, conversationKind, idNamespace, id, threadId } = identity.ref.conversation;
  return { eventId, revision, messageKey, occurredAt, editedAt, receivedAt, processedAt,
    ref: { id: identity.ref.id, conversation: { platform, accountId, conversationKind, idNamespace, id, threadId } } };
}

/** Truncate a JS string so its UTF-8 encoding fits `maxBytes`. */
export function utf8ByteSlice(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  // Avoid splitting a multibyte codepoint.
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Minimal message shape accepted by pack/append (host FormattedMessage satisfies this). */
export type ChatLogLikeMessage = {
  role: 'user' | 'assistant' | 'system';
  uid: number;
  username: string;
  fullName: string;
  timestamp: number;
  messageId: number;
  messageThreadId?: number;
  eventIdentity?: ChatLogEventIdentity;
  /** Host-established storage provenance; never infer it from a legacy bucket. */
  contextScope?: {
    platform: 'telegram' | 'qq';
    accountId: string;
    chatId: number;
    conversationKind: 'private' | 'group';
    threadId: number;
  };
  textContent: string;
  captionContent?: string;
  sticker?: {
    emoji: string;
    fileId: string;
    fileUniqueId: string;
    setName?: string;
    isAnimated?: boolean;
    isVideo?: boolean;
  };
  replyTo?: { messageId: number; uid: number; fullName: string; textSnippet: string };
  isForwarded: boolean;
  forwardFrom?: string;
  imageFileId?: string;
  imageDescriptions?: string[];
  inlineKeyboard?: Array<{ text: string; url?: string; callbackData?: string }>;
  isBot?: boolean;
  isAnonymous?: boolean;
  anonymousType?: string;
  viaBot?: string;
  botClass?: string;
};

/** Fields kept in the ChatLog JSON body (prompt/slim path). */
export type ChatLogPayload = Pick<
  ChatLogLikeMessage,
  | 'role'
  | 'uid'
  | 'username'
  | 'fullName'
  | 'timestamp'
  | 'messageId'
  | 'textContent'
  | 'isForwarded'
> &
  Partial<
    Pick<
      ChatLogLikeMessage,
      | 'captionContent'
      | 'sticker'
      | 'replyTo'
      | 'forwardFrom'
      | 'imageFileId'
      | 'imageDescriptions'
      | 'inlineKeyboard'
      | 'isBot'
      | 'isAnonymous'
      | 'anonymousType'
      | 'viaBot'
      | 'botClass'
      | 'messageThreadId'
      | 'contextScope'
    >
  > & { sourceEvent?: ChatLogEventIdentity };

/** Alias for callers that still say FormattedMessage-shaped. */
export type ChatLogRowLike = ChatLogLikeMessage;

export function toChatLogPayload(message: ChatLogLikeMessage): ChatLogPayload {
  const payload: ChatLogPayload = {
    role: message.role,
    uid: message.uid || 0,
    username: message.username || '',
    fullName: message.fullName || '',
    timestamp: message.timestamp || Math.floor(Date.now() / 1000),
    messageId: message.messageId,
    textContent: utf8ByteSlice(String(message.textContent ?? ''), 2400),
    isForwarded: !!message.isForwarded,
  };
  if (message.captionContent) {
    payload.captionContent = utf8ByteSlice(String(message.captionContent), 800);
  }
  if (message.sticker) {
    payload.sticker = { ...message.sticker };
  }
  if (message.replyTo) {
    payload.replyTo = {
      messageId: message.replyTo.messageId,
      uid: message.replyTo.uid,
      fullName: message.replyTo.fullName,
      textSnippet: utf8ByteSlice(String(message.replyTo.textSnippet ?? ''), 120),
    };
  }
  if (message.forwardFrom) payload.forwardFrom = utf8ByteSlice(String(message.forwardFrom), 120);
  if (message.imageFileId) payload.imageFileId = message.imageFileId;
  if (message.imageDescriptions?.length) {
    payload.imageDescriptions = message.imageDescriptions
      .slice(0, 3)
      .map((d) => utf8ByteSlice(String(d), 300));
  }
  if (message.inlineKeyboard?.length) {
    payload.inlineKeyboard = message.inlineKeyboard.slice(0, 8).map((b) => ({
      text: utf8ByteSlice(String(b.text ?? ''), 64),
      ...(b.url ? { url: utf8ByteSlice(String(b.url), 200) } : {}),
      ...(b.callbackData ? { callbackData: utf8ByteSlice(String(b.callbackData), 64) } : {}),
    }));
  }
  if (message.isBot) payload.isBot = true;
  if (message.isAnonymous) payload.isAnonymous = true;
  if (message.anonymousType) payload.anonymousType = message.anonymousType;
  if (message.viaBot) payload.viaBot = message.viaBot;
  if (message.botClass) payload.botClass = message.botClass;
  if (message.messageThreadId !== undefined) payload.messageThreadId = message.messageThreadId;
  if (message.contextScope !== undefined) payload.contextScope = { ...message.contextScope };
  // Source WAIT must identify the exact gateway revision even when this is the sole
  // history store. Only copy fields from a host-bound group row. No intent/ACL,
  // raw update or model input is part of the storage evidence.
  const identity = message.eventIdentity;
  if (message.role === 'user' && message.contextScope?.platform === 'telegram'
    && message.contextScope.conversationKind === 'group' && identity) {
    payload.sourceEvent = copySourceEvent(identity);
    // Telegram's formatter explicitly records false on human messages.
    if (message.isBot === false) payload.isBot = false;
  }
  return payload;
}

/** JSON string for ChatLog body; truncated to fit a 4KB page tuple (UTF-8 bytes). */
export function packChatLogBody(message: ChatLogLikeMessage): string {
  let payload = toChatLogPayload(message);
  let json = JSON.stringify(payload);
  let bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= CHAT_JSON_MAX_BYTES) return json;

  // Keep the existing prompt body budget. Incomplete rows can still serve as
  // history, but cannot attest a WAIT source.
  if (payload.sourceEvent) {
    delete payload.sourceEvent;
    if (payload.isBot === false) delete payload.isBot;
    json = JSON.stringify(payload);
    bytes = Buffer.byteLength(json, 'utf8');
    if (bytes <= CHAT_JSON_MAX_BYTES) return json;
  }

  // Shrink text until UTF-8 JSON fits.
  let text = payload.textContent ?? '';
  while (bytes > CHAT_JSON_MAX_BYTES && text.length > 32) {
    text = utf8ByteSlice(text, Math.max(32, Math.floor(Buffer.byteLength(text, 'utf8') * 0.7)));
    payload = {
      ...payload,
      textContent: text,
      captionContent: payload.captionContent
        ? utf8ByteSlice(payload.captionContent, 120)
        : undefined,
      imageDescriptions: payload.imageDescriptions?.map((d) => utf8ByteSlice(d, 60)),
    };
    json = JSON.stringify(payload);
    bytes = Buffer.byteLength(json, 'utf8');
  }
  if (bytes <= CHAT_JSON_MAX_BYTES) return json;

  const minimal: ChatLogPayload = {
    role: payload.role,
    uid: payload.uid,
    username: utf8ByteSlice(payload.username, 64),
    fullName: utf8ByteSlice(payload.fullName, 64),
    timestamp: payload.timestamp,
    messageId: payload.messageId,
    textContent: utf8ByteSlice(payload.textContent ?? '', 1200),
    isForwarded: payload.isForwarded,
    ...(payload.messageThreadId !== undefined ? { messageThreadId: payload.messageThreadId } : {}),
    ...(payload.contextScope !== undefined ? { contextScope: payload.contextScope } : {}),
    ...(payload.sticker
      ? { sticker: { emoji: payload.sticker.emoji, fileId: '', fileUniqueId: '' } }
      : {}),
    ...(payload.imageFileId ? { imageFileId: '1' } : {}),
  };
  json = JSON.stringify(minimal);
  if (Buffer.byteLength(json, 'utf8') <= CHAT_JSON_MAX_BYTES) return json;
  return utf8ByteSlice(json, CHAT_JSON_MAX_BYTES);
}

export type ChatLogRow = {
  messageId: number;
  ts: number;
  uid: number;
  role: number;
  roleName: string;
  text: string;
  bodyFormat?: 'text' | 'json';
};

export function unpackChatLogRow(row: ChatLogRow): ChatLogLikeMessage {
  const role =
    row.roleName === 'assistant' || row.role === 1
      ? 'assistant'
      : row.roleName === 'system' || row.role === 2
        ? 'system'
        : 'user';

  if (row.bodyFormat === 'json' || (row.bodyFormat !== 'text' && row.text.startsWith('{'))) {
    try {
      const p = JSON.parse(row.text) as ChatLogPayload;
      return {
        role: p.role || role,
        uid: p.uid ?? row.uid,
        username: p.username ?? '',
        fullName: p.fullName ?? '',
        timestamp: p.timestamp || row.ts,
        messageId: p.messageId || row.messageId,
        textContent: p.textContent ?? '',
        captionContent: p.captionContent,
        sticker: p.sticker,
        replyTo: p.replyTo,
        isForwarded: !!p.isForwarded,
        forwardFrom: p.forwardFrom,
        imageFileId: p.imageFileId,
        imageDescriptions: p.imageDescriptions,
        inlineKeyboard: p.inlineKeyboard,
        isBot: p.isBot,
        isAnonymous: p.isAnonymous,
        anonymousType: p.anonymousType,
        viaBot: p.viaBot,
        botClass: p.botClass,
        messageThreadId: p.messageThreadId,
        contextScope: p.contextScope,
        ...(p.contextScope?.platform === 'telegram' && p.contextScope.conversationKind === 'group'
          && p.role === 'user' && p.sourceEvent ? { eventIdentity: copySourceEvent(p.sourceEvent) } : {}),
      };
    } catch {
      // fall through to plain text
    }
  }

  return {
    role,
    uid: row.uid,
    username: '',
    fullName: '',
    timestamp: row.ts,
    messageId: row.messageId,
    textContent: row.text,
    isForwarded: false,
  };
}

export function chatAppendFromFormatted(message: ChatLogLikeMessage): {
  messageId: number;
  ts: number;
  uid: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  bodyFormat: 'json';
} {
  let text = packChatLogBody(message);
  // Hard cap encoded tuple under empty-page free space (~4028).
  for (let i = 0; i < 6; i++) {
    const enc = encodeChatTuple({
      messageId: message.messageId >>> 0,
      ts: message.timestamp || Math.floor(Date.now() / 1000),
      uid: (message.uid || 0) >>> 0,
      role: message.role === 'assistant' ? 1 : message.role === 'system' ? 2 : 0,
      text,
      bodyFormat: 'json',
    });
    if (enc.length <= 3900) break;
    text = utf8ByteSlice(text, Math.max(64, Math.floor(Buffer.byteLength(text, 'utf8') * 0.75)));
  }
  return {
    messageId: message.messageId,
    ts: message.timestamp || Math.floor(Date.now() / 1000),
    uid: message.uid || 0,
    role:
      message.role === 'assistant'
        ? 'assistant'
        : message.role === 'system'
          ? 'system'
          : 'user',
    text,
    bodyFormat: 'json',
  };
}
