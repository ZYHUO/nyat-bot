import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { userKey } from '../platform/identity.js';
import { findConversationRef, findUserRef, isPlatformInternalId, PLATFORM_INTERNAL_ID_BASE } from '../platform/identity-store.js';
import type { Platform } from '../platform/types.js';
import { resolveConversationScope } from './privacy-scope.js';

export interface OwnerMemoryPrincipal {
  platform: Platform;
  accountId: string;
  uid: number;
  dmChatId: number;
  botUid: number | null;
}

export interface OwnerDmReadContext {
  audience: 'owner_dm';
  targetChatId: number;
  principals: OwnerMemoryPrincipal[];
  accounts: Array<{ platform: Platform; accountId: string }>;
}

export interface OwnerMemoryProvenance {
  audience: 'owner_dm';
  sourceChatId: number;
  platform: Platform;
  accountId: string | null;
  visibility: 'private' | 'contextual' | 'public' | 'unknown';
  provenance: 'verified_account' | 'legacy_owner_authored';
  label: string;
}

function nativeUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && !isPlatformInternalId(value);
}

function qqId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

/** Read an existing alias only. Permission checks must never create identities. */
function storedQqUser(accountId: string, id: string): number | null {
  try {
    const key = userKey({ platform: 'qq', accountId, idNamespace: 'qq-number', id });
    const row = getDb().prepare("SELECT identity_id FROM platform_identity_refs WHERE ref_kind = 'user' AND ref_key = ?")
      .get(key) as { identity_id: number } | undefined;
    if (!row || !Number.isSafeInteger(row.identity_id) || row.identity_id <= 0) return null;
    const uid = PLATFORM_INTERNAL_ID_BASE + row.identity_id;
    if (!Number.isSafeInteger(uid)) return null;
    const user = findUserRef(uid), dm = findConversationRef(uid);
    if (!user || !dm || user.platform !== 'qq' || user.idNamespace !== 'qq-number'
      || user.accountId !== accountId || user.id !== id || dm.platform !== 'qq'
      || dm.idNamespace !== 'qq-number' || dm.accountId !== accountId || dm.id !== id
      || dm.conversationKind !== 'private') return null;
    return uid;
  } catch { return null; }
}

/**
 * The configured Telegram/QQ owners are the only linked person. A model-supplied
 * name, uid or destination cannot turn a group/stranger DM into this audience.
 * requesterUid is an optional additional restriction, never the source of authority.
 */
export function resolveOwnerDmReadContext(boundChatId: number, requesterUid?: number): OwnerDmReadContext | null {
  if (!Number.isSafeInteger(boundChatId) || boundChatId <= 0
    || (requesterUid !== undefined && requesterUid !== boundChatId)) return null;
  const config = env();
  const principals: OwnerMemoryPrincipal[] = [];
  if (nativeUserId(config.MASTER_UID)) {
    const scope = resolveConversationScope(config.MASTER_UID);
    const botUid = Number(scope?.accountId);
    if (scope?.platform === 'telegram' && scope.accountId && nativeUserId(botUid) && botUid !== config.MASTER_UID) {
      principals.push({ platform: 'telegram', accountId: scope.accountId, uid: config.MASTER_UID,
        dmChatId: config.MASTER_UID, botUid });
    }
  }
  if (qqId(config.ONEBOT_ACCOUNT_ID) && qqId(config.ONEBOT_OWNER_ID) && config.ONEBOT_ACCOUNT_ID !== config.ONEBOT_OWNER_ID) {
    const uid = storedQqUser(config.ONEBOT_ACCOUNT_ID, config.ONEBOT_OWNER_ID);
    if (uid !== null) principals.push({ platform: 'qq', accountId: config.ONEBOT_ACCOUNT_ID, uid, dmChatId: uid,
      botUid: storedQqUser(config.ONEBOT_ACCOUNT_ID, config.ONEBOT_ACCOUNT_ID) });
  }
  const target = principals.find(principal => principal.dmChatId === boundChatId);
  if (!target) return null;
  // The two configured administrators need not be the same person. Linking is
  // a separate explicit deployment decision, never inferred from configuration.
  const authorized = config.OWNER_MEMORY_LINK_ENABLED === true ? principals : [target];
  return { audience: 'owner_dm', targetChatId: boundChatId, principals: authorized,
    accounts: authorized.map(({ platform, accountId }) => ({ platform, accountId })) };
}

/** A separate owner audience policy; the ordinary conversation scrub stays strict. */
export function inspectOwnerMemorySource(item: {
  sourceChatId?: number | null; sourcePlatform?: unknown; sourceAccountId?: unknown;
  visibility?: unknown; uid: number; role: unknown;
}, context: OwnerDmReadContext): OwnerMemoryProvenance | null {
  const chatId = item.sourceChatId;
  if (typeof chatId !== 'number' || !Number.isSafeInteger(item.uid) || item.uid <= 0
    || (item.role !== 'user' && item.role !== 'assistant')) return null;
  const source = resolveConversationScope(chatId);
  if (!source || (env().MEMORY_SENSITIVE_CHAT_IDS ?? []).includes(chatId)) return null;
  const principal = context.principals.find(candidate => candidate.platform === source.platform && candidate.accountId === source.accountId);
  if (!principal || (item.sourcePlatform !== undefined && item.sourcePlatform !== source.platform)
    || (item.sourceAccountId !== undefined && item.sourceAccountId !== principal.accountId)) return null;
  // An owner's message occurring in someone else's private chat is not a grant
  // to that conversation. Group bot replies lack trustworthy addressee metadata.
  if (source.conversationKind === 'private' && chatId !== principal.dmChatId) return null;
  if (item.role === 'user') {
    if (item.uid !== principal.uid) return null;
  } else if (source.conversationKind !== 'private' || principal.botUid === null || item.uid !== principal.botUid) return null;

  const legacy = source.platform === 'telegram' && item.sourceAccountId === undefined;
  // Native Telegram IDs prove the human author, not which bot wrote an old row.
  // Only the owner's own words have this narrow legacy exception.
  if (legacy && item.role !== 'user') return null;
  const visibility = item.visibility === 'private' || item.visibility === 'contextual' || item.visibility === 'public'
    ? item.visibility : 'unknown';
  return { audience: 'owner_dm', sourceChatId: chatId, platform: source.platform,
    accountId: legacy ? null : principal.accountId, visibility,
    provenance: legacy ? 'legacy_owner_authored' : 'verified_account',
    label: legacy ? '历史Telegram/账号未知（主人本人发言）'
      : `${source.platform === 'qq' ? 'QQ' : 'Telegram'}/账号${principal.accountId}/${source.conversationKind === 'private' ? '主人私聊' : '群内主人发言'}` };
}
