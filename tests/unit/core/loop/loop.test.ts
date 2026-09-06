import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
const envStore: Record<string, unknown> = {
  CORE_BELIEF_VIEW_ENABLED: false,
  CORE_BLACKBOARD_ENABLED: false,
  CORE_PERMISSION_GATE_ENABLED: false,
  CORE_V2_ENABLED: true,
  CORE_V2_CHAT_IDS: '',
  BELIEF_VIEW_INJECT_MAX: 4,
  BELIEF_TTL_DEFAULT_SEC: 7776000,
  JUDGE_KNOWLEDGE_ENABLED: false,
  JUDGE_KNOWLEDGE_PERMANENT: true,
  JUDGE_KNOWLEDGE_GROUP: true,
};

vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/env.js', () => ({ env: () => envStore }));
vi.mock('../../../../src/bot/bot.js', () => ({
  getBotUid: () => 999,
  getBotIdentity: () => ({ uid: 999, username: 'nyatbot', displayName: 'nyat', nicknames: ['nyat'] }),
}));
vi.mock('../../../../src/tracking/activity.js', () => ({
  getActivitySummary: async () => ({ messages5min: 0, messages1hour: 0 }),
}));
vi.mock('../../../../src/knowledge/manager.js', () => ({ getKnowledge: () => '' }));
vi.mock('../../../../src/pipeline/judge/judge.js', () => ({
  l0Rule: vi.fn(),
}));
vi.mock('../../../../src/pipeline/judge/micro.js', () => ({
  microJudge: vi.fn(),
}));
vi.mock('../../../../src/pipeline/context/manager.js', () => ({
  getRecent: async () => [],
}));

import { classifyLevel } from '../../../../src/core/loop.js';
import { assembleState } from '../../../../src/core/state.js';
import { assembleSystemPrompt } from '../../../../src/core/prompt/system.js';
import { l0Rule } from '../../../../src/pipeline/judge/judge.js';
import { microJudge } from '../../../../src/pipeline/judge/micro.js';

function msg(text: string, extra: Record<string, unknown> = {}) {
  return {
    role: 'user' as const,
    uid: 1001,
    username: 'alice',
    fullName: 'Alice',
    timestamp: 1700000000,
    messageId: 1,
    textContent: text,
    isForwarded: false,
    ...extra,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0083_core_belief_view.sql', 'utf8'));
  db.exec(readFileSync('migrations/0084_core_blackboard.sql', 'utf8'));
  vi.mocked(l0Rule).mockReset();
  vi.mocked(microJudge).mockReset();
  envStore['CORE_BELIEF_VIEW_ENABLED'] = false;
  envStore['CORE_V2_CHAT_IDS'] = '';
});

describe('core loop classifyLevel', () => {
  it('L0 命中 → l0-pass（不用想）', () => {
    expect(
      classifyLevel(
        { action: 'REPLY', level: 'L0_RULE', latencyMs: 0 },
        { mentioned: false, repliedToBot: false },
      ),
    ).toBe('l0-pass');
  });

  it('L0 未命中 + 被@/回复 → l2-upgrade 候选', () => {
    expect(classifyLevel(null, { mentioned: true, repliedToBot: false })).toBe('l2-upgrade');
    expect(classifyLevel(null, { mentioned: false, repliedToBot: true })).toBe('l2-upgrade');
  });

  it('L0 未命中 + 普通消息 → l1-converse', () => {
    expect(classifyLevel(null, { mentioned: false, repliedToBot: false })).toBe('l1-converse');
  });
});

