// ────────────────────────────────────────
// Schema 漂移守卫。
//
// 现状:21 个测试文件各自只加载**手挑的 1-6 个** migration,没有任何测试加载全集。
// 后果是 src 里的 SQL 可以引用一个根本不存在的列而套件全绿 —— `school-state.ts` 的
// `FROM school_overrides WHERE date = ?`(真实列名是 bj_date)就这样活了下来:查询包在
// try/catch 里,catch 只 logger.debug,而生产 LOG_LEVEL=info 让那行日志从不落盘,
// 调用方把 undefined 当成"这天没有 override",于是整个人工登记的调休/补课/考试
// override 被永久忽略而没有任何症状。
//
// 这个文件做两件事:
//   1. 把 migrations/ 下**全部** .sql 按 runMigrations 的同一排序灌进 :memory:,
//      断言无抛出 —— 拦住"新 migration 会不会搞挂启动"。
//   2. 把 src/ 里所有 SQL 字面量抽出来,对每条跑 `prepare()`(只 prepare 不执行也能抓
//      列名/表名错误)—— 拦住所有同类漂移,不只是已知的那一处。
// ────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');
const SRC_DIR = resolve(process.cwd(), 'src');

/** 与 src/db/sqlite.ts:runMigrations 完全相同的排序。 */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

function buildFullSchema(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of migrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  return db;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// 定界符必须逐类匹配:`...` 只能由反引号收尾。用 [`'"]...[`'"] 这种写法会在 SQL 内部
// 第一个引号处提前截断(例如 strftime('%s','now')),产出残缺语句 → prepare 失败 → 误报。
const LITERAL_PATTERNS = [
  /`((?:[^`\\]|\\.)*)`/g,
  /'((?:[^'\\\n]|\\.)*)'/g,
  /"((?:[^"\\\n]|\\.)*)"/g,
];

// 必须长得像完整语句,不能只是以 "Delete " 开头的英文日志文案。
const SQL_SHAPES = [
  /^SELECT\s[\s\S]*\sFROM\s/i,
  /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s/i,
  /^UPDATE\s+(?:OR\s+\w+\s+)?[\w".]+\s+SET\s/i,
  /^DELETE\s+FROM\s/i,
];

/**
 * 抽出 src 里可以独立 prepare 的静态 SQL。跳过含 ${} 插值的(那些是动态占位符列表,
 * 拼接后才完整)。**不做 \s+ → ' ' 归一化** —— 那会把 `--` 行注释后面的整条语句吃掉,
 * SQLite 报 "incomplete input"。SQLite 本来就能处理换行。
 */
function extractSqlLiterals(src: string): string[] {
  const out: string[] = [];
  for (const re of LITERAL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // 还原 JS 转义:源码里的 \' 在实际字符串值里是 '。
      const raw = (m[1] ?? '')
        .replace(/\\(['"`\\])/g, '$1')
        .trim();
      if (raw.includes('${')) continue;
      if (!SQL_SHAPES.some((s) => s.test(raw))) continue;
      out.push(raw);
    }
  }
  return out;
}

describe('migrations: full-chain apply', () => {
  it('applies every migration in runMigrations order without throwing', () => {
    expect(() => buildFullSchema().close()).not.toThrow();
  });

  it('has contiguous 4-digit numbering with no gaps or dups', () => {
    const nums = migrationFiles().map((f) => Number.parseInt(f.slice(0, 4), 10));
    expect(nums.some(Number.isNaN)).toBe(false);
    const gaps = Array.from({ length: Math.max(...nums) }, (_, i) => i + 1).filter(
      (n) => !nums.includes(n),
    );
    const dups = nums.filter((n, i) => nums.indexOf(n) !== i);
    expect({ gaps, dups }).toEqual({ gaps: [], dups: [] });
  });

  it('lexicographic sort still equals numeric sort (breaks at 5-digit prefixes)', () => {
    // readdirSync().sort() 是纯字符串排序。一旦出现 0100_ 前缀,它会排在 0049_ **之前**
    // 执行。现在离 0099 还有余量,这条断言是那道悬崖上的护栏。
    const nums = migrationFiles().map((f) => Number.parseInt(f.slice(0, 4), 10));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it('contains no embedded BEGIN/COMMIT (runMigrations wraps each file in a transaction)', () => {
    const offenders = migrationFiles().filter((f) =>
      /^\s*(BEGIN|COMMIT)\b/im.test(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('src SQL literals are preparable against the full schema', () => {
  it('every static SELECT/INSERT/UPDATE/DELETE in src/ prepares cleanly', () => {
    const db = buildFullSchema();
    const failures: Array<{ file: string; sql: string; error: string }> = [];
    try {
      for (const file of walk(SRC_DIR)) {
        const src = readFileSync(file, 'utf-8');
        for (const sql of extractSqlLiterals(src)) {
          try {
            db.prepare(sql);
          } catch (err) {
            failures.push({
              file: file.slice(SRC_DIR.length + 1),
              sql: sql.slice(0, 160),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } finally {
      db.close();
    }
    expect(failures).toEqual([]);
  });
});
