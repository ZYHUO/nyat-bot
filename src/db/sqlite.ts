import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!_db) {
    // vitest 下强制内存库：dotenv 会把生产 SQLITE_PATH 喂给测试进程，漏 mock
    // 的测试会读写生产 data/xxb.db（Redis 污染事故的孪生通道）。没 mock 的测试
    // 会在 :memory: 上显式报表不存在——正好暴露该补 mock 的测试。
    const isVitest = !!process.env['VITEST'];
    const dbPath = isVitest ? ':memory:' : resolve(env().SQLITE_PATH);
    const dir = dirname(dbPath);
    if (!isVitest && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
    // WAL + synchronous=FULL(SQLite 默认) 意味着每次 commit 都 fsync WAL:实测 2.24ms/commit
    // vs NORMAL 的 0.017ms(约 130x)。热路径一条入站消息会产生 3-10 个独立隐式事务
    // (memory_meta / social_edges / person_aliases / user_profiles / self_replies …),
    // 即 ~7-22ms 同步 fsync 阻塞在唯一的 JS 线程上。WAL 下 NORMAL 不会损坏数据库,
    // 只在**操作系统/断电**故障时可能丢最后几次 commit(进程崩溃不丢)——对心情增量/
    // 外号计数/记忆 sidecar 这类数据是可接受的权衡。
    _db.pragma('synchronous = NORMAL');

    // try loading sqlite-vec extension (optional)
    try {
      _db.loadExtension('vec0');
      logger.info('sqlite-vec extension loaded');
    } catch {
      logger.debug('sqlite-vec extension not available, skipping');
    }

    logger.info({ path: dbPath }, 'SQLite database opened');
  }
  return _db;
}

export function runMigrations(migrationsDir: string): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT name FROM _migrations')
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applyMigration = db.transaction((sql: string, name: string) => {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
  });

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(resolve(migrationsDir, file), 'utf-8');
    try {
      applyMigration(sql, file);
      logger.info({ migration: file }, 'Migration applied');
    } catch (err) {
      // 多进程同时启动的竞态:另一方已插入同名 _migrations 记录。迁移 SQL 本身
      // 幂等(IF NOT EXISTS),约束冲突说明对方已经应用,安全跳过而不是崩掉。
      if (err instanceof Error && err.message.includes('_migrations')) {
        logger.info({ migration: file }, 'Migration already applied by concurrent process — skipped');
        continue;
      }
      throw err;
    }
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
