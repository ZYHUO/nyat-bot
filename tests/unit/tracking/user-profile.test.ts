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
  env: () => ({ PROFILE_SYNC_BATCH_SIZE: 20 }),
}));

const {
  recordUserMessage,
  getUserProfilePrompt,
  getProfileSections,
  buildProfileInjection,
  runUserProfileSync,
  muteUser,
  getBotTagForAddressing,
  setBotTag,
  clearBotTag,
  _flushAllBuffers,
} = await import('../../../src/tracking/user-profile.js');

function initSchema(db: Database.Database): void {
  const migrations = [
    'migrations/0005_user_profiles.sql',
    'migrations/0007_user_preferences.sql',
    'migrations/0008_mute_dedup.sql',
    'migrations/0011_mute_expires.sql',
    'migrations/0025_profile_sections.sql',
    'migrations/0046_bot_tag.sql',
  ];
  for (const migration of migrations) {
    db.exec(readFileSync(resolve(process.cwd(), migration), 'utf-8'));
  }
}

// The 8-section JSON contract the prompt now asks the model to emit (G: +topics).
function sectionJson(over: Record<string, string[]> = {}): string {
  return JSON.stringify({
    identity: [],
    relationships: [],
    stable_facts: [],
    interaction_prefs: [],
    topics: [],
    recent: [],
    uncertain: [],
    maintenance: [],
    ...over,
  });
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

  it('upserts sections, derives legacy profile_prompt, and clears pending after threshold', async () => {
    for (let i = 1; i <= 8; i++) {
      recordUserMessage(-1001, 42, 'alice', 'Alice', 'curious', `msg-${i}`);
    }
    _flushAllBuffers();
    mockCallWithFallback.mockResolvedValue({
      content: sectionJson({
        identity: ['学生'],
        interaction_prefs: ['喜欢提问', '表达直接'],
        recent: ['在准备考试'],
        uncertain: ['可能住在北京'],
      }),
    });

    await runUserProfileSync();

    // Sections upserted, one row per non-empty section (empties skipped).
    const sections = getProfileSections(-1001, 42);
    const names = sections.map((s) => s.section_name);
    expect(names).toEqual(['identity', 'interaction_prefs', 'recent', 'uncertain']);
    expect(sections.find((s) => s.section_name === 'interaction_prefs')?.bullets)
      .toEqual(['喜欢提问', '表达直接']);

    // Legacy single prompt derived from key sections (identity/stable_facts/interaction_prefs/recent).
    const legacy = getUserProfilePrompt(-1001, 42);
    expect(legacy).toContain('学生');
    expect(legacy).toContain('喜欢提问');
    expect(legacy).toContain('在准备考试');
    // 'uncertain' is not part of the legacy derivation.
    expect(legacy).not.toContain('可能住在北京');

    const row = testDb
      .prepare('SELECT pending_messages FROM user_profiles WHERE chat_id = ? AND uid = ?')
      .get(-1001, 42) as { pending_messages: string };
    expect(row.pending_messages).toBe('[]');
  });

  it('G: parses and stores the topics section', async () => {
    for (let i = 1; i <= 8; i++) {
      recordUserMessage(-1001, 42, 'alice', 'Alice', 'curious', `msg-${i}`);
    }
    _flushAllBuffers();
    mockCallWithFallback.mockResolvedValue({
      content: sectionJson({
        identity: ['学生'],
        topics: ['VPS', '显卡', '二次元'],
      }),
    });

    await runUserProfileSync();

    const sections = getProfileSections(-1001, 42);
    const topics = sections.find((s) => s.section_name === 'topics');
    expect(topics?.bullets).toEqual(['VPS', '显卡', '二次元']);
  });

  it('upsert is idempotent on (chat_id, uid, section_name) across syncs', async () => {
    for (let i = 1; i <= 8; i++) {
      recordUserMessage(-1001, 42, 'alice', 'Alice', undefined, `a-${i}`);
    }
    _flushAllBuffers();
    mockCallWithFallback.mockResolvedValue({
      content: sectionJson({ identity: ['学生'] }),
    });
    await runUserProfileSync();

    for (let i = 1; i <= 8; i++) {
      recordUserMessage(-1001, 42, 'alice', 'Alice', undefined, `b-${i}`);
    }
    _flushAllBuffers();
    mockCallWithFallback.mockResolvedValue({
      content: sectionJson({ identity: ['研究生'] }),
    });
    await runUserProfileSync();

    const rows = testDb
      .prepare("SELECT bullets FROM user_profile_sections WHERE chat_id = ? AND uid = ? AND section_name = 'identity'")
      .all(-1001, 42) as Array<{ bullets: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.bullets)).toEqual(['研究生']);
  });

  it('buildProfileInjection caps recent to 2 bullets and drops uncertain when others exist', async () => {
    for (let i = 1; i <= 8; i++) {
      recordUserMessage(-1001, 42, 'alice', 'Alice', undefined, `msg-${i}`);
    }
    _flushAllBuffers();
    mockCallWithFallback.mockResolvedValue({
      content: sectionJson({
        identity: ['学生'],
        recent: ['事件一', '事件二', '事件三'],
        uncertain: ['也许喜欢猫'],
      }),
    });
    await runUserProfileSync();

    const block = buildProfileInjection(-1001, 42);
    expect(block).not.toBeNull();
    expect(block).toContain('身份: 学生');
    // recent capped to 2
    expect(block).toContain('事件一');
    expect(block).toContain('事件二');
    expect(block).not.toContain('事件三');
    // uncertain dropped because other sections have content
    expect(block).not.toContain('也许喜欢猫');
  });

  it('buildProfileInjection keeps uncertain when it is the only populated section', async () => {
    for (let i = 1; i <= 8; i++) {
      recordUserMessage(-1001, 7, 'bob', 'Bob', undefined, `m-${i}`);
    }
    _flushAllBuffers();
    mockCallWithFallback.mockResolvedValue({
      content: sectionJson({ uncertain: ['可能是新人'] }),
    });
    await runUserProfileSync();

    const block = buildProfileInjection(-1001, 7);
    expect(block).not.toBeNull();
    expect(block).toContain('可能是新人');
  });

  it('returns null injection and no sections when nothing was summarized', () => {
    expect(getProfileSections(-1001, 999)).toEqual([]);
    expect(buildProfileInjection(-1001, 999)).toBeNull();
  });

  it('tolerates code-fenced JSON output from the model', async () => {
    for (let i = 1; i <= 8; i++) {
      recordUserMessage(-1001, 88, 'carol', 'Carol', undefined, `c-${i}`);
    }
    _flushAllBuffers();
    mockCallWithFallback.mockResolvedValue({
      content: '```json\n' + sectionJson({ stable_facts: ['爱好摄影'] }) + '\n```',
    });
    await runUserProfileSync();

    const sections = getProfileSections(-1001, 88);
    expect(sections).toEqual([{ section_name: 'stable_facts', bullets: ['爱好摄影'] }]);
  });

  it('uses a conservative prompt that forbids over-inference and asks for 8-section JSON', async () => {
    for (let i = 1; i <= 8; i++) {
      recordUserMessage(-1001, 42, 'alice', 'Alice', '威严满满', `msg-${i}`);
    }
    _flushAllBuffers();
    mockCallWithFallback.mockResolvedValue({
      content: sectionJson({ interaction_prefs: ['表达直接', '偏理性'] }),
    });

    await runUserProfileSync();

    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    const args = mockCallWithFallback.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(args.messages[0]?.content).toContain('证据不足时只做保守描述');
    expect(args.messages[0]?.content).toContain('不要从用户名、昵称或 Tag 过度推断人格');
    // New output contract: 8 named JSON sections (G added 'topics').
    expect(args.messages[0]?.content).toContain('identity');
    expect(args.messages[0]?.content).toContain('uncertain');
    expect(args.messages[0]?.content).toContain('topics');
    expect(args.messages[0]?.content).toContain('只输出 JSON 对象');
    expect(args.messages[1]?.content).toContain('用户标签(Tag): 威严满满');
    expect(args.messages[1]?.content).toContain('最新发言(8条)');
  });
});

