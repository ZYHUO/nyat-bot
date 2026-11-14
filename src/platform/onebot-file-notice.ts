import { createHash } from 'node:crypto';
import { assertOneBotAssetId } from './onebot-media-stream.js';
import { assertOneBotMediaUrl } from './onebot-media-policy.js';
import type { AccountRef, ConversationRef, NormalizedMessage } from './types.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function id(value: unknown): string | null {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}

/** File notices have no QQ message_id. Their namespaced IDs must never be quoted. */
export function decodeOneBotFileNotice(raw: unknown, account: string | AccountRef): NormalizedMessage | null {
  const accountId = typeof account === 'string' ? id(account) :
    account.platform === 'qq' && account.idNamespace === 'qq-number' ? id(account.accountId) : null;
  const event = record(raw);
  if (!accountId || !event || event['post_type'] !== 'notice' || id(event['self_id']) !== accountId) return null;
  const type = event['notice_type'];
  if (type !== 'group_upload' && type !== 'offline_file') return null;
  const senderId = id(event['user_id']);
  const groupId = type === 'group_upload' ? id(event['group_id']) : undefined;
  const time = event['time']; const file = record(event['file']);
  if (!senderId || senderId === accountId || (type === 'group_upload' && !groupId) || !file ||
    typeof time !== 'number' || !Number.isFinite(time) || time <= 0 || !Number.isSafeInteger(time * 1000)) return null;
  const size = file['size']; const name = file['name'];
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 ||
    typeof name !== 'string' || !name || name.length > 255) return null;
  let assetRef: string; let url: string | undefined;
  try {
    if (type === 'group_upload') {
      if (typeof file['id'] !== 'string') return null;
      assertOneBotAssetId(file['id']); assetRef = file['id'];
    } else {
      // Standard OneBot offline_file is URL-only; NapCat 4.18.42 normally emits
      // private files as ordinary message segments, which use the stream path.
      if (typeof file['url'] !== 'string') return null;
      url = assertOneBotMediaUrl(file['url']).href; assetRef = url;
    }
  } catch { return null; }
  const conversation: ConversationRef = { platform: 'qq', accountId, idNamespace: 'qq-number',
    conversationKind: type === 'group_upload' ? 'group' : 'private', id: groupId ?? senderId };
  // Repeated notice delivery deduplicates; a later upload of the same file is a
  // distinct event. A string prefix cannot collide with native numeric IDs.
  const eventId = createHash('sha256').update(JSON.stringify([type, accountId, conversation.id, senderId, time, assetRef, name, size])).digest('hex');
  return {
    ref: { conversation, id: `file:${eventId}` },
    sender: { platform: 'qq', accountId, idNamespace: 'qq-number', id: senderId },
    timestampMs: time * 1000,
    segments: [{ type: 'file', assetRef, fileName: name, fileSize: size, ...(url ? { url } : {}) }],
  };
}
