import { getRedis } from "../../db/redis.js";
import { logger } from "../../shared/logger.js";
import type { ReplyObligation, ReplyObligationState } from "./obligation.js";

const KEY_TTL_SEC = 60 * 60 * 24;
const INDEX_KEY = (chatId: number) => `xxb:turn:obligations:${chatId}`;
const ITEM_KEY = (chatId: number, obligationId: string) => `xxb:turn:obligation:${chatId}:${obligationId}`;
const META_KEY = (chatId: number) => `xxb:turn:obligation_meta:${chatId}`;

export async function saveObligation(obligation: ReplyObligation): Promise<void> {
  const redis = getRedis();
  const key = ITEM_KEY(obligation.chatId, obligation.id);
  await redis.set(key, JSON.stringify(obligation), "EX", KEY_TTL_SEC);
  await redis.zadd(INDEX_KEY(obligation.chatId), obligation.createdAt, obligation.id);
  await redis.expire(INDEX_KEY(obligation.chatId), KEY_TTL_SEC);
}

export async function listActiveObligations(chatId: number): Promise<ReplyObligation[]> {
  const redis = getRedis();
  const ids = await redis.zrange(INDEX_KEY(chatId), 0, -1);
  if (ids.length === 0) return [];
  const raws = await Promise.all(ids.map((id) => redis.get(ITEM_KEY(chatId, id))));
  const out: ReplyObligation[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as ReplyObligation;
      if (["pending", "active", "waiting"].includes(parsed.state)) out.push(parsed);
    } catch (err) {
      logger.warn({ err, chatId }, "Malformed obligation dropped");
    }
  }
  return out;
}

export async function getObligation(chatId: number, obligationId: string): Promise<ReplyObligation | null> {
  const raw = await getRedis().get(ITEM_KEY(chatId, obligationId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReplyObligation;
  } catch (err) {
    logger.warn({ err, chatId, obligationId }, "Malformed obligation read");
    return null;
  }
}

export async function setActiveObligation(chatId: number, obligationId?: string): Promise<void> {
  const redis = getRedis();
  if (!obligationId) {
    await redis.hdel(META_KEY(chatId), "activeObligationId");
    return;
  }
  await redis.hset(META_KEY(chatId), "activeObligationId", obligationId);
  await redis.expire(META_KEY(chatId), KEY_TTL_SEC);
}

export async function getActiveObligationId(chatId: number): Promise<string | undefined> {
  const v = await getRedis().hget(META_KEY(chatId), "activeObligationId");
  return v || undefined;
}

export async function updateObligationState(
  chatId: number,
  obligationId: string,
  state: ReplyObligationState,
  patch?: Partial<ReplyObligation>,
): Promise<ReplyObligation | null> {
  const current = await getObligation(chatId, obligationId);
  if (!current) return null;
  const next: ReplyObligation = {
    ...current,
    ...patch,
    state,
    updatedAt: Date.now(),
  };
  await saveObligation(next);
  if (state === "active") await setActiveObligation(chatId, obligationId);
  if (state === "fulfilled" || state === "dropped" || state === "superseded") {
    const active = await getActiveObligationId(chatId);
    if (active === obligationId) await setActiveObligation(chatId, undefined);
  }
  return next;
}


export async function supersedeActiveObligation(
  chatId: number,
  nextObligationId: string,
): Promise<void> {
  const activeId = await getActiveObligationId(chatId);
  if (!activeId || activeId === nextObligationId) return;
  const current = await getObligation(chatId, activeId);
  if (!current) return;
  await updateObligationState(chatId, activeId, 'superseded', {
    supersededBy: nextObligationId,
    reason: current.reason ? `${current.reason};superseded` : 'superseded',
  });
}


export async function expireStaleObligations(
  chatId: number,
  now = Date.now(),
  maxAgeMs = 10 * 60 * 1000,
): Promise<number> {
  const obligations = await listActiveObligations(chatId);
  let expired = 0;
  for (const o of obligations) {
    const age = now - (o.updatedAt || o.createdAt);
    if (age < maxAgeMs) continue;
    await updateObligationState(chatId, o.id, 'dropped', {
      reason: o.reason ? `${o.reason};stale_expired` : 'stale_expired',
      expiresAt: now,
    });
    expired++;
  }
  return expired;
}
