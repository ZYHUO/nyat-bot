import type { Redis } from 'ioredis';
import type { ReplyObligation } from '../pipeline/turn/obligation.js';
import { logger } from '../shared/logger.js';

const OBL_INDEX = (chatId: number) => `xxb:turn:obligations:${chatId}`;
const OBL_ITEM = (chatId: number, obligationId: string) => `xxb:turn:obligation:${chatId}:${obligationId}`;
const OBL_META = (chatId: number) => `xxb:turn:obligation_meta:${chatId}`;

export interface ObligationAdminSnapshot {
  chatId: number;
  activeObligationId?: string;
  obligations: ReplyObligation[];
}

export async function listObligationSnapshots(redis: Redis, chatId?: number): Promise<ObligationAdminSnapshot[]> {
  const chatIds = chatId !== undefined ? [chatId] : await discoverChats(redis);
  const out: ObligationAdminSnapshot[] = [];
  for (const cid of chatIds) {
    const ids = await redis.zrange(OBL_INDEX(cid), 0, -1);
    if (ids.length === 0) continue;
    const raws = await Promise.all(ids.map((id) => redis.get(OBL_ITEM(cid, id))));
    const obligations: ReplyObligation[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      try {
        obligations.push(JSON.parse(raw) as ReplyObligation);
      } catch (err) {
        logger.warn({ err, chatId: cid }, 'Malformed obligation dropped from admin snapshot');
      }
    }
    const activeObligationId = (await redis.hget(OBL_META(cid), 'activeObligationId')) || undefined;
    obligations.sort((a, b) => b.updatedAt - a.updatedAt);
    out.push({ chatId: cid, activeObligationId, obligations });
  }
  out.sort((a, b) => {
    const at = a.obligations[0]?.updatedAt ?? 0;
    const bt = b.obligations[0]?.updatedAt ?? 0;
    return bt - at;
  });
  return out;
}

async function discoverChats(redis: Redis): Promise<number[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'xxb:turn:obligations:*', 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys.map((k) => Number(k.replace('xxb:turn:obligations:', ''))).filter((n) => Number.isFinite(n));
}