describe('bot_tag — bot 对用户本人的称呼(per-chat, DM 默认回退)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
    mockCallWithFallback.mockReset();
  });
  afterEach(() => { testDb.close(); });

  it('setBotTag 在已存在行上设值,getBotTagForAddressing 读回', () => {
    recordUserMessage(-1001, 42, 'alice', 'Alice', null, 'hi');
    _flushAllBuffers();
    setBotTag(-1001, 42, '猫哥');
    expect(getBotTagForAddressing(-1001, 42)).toBe('猫哥');
  });

  it('setBotTag 在无行时 upsert 建行(不抛错)', () => {
    setBotTag(999, 888, '阿强');
    expect(getBotTagForAddressing(999, 888)).toBe('阿强');
  });

  it('群行无 bot_tag → 回退 DM 默认行 (uid,uid) 的 bot_tag', () => {
    // DM 里设的称呼(chat_id=uid)作跨群默认
    setBotTag(777, 777, '猫哥');
    // 群行存在但没 bot_tag
    recordUserMessage(-1001, 777, 'u', 'U', null, 'msg');
    _flushAllBuffers();
    expect(getBotTagForAddressing(-1001, 777)).toBe('猫哥');
  });

  it('群行有 bot_tag → 优先于 DM 默认行', () => {
    setBotTag(777, 777, '猫哥'); // DM 默认
    setBotTag(-1001, 777, '群里的猫哥'); // 群行覆盖
    expect(getBotTagForAddressing(-1001, 777)).toBe('群里的猫哥');
  });

  it('都没有 bot_tag → null', () => {
    recordUserMessage(-1001, 42, 'alice', 'Alice', '群外号', 'hi');
    _flushAllBuffers();
    expect(getBotTagForAddressing(-1001, 42)).toBeNull();
  });

  it('clearBotTag 清掉群行 bot_tag → 回退到 DM 默认', () => {
    setBotTag(777, 777, '猫哥');
    setBotTag(-1001, 777, '群里的猫哥');
    clearBotTag(-1001, 777);
    expect(getBotTagForAddressing(-1001, 777)).toBe('猫哥');
  });

  it('setBotTag 截 32 字 + trim', () => {
    const long = '  猫'.repeat(40);
    setBotTag(1, 1, long);
    const got = getBotTagForAddressing(1, 1)!;
    expect(got.length).toBeLessThanOrEqual(32);
    expect(got.startsWith('猫')).toBe(true);
  });
});
