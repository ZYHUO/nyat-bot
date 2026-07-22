/**
 * Bulk-load live Redis ctx + SQLite bonds into NyatDB.
 *
 *   npx tsx scripts/migrate-to-nyatdb.ts
 *   npx tsx scripts/migrate-to-nyatdb.ts --fresh   # wipe NYATDB_PATH first
 *   npx tsx scripts/migrate-to-nyatdb.ts --native  # prefer Rust engine
 *
 * Mapping:
 *   Redis  xxb:ctx:{chatId}           → ChatLog
 *   SQLite chat_relationships         → Bond
 *   Redis  xxb:social:lastspoke:*     → HotState (optional small set)
 *
 * Does NOT migrate Qdrant → Recall (needs embeddings) or BullMQ queues.
 */
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Redis from 'ioredis';
import Database from 'better-sqlite3';
import { config as loadDotenv } from 'dotenv';
import { openNyatDb, closeNyatDb, isNyatDbNativeAvailable, chatAppendFromFormatted } from '../src/nyatdb/index.js';
import type { FormattedMessage } from '../src/shared/types.js';

loadDotenv();

const CTX_PREFIX = 'xxb:ctx:';
const LASTSPOKE_PREFIX = 'xxb:social:lastspoke:';

function parseArgs(argv: string[]) {
  return {
    fresh: argv.includes('--fresh'),
    native: argv.includes('--native') || process.env.NYATDB_NATIVE === 'true',
    skipHot: argv.includes('--skip-hot'),
    path: resolve(process.env.NYATDB_PATH || './data/nyatdb'),
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379/5',
    sqlitePath: resolve(process.env.SQLITE_PATH || './data/xxb.db'),
  };
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

async function migrateCtx(
  redis: Redis,
  ndb: ReturnType<typeof openNyatDb>,
): Promise<{ chats: number; msgs: number; skipped: number; failed: number }> {
  const keys = await scanKeys(redis, `${CTX_PREFIX}*`);
  let chats = 0;
  let msgs = 0;
  let skipped = 0;
  let failed = 0;

  for (const key of keys) {
    const chatId = Number(key.slice(CTX_PREFIX.length));
    if (!Number.isFinite(chatId)) {
      console.warn(`skip bad ctx key ${key}`);
      continue;
    }
    const raw = await redis.lrange(key, 0, -1);
    let appended = 0;
    for (const line of raw) {
      let m: FormattedMessage;
      try {
        m = JSON.parse(line) as FormattedMessage;
      } catch {
        skipped++;
        continue;
      }
      const messageId = Number(m.messageId);
      if (!Number.isFinite(messageId) || messageId <= 0) {
        skipped++;
        continue;
      }
      // Idempotent: skip if already indexed
      if (ndb.chatGet(chatId, messageId)) {
        skipped++;
        continue;
      }
      try {
        ndb.chatAppend(chatId, chatAppendFromFormatted(m));
        appended++;
        msgs++;
      } catch (err) {
        failed++;
        console.warn(`  append fail chat=${chatId} mid=${messageId}:`, err);
      }
    }
    if (appended > 0) {
      chats++;
      console.log(`  ctx ${chatId}: +${appended}/${raw.length}`);
    }
  }
  return { chats, msgs, skipped, failed };
}

function migrateBonds(
  sqlitePath: string,
  ndb: ReturnType<typeof openNyatDb>,
): { bonds: number } {
  if (!existsSync(sqlitePath)) {
    console.warn(`SQLite missing: ${sqlitePath}`);
    return { bonds: 0 };
  }
  const db = new Database(sqlitePath, { readonly: true });
  let bonds = 0;
  try {
    const rows = db
      .prepare(
        `SELECT chat_id, uid, affinity, last_summary
         FROM chat_relationships
         ORDER BY updated_at DESC`,
      )
      .all() as Array<{
      chat_id: number;
      uid: number;
      affinity: number;
      last_summary: string;
    }>;
    for (const r of rows) {
      ndb.bondUpsert({
        uid: r.uid >>> 0,
        chatId: r.chat_id,
        score: Number(r.affinity) || 0,
        note: String(r.last_summary ?? '').slice(0, 500),
      });
      bonds++;
    }
  } finally {
    db.close();
  }
  return { bonds };
}

async function migrateHotLastSpoke(
  redis: Redis,
  ndb: ReturnType<typeof openNyatDb>,
): Promise<number> {
  const keys = await scanKeys(redis, `${LASTSPOKE_PREFIX}*`);
  let n = 0;
  for (const key of keys) {
    const val = await redis.get(key);
    if (val == null) continue;
    const ttl = await redis.pttl(key);
    const ttlMs = ttl > 0 ? ttl : 0;
    ndb.hotSet(key, val, ttlMs);
    n++;
  }
  return n;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log('migrate-to-nyatdb');
  console.log(`  path=${args.path}`);
  console.log(`  redis=${args.redisUrl}`);
  console.log(`  sqlite=${args.sqlitePath}`);
  console.log(`  native=${args.native && isNyatDbNativeAvailable()}`);

  if (args.fresh && existsSync(args.path)) {
    console.log('  --fresh: removing existing NYATDB_PATH');
    rmSync(args.path, { recursive: true, force: true });
  }
  mkdirSync(args.path, { recursive: true });

  const ndb = openNyatDb(args.path, {
    syncEvery: 32,
    poolFrames: 128,
    preferNative: args.native,
  });
  const redis = new Redis(args.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();

  const t0 = Date.now();
  try {
    console.log('\n[1/3] Redis ctx → ChatLog');
    const ctx = await migrateCtx(redis, ndb);
    console.log(`  done chats=${ctx.chats} msgs=${ctx.msgs} skipped=${ctx.skipped} failed=${ctx.failed}`);

    console.log('\n[2/3] SQLite chat_relationships → Bond');
    const bond = migrateBonds(args.sqlitePath, ndb);
    console.log(`  done bonds=${bond.bonds}`);

    let hot = 0;
    if (!args.skipHot) {
      console.log('\n[3/3] Redis lastspoke → HotState');
      hot = await migrateHotLastSpoke(redis, ndb);
      console.log(`  done hot=${hot}`);
    } else {
      console.log('\n[3/3] HotState skipped (--skip-hot)');
    }

    ndb.checkpoint();
    const stats = ndb.stats();
    console.log('\nstats', stats);
    console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Sample verify: pick busiest ctx key
    const sampleKeys = await scanKeys(redis, `${CTX_PREFIX}*`);
    if (sampleKeys[0]) {
      const chatId = Number(sampleKeys[0]!.slice(CTX_PREFIX.length));
      const redisLen = await redis.llen(sampleKeys[0]!);
      const recent = ndb.chatRecent(chatId, 5);
      console.log(`\nsample chatId=${chatId} redisLen=${redisLen} nyatRecent=${recent.length}`);
      if (recent[0]) console.log('  tip', recent[recent.length - 1]);
    }
  } finally {
    await redis.quit().catch(() => {});
    ndb.close({ skipCheckpoint: false });
    closeNyatDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
