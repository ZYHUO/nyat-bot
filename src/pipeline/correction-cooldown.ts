import { getRedis } from '../db/redis.js';

const COOLDOWN_MS = 600_000;
const key = (chatId: number): string => `xxb:corrected:${chatId}`;
const localDeadlines = new Map<number, number>();

/** Synchronous last-moment fence for a stop received by this process. */
export function isLocallyCorrectionCooling(chatId: number): boolean {
  const deadline = localDeadlines.get(chatId);
  if (deadline === undefined) return false;
  if (deadline > Date.now()) return true;
  localDeadlines.delete(chatId);
  return false;
}

/** Returns true only for the first stop in a cooling window, avoiding ACK spam. */
export async function startCorrectionCooldown(chatId: number): Promise<boolean> {
  // Install the local fence before an await: even an unavailable Redis must
  // not let this process keep speaking after it has received a clear stop.
  if (!isLocallyCorrectionCooling(chatId)) localDeadlines.set(chatId, Date.now() + COOLDOWN_MS);
  const started = await getRedis().set(key(chatId), '1', 'EX', COOLDOWN_MS / 1000, 'NX') === 'OK';
  return started;
}

/** Shared by ingress, Heart and send fences; no conversation content is read. */
export async function isCorrectionCooling(chatId: number): Promise<boolean> {
  if (chatId >= 0) return false;
  if (isLocallyCorrectionCooling(chatId)) return true;
  try { return await getRedis().get(key(chatId)) === '1'; }
  catch { return false; }
}