describe('core runCoreTick', () => {
  it('L0 命中 → 回 L0 判决，不烧 L1', async () => {
    vi.mocked(l0Rule).mockReturnValue({ action: 'IGNORE', level: 'L0_RULE', latencyMs: 0 });
    const { runCoreTick } = await import('../../../../src/core/loop.js');
    const r = await runCoreTick({ chatId: -100, message: msg('hi'), recentMessages: [] });
    expect(r.level).toBe('l0-pass');
    expect(r.judgeResult?.action).toBe('IGNORE');
    expect(vi.mocked(microJudge)).not.toHaveBeenCalled();
  });

  it('L0 未命中 → L1 会话，proposal 上黑板', async () => {
    vi.mocked(l0Rule).mockReturnValue(null);
    vi.mocked(microJudge).mockResolvedValue({
      action: 'REPLY',
      level: 'L1_MICRO',
      confidence: 0.9,
      latencyMs: 100,
    });
    const { runCoreTick } = await import('../../../../src/core/loop.js');
    const r = await runCoreTick({ chatId: -100, message: msg('今天天气不错'), recentMessages: [] });
    expect(r.level).toBe('l1-converse');
    expect(r.judgeResult?.action).toBe('REPLY');
    const n = (
      db.prepare(`SELECT COUNT(*) c FROM core_blackboard WHERE kind='proposal'`).get() as {
        c: number;
      }
    ).c;
    expect(n).toBe(1);
  });

  it('L1 失败 → legacy fallback（不拦旧链路）', async () => {
    vi.mocked(l0Rule).mockReturnValue(null);
    vi.mocked(microJudge).mockRejectedValue(new Error('llm down'));
    const { runCoreTick } = await import('../../../../src/core/loop.js');
    const r = await runCoreTick({ chatId: -100, message: msg('hi'), recentMessages: [] });
    expect(r.fallbackToLegacy).toBe(true);
  });

  it('l2-upgrade：REPLY proposal 自动 promote → L2 dry-run 有一条 readonly（Phase 6）', async () => {
    vi.mocked(l0Rule).mockReturnValue(null);
    vi.mocked(microJudge).mockResolvedValue({
      action: 'REPLY',
      level: 'L1_MICRO',
      confidence: 0.9,
      latencyMs: 100,
    });
    const { runCoreTick } = await import('../../../../src/core/loop.js');
    const r = await runCoreTick({
      chatId: -100,
      message: msg('@nyatbot 帮我查一下这个', { replyTo: undefined }),
      recentMessages: [],
    });
    expect(r.level).toBe('l2-upgrade');
    expect(r.judgeResult?.action).toBe('REPLY');
    // Phase 6：REPLY proposal 带 tool 意图 → 自动 promote → dry-run 一条 readonly
    expect(r.l2DryRun).toEqual([{ tool: 'chats.recentMessages', tier: 'readonly', approved: true }]);
  });

  it('l2-upgrade：IGNORE proposal 无 tool → 不 promote，dry-run 空', async () => {
    vi.mocked(l0Rule).mockReturnValue(null);
    vi.mocked(microJudge).mockResolvedValue({
      action: 'IGNORE',
      level: 'L1_MICRO',
      confidence: 0.9,
      latencyMs: 100,
    });
    const { runCoreTick } = await import('../../../../src/core/loop.js');
    // @bot 点名（mock bot username=nyatbot）→ l2-upgrade；判 IGNORE → proposal 无 tool → promote 不转
    const r = await runCoreTick({
      chatId: -100,
      message: msg('@nyatbot 别理我', { replyTo: undefined }),
      recentMessages: [],
    });
    expect(r.level).toBe('l2-upgrade');
    expect(r.l2DryRun).toEqual([]);
  });
});

describe('core assembleState + system prompt', () => {
  it('空库 → beliefs 空，prompt 只有 identity', async () => {
    envStore['CORE_BELIEF_VIEW_ENABLED'] = true;
    const st = await assembleState(-100, msg('hi'), []);
    expect(st.beliefs).toEqual([]);
    const p = assembleSystemPrompt(st);
    expect(p.beliefCount).toBe(0);
    expect(p.system).toContain('nyat-bot');
    expect(p.system).not.toContain('[当前信念]');
  });

  it('isCoreChat: 空名单 → 全量 true；总开关可一刀切', async () => {
    const { isCoreChat } = await import('../../../../src/core/loop.js');
    envStore['CORE_V2_ENABLED'] = true;
    expect(isCoreChat(-100)).toBe(true);
    expect(isCoreChat(-999)).toBe(true);
    envStore['CORE_V2_CHAT_IDS'] = '-100,-200';
    expect(isCoreChat(-100)).toBe(true);
    expect(isCoreChat(-300)).toBe(false);
    envStore['CORE_V2_ENABLED'] = false;
    expect(isCoreChat(-100)).toBe(false);
    envStore['CORE_V2_ENABLED'] = true;
    envStore['CORE_V2_CHAT_IDS'] = '';
  });
});
