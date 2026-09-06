import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { writeEntry, readEntry } from '../../../../src/core/blackboard/store.js';
import { promoteProposal, pendingIntents, executeIntent } from '../../../../src/core/promote.js';
import { _resetGateForTest } from '../../../../src/core/permission/gate.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0084_core_blackboard.sql', 'utf8'));
  _resetGateForTest();
});

function proposal(content: string): string {
  const r = writeEntry({ kind: 'proposal', author: 'l1', content, chatId: -100 });
  expect(r.ok).toBe(true);
  return r.id!;
}

describe('gate promotion', () => {
  it('只读类 proposal 自动 promotion → intent', () => {
    const pid = proposal(JSON.stringify({ tool: 'memory.search', args: {}, why: '查一下' }));
    const r = promoteProposal(pid);
    expect(r.promoted).toBe(true);
    expect(r.intentId).toBeTruthy();
    const intent = readEntry(r.intentId!);
    expect(intent!.kind).toBe('authorized_intent');
    expect(intent!.author).toBe('gate');
    // proposal 被消费
    expect(readEntry(pid)!.status).toBe('consumed');
  });

  it('写类 proposal 不自动转 → needs-user-confirm', () => {
    const pid = proposal(
      JSON.stringify({ tool: 'telegram.sendText', args: { text: 'hi' }, why: '回一句' }),
    );
    const r = promoteProposal(pid);
    expect(r.promoted).toBe(false);
    expect(r.reason).toBe('needs-user-confirm');
    // proposal 保持 open（等确认，不吞掉）
    expect(readEntry(pid)!.status).toBe('open');
  });

  it('危险命令 proposal 不自动转', () => {
    const pid = proposal(
      JSON.stringify({ tool: 'computer.run', args: { command: 'rm -rf /tmp/x' }, why: '清理' }),
    );
    expect(promoteProposal(pid).promoted).toBe(false);
  });

  it('非 JSON proposal 拒绝', () => {
    const pid = proposal('not json{{{');
    expect(promoteProposal(pid).promoted).toBe(false);
  });
});

describe('L2 executeIntent (dry-run)', () => {
  it('只读 intent 全链跑通：intent → receipt(consumed) → intent consumed', async () => {
    const pid = proposal(JSON.stringify({ tool: 'web.search', args: { q: 'x' }, why: '查' }));
    const { intentId } = promoteProposal(pid);
    const pend = pendingIntents(-100);
    expect(pend.map((e) => e.id)).toContain(intentId);
    const r = await executeIntent(intentId!);
    expect(r.executed).toBe(true);
    expect(r.tool).toBe('web.search');
    expect(r.tier).toBe('readonly');
    expect(readEntry(r.receiptId!)!.status).toBe('consumed');
    expect(readEntry(intentId!)!.status).toBe('consumed');
  });

  it('无 intent → 不执行（L2 不自己编事做）', async () => {
    expect(pendingIntents(-100)).toEqual([]);
    const r = await executeIntent('no-such-id');
    expect(r.executed).toBe(false);
  });

  it('已消费的 intent 不重放', async () => {
    const pid = proposal(JSON.stringify({ tool: 'memory.search', args: {}, why: '查' }));
    const { intentId } = promoteProposal(pid);
    expect((await executeIntent(intentId!)).executed).toBe(true);
    const again = await executeIntent(intentId!);
    expect(again.executed).toBe(false);
    expect(again.reason).toContain('consumed');
  });
});
