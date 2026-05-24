// ────────────────────────────────────────
// Group Resolver — find target group for DM relay
// ────────────────────────────────────────

import { getUserGroups } from '../context/manager.js';
import { getBot } from '../../bot/bot.js';
import { getRedis } from '../../db/redis.js';
import { logger } from '../../shared/logger.js';

const GROUP_TITLE_CACHE_PREFIX = 'xxb:group:title:';
const GROUP_TITLE_TTL = 3600; // 1 hour
const PENDING_GROUP_PREFIX = 'xxb:dm:pending_group:';
const PENDING_GROUP_TTL = 120; // 2 minutes

async function getGroupTitle(chatId: number): Promise<string> {
  const redis = getRedis();
  const cacheKey = GROUP_TITLE_CACHE_PREFIX + chatId;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  // Fetch from Telegram
  try {
    const chat = await getBot().api.getChat(chatId);
    const title = 'title' in chat ? (chat.title ?? String(chatId)) : String(chatId);
    await redis.set(cacheKey, title, 'EX', GROUP_TITLE_TTL);
    return title;
  } catch (err) {
    logger.debug({ err, chatId }, 'Failed to fetch group title');
    return String(chatId);
  }
}

export interface ResolvedGroup {
  chatId: number;
  title: string;
}

export type GroupResolveResult =
  | { ok: true; group: ResolvedGroup }
  | { ok: false; reason: 'no_groups'; reply: string }
  | { ok: false; reason: 'multiple_groups'; reply: string; groups: ResolvedGroup[] };

export async function resolveGroup(uid: number): Promise<GroupResolveResult> {
  const groupIds = await getUserGroups(uid);

  if (groupIds.length === 0) {
    return {
      ok: false,
      reason: 'no_groups',
      reply: '本喵没有在任何群里见过你喵~ 先在群里说句话让本喵认识你吧！',
    };
  }

  if (groupIds.length === 1) {
    const title = await getGroupTitle(groupIds[0]!);
    return { ok: true, group: { chatId: groupIds[0]!, title } };
  }

  // Multiple groups — list them
  const groups: ResolvedGroup[] = [];
  for (const gid of groupIds) {
    const title = await getGroupTitle(gid);
    groups.push({ chatId: gid, title });
  }

  const list = groups.map((g, i) => `${i + 1}. ${g.title}`).join('\n');
  return {
    ok: false,
    reason: 'multiple_groups',
    reply: `你在多个群里喵，请指定群序号：\n${list}\n\n回复数字就行~`,
    groups,
  };
}

// ── Pending group selection state ────────────────────────────────

interface PendingGroupState {
  intent: 'view_group' | 'relay_message';
  groups: ResolvedGroup[];
  /** relay_message fields (only if intent === 'relay_message') */
  targetHandle?: string;
  content?: string;
}

export async function savePendingGroupSelection(uid: number, state: PendingGroupState): Promise<void> {
  const redis = getRedis();
  await redis.set(PENDING_GROUP_PREFIX + uid, JSON.stringify(state), 'EX', PENDING_GROUP_TTL);
}

export async function getPendingGroupSelection(uid: number): Promise<PendingGroupState | null> {
  const redis = getRedis();
  const raw = await redis.get(PENDING_GROUP_PREFIX + uid);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingGroupState;
  } catch {
    return null;
  }
}

export async function clearPendingGroupSelection(uid: number): Promise<void> {
  const redis = getRedis();
  await redis.del(PENDING_GROUP_PREFIX + uid);
}
