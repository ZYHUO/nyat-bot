import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises the self-act outcome loop against a real in-memory SQLite loaded
// with the real migration, rather than a hand-rolled mock: the queries here are
// the whole point of the feature, so mocking them would test nothing.

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = { SELF_HISTORY_ENABLED: true };
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

const CHAT = -100;

/** Minimal base table; migration 0112 adds bot_message_id/outcome/outcome_at. */
function baseSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE self_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      trigger_uid INTEGER NOT NULL,
      trigger_msg_id INTEGER,
      reply_text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
}

beforeEach(() => {
  db = new Database(':memory:');
  baseSchema(db);
  db.exec(readFileSync('migrations/0112_self_reply_outcomes.sql', 'utf8'));
  envValues['SELF_HISTORY_ENABLED'] = true;
});

const importModule = async () =>
  await import('../../../src/tracking/self-history.js');

describe('self-act history (behaviour the model can see)', () => {
  it('maps every existing reply-outcome signal onto an act outcome', async () => {
    const m = await importModule();
    expect(m.actOutcomeFromSignal('user_replied')).toBe('replied');
    expect(m.actOutcomeFromSignal('user_mentioned_bot')).toBe('mentioned');
    expect(m.actOutcomeFromSignal('explicit_positive')).toBe('reacted');
    expect(m.actOutcomeFromSignal('explicit_negative')).toBe('corrected');
    expect(m.actOutcomeFromSignal('repair_loop')).toBe('corrected');
    expect(m.actOutcomeFromSignal('ignored_5_msgs')).toBe('ignored');
    expect(m.actOutcomeFromSignal('something_new')).toBe('unknown');
  });

  it('records a sent message with its id and closes its outcome', async () => {
    const m = await importModule();
    m.recordSelfReply(CHAT, 1001, 5, '签到成功喵', 900);
    expect(db.prepare('SELECT outcome FROM self_replies').get()).toMatchObject({ outcome: 'unknown' });

    expect(m.closeSelfActOutcome({ chatId: CHAT, botMessageId: 900, outcome: 'ignored' })).toBe(true);
    expect(db.prepare('SELECT outcome FROM self_replies').get()).toMatchObject({ outcome: 'ignored' });
  });

  it('attributes outcomes by message id, not by recency', async () => {
    const m = await importModule();
    // Three bubbles went out in one turn; the middle one got replied to.
    m.recordSelfReply(CHAT, 1001, 5, '第一句', 901);
    m.recordSelfReply(CHAT, 1001, 5, '第二句', 902);
    m.recordSelfReply(CHAT, 1001, 5, '第三句', 903);

    expect(m.closeSelfActOutcome({ chatId: CHAT, botMessageId: 902, outcome: 'replied' })).toBe(true);

    const rows = db.prepare('SELECT bot_message_id, outcome FROM self_replies ORDER BY bot_message_id').all();
    expect(rows).toEqual([
      { bot_message_id: 901, outcome: 'unknown' },
      { bot_message_id: 902, outcome: 'replied' },
      { bot_message_id: 903, outcome: 'unknown' },
    ]);
  });

  it('does not re-close an already-closed act', async () => {
    const m = await importModule();
    m.recordSelfReply(CHAT, 1001, 5, '一句话', 910);
    expect(m.closeSelfActOutcome({ chatId: CHAT, botMessageId: 910, outcome: 'replied' })).toBe(true);
    // A later, weaker signal must not overwrite the first observation.
    expect(m.closeSelfActOutcome({ chatId: CHAT, botMessageId: 910, outcome: 'ignored' })).toBe(false);
    expect(db.prepare('SELECT outcome FROM self_replies').get()).toMatchObject({ outcome: 'replied' });
  });

  it('rejects unknown outcomes and unusable ids', async () => {
    const m = await importModule();
    m.recordSelfReply(CHAT, 1001, 5, 'x', 920);
    expect(m.closeSelfActOutcome({ chatId: CHAT, botMessageId: 920, outcome: 'unknown' })).toBe(false);
    expect(m.closeSelfActOutcome({ chatId: CHAT, botMessageId: 0, outcome: 'ignored' })).toBe(false);
    expect(m.closeSelfActOutcome({ chatId: 0, botMessageId: 920, outcome: 'ignored' })).toBe(false);
  });

  it('does not leak outcomes across chats', async () => {
    const m = await importModule();
    m.recordSelfReply(-100, 1001, 5, 'A群的话', 930);
    m.recordSelfReply(-200, 1001, 6, 'B群的话', 931);
    expect(m.closeSelfActOutcome({ chatId: -200, botMessageId: 930, outcome: 'ignored' })).toBe(false);
    const rows = db.prepare('SELECT chat_id, outcome FROM self_replies ORDER BY chat_id').all();
    expect(rows).toEqual([
      { chat_id: -200, outcome: 'unknown' },
      { chat_id: -100, outcome: 'unknown' },
    ]);
  });

  it('summarises recent behaviour as counts plus concrete lines', async () => {
    const m = await importModule();
    const now = Math.floor(Date.now() / 1000);
    m.recordSelfReply(CHAT, 1001, 1, '第一句', 1001);
    m.recordSelfReply(CHAT, 1001, 2, '第二句', 1002);
    m.recordSelfReply(CHAT, 1001, 3, '第三句', 1003);
    db.prepare('UPDATE self_replies SET ts = ? WHERE bot_message_id = 1001').run(now - 600);
    db.prepare('UPDATE self_replies SET ts = ? WHERE bot_message_id = 1002').run(now - 300);
    db.prepare('UPDATE self_replies SET ts = ? WHERE bot_message_id = 1003').run(now - 60);
    m.closeSelfActOutcome({ chatId: CHAT, botMessageId: 1001, outcome: 'ignored' });
    m.closeSelfActOutcome({ chatId: CHAT, botMessageId: 1002, outcome: 'replied' });

    const summary = m.getSelfActSummary(CHAT, 45 * 60);
    expect(summary).not.toBeNull();
    expect(summary?.total).toBe(3);
    expect(summary?.byOutcome).toMatchObject({ ignored: 1, replied: 1, unknown: 1 });
    expect(summary?.recent[0]?.text).toBe('第三句');

    const rendered = m.renderSelfActSummary(summary);
    expect(rendered).toContain('你在这个群说了 3 次');
    expect(rendered).toContain('有人回 1');
    expect(rendered).toContain('没人接 1');
    // Concrete lines so the model can recognise its own repetition.
    expect(rendered).toContain('第三句');
  });

  it('renders nothing when there is no behaviour to report', async () => {
    const m = await importModule();
    expect(m.renderSelfActSummary(m.getSelfActSummary(CHAT, 3600))).toBe('');
    expect(m.renderSelfActSummary(null)).toBe('');
  });

  it('excludes acts older than the window', async () => {
    const m = await importModule();
    const now = Math.floor(Date.now() / 1000);
    m.recordSelfReply(CHAT, 1001, 1, '很久以前', 1001);
    db.prepare('UPDATE self_replies SET ts = ? WHERE bot_message_id = 1001').run(now - 3 * 3600);
    m.recordSelfReply(CHAT, 1001, 2, '刚才', 1002);
    db.prepare('UPDATE self_replies SET ts = ? WHERE bot_message_id = 1002').run(now - 60);

    const summary = m.getSelfActSummary(CHAT, 45 * 60);
    expect(summary?.total).toBe(1);
    expect(summary?.recent[0]?.text).toBe('刚才');
  });

  it('reports nothing when the feature is off', async () => {
    const m = await importModule();
    m.recordSelfReply(CHAT, 1001, 1, 'x', 1001);
    envValues['SELF_HISTORY_ENABLED'] = false;
    expect(m.getSelfActSummary(CHAT, 3600)).toBeNull();
    expect(m.closeSelfActOutcome({ chatId: CHAT, botMessageId: 1001, outcome: 'ignored' })).toBe(false);
    expect(m.renderSelfActSummary(null)).toBe('');
  });
});
