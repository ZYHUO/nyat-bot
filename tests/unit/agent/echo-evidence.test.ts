/**
 * host 观测的「有没有人接」→ 无 contract 任务的证据（applyEchoEvidence）。
 *
 * 为什么存在：task_evidence 7038 / 7039 行是 unverified（群聊任务没有 caller 契约），
 * 经验→技能这条链没有任何独立信号。host 自己看得到一件事——任务发出的消息后来怎么样了
 * （self_replies.outcome）。这里锁：
 *   ① 聚合规则（corrected 压倒一切；有人接 → verified；全被无视 → failed；还没结算 → 不动）
 *   ② 只升级 unverified 行——caller 契约给的 verified/failed 一律不动（不削弱原有证据门）
 *   ③ 端到端：closeSelfActOutcome 结算一条 → 任务证据真的变了 → 注入过的 skill 真的记功
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
const envMock: Record<string, unknown> = {
  SELF_HISTORY_ENABLED: true,
  SKILL_VERIFIED_USE_ENABLED: true,
  COGNITIVE_CLOCK_ENABLED: false,
};
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));

const { applyEchoEvidence } = await import('../../../src/agent/task-evidence-store.js');
const { recordSelfReply, closeSelfActOutcome } = await import('../../../src/tracking/self-history.js');
const { recordSkillInjections, recordSkillVerifiedUseForTask } = await import('../../../src/agent/skills.js');

const MIGRATIONS = [
  '0018_self_history_relationship.sql',
  '0054_episodes_experience.sql',
  '0071_skills.sql',
  '0072_task_evidence.sql',
  '0074_skill_verified_use.sql',
  '0112_self_reply_outcomes.sql',
  '0116_self_reply_task_id.sql',
];

const CHAT = -1001;

function seedEvidence(taskId: string, assessment: 'unverified' | 'verified' | 'failed' = 'unverified'): void {
  db.prepare(
    `INSERT INTO task_evidence (task_id, chat_id, lifecycle, assessment, reasons, updated_at) VALUES (?, ?, 'done', ?, '["no_contract"]', 1)`,
  ).run(taskId, CHAT, assessment);
}
function send(taskId: string, botMsgId: number, outcome = 'unknown'): void {
  recordSelfReply(CHAT, 5, 1, `话${botMsgId}`, botMsgId, taskId);
  if (outcome !== 'unknown') {
    db.prepare(`UPDATE self_replies SET outcome = ? WHERE bot_message_id = ?`).run(outcome, botMsgId);
  }
}
const assessment = (taskId: string): string =>
  (db.prepare(`SELECT assessment FROM task_evidence WHERE task_id = ?`).get(taskId) as { assessment: string }).assessment;

beforeEach(() => {
  db = new Database(':memory:');
  for (const m of MIGRATIONS) db.exec(readFileSync(`migrations/${m}`, 'utf8'));
  envMock.SKILL_VERIFIED_USE_ENABLED = true;
});

describe('applyEchoEvidence —— 聚合规则', () => {
  it('① 有人接（replied）→ verified，原因带 host_echo: 前缀且保留旧原因', () => {
    seedEvidence('t1');
    send('t1', 100, 'replied');
    expect(applyEchoEvidence('t1')).toBe('verified');
    expect(assessment('t1')).toBe('verified');
    const reasons = JSON.parse((db.prepare(`SELECT reasons FROM task_evidence WHERE task_id='t1'`).get() as { reasons: string }).reasons);
    expect(reasons).toEqual(['no_contract', 'host_echo:landed']);
  });

  it('② mentioned / reacted 同样算被接住', () => {
    seedEvidence('t2'); send('t2', 101, 'mentioned');
    seedEvidence('t3'); send('t3', 102, 'reacted');
    expect(applyEchoEvidence('t2')).toBe('verified');
    expect(applyEchoEvidence('t3')).toBe('verified');
  });

  it('③ 被纠正（corrected）→ failed，哪怕另一条被接住了（压倒一切）', () => {
    seedEvidence('t4');
    send('t4', 103, 'replied');
    send('t4', 104, 'corrected');
    expect(applyEchoEvidence('t4')).toBe('failed');
  });

  it('④ 全部已结算且全是 ignored → failed', () => {
    seedEvidence('t5');
    send('t5', 105, 'ignored');
    send('t5', 106, 'ignored');
    expect(applyEchoEvidence('t5')).toBe('failed');
  });

  it('⑤ 一条 ignored + 一条还没结算（unknown）→ 不下结论，保持 unverified', () => {
    seedEvidence('t6');
    send('t6', 107, 'ignored');
    send('t6', 108, 'unknown');
    expect(applyEchoEvidence('t6')).toBe('unchanged');
    expect(assessment('t6')).toBe('unverified');
  });

  it('⑥ 一条被接住 + 一条还没结算 → 已经够 verified（被接住是正面事实，不必等其余）', () => {
    seedEvidence('t7');
    send('t7', 109, 'replied');
    send('t7', 110, 'unknown');
    expect(applyEchoEvidence('t7')).toBe('verified');
  });

  it('⑦ 任务没发过消息（self_replies 里没有它）→ 不动', () => {
    seedEvidence('t8');
    expect(applyEchoEvidence('t8')).toBe('unchanged');
  });

  it('⑧ 没有 task_evidence 行 → 不动（不凭空造证据）', () => {
    send('ghost', 111, 'replied');
    expect(applyEchoEvidence('ghost')).toBe('unchanged');
    expect(db.prepare(`SELECT COUNT(*) c FROM task_evidence`).get()).toEqual({ c: 0 });
  });
});

describe('applyEchoEvidence —— 不削弱原有证据门', () => {
  it('⑨ caller 契约已判 verified / failed 的行一律不动', () => {
    seedEvidence('c1', 'verified'); send('c1', 120, 'corrected');
    seedEvidence('c2', 'failed'); send('c2', 121, 'replied');
    expect(applyEchoEvidence('c1')).toBe('unchanged');
    expect(applyEchoEvidence('c2')).toBe('unchanged');
    expect(assessment('c1')).toBe('verified');
    expect(assessment('c2')).toBe('failed');
  });

  it('⑨b 守卫本身有效：行已是 verified 时，连 self_replies 都不该被读（不靠 UPDATE 的 WHERE 兜底）', () => {
    seedEvidence('c3', 'verified');
    send('c3', 123, 'corrected');
    const spy = vi.spyOn(db, 'prepare');
    applyEchoEvidence('c3');
    const touchedSelfReplies = spy.mock.calls.some((c) => String(c[0]).includes('FROM self_replies'));
    spy.mockRestore();
    expect(touchedSelfReplies).toBe(false);
  });

  it('⑩ 重复调用幂等：升级一次后再调不再变', () => {
    seedEvidence('t9'); send('t9', 122, 'replied');
    expect(applyEchoEvidence('t9')).toBe('verified');
    expect(applyEchoEvidence('t9')).toBe('unchanged');
  });
});

describe('端到端：结局结算 → 任务证据 → skill 记功', () => {
  it('⑪ closeSelfActOutcome 结算一条 replied → task_evidence 升 verified → 注入过的 skill verified_use_count+1', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO skills (name, tier, trigger_when, steps, created_at) VALUES ('s1','small','t','x',?)`).run(now);
    db.prepare(`INSERT INTO skills (name, tier, trigger_when, steps, created_at) VALUES ('s2','small','t','x',?)`).run(now);
    const skillIds = (db.prepare(`SELECT id FROM skills ORDER BY id`).all() as Array<{ id: number }>).map((r) => r.id);

    seedEvidence('e2e');
    recordSkillInjections('e2e', skillIds);
    recordSelfReply(CHAT, 5, 1, '接住你', 200, 'e2e');

    expect(closeSelfActOutcome({ chatId: CHAT, botMessageId: 200, outcome: 'replied' })).toBe(true);
    // 回写是 fire-and-forget 的动态 import 链，等它落地
    await vi.waitFor(() => expect(assessment('e2e')).toBe('verified'));
    await vi.waitFor(() => {
      const counts = (db.prepare(`SELECT verified_use_count v FROM skills ORDER BY id`).all() as Array<{ v: number }>).map((r) => r.v);
      expect(counts).toEqual([1, 1]);
    });
  });

  it('⑫ SKILL_VERIFIED_USE_ENABLED 关 → 证据照升，但 skill 不记功', () => {
    envMock.SKILL_VERIFIED_USE_ENABLED = false;
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO skills (name, tier, trigger_when, steps, created_at) VALUES ('s1','small','t','x',?)`).run(now);
    seedEvidence('off');
    recordSkillInjections('off', [1]);
    expect(recordSkillVerifiedUseForTask('off')).toBe(0);
    expect((db.prepare(`SELECT verified_use_count v FROM skills`).get() as { v: number }).v).toBe(0);
  });

  it('⑬ recordSelfReply 把 taskId 写进 self_replies；不传则为 NULL（不凭空造关联）', () => {
    recordSelfReply(CHAT, 5, 1, '有任务', 300, 'tX');
    recordSelfReply(CHAT, 5, 1, '无任务', 301);
    const rows = db.prepare(`SELECT bot_message_id b, task_id t FROM self_replies ORDER BY b`).all();
    expect(rows).toEqual([{ b: 300, t: 'tX' }, { b: 301, t: null }]);
  });
});

describe('向后兼容：老 schema（没有 task_id 列）', () => {
  it('⑭ 不带 taskId 的 recordSelfReply 在没有 task_id 列的表上照样写成功（必写记录不依赖新增可选列）', () => {
    const old = new Database(':memory:');
    old.exec(`CREATE TABLE self_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, trigger_uid INTEGER DEFAULT 0, trigger_msg_id INTEGER, reply_text TEXT, ts INTEGER, bot_message_id INTEGER, outcome TEXT DEFAULT 'unknown', outcome_at INTEGER)`);
    const keep = db;
    db = old;
    try {
      recordSelfReply(CHAT, 5, 1, '老表也要写进去', 400);
      expect(old.prepare(`SELECT COUNT(*) c FROM self_replies`).get()).toEqual({ c: 1 });
    } finally {
      db = keep;
    }
  });
});

describe('接线：生产路径真的把 taskId / 注入记录传下去', () => {
  it('host-api 的 sendText 把 opts.taskId 传给 recordSelfReply', () => {
    const src = readFileSync('src/subagent/host-api.ts', 'utf8');
    expect(src).toMatch(/recordSelfReply\(chatId, opts\.targetUserId \?\? 0, effectiveAnchor, part, messageId, opts\.taskId\)/);
  });
  it('executor 在 prompt 准备后落盘注入的 skill', () => {
    const src = readFileSync('src/subagent/executor.ts', 'utf8');
    expect(src).toContain('recordSkillInjections(task.id, injectedSkillIds)');
  });
  it('closeSelfActOutcome 结算后触发 applyEchoEvidence', () => {
    const src = readFileSync('src/tracking/self-history.ts', 'utf8');
    expect(src).toContain('applyEchoEvidence(row.task_id!)');
  });
});
