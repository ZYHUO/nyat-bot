import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  classifyCommandSafety, upsertCommandObservation, getCommandProfile,
  whyNotInvocable, MATURITY_MIN_OBSERVATIONS,
} = await import('../../../src/learners/bot-command-store.js');

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE bot_command_profiles (
      bot_username TEXT NOT NULL, command_name TEXT NOT NULL,
      usage_syntax TEXT NOT NULL DEFAULT '', use_scenario TEXT NOT NULL DEFAULT '',
      needs_reply INTEGER NOT NULL DEFAULT 0, needs_admin INTEGER NOT NULL DEFAULT 1,
      output_type TEXT NOT NULL DEFAULT 'unknown', peer_accepts_bot INTEGER,
      confidence REAL NOT NULL DEFAULT 0.3, observation_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'learning', last_learned_ts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bot_username, command_name));
  `);
});
afterEach(() => testDb.close());

describe('classifyCommandSafety', () => {
  it('管理/财务类 → blocked', () => {
    for (const c of ['/ban', '/unban', '/kick', '/invite', '/take', '/pay', '/transfer', '/createlottery', '/pin']) {
      expect(classifyCommandSafety(c), c).toBe('blocked');
    }
  });
  it('关键词命中 → blocked(即使命令名没列举)', () => {
    expect(classifyCommandSafety('/banuser')).toBe('blocked');
    expect(classifyCommandSafety('/mywallet')).toBe('blocked');
  });
  it('只读查询 → candidate', () => {
    for (const c of ['/geo', '/stock', '/music', '/price', '/listlottery']) {
      // 注意 /listlottery 含 lottery 关键词 → 实际 blocked,验证关键词优先
      const v = classifyCommandSafety(c);
      if (c === '/listlottery') expect(v).toBe('blocked');
      else expect(v, c).toBe('candidate');
    }
  });
});

describe('upsertCommandObservation + 成熟度', () => {
  it('首次插入只读命令 → learning,observation=1,needs_admin 保守=1', () => {
    upsertCommandObservation({ botUsername: 'uzumaru_geoip_bot', command: '/geo', usageSyntax: '/geo <IP>', useScenario: '查IP', outputType: 'text' });
    const p = getCommandProfile('uzumaru_geoip_bot', '/geo')!;
    expect(p.status).toBe('learning');
    expect(p.observation_count).toBe(1);
    expect(p.needs_admin).toBe(1); // 默认保守(没学到不需要)
    expect(whyNotInvocable(p)).toBe('needs_admin');
  });

  it('学到 needs_admin=false 后,够次数+置信 → ready 且可代发', () => {
    for (let i = 0; i < MATURITY_MIN_OBSERVATIONS + 1; i++) {
      upsertCommandObservation({ botUsername: 'geo', command: '/geo', outputType: 'text', needsAdmin: false, peerAcceptsBot: true });
    }
    const p = getCommandProfile('geo', '/geo')!;
    expect(p.needs_admin).toBe(0);
    expect(p.status).toBe('ready');
    expect(whyNotInvocable(p)).toBeNull();
  });

  it('管理类命令即使观察很多也永远 blocked / 不可代发', () => {
    for (let i = 0; i < 10; i++) upsertCommandObservation({ botUsername: 'paimeng_ban_bot', command: '/ban', needsAdmin: false, outputType: 'text' });
    const p = getCommandProfile('paimeng_ban_bot', '/ban')!;
    expect(p.status).toBe('blocked');
    expect(whyNotInvocable(p)).toBe('blocked_by_safety');
  });

  it('needs_reply=1(需回复某条消息)→ 不可代发(review #2)', () => {
    for (let i = 0; i < 5; i++) upsertCommandObservation({ botUsername: 'rb', command: '/q', needsAdmin: false, outputType: 'text', needsReply: true });
    expect(whyNotInvocable(getCommandProfile('rb', '/q'))).toBe('needs_reply');
  });

  it('callback 回执(数据在按钮后)→ 不可代发', () => {
    for (let i = 0; i < 5; i++) upsertCommandObservation({ botUsername: 'b', command: '/q', needsAdmin: false, outputType: 'callback' });
    expect(whyNotInvocable(getCommandProfile('b', '/q'))).toBe('output_unreachable');
  });

  it('对方不理 bot(peer_accepts_bot=0)→ 不可代发', () => {
    for (let i = 0; i < 5; i++) upsertCommandObservation({ botUsername: 'b2', command: '/q', needsAdmin: false, outputType: 'text', peerAcceptsBot: false });
    expect(whyNotInvocable(getCommandProfile('b2', '/q'))).toBe('peer_ignores_bots');
  });

  it('needs_admin 不会无故从 0 收紧回 1', () => {
    upsertCommandObservation({ botUsername: 'b3', command: '/x', needsAdmin: false });
    upsertCommandObservation({ botUsername: 'b3', command: '/x' }); // 没带 needsAdmin
    expect(getCommandProfile('b3', '/x')!.needs_admin).toBe(0);
  });
});
