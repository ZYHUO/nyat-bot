/**
 * Step4 bench: native chatGet / chatGetBatch vs TS NyatDB vs SQLite PK.
 *
 *   BENCH_MSGS=50000 BENCH_N=2000 npx tsx scripts/bench-nyatdb-native.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { NyatDb, NyatDbNativeFacade, isNyatDbNativeAvailable, openNyatDbNative } from '../packages/nyatdb/src/index.ts';

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function summarize(name: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(
    `${name.padEnd(40)} n=${String(s.length).padStart(5)}  ` +
      `avg=${avg.toFixed(3)}ms  p50=${pct(s, 50).toFixed(3)}ms  ` +
      `p95=${pct(s, 95).toFixed(3)}ms  ops/s=${(1000 / avg).toFixed(0)}`,
  );
}

function randomText(i: number): string {
  const n = 40 + (i % 40);
  let s = `id=${i}|`;
  for (let k = 0; k < n; k++) s += String.fromCharCode(0x4e00 + ((i * 17 + k * 13) % 2000));
  return s;
}

async function main(): Promise<void> {
  if (!isNyatDbNativeAvailable()) {
    console.error('native addon missing — run: npm run build:nyatdb');
    process.exit(1);
  }

  const MSG = Number(process.env.BENCH_MSGS ?? 50_000);
  const N = Number(process.env.BENCH_N ?? 2000);
  const BATCH = Number(process.env.BENCH_BATCH ?? 100);
  const chatId = -1002767093213;
  const dir = mkdtempSync(join(tmpdir(), 'nyat-s4-'));

  console.log(`\n=== Step4 bench msgs=${MSG} lookups=${N} batch=${BATCH} ===\n`);

  const native = new NyatDbNativeFacade(
    openNyatDbNative({ path: join(dir, 'native'), syncEvery: 512, poolFrames: 1024, chatRingMax: 100 }),
  );
  const ts = NyatDb.open({
    path: join(dir, 'ts'),
    syncEvery: 512,
    poolFrames: 1024,
    chatRingMax: 100,
  });
  const sqlitePath = join(dir, 'bench.sqlite');
  const sqlite = new Database(sqlitePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(
    `CREATE TABLE messages (chat_id INTEGER, message_id INTEGER, text TEXT, PRIMARY KEY(chat_id, message_id))`,
  );
  const ins = sqlite.prepare(`INSERT INTO messages VALUES (?,?,?)`);
  const many = sqlite.transaction((rows: Array<[number, number, string]>) => {
    for (const r of rows) ins.run(...r);
  });

  const batchSql: Array<[number, number, string]> = [];
  const t0 = performance.now();
  for (let i = 1; i <= MSG; i++) {
    const text = randomText(i);
    native.chatAppend(chatId, { messageId: i, ts: 1_700_000_000 + i, uid: 1, role: 'user', text });
    ts.chatAppend(chatId, { messageId: i, ts: 1_700_000_000 + i, uid: 1, role: 'user', text });
    batchSql.push([chatId, i, text]);
    if (batchSql.length >= 5000) many(batchSql.splice(0, batchSql.length));
    if (i % 25_000 === 0) {
      native.checkpoint();
      ts.checkpoint();
    }
  }
  if (batchSql.length) many(batchSql);
  native.checkpoint();
  ts.checkpoint();
  console.log(`seed ${(performance.now() - t0).toFixed(0)}ms  native.stats`, native.stats());

  const ids = Array.from({ length: N }, (_, i) => 1 + ((i * 9973) % MSG));
  const sqlGet = sqlite.prepare(`SELECT text FROM messages WHERE chat_id=? AND message_id=?`);

  {
    const samples: number[] = [];
    for (const id of ids) {
      const a = performance.now();
      native.chatGet(chatId, id);
      samples.push(performance.now() - a);
    }
    summarize('native chatGet', samples);
  }
  {
    const samples: number[] = [];
    for (let off = 0; off < ids.length; off += BATCH) {
      const chunk = ids.slice(off, off + BATCH);
      const a = performance.now();
      native.chatGetBatch(chatId, chunk);
      const elapsed = performance.now() - a;
      for (let i = 0; i < chunk.length; i++) samples.push(elapsed / chunk.length);
    }
    summarize(`native chatGetBatch/${BATCH}`, samples);
  }
  {
    const samples: number[] = [];
    for (const id of ids) {
      const a = performance.now();
      ts.chatGet(chatId, id);
      samples.push(performance.now() - a);
    }
    summarize('TS chatGet', samples);
  }
  {
    const samples: number[] = [];
    for (const id of ids) {
      const a = performance.now();
      sqlGet.get(chatId, id);
      samples.push(performance.now() - a);
    }
    summarize('SQLite PK', samples);
  }

  // wall throughput for one big batch
  {
    const a = performance.now();
    native.chatGetBatch(chatId, ids);
    const ms = performance.now() - a;
    console.log(
      `\nnative one-shot batch N=${N}: ${ms.toFixed(1)}ms → ${(N / (ms / 1000)).toFixed(0)} ops/s  avg=${(ms / N).toFixed(3)}ms`,
    );
  }

  native.close({ skipCheckpoint: true });
  ts.close({ skipCheckpoint: true });
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('\ndone');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
