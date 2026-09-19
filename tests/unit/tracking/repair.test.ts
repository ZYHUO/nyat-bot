import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Repair: the bot noticing it said something that landed badly and never came
// back to it. `action-board.ts` already defined a `repair` action with a weight
// and `outcome.ts` already produced the `corrected` signal — but nothing
// consumed it, so the action existed with no producer.
//
// This only SURFACES the situation; the model decides whether to act. An
// auto-apology would read as servile, which is the opposite of a person.

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const envValues: Record<string, unknown> = { REPAIR_ENABLED: true };
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

const NOW = 1_700_000_000;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0018_self_history_relationship.sql', 'utf8'));
  db.exec(readFileSync('migrations/0112_self_reply_outcomes.sql', 'utf8'));
  envValues['REPAIR_ENABLED'] = true;
});

const load = async () => {
  vi.resetModules();
  return await import('../../../src/tracking/repair.js');
};

function speak(chatId: number, ts: number, text: string, outcome: string, mid: number): void {
  db.prepare(
    `INSERT INTO self_replies (chat_id, trigger_uid, trigger_msg_id, reply_text, ts, bot_message_id, outcome)
     VALUES (?, 1, 1, ?, ?, ?, ?)`,
  ).run(chatId, text, ts, mid, outcome);
}

describe('unrepaired acts', () => {
  it('surfaces an act that got a bad reaction and was never revisited', async () => {
    const m = await load();
    speak(-100, NOW - 600, '你这个问题很蠢', 'corrected', 5001);
    const acts = m.findUnrepairedActs(-100, NOW);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ botMessageId: 5001, said: '你这个问题很蠢', kind: 'corrected' });
    expect(acts[0]!.minutesAgo).toBe(10);
  });

  it('stays quiet once the bot has spoken again', async () => {
    const m = await load();
    speak(-100, NOW - 900, '你这个问题很蠢', 'corrected', 5001);
    // A later message means it already had a chance to smooth things over.
    speak(-100, NOW - 120, '刚那句说重了，我看看你问的啥', 'unknown', 5002);
    expect(m.findUnrepairedActs(-100, NOW)).toHaveLength(0);
  });

  it('ignores acts that did not land badly', async () => {
    const m = await load();
    speak(-100, NOW - 300, '在的喵', 'replied', 5003);
    speak(-100, NOW - 200, '哈哈', 'ignored', 5004);
    expect(m.findUnrepairedActs(-100, NOW)).toHaveLength(0);
  });

  it('ignores acts older than the lookback window', async () => {
    const m = await load();
    speak(-100, NOW - 4 * 3600, '很久以前说错的', 'corrected', 5005);
    expect(m.findUnrepairedActs(-100, NOW)).toHaveLength(0);
  });

  it('does nothing when disabled', async () => {
    const m = await load();
    envValues['REPAIR_ENABLED'] = false;
    speak(-100, NOW - 300, '说错的', 'corrected', 5006);
    expect(m.findUnrepairedActs(-100, NOW)).toHaveLength(0);
  });

  it('renders as an opening, never as an instruction to apologise', async () => {
    const m = await load();
    speak(-100, NOW - 600, '你这个问题很蠢', 'corrected', 5007);
    const text = m.renderUnrepairedActs(m.findUnrepairedActs(-100, NOW));
    expect(text).toContain('有件事可能没说好');
    expect(text).toContain('你这个问题很蠢');
    // A person is obliged to notice, not to apologise.
    expect(text).toContain('你自己看');
    expect(text).not.toMatch(/必须|应该道歉|立刻道歉/);
  });

  it('renders nothing when there is nothing to repair', async () => {
    const m = await load();
    expect(m.renderUnrepairedActs([])).toBe('');
  });
});
