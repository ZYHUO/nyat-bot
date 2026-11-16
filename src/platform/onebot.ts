import { accountKey, conversationKey, opaqueId } from './identity.js';
import type {
  AccountRef, ConversationRef, MessageSegment, NormalizedMessage,
  PlatformAction, PlatformAdapterCodec, PlatformCapabilities, UserRef,
} from './types.js';
import { PlatformBoundaryError, UnsupportedCapabilityError } from './types.js';

type RecordValue = Record<string, unknown>;
export interface OneBotSegment { type: string; data: Record<string, string>; }
export type OneBotSendCommand =
  | { action: 'send_group_msg'; params: { group_id: number; message: OneBotSegment[] } }
  | { action: 'send_private_msg'; params: { user_id: number; message: OneBotSegment[] } };

export const ONEBOT_MINIMAL_CAPABILITIES: PlatformCapabilities = Object.freeze({
  inboundSegments: Object.freeze(['text', 'mention', 'mention-all', 'reply', 'image', 'voice', 'video', 'file', 'unsupported'] as const),
  outboundSegments: Object.freeze(['text', 'mention', 'reply'] as const),
  actions: Object.freeze(['send'] as const),
});

function record(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformBoundaryError('invalid_event', `${field} must be an object`);
  }
  return value as RecordValue;
}

function numericId(value: unknown, field: string, positive = true): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new PlatformBoundaryError('unsafe_numeric_id', `${field} has already lost numeric precision`);
    }
    value = String(value);
  }
  const id = opaqueId(value, field);
  if (!/^-?\d+$/.test(id) || (positive && !/^[1-9]\d*$/.test(id))) {
    throw new PlatformBoundaryError('invalid_id', `${field} is not a valid OneBot integer ID`);
  }
  return id;
}

function actionId(value: string, field: string): number {
  const id = numericId(value, field);
  const number = Number(id);
  if (!Number.isSafeInteger(number)) {
    throw new PlatformBoundaryError('unsafe_numeric_id', `${field} cannot be represented by the OneBot JSON numeric API`);
  }
  return number;
}

