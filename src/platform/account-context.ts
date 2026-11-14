import { findConversationRef, getOrCreateUserId, isPlatformInternalId } from './identity-store.js';
import { PlatformBoundaryError } from './types.js';

export interface ConversationBotIdentity { uid: number; username: string; displayName: string; nicknames: string[]; }

/** Explicit chat context prevents a QQ conversation from inheriting Telegram's bot identity. */
export function getPlatformBotIdentity(chatId: number | undefined, nicknames: readonly string[]): ConversationBotIdentity | null {
  if (chatId === undefined || !isPlatformInternalId(chatId)) return null;
  const ref = Number.isSafeInteger(chatId) ? findConversationRef(chatId) : null;
  if (!ref || ref.platform !== 'qq') throw new PlatformBoundaryError('unresolved_platform_chat', 'Platform chat identity is unavailable');
  const uid = getOrCreateUserId({ platform: ref.platform, accountId: ref.accountId, idNamespace: ref.idNamespace, id: ref.accountId });
  const names = nicknames.map((name) => name.trim()).filter(Boolean);
  const displayName = names[0] ?? 'NyatBot';
  return { uid, username: '', displayName, nicknames: [...new Set([displayName, ...names])] };
}
