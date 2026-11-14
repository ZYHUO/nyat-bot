import { env } from '../env.js';
import { accountKey } from './identity.js';
import { findConversationRef, findUserRef, isPlatformInternalId } from './identity-store.js';

/** QQ owner authority stays in its platform/account; never aliases MASTER_UID. */
export function isOneBotOwner(chatId: number, uid: number): boolean {
  if (!isPlatformInternalId(chatId) || !isPlatformInternalId(uid)) return false;
  const chat = findConversationRef(chatId);
  const user = findUserRef(uid);
  return !!chat && !!user && chat.platform === 'qq' && chat.idNamespace === 'qq-number' && accountKey(chat) === accountKey(user)
    && chat.accountId === env().ONEBOT_ACCOUNT_ID && user.id === env().ONEBOT_OWNER_ID;
}

/** Persona recognition only; this does not grant Telegram administration rights. */
export function isConversationOwner(chatId: number, uid: number): boolean {
  return isPlatformInternalId(chatId) ? isOneBotOwner(chatId, uid) : uid === env().MASTER_UID;
}
