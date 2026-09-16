/**
 * 200k-scale bench: NyatDB vs Redis vs SQLite — latency + RAM + disk.
 * Phases are isolated so one backend's buffers don't OOM the process.
 *
 *   BENCH_MSGS=200000 BENCH_N=200 BENCH_REDIS_FULL=1 npx tsx scripts/bench-nyatdb-vs-redis.ts
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import Redis from 'ioredis';
import { NyatDb } from '../packages/nyatdb/src/index.ts';

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

function summarize(name: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const avg = sum / s.length;
  console.log(
    `${name.padEnd(36)} n=${String(s.length).padStart(4)}  ` +
      `avg=${avg.toFixed(3)}ms  p50=${pct(s, 50).toFixed(3)}ms  ` +
      `p95=${pct(s, 95).toFixed(3)}ms  p99=${pct(s, 99).toFixed(3)}ms  ` +
      `ops/s=${(1000 / avg).toFixed(0)}`,
  );
}

async function bench(label: string, n: number, fn: () => void | Promise<void>): Promise<number[]> {
  for (let i = 0; i < Math.min(20, n); i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  summarize(label, samples);
  return samples;
}

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

function heapMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function duBytes(path: string): number {
  try {
    const out = execSync(`du -sb '${path}' 2>/dev/null | cut -f1`, { encoding: 'utf8' }).trim();
    return Number(out) || 0;
  } catch {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

function randomText(i: number): string {
  const n = 40 + (i % 40);
  let s = `id=${i}|`;
  for (let k = 0; k < n; k++) s += String.fromCharCode(0x4e00 + ((i * 17 + k * 13) % 2000));
  return s;
}

async function redisMemoryBytes(redis: Redis, key: string): Promise<number> {
  try {
    const v = await redis.call('MEMORY', 'USAGE', key);
    return typeof v === 'number' ? v : Number(v) || 0;
  } catch {
    const len = await redis.llen(key);
    if (len <= 0) return 0;
    const sample = await redis.lrange(key, 0, Math.min(9, len - 1));
    const avg = sample.reduce((a, b) => a + Buffer.byteLength(b), 0) / Math.max(1, sample.length);
    return Math.floor(avg * len * 1.3);
  }
}

type Lat = { avg: number; p50: number; p95: number; p99: number; ops: number };

function latOf(samples: number[]): Lat {
  const s = [...samples].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    avg: Number(avg.toFixed(3)),
    p50: Number(pct(s, 50).toFixed(3)),
    p95: Number(pct(s, 95).toFixed(3)),
    p99: Number(pct(s, 99).toFixed(3)),
    ops: Number((1000 / avg).toFixed(0)),
  };
}

async function main(): Promise<void> {
  const N = Number(process.env.BENCH_N ?? 200);
  const MSG = Number(process.env.BENCH_MSGS ?? 200_000);
  const RECENT = Number(process.env.BENCH_RECENT ?? 50);
  const chatId = -1002767093213;
  const redisWindow = Number(process.env.BENCH_REDIS_WINDOW ?? 5000);
  const wantFull = process.env.BENCH_REDIS_FULL === '1';
  const mid = MSG - 123;

  console.log(`\n=== ${MSG.toLocaleString()} msgs · recent=${RECENT} · N=${N} ===\n`);

  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0';
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  const ctxKey = `bench:bigctx:${chatId}`;
  const ctxFullKey = `bench:bigctx:full:${chatId}`;
  await redis.del(ctxKey, ctxFullKey, 'bench:hot');

  const dir = mkdtempSync(join(tmpdir(), 'nyatdb-200k-'));
  const report: Record<string, unknown> = { msgs: MSG, recent: RECENT };

  // ── Phase A: NyatDB ──
  console.log('--- Phase A: NyatDB inject ---');
  const rssA0 = rssMb();
  const db = NyatDb.open({
    path: dir,
    syncEvery: 512,
    poolFrames: 512,
    chatRingMax: Math.max(200, RECENT * 2),
  });
  const tA0 = performance.now();
  for (let i = 1; i <= MSG; i++) {
    const text = randomText(i);
    db.chatAppend(chatId, {
      messageId: i,
      ts: 1_700_000_000 + i,
      uid: 1 + (i % 97),
      role: 'user',
      text,
    });
    if (i % 50_000 === 0) {
      db.checkpoint(); // rotate WAL, flush pool
      console.log(`  … ${i.toLocaleString()}  rss=${rssMb().toFixed(0)}MB  ${JSON.stringify(db.stats().pool)}`);
    }
  }
  db.hotSet('bench:hot', Buffer.from('v'));
  db.checkpoint();
  const seedA = performance.now() - tA0;
  const rssA = rssMb();
  const heapA = heapMb();
  const nyatHeap = duBytes(join(dir, 'heap.ndb'));
  const nyatWal = duBytes(join(dir, 'wal'));
  const nyatSnap = duBytes(join(dir, 'snap'));
  const nyatTotal = duBytes(dir);

  console.log(
    `  seed ${(seedA / 1000).toFixed(1)}s  rssΔ=${(rssA - rssA0).toFixed(0)}MB (now ${rssA.toFixed(0)}MB heap ${heapA.toFixed(0)}MB)`,
  );
  console.log(
    `  disk heap=${fmtBytes(nyatHeap)} wal=${fmtBytes(nyatWal)} snap=${fmtBytes(nyatSnap)} total=${fmtBytes(nyatTotal)}`,
  );
  console.log(`  stats`, db.stats());

  console.log(`\n=== NyatDB latency ===\n`);
  const nyatRecent = await bench(`NyatDB chatRecent(${RECENT})`, N, () => {
    db.chatRecent(chatId, RECENT);
  });
  const nyatGet = await bench('NyatDB chatGet', N, () => {
    db.chatGet(chatId, mid);
  });
  const nyatHot = await bench('NyatDB hotGet', N, () => {
    db.hotGet('bench:hot');
  });

  report.nyatdb = {
    seedSec: Number((seedA / 1000).toFixed(2)),
    ram: { rssMb: Number(rssA.toFixed(1)), heapUsedMb: Number(heapA.toFixed(1)), rssDeltaMb: Number((rssA - rssA0).toFixed(1)) },
    disk: { heap: nyatHeap, wal: nyatWal, snap: nyatSnap, total: nyatTotal },
    stats: db.stats(),
    latency: { recent: latOf(nyatRecent), get: latOf(nyatGet), hot: latOf(nyatHot) },
  };
  db.close();

  // ── Phase B: Redis ──
  console.log('\n--- Phase B: Redis inject ---');
  if (global.gc) global.gc();
  const rssB0 = rssMb();
  const tB0 = performance.now();
  let pipe = redis.pipeline();
  let pipeCount = 0;
  for (let i = 1; i <= MSG; i++) {
    const text = randomText(i);
    const json = JSON.stringify({
      messageId: i,
      uid: 1 + (i % 97),
      role: 'user',
      textContent: text,
      timestamp: 1_700_000_000 + i,
    });
    pipe.rpush(ctxKey, json);
    if (wantFull) pipe.rpush(ctxFullKey, json);
    pipeCount++;
    if (pipeCount >= 2000) {
      await pipe.exec();
      pipe = redis.pipeline();
      pipeCount = 0;
    }
    if (i % 50_000 === 0) console.log(`  … ${i.toLocaleString()}  rss=${rssMb().toFixed(0)}MB`);
  }
  if (pipeCount) await pipe.exec();
  await redis.ltrim(ctxKey, -redisWindow, -1);
  await redis.set('bench:hot', 'v');
  const seedB = performance.now() - tB0;
  const rssB = rssMb();
  const redisWinBytes = await redisMemoryBytes(redis, ctxKey);
  const redisFullBytes = wantFull ? await redisMemoryBytes(redis, ctxFullKey) : 0;
  const redisWinLen = await redis.llen(ctxKey);
  const redisFullLen = wantFull ? await redis.llen(ctxFullKey) : 0;

  console.log(`  seed ${(seedB / 1000).toFixed(1)}s  clientRssΔ=${(rssB - rssB0).toFixed(0)}MB`);
  console.log(
    `  MEMORY USAGE window(llen=${redisWinLen})=${fmtBytes(redisWinBytes)}` +
      (wantFull ? `  full(llen=${redisFullLen})=${fmtBytes(redisFullBytes)}` : '  (set BENCH_REDIS_FULL=1 for full)'),
  );

  console.log(`\n=== Redis latency ===\n`);
  const redisRecent = await bench(`Redis LRANGE last ${RECENT}`, N, async () => {
    await redis.lrange(ctxKey, -RECENT, -1);
  });
  const redisHot = await bench('Redis GET', N, async () => {
    await redis.get('bench:hot');
  });

  report.redis = {
    seedSec: Number((seedB / 1000).toFixed(2)),
    clientRssDeltaMb: Number((rssB - rssB0).toFixed(1)),
    memory: { windowBytes: redisWinBytes, windowLen: redisWinLen, fullBytes: redisFullBytes || null, fullLen: redisFullLen || null },
    latency: { recent: latOf(redisRecent), hot: latOf(redisHot) },
  };

  // ── Phase C: SQLite ──
  console.log('\n--- Phase C: SQLite inject ---');
  if (global.gc) global.gc();
  const rssC0 = rssMb();
  const sqlitePath = join(dir, 'bench.sqlite');
  const sqlite = new Database(sqlitePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.exec(`
    CREATE TABLE messages (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      uid INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX idx_messages_chat_ts ON messages(chat_id, ts DESC);
  `);
  const sqliteInsert = sqlite.prepare(
    `INSERT INTO messages (chat_id, message_id, ts, uid, role, text) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const sqliteRecent = sqlite.prepare(
    `SELECT message_id, ts, uid, role, text FROM messages
     WHERE chat_id = ? ORDER BY ts DESC, message_id DESC LIMIT ?`,
  );
  const sqliteById = sqlite.prepare(
    `SELECT text FROM messages WHERE chat_id = ? AND message_id = ?`,
  );
  const insertMany = sqlite.transaction(
    (rows: Array<[number, number, number, number, string, string]>) => {
      for (const r of rows) sqliteInsert.run(...r);
    },
  );

  const tC0 = performance.now();
  const batch: Array<[number, number, number, number, string, string]> = [];
  for (let i = 1; i <= MSG; i++) {
    const text = randomText(i);
    batch.push([chatId, i, 1_700_000_000 + i, 1 + (i % 97), 'user', text]);
    if (batch.length >= 5000) insertMany(batch.splice(0, batch.length));
    if (i % 50_000 === 0) console.log(`  … ${i.toLocaleString()}  rss=${rssMb().toFixed(0)}MB`);
  }
  if (batch.length) insertMany(batch);
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  const seedC = performance.now() - tC0;
  const rssC = rssMb();
  const sqliteMain = duBytes(sqlitePath);
  const sqliteWal = duBytes(sqlitePath + '-wal');
  const sqliteTotal = sqliteMain + sqliteWal;

  console.log(`  seed ${(seedC / 1000).toFixed(1)}s  rssΔ=${(rssC - rssC0).toFixed(0)}MB (now ${rssC.toFixed(0)}MB)`);
  console.log(`  disk db=${fmtBytes(sqliteMain)} wal=${fmtBytes(sqliteWal)} total=${fmtBytes(sqliteTotal)}`);

  console.log(`\n=== SQLite latency ===\n`);
  const sqlRecent = await bench(`SQLite ORDER BY LIMIT ${RECENT}`, N, () => {
    sqliteRecent.all(chatId, RECENT);
  });
  const sqlGet = await bench('SQLite PK get', N, () => {
    sqliteById.get(chatId, mid);
  });

  report.sqlite = {
    seedSec: Number((seedC / 1000).toFixed(2)),
    ram: { rssMb: Number(rssC.toFixed(1)), rssDeltaMb: Number((rssC - rssC0).toFixed(1)) },
    disk: { db: sqliteMain, wal: sqliteWal, total: sqliteTotal },
    latency: { recent: latOf(sqlRecent), get: latOf(sqlGet) },
  };

  // ── Summary table ──
  console.log('\n========== SUMMARY ==========\n');
  console.log(`msgs=${MSG.toLocaleString()}  text≈80–120 CJK chars\n`);
  console.log('DISK / SERVER RAM');
  console.log(
    `  NyatDB   ${fmtBytes(nyatTotal).padStart(10)}  (process rssΔ ${((report.nyatdb as { ram: { rssDeltaMb: number } }).ram.rssDeltaMb)}MB, indexed=${MSG})`,
  );
  console.log(
    `  SQLite   ${fmtBytes(sqliteTotal).padStart(10)}  (process rssΔ ${(report.sqlite as { ram: { rssDeltaMb: number } }).ram.rssDeltaMb}MB)`,
  );
  console.log(
    `  Redis    window ${fmtBytes(redisWinBytes)} (llen=${redisWinLen})` +
      (wantFull ? `  |  full ${fmtBytes(redisFullBytes)} (llen=${redisFullLen})` : ''),
  );
  console.log('\nRECENT read (lower better)');
  console.log(
    `  NyatDB   avg=${latOf(nyatRecent).avg}ms  p50=${latOf(nyatRecent).p50}ms  ${latOf(nyatRecent).ops} ops/s`,
  );
  console.log(
    `  Redis    avg=${latOf(redisRecent).avg}ms  p50=${latOf(redisRecent).p50}ms  ${latOf(redisRecent).ops} ops/s`,
  );
  console.log(
    `  SQLite   avg=${latOf(sqlRecent).avg}ms  p50=${latOf(sqlRecent).p50}ms  ${latOf(sqlRecent).ops} ops/s`,
  );
  console.log('\nPOINT get');
  console.log(`  NyatDB   avg=${latOf(nyatGet).avg}ms  ${latOf(nyatGet).ops} ops/s`);
  console.log(`  SQLite   avg=${latOf(sqlGet).avg}ms  ${latOf(sqlGet).ops} ops/s`);
  console.log('\nHOT get');
  console.log(`  NyatDB   avg=${latOf(nyatHot).avg}ms  ${latOf(nyatHot).ops} ops/s`);
  console.log(`  Redis    avg=${latOf(redisHot).avg}ms  ${latOf(redisHot).ops} ops/s`);

  const reportPath = join(dir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nreport → ${reportPath}`);

  // keep report copy under /tmp before cleanup
  writeFileSync('/tmp/nyatdb-200k-report.json', JSON.stringify(report, null, 2));

  sqlite.close();
  await redis.del(ctxKey, ctxFullKey, 'bench:hot');
  await redis.quit();
  rmSync(dir, { recursive: true, force: true });
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
