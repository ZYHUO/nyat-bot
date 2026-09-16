/**
 * One-shot: copy Redis-only chat rows into NyatDB (dual-write hole era).
 *
 * ⚠️ MUST stop the bot first — concurrent native/JS NyatDB writers corrupt data.
 * Do not run while `xxb-ts` is up.
 *
 *   sudo systemctl stop xxb-ts
 *   npx tsx scripts/backfill-nyatdb-holes.ts
 *   sudo systemctl start xxb-ts
 */
import { getRedis, closeRedis } from '../src/db/redis.js';
import {
  getNyatDb,
  closeNyatDb,
  chatAppendFromFormatted,
} from '../src/nyatdb/index.js';
import { env } from '../src/env.js';
import type { FormattedMessage } from '../src/shared/types.js';

async function main(): Promise<void> {
  const e = env();
  if (!e.NYATDB_ENABLED) throw new Error('NYATDB_ENABLED=false');
  const redis = getRedis();
  const db = getNyatDb();
  if (!db) throw new Error('nyatdb unavailable');

  const groups = await redis.zrange('xxb:active_groups', 0, -1);
  let total = 0;
  for (const g of groups) {
    const chatId = Number(g);
    if (!Number.isFinite(chatId)) continue;
    const raw = await redis.lrange(`xxb:ctx:${chatId}`, 0, -1);
    const msgs: FormattedMessage[] = [];
    for (const r of raw) {
      try {
        msgs.push(JSON.parse(r) as FormattedMessage);
      } catch {
        /* skip */
      }
    }
    msgs.sort((a, b) => a.messageId - b.messageId || a.timestamp - b.timestamp);

    const known = new Set(db.chatRecent(chatId, e.NYATDB_CHAT_RING_MAX).map((m) => m.messageId));
    // Also probe chatGet for rows outside the ring window
    let n = 0;
    for (const m of msgs) {
      if (!(m.messageId > 0)) continue;
      if (known.has(m.messageId)) continue;
      if (typeof db.chatGet === 'function' && db.chatGet(chatId, m.messageId)) {
        known.add(m.messageId);
        continue;
      }
      try {
        db.chatAppend(chatId, chatAppendFromFormatted(m));
        known.add(m.messageId);
        n += 1;
      } catch (err) {
        console.warn('append fail', chatId, m.messageId, err);
      }
    }
    // Force ring reorder via chatRecent sort path
    db.chatRecent(chatId, e.NYATDB_CHAT_RING_MAX);
    if (n) {
      total += n;
      console.log(`chat ${chatId}: backfilled ${n}`);
    }
  }
  console.log(`done total=${total}`);
  try {
    db.checkpoint?.();
  } catch {
    /* optional */
  }
  closeNyatDb();
  await closeRedis?.().catch?.(() => undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
