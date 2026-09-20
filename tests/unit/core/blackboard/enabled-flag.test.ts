/**
 * CORE_BLACKBOARD_ENABLED —— 从死旗标变成真闸门。
 *
 * 2026-09-21 之前：env.ts 里声明了、.env 里开着，而全仓库没有一处读它。
 * 黑板被四个模块（agent/cognitive-workspace、agency-intent-adapter、
 * core/promote、core/loop）当存储层**无条件**用着。测试把它设成 false
 * 以为关掉了黑板，其实什么都没验证——假开关比死旗标更坏。
 *
 * 现在它在 store 边界上门控四个入口。锁的是"关掉时语义自洽"：
 *   写不进、读不出、状态不迁 —— 三个"空"都是这些函数的既有正常返回，
 *   调用方本来就要处理，不需要额外分支。
 *
 * 生产 .env 是 true，所以这条修的是"关不掉"，不是"关一下"。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
const envValues: Record<string, unknown> = { CORE_BLACKBOARD_ENABLED: true };
vi.mock('../../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { writeEntry, readEntry, listEntries, setEntryStatus } = await import(
  '../../../../src/core/blackboard/store.js'
);

beforeEach(() => {
  db = new Database(':memory:');
  for (const f of ['0084_core_blackboard.sql', '0085_core_belief_view.sql']) {
    try {
      db.exec(readFileSync(`migrations/${f}`, 'utf8'));
    } catch {
      /* 表可能在别的迁移里；缺表由下面的 ensure 兜住 */
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS core_blackboard (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_id INTEGER, author TEXT NOT NULL,
    content TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  envValues.CORE_BLACKBOARD_ENABLED = true;
});

// ACL（src/core/blackboard/acl.ts）：authorized_intent 只有 'gate' 能写，
// proposal 只有 'l1' 能写。用错的 author 会被 ACL 拒，跟旗标是两条拒绝路径。
const intent = {
  kind: 'authorized_intent' as const,
  author: 'gate' as const,
  content: '{"tool":"mute","args":{"uid":1}}',
};

describe('CORE_BLACKBOARD_ENABLED', () => {
  it('开着：写-读-迁状态全通（原行为不退）', () => {
    const w = writeEntry(intent);
    expect(w.ok).toBe(true);
    expect(w.id).toBeTruthy();
    expect(readEntry(w.id!)?.content).toBe(intent.content);
    expect(listEntries('authorized_intent', 'open').length).toBe(1);
    expect(setEntryStatus(w.id!, 'consumed')).toBe(true);
    expect(listEntries('authorized_intent', 'open').length).toBe(0);
  });

  it('**关着：写不进**（{ok:false, reason}，不抛错）', () => {
    envValues.CORE_BLACKBOARD_ENABLED = false;
    const w = writeEntry(intent);
    expect(w.ok).toBe(false);
    expect(w.reason).toBe('blackboard disabled');
  });

  it('关着：读不出（readEntry → null）', () => {
    const w = writeEntry(intent);
    expect(w.ok).toBe(true);
    envValues.CORE_BLACKBOARD_ENABLED = false;
    expect(readEntry(w.id!)).toBeNull();
  });

  it('关着：列不出（listEntries → []）', () => {
    writeEntry(intent);
    expect(listEntries('authorized_intent', 'open').length).toBe(1);
    envValues.CORE_BLACKBOARD_ENABLED = false;
    expect(listEntries('authorized_intent', 'open')).toEqual([]);
    expect(listEntries('authorized_intent')).toEqual([]);
  });

  it('关着：状态不迁（setEntryStatus → false）', () => {
    const w = writeEntry(intent);
    envValues.CORE_BLACKBOARD_ENABLED = false;
    expect(setEntryStatus(w.id!, 'rejected')).toBe(false);
    // 再开回来，状态确实没被改过
    envValues.CORE_BLACKBOARD_ENABLED = true;
    expect(readEntry(w.id!)?.status).toBe('open');
  });

  it('关着时库里不留痕（不是"写了但读不到"）', () => {
    envValues.CORE_BLACKBOARD_ENABLED = false;
    writeEntry(intent);
    writeEntry(intent);
    const n = (db.prepare('SELECT COUNT(*) n FROM core_blackboard').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('env() 抛异常时按关处理（黑板是可选层，不该拦住启动）', () => {
    envValues.CORE_BLACKBOARD_ENABLED = undefined;
    // mock 的 env() 返回 undefined 字段 → === true 为 false → 关
    expect(writeEntry(intent).ok).toBe(false);
    expect(listEntries('authorized_intent')).toEqual([]);
  });

  it('ACL 仍然先于旗标生效（旗标关时不需要问 ACL）', () => {
    // 越权写入在开着时也被拒——两条拒绝路径不要互相掩盖
    const denied = writeEntry({ ...intent, author: 'l1' as never });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('ACL');
    envValues.CORE_BLACKBOARD_ENABLED = false;
    const denied2 = writeEntry({ ...intent, author: 'l1' as never });
    expect(denied2.reason).toBe('blackboard disabled'); // 旗标在前，短路
  });
});
