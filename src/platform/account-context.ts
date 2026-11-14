import { findConversationRef, getOrCreateUserId, isPlatformInternalId } from './identity-store.js';
import { PlatformBoundaryError } from './types.js';

export interface ConversationBotIdentity { uid: number; username: string; displayName: string; nicknames: string[]; }
const accountNames = new Map<string, { displayName: string }>();

/** Only the authenticated login response supplies this account's display name. */
export function registerPlatformBotName(accountId: string, displayName: string): () => void {
  if (!/^[1-9]\d*$/.test(accountId) || typeof displayName !== 'string') throw new PlatformBoundaryError('invalid_account_name', 'Invalid QQ account name');
  const name = displayName.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  if (!name) throw new PlatformBoundaryError('invalid_account_name', 'Empty QQ account name');
  const value = { displayName: name };
  accountNames.set(accountId, value);
  return () => { if (accountNames.get(accountId) === value) accountNames.delete(accountId); };
}

/** Explicit chat context prevents a QQ conversation from inheriting Telegram's bot identity. */
export function getPlatformBotIdentity(chatId: number | undefined, nicknames: readonly string[], displayNameOverride = ''): ConversationBotIdentity | null {
  if (chatId === undefined || !isPlatformInternalId(chatId)) return null;
  const ref = Number.isSafeInteger(chatId) ? findConversationRef(chatId) : null;
  if (!ref || ref.platform !== 'qq') throw new PlatformBoundaryError('unresolved_platform_chat', 'Platform chat identity is unavailable');
  const uid = getOrCreateUserId({ platform: ref.platform, accountId: ref.accountId, idNamespace: ref.idNamespace, id: ref.accountId });
  const names = nicknames.map((name) => name.trim()).filter(Boolean);
  const loginName = accountNames.get(ref.accountId)?.displayName;
  const override = displayNameOverride.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  const displayName = override || loginName || names[0] || 'NyatBot';
  return { uid, username: '', displayName, nicknames: [...new Set([displayName, ...(loginName ? [loginName] : []), ...names])] };
}