function decodeCq(value: string, parameter = false): string {
  const decoded = value.replace(/&#91;/g, '[').replace(/&#93;/g, ']');
  return (parameter ? decoded.replace(/&#44;/g, ',') : decoded).replace(/&amp;/g, '&');
}

/** OneBot may deliver arrays or CQ strings; outgoing text always uses typed segments. */
function parseCqString(message: string): unknown[] {
  const segments: unknown[] = [];
  const re = /\[CQ:([a-zA-Z_][a-zA-Z0-9_]*)(?:,([^\]]*))?\]/g;
  let offset = 0;
  for (const match of message.matchAll(re)) {
    const index = match.index;
    if (index > offset) segments.push({ type: 'text', data: { text: decodeCq(message.slice(offset, index)) } });
    const data: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const param of (match[2] ?? '').split(',')) {
      const equals = param.indexOf('=');
      if (equals > 0) data[param.slice(0, equals)] = decodeCq(param.slice(equals + 1), true);
    }
    segments.push({ type: match[1], data });
    offset = index + match[0].length;
  }
  if (offset < message.length) segments.push({ type: 'text', data: { text: decodeCq(message.slice(offset)) } });
  return segments;
}

function normalizeSegment(raw: unknown, conversation: ConversationRef): MessageSegment {
  const segment = record(raw, 'message segment');
  const type = opaqueId(segment['type'], 'segment.type');
  const data = record(segment['data'], 'segment.data');
  switch (type) {
    case 'text':
      if (typeof data['text'] !== 'string') throw new PlatformBoundaryError('invalid_event', 'text must be a string');
      return { type: 'text', text: data['text'] };
    case 'at':
      if (data['qq'] === 'all') return { type: 'mention-all' };
      return { type: 'mention', user: {
        platform: 'qq', accountId: conversation.accountId, idNamespace: 'qq-number',
        id: numericId(data['qq'], 'at.qq'),
      } };
    case 'reply':
      return { type: 'reply', message: { conversation, id: numericId(data['id'], 'reply.id', false) } };
    case 'image':
    case 'record':
    case 'video':
    case 'file':
      return { type: type === 'record' ? 'voice' : type, assetRef: opaqueId(data['file_id'] ?? data['file'] ?? data['url'], 'media asset'),
        ...(typeof data['url'] === 'string' && data['url'].length <= 4096 ? { url: data['url'] } : {}),
        ...(typeof data['name'] === 'string' ? { fileName: data['name'].slice(0, 255) }
          : type === 'file' && typeof data['file_id'] === 'string' && typeof data['file'] === 'string'
            ? { fileName: data['file'].slice(0, 255) } : {}),
        ...(Number.isSafeInteger(Number(data['file_size'] ?? data['size'])) && Number(data['file_size'] ?? data['size']) >= 0
          ? { fileSize: Number(data['file_size'] ?? data['size']) } : {}),
      };
    default:
      // Preserve the unsupported kind for callers to report/skip; do not invent text.
      return { type: 'unsupported', platformType: type };
  }
}

function requireConversation(account: AccountRef, conversation: ConversationRef): void {
  conversationKey(conversation);
  if (accountKey(account) !== accountKey(conversation)) {
    throw new PlatformBoundaryError('wrong_account', 'Destination belongs to another platform, account or namespace');
  }
  if (conversation.threadId !== undefined) throw new UnsupportedCapabilityError('threads');
}

/** Codec only: constructing it does not log in, open a socket, or enable QQ ingress. */
export function createOneBotCodec(accountId: string): PlatformAdapterCodec<OneBotSendCommand> {
  const account: AccountRef = Object.freeze({
    platform: 'qq', accountId: numericId(accountId, 'accountId'), idNamespace: 'qq-number',
  });
  return {
    account,
    capabilities: ONEBOT_MINIMAL_CAPABILITIES,
    normalize(event: unknown): NormalizedMessage | null {
      const source = record(event, 'event');
      // Ignore heartbeat, notice, request, and message_sent echoes in this minimal path.
      if (source['post_type'] !== 'message') return null;
      if (numericId(source['self_id'], 'self_id') !== account.accountId) {
        throw new PlatformBoundaryError('wrong_account', 'Event came from another OneBot account');
      }
      const kind = source['message_type'];
      if (kind !== 'private' && kind !== 'group') throw new UnsupportedCapabilityError('message type');
      if (kind === 'private' && source['sub_type'] === 'group') {
        throw new UnsupportedCapabilityError('temporary group sessions');
      }
      const senderId = numericId(source['user_id'], 'user_id');
      if (senderId === account.accountId) return null;
      const conversation: ConversationRef = {
        ...account, conversationKind: kind,
        id: kind === 'group' ? numericId(source['group_id'], 'group_id') : senderId,
      };
      const timestamp = source['time'];
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0 ||
        !Number.isSafeInteger(Math.floor(timestamp * 1000))) {
        throw new PlatformBoundaryError('invalid_event', 'time must be valid Unix seconds');
      }
      const rawMessage = source['message'];
      const parts = typeof rawMessage === 'string' ? parseCqString(rawMessage) : rawMessage;
      if (!Array.isArray(parts)) throw new PlatformBoundaryError('invalid_event', 'message must be an array or CQ string');
      const sender: UserRef = { ...account, id: senderId };
      const senderInfo = source['sender'] ? record(source['sender'], 'sender') : {};
      const senderName = senderInfo['card'] || senderInfo['nickname'];
      const marked = (fields: string[]) => fields.some(field => source[field] !== undefined
        && source[field] !== null && source[field] !== false && source[field] !== 0);
      const authorityIneligible = marked(['edited', 'edited_at', 'edit_time', 'edit_date', 'is_edited']) ? 'edited' as const
        : marked(['forward_origin', 'forward_from', 'forward_from_chat', 'forward_id', 'is_forward', 'forwarded'])
          ? 'forwarded' as const : undefined;
      return {
        ref: { conversation, id: numericId(source['message_id'], 'message_id', false) },
        sender, ...(typeof senderName === 'string' ? { senderName } : {}),
        timestampMs: Math.floor(timestamp * 1000),
        ...(authorityIneligible ? { authorityIneligible } : {}),
        segments: parts.map(part => normalizeSegment(part, conversation)),
      };
    },
    encode(action: PlatformAction): OneBotSendCommand {
      if (action.action !== 'send') throw new UnsupportedCapabilityError(action.action);
      requireConversation(account, action.conversation);
      if (!action.segments.length) throw new PlatformBoundaryError('empty_message', 'Cannot send an empty message');
      let replyCount = 0;
      const message: OneBotSegment[] = action.segments.map((segment): OneBotSegment => {
        switch (segment.type) {
          case 'text': return { type: 'text', data: { text: segment.text } };
          case 'mention':
            if (action.conversation.conversationKind !== 'group') throw new UnsupportedCapabilityError('private mentions');
            if (accountKey(segment.user) !== accountKey(account)) {
              throw new PlatformBoundaryError('wrong_account', 'Mention target belongs to another account or namespace');
            }
            return { type: 'at', data: { qq: numericId(segment.user.id, 'mention.id') } };
          case 'reply':
            if (conversationKey(segment.message.conversation) !== conversationKey(action.conversation)) {
              throw new PlatformBoundaryError('cross_conversation_reply', 'Reply target belongs to another conversation');
            }
            if (++replyCount > 1) throw new UnsupportedCapabilityError('multiple reply targets');
            return { type: 'reply', data: { id: numericId(segment.message.id, 'reply.id', false) } };
          default: throw new UnsupportedCapabilityError(segment.type);
        }
      });
      // QQ clients expect the quoted-message segment first, while text order stays intact.
      message.sort((a, b) => Number(b.type === 'reply') - Number(a.type === 'reply'));
      if (action.conversation.conversationKind === 'group') {
        return { action: 'send_group_msg', params: { group_id: actionId(action.conversation.id, 'group_id'), message } };
      }
      return { action: 'send_private_msg', params: { user_id: actionId(action.conversation.id, 'user_id'), message } };
    },
  };
}
