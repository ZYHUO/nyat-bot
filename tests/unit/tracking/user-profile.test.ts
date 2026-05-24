import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
const mockCallWithFallback = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: Parameters<typeof mockCallWithFallback>) =>
    mockCallWithFallback(...args),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({}),
}));

const {
  recordUserMessage,
  getUserProfilePrompt,
  runUserProfileSync,
  muteUser,
  _flushAllBuffers,
} = await import('../../../src/tracking/user-profile.js');

function initSchema(db: Database.Database): void {
  const migrations = [
    'migrations/0005_user_profiles.sql',
    'migrations/0007_user_preferences.sql',
    'migrations/0008_mute_dedup.sql',
    'migrations/0011_mute_expires.sql',
  ];
  for (const migration of migrations) {
    db.exec(readFileSync(resolve(process.cwd(), migration), 'utf-8'));
  }
}

describe('user-profile', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
    mockCallWithFallback.mockReset();
  });

  afterEach(() => {
    _flushAllBuffers(); // flush any pending write buffers before closing DB
    testDb.close();
  });

  it('appends pending_messages as a valid JSON array across multiple writes', () => {
    recordUserMessage(-1001, 42, 'alice', 'Alice', undefined, 'first');
    recordUserMessage(-1001, 42, 'alice', 'Alice', undefined, 'second');
    _flushAllBuffers();

    const row = testDb
      .prepare('SELECT pending_messages FROM user_profiles WHERE chat_id = ? AND uid = ?')
      .get(-1001, 42) as { pending_messages: string };

    expect(JSON.parse(row.pending_messages)).toEqual(['first', 'second']);
  });

  it('does not summarize when pending sample count is below threshold', async () => {
    recordUserMessage(-1001, 42, 'alice', 'Alice', 'curious', 'first');
    recordUserMessage(-1001, 42, 'alice', 'Alice', 'curious', 'second');
    _flushAllBuffers();

    await runUserProfileSync();

    expect(mockCallWithFallback).not.toHaveBeenCalled();
    expect(getUserProfilePrompt(-1001, 42)).toBeNull();
    const row = testDb
      .prepare('SELECT pending_messages FROM user_profiles WHERE chat_id = ? AND uid = ?')
      .get(-1001, 42) as { pending_messages: string };
    expect(JSON.parse(row.pending_messages)).toEqual(['first', 'second']);
  });

  it('stores temporary mute marker separately from persistent mute', () => {
    const callMuteUser = muteUser as unknown as (
      chatId: number,
      uid: number,
      level: 1 | 2,
      opts?: { temporary?: boolean },
    ) => void;

    callMuteUser(-1001, 42, 1, { temporary: true });

    const row = testDb.prepare(
      'SELECT value, mute_level FROM user_preferences WHERE chat_id = ? AND uid = ? AND pref_key = ?',
    ).get(-1001, 42, 'mute') as { value: string; mute_level: number };

    expect(row).toEqual({ value: 'muted_temp', mute_level: 0 });
  });

  it('updates profile_prompt and clears pending_messages after threshold is reached', async () => {
    for (let i = 1; i <= 8; i++) {
      recordUserMessage(-1001, 42, 'alice', 'Alice', 'curious', `msg-${i}`);
    }
    _flushAllBuffers();
    mockCallWithFallback.mockResolvedValue({ content: '喜欢提问，表达直接。' });

    await runUserProfileSync();

    expect(getUserProfilePrompt(-1001, 42)).toBe('喜欢提问，表达直接。');
    const row = testDb
      .prepare('SELECT pending_messages FROM user_profiles WHERE chat_id = ? AND uid = ?')
      .get(-1001, 42) as { pending_messages: string };
    expect(row.pending_messages).toBe('[]');
  });

  it('uses a conservative prompt that forbids over-inference from sparse evidence or tags', async () => {
    for (let i = 1; i <= 8; i++) {
      recordUserMessage(-1001, 42, 'alice', 'Alice', '威严满满', `msg-${i}`);
    }
    _flushAllBuffers();
    mockCallWithFallback.mockResolvedValue({ content: '表达直接，偏理性。' });

    await runUserProfileSync();

    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    const args = mockCallWithFallback.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(args.messages[0]?.content).toContain('证据不足时只做保守描述');
    expect(args.messages[0]?.content).toContain('不要从用户名、昵称或 Tag 过度推断人格');
    expect(args.messages[1]?.content).toContain('用户标签(Tag): 威严满满');
    expect(args.messages[1]?.content).toContain('最新发言(8条)');
  });
});
