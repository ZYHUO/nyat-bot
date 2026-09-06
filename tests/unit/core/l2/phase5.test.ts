import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
const envStore: Record<string, unknown> = {
  MASTER_UID: 1001,
  CORE_PERMISSION_GATE_ENABLED: false,
};
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/env.js', () => ({ env: () => envStore }));
vi.mock('../../../../src/agent/skills.js', () => ({ saveSkill: vi.fn(() => 999) }));
vi.mock('../../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => [{ text: 'hit' }]),
}));
vi.mock('../../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async () => []),
}));
vi.mock('../../../../src/pipeline/tools/search.js', () => ({
  executeSearch: vi.fn(async (q: string) => `results for ${q}`),
}));
vi.mock('../../../../src/pipeline/shared.js', () => ({
  sender: { sendDirect: vi.fn(async () => 123) },
}));

import { handleSkillCommand } from '../../../../src/core/skills/commands.js';
import {
  proposeSkill,
  verifySkill,
  getLifecycle,
} from '../../../../src/core/skills/lifecycle.js';
import { writeEntry } from '../../../../src/core/blackboard/store.js';
import { executeIntentReal } from '../../../../src/core/l2/execute.js';
import { gateConfirm } from '../../../../src/core/permission/gate.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0084_core_blackboard.sql', 'utf8'));
  db.exec(readFileSync('migrations/0086_core_skill_lifecycle.sql', 'utf8'));
  envStore['CORE_PERMISSION_GATE_ENABLED'] = false;
});

describe('/skill command', () => {
  it('非主人 → 拒绝（不透露门）', async () => {
    expect(await handleSkillCommand(-100, 1001, 'pending')).toBe('这个命令用不了喵~');
    expect(await handleSkillCommand(9999, 2002, 'pending')).toBe('这个命令用不了喵~');
  });

  it('主人 DM 全链：pending → verify → approve → publish', async () => {
    const id = proposeSkill({ name: '查快递', triggerWhen: '问快递', steps: '问单号再查' });
    const pending = await handleSkillCommand(1001, 1001, 'pending');
    expect(pending).toContain(`#${id}`);
    expect(await handleSkillCommand(1001, 1001, `show ${id}`)).toContain('查快递');
    expect(await handleSkillCommand(1001, 1001, `approve ${id}`)).toContain('批不了');
    expect(await handleSkillCommand(1001, 1001, `verify ${id}`)).toContain('验证通过');
    expect(await handleSkillCommand(1001, 1001, `approve ${id}`)).toContain('已批准');
    expect(await handleSkillCommand(1001, 1001, `publish ${id}`)).toContain('已发布');
    expect(getLifecycle(id)!.status).toBe('published');
  });

  it('reject 驳回 verified', async () => {
    const id = proposeSkill({ name: 'xx', triggerWhen: 't', steps: 's' });
    verifySkill(id);
    expect(await handleSkillCommand(1001, 1001, `reject ${id}`)).toContain('已驳回');
    expect(getLifecycle(id)!.status).toBe('rejected');
  });
});

describe('L2 real execute + gate', () => {
  function mkIntent(tool: string, args: unknown): string {
    const w = writeEntry({
      kind: 'authorized_intent',
      author: 'gate',
      content: JSON.stringify({ tool, args, why: 'test' }),
      chatId: -100,
    });
    if (!w.ok) throw new Error('write failed');
    return w.id!;
  }

  it('readonly 无 intent 也能过（memory.search 真调 mock）', async () => {
    const id = mkIntent('memory.search', { query: '猫', chatId: -100 });
    const r = await executeIntentReal(id);
    expect(r.executed).toBe(true);
    expect(r.tier).toBe('readonly');
    expect(r.data).toEqual([{ text: 'hit' }]);
  });

  it('未知工具 → fail-closed（irreversible，无确认直接拒）', async () => {
    const id = mkIntent('computer.run', { command: 'rm -rf /' });
    const r = await executeIntentReal(id);
    expect(r.executed).toBe(false);
    expect(r.tier).toBe('irreversible');
    expect(r.reason).toContain('confirmation');
  });

  it('reversible_write 无有效 intent ID 形状也能过（有 intent 行）→ 真执行 sendText mock', async () => {
    const id = mkIntent('telegram.sendText', { text: 'hi', chatId: -100 });
    const r = await executeIntentReal(id);
    expect(r.executed).toBe(true);
    expect(r.data).toEqual({ messageId: 123 });
  });

  it('sendText scope  violation（跨群挪用）→ 拒', async () => {
    const id = mkIntent('telegram.sendText', { text: 'hi', chatId: -200 });
    const r = await executeIntentReal(id);
    expect(r.executed).toBe(false);
    expect(r.reason).toContain('scope violation');
  });

  it('consumed intent 不可重放', async () => {
    const id = mkIntent('memory.search', { query: 'x' });
    await executeIntentReal(id);
    const r2 = await executeIntentReal(id);
    expect(r2.executed).toBe(false);
    expect(r2.reason).toContain('consumed');
  });

  it('irreversible + gateConfirm → 放行到"无实现"（computer.run 安全版也无 L2 实现）', async () => {
    const id = mkIntent('computer.run', { command: 'echo hi' });
    gateConfirm(id, { userId: 1001 });
    const r = await executeIntentReal(id);
    // reversible_write 的 computer.run 有 intent 即 approve 过，但 TOOLS 无实现 → 拒
    expect(r.executed).toBe(false);
    expect(r.reason).toContain('no L2 implementation');
  });
});
