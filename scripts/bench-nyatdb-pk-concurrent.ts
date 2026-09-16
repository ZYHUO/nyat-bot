/**
 * Point-get race: NyatDB vs SQLite under concurrency=100 random lookups.
 *
 *   BENCH_MSGS=100000 CONCURRENCY=100 BENCH_N=2000 npx tsx scripts/bench-nyatdb-pk-concurrent.ts
 *
 * Note: NyatDB + better-sqlite3 are sync on the Node main thread — Promise.all
 * concurrency does NOT use extra CPU cores. Worker-thread section measures that.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { NyatDb } from '../packages/nyatdb/src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'bench-nyatdb-pk-worker.ts');

function randomText(i: number): string {
  const n = 40 + (i % 40);
  let s = `id=${i}|`;
  for (let k = 0; k < n; k++) s += String.fromCharCode(0x4e00 + ((i * 17 + k * 13) % 2000));
  return s;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function summarize(name: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(
    `${name.padEnd(42)} n=${String(s.length).padStart(5)}  ` +
      `avg=${avg.toFixed(3)}ms  p50=${pct(s, 50).toFixed(3)}ms  ` +
      `p95=${pct(s, 95).toFixed(3)}ms  p99=${pct(s, 99).toFixed(3)}ms  ` +
      `ops/s=${(1000 / avg).toFixed(0)}`,
  );
}

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

function spawnWorker(workerData: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      execArgv: ['--import', 'tsx'],
      workerData,
    });
    worker.on('message', () => resolve());
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exit ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const MSG = Number(process.env.BENCH_MSGS ?? 100_000);
  const CONC = Number(process.env.CONCURRENCY ?? 100);
  const N = Number(process.env.BENCH_N ?? 2000);
  const chatId = -1002767093213;
  const dir = mkdtempSync(join(tmpdir(), 'nyat-pk-'));

  console.log(`\n=== seed ${MSG.toLocaleString()} msgs · concurrency=${CONC} · lookups=${N} ===\n`);
  const rss0 = rssMb();

  const db = NyatDb.open({
    path: join(dir, 'nyat'),
    syncEvery: 512,
    poolFrames: 1024,
    chatRingMax: 100,
  });
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
  `);
  const ins = sqlite.prepare(
    `INSERT INTO messages (chat_id, message_id, ts, uid, role, text) VALUES (?,?,?,?,?,?)`,
  );
  const many = sqlite.transaction((rows: Array<[number, number, number, number, string, string]>) => {
    for (const r of rows) ins.run(...r);
  });

  const batch: Array<[number, number, number, number, string, string]> = [];
  for (let i = 1; i <= MSG; i++) {
    const text = randomText(i);
    db.chatAppend(chatId, {
      messageId: i,
      ts: 1_700_000_000 + i,
      uid: 1 + (i % 97),
      role: 'user',
      text,
    });
    batch.push([chatId, i, 1_700_000_000 + i, 1 + (i % 97), 'user', text]);
    if (batch.length >= 5000) many(batch.splice(0, batch.length));
    if (i % 50_000 === 0) db.checkpoint();
  }
  if (batch.length) many(batch);
  db.checkpoint();
  sqlite.pragma('wal_checkpoint(TRUNCATE)');

  const rssAfter = rssMb();
  console.log(
    `seed done  rss ${rss0.toFixed(0)}→${rssAfter.toFixed(0)}MB (Δ${(rssAfter - rss0).toFixed(0)})  ` +
      `nyat indexed=${db.stats().indexed} pool=${JSON.stringify(db.stats().pool)}\n`,
  );

  const sqlGet = sqlite.prepare(`SELECT text FROM messages WHERE chat_id=? AND message_id=?`);
  const ids = Array.from({ length: N }, (_, i) => 1 + ((i * 9973) % MSG));

  console.log('--- sequential ---');
  {
    const samples: number[] = [];
    for (const id of ids) {
      const t0 = performance.now();
      db.chatGet(chatId, id);
      samples.push(performance.now() - t0);
    }
    summarize('NyatDB chatGet seq', samples);
  }
  {
    const samples: number[] = [];
    for (const id of ids) {
      const t0 = performance.now();
      sqlGet.get(chatId, id);
      samples.push(performance.now() - t0);
    }
    summarize('SQLite PK seq', samples);
  }

  console.log(`\n--- Promise.all waves (concurrency=${CONC}, still 1 JS thread) ---`);
  async function waveBench(label: string, fn: (id: number) => void): Promise<void> {
    const samples: number[] = [];
    for (let off = 0; off < ids.length; off += CONC) {
      const chunk = ids.slice(off, off + CONC);
      const t0 = performance.now();
      await Promise.all(
        chunk.map(
          (id) =>
            new Promise<void>((resolve) => {
              fn(id);
              resolve();
            }),
        ),
      );
      const elapsed = performance.now() - t0;
      for (let i = 0; i < chunk.length; i++) samples.push(elapsed / chunk.length);
    }
    summarize(label, samples);
  }
  await waveBench('NyatDB chatGet ×100 wave', (id) => {
    db.chatGet(chatId, id);
  });
  await waveBench('SQLite PK ×100 wave', (id) => {
    sqlGet.get(chatId, id);
  });

  console.log('\n--- wall-clock throughput (total time / N) ---');
  {
    const t0 = performance.now();
    for (let off = 0; off < ids.length; off += CONC) {
      const chunk = ids.slice(off, off + CONC);
      await Promise.all(chunk.map((id) => Promise.resolve(db.chatGet(chatId, id))));
    }
    const ms = performance.now() - t0;
    console.log(
      `NyatDB wall ${ms.toFixed(1)}ms for ${N} gets → ${(N / (ms / 1000)).toFixed(0)} ops/s  avg=${(ms / N).toFixed(3)}ms`,
    );
  }
  {
    const t0 = performance.now();
    for (let off = 0; off < ids.length; off += CONC) {
      const chunk = ids.slice(off, off + CONC);
      await Promise.all(chunk.map((id) => Promise.resolve(sqlGet.get(chatId, id))));
    }
    const ms = performance.now() - t0;
    console.log(
      `SQLite wall ${ms.toFixed(1)}ms for ${N} gets → ${(N / (ms / 1000)).toFixed(0)} ops/s  avg=${(ms / N).toFixed(3)}ms`,
    );
  }

  const workers = Math.min(CONC, Number(process.env.WORKERS ?? 4));
  console.log(`\n--- worker_threads (workers=${workers}, multi-core) ---`);
  console.log(
    'NyatDB: single-process heap (no multi-open yet) — skip. SQLite: concurrent readonly connections.\n',
  );
  const perWorker = Math.ceil(N / workers);
  const workerIds = Array.from({ length: workers }, (_, w) =>
    ids.slice(w * perWorker, (w + 1) * perWorker),
  );

  {
    const t0 = performance.now();
    await Promise.all(
      workerIds.map((chunk, w) =>
        spawnWorker({ sqlitePath, chatId, ids: chunk, workerId: w }),
      ),
    );
    const ms = performance.now() - t0;
    console.log(
      `SQLite ${workers} workers wall ${ms.toFixed(1)}ms → ${(N / (ms / 1000)).toFixed(0)} ops/s  avg=${(ms / N).toFixed(3)}ms`,
    );
  }

  // Same N lookups on 1 thread for comparison baseline after workers warmed OS cache
  {
    const t0 = performance.now();
    for (const id of ids) sqlGet.get(chatId, id);
    const ms = performance.now() - t0;
    console.log(
      `SQLite 1-thread wall ${ms.toFixed(1)}ms → ${(N / (ms / 1000)).toFixed(0)} ops/s  avg=${(ms / N).toFixed(3)}ms`,
    );
  }

  db.close({ skipCheckpoint: true });

  writeFileSync(
    '/tmp/nyatdb-pk-concurrent-report.json',
    JSON.stringify(
      {
        msgs: MSG,
        concurrency: CONC,
        workers,
        lookups: N,
        rssDeltaMb: Number((rssAfter - rss0).toFixed(1)),
      },
      null,
      2,
    ),
  );

  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('\ndone');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
