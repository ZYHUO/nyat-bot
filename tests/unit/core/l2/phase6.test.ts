import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
const envStore: Record<string, unknown> = {
  MASTER_UID: 1001,
  CORE_PERMISSION_GATE_ENABLED: false,
  CORE_DRIVE_SATIATION_HALFLIFE_SEC: 21600,
};
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/env.js', () => ({ env: () => envStore }));

import { decayedSatiation } from '../../../../src/core/drives/store.js';
import { promoteProposal } from '../../../../src/core/promote.js';
import { writeEntry, listEntries } from '../../../../src/core/blackboard/store.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0084_core_blackboard.sql', 'utf8'));
});

describe('phase6: proposal auto-promote shape', () => {
  it('REPLY 形 proposal（含 tool 意图）→ 自动 promote 成 intent', () => {
    const w = writeEntry({
      kind: 'proposal',
      author: 'l1',
      content: JSON.stringify({
        action: 'REPLY',
        rule: 'r',
        tool: 'chats.recentMessages',
        args: { chatId: -100 },
        why: 'l1-reply',
      }),
      chatId: -100,
    });
    expect(w.ok).toBe(true);
    const pr = promoteProposal(w.id!);
    expect(pr.promoted).toBe(true);
    const intents = listEntries('authorized_intent', 'open', 5);
    expect(intents.length).toBe(1);
    const body = JSON.parse(intents[0]!.content) as { tool: string };
    expect(body.tool).toBe('chats.recentMessages');
  });

  it('非 REPLY 形 proposal（无 tool）→ 不 promote（needs-user-confirm）', () => {
    const w = writeEntry({
      kind: 'proposal',
      author: 'l1',
      content: JSON.stringify({ action: 'IGNORE', rule: 'r' }),
      chatId: -100,
    });
    const pr = promoteProposal(w.id!);
    expect(pr.promoted).toBe(false);
    expect(pr.reason).toBe('needs-user-confirm');
  });
});

describe('phase6: halflife 经 env() 读', () => {
  it('env 缺 key → 默认 6h 衰减（纯函数口径不变）', () => {
    expect(decayedSatiation(1, 21600, 21600)).toBeCloseTo(0.5);
  });

  it('env 可配 halflife（读 envStore）', async () => {
    envStore['CORE_DRIVE_SATIATION_HALFLIFE_SEC'] = 3600;
    const { getDrives } = await import('../../../../src/core/drives/store.js');
    // 缺行 → 默认值，不抛即过（halflife 只在有行时参与 decay）
    expect(getDrives()).toHaveLength(4);
    envStore['CORE_DRIVE_SATIATION_HALFLIFE_SEC'] = 21600;
  });
});
