import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem, SubagentCallback } from '../../../src/meta/types.js';

const f = vi.hoisted(() => ({
  config: {
    META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true,
    META_SUBAGENT_CHAT_IDS: [42, -100], META_ACTIVATED_AT_SEC: 100,
    MASTER_UID: 42, META_USAGE: 'synthetic', CODEACT_TIMEOUT_MS: 1000,
    DIGEST_PERSIST_ENABLED: true, COGNITIVE_WORKSPACE_V2_ENABLED: false,
    DREAM_JOURNAL_ENABLED: true,
  },
  call: vi.fn(async () => ({ content: '[SESSION_DIGEST]scoped output[/SESSION_DIGEST]' })),
  persist: vi.fn(), add: vi.fn(), recent: vi.fn(), memoryRecent: vi.fn(), api: vi.fn(),
  lpush: vi.fn(async () => 1), engine: vi.fn(),
  journalInfo: null as { chatId: number; link: string } | null,
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => '') }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: f.call }));
vi.mock('../../../src/meta/meta-api.js', () => ({ buildMetaApiContext: f.api }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ addDigest: f.add, recentDigests: f.memoryRecent }) }));
vi.mock('../../../src/meta/session-digest.js', () => ({ persistDigest: f.persist, recentDigests: f.recent }));
vi.mock('../../../src/cron/dream-journal.js', () => ({ getJournalChannelInfo: async () => f.journalInfo }));
vi.mock('../../../src/sandbox/codeact/runner.js', () => ({ executeIsolatedCode: vi.fn() }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ lpush: f.lpush, ltrim: vi.fn() }) }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotIdentity: () => ({ uid: 123 }) }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/context-engine/index.js', () => ({
  getContextEngine: f.engine,
  staticText: (_id: string, text: string) => text,
  deltaText: (_id: string, text: string) => text,
  ephemeralText: (_id: string, text: string) => text,
  volatileText: (_id: string, text: string) => text,
}));
import { runMetaSession } from '../../../src/meta/session.js';

function attention(chatId: number, text: string, createdAt = 101000): AttentionItem {
  return { id: `a${chatId}`, chatId, layer: 'L1', pressure: 70, reason: 'synthetic_question', textPreview: text, messageId: 7, createdAt };
}
function callback(chatId: number, summary: string, createdAt = 101000): SubagentCallback {
  return { id: `c${chatId}`, taskId: `t${chatId}`, chatId, summary, createdAt, ok: false };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.config.META_SUBAGENT_ENABLED = true;
  f.config.DIGEST_PERSIST_ENABLED = true;
  f.journalInfo = null;
  f.api.mockReturnValue({ journal: {}, dispatch: {} });
  f.recent.mockImplementation((_limit, opts) => [{ createdAt: 100, text: `digest-${opts.sourceChatId}` }]);
  f.memoryRecent.mockImplementation((_limit, opts) => [{ at: 100000, text: `memory-${opts.sourceChatId}` }]);
  f.engine.mockReturnValue({ assemble: async (parts: string[]) => ({ prompt: parts.join('\n'), manifest: { cacheHitRatio: 0, totalChars: 100 } }) });
});

describe('Meta session source partition and activation', () => {
  it('never puts private and group attention/callbacks in the same model context', async () => {
    const result = await runMetaSession([attention(42, 'PRIVATE_MARKER'), attention(-100, 'GROUP_MARKER')], [callback(42, 'PRIVATE_CALLBACK'), callback(-100, 'GROUP_CALLBACK')]);
    expect(f.call).toHaveBeenCalledTimes(2);
    const prompts = f.call.mock.calls.map((args) => (args as unknown as [{ messages: Array<{ content: string }> }])[0].messages[0]!.content);
    expect(prompts[0]).toContain('PRIVATE_MARKER');
    expect(prompts[0]).toContain('PRIVATE_CALLBACK');
    expect(prompts[0]).toContain('digest-42');
    expect(prompts[0]).not.toContain('GROUP_MARKER');
    expect(prompts[0]).not.toContain('GROUP_CALLBACK');
    expect(prompts[1]).toContain('GROUP_MARKER');
    expect(prompts[1]).not.toContain('PRIVATE_MARKER');
    expect(prompts[1]).not.toContain('PRIVATE_CALLBACK');
    expect(f.api.mock.calls.map(([opts]) => opts.scopeChatId)).toEqual([42, -100]);
    expect(f.engine.mock.calls.map(([name]) => name)).toEqual(['meta:42', 'meta:-100']);
    expect(f.persist).toHaveBeenCalledWith({ kind: 'meta', text: 'scoped output', sourceChatId: 42 });
    expect(f.persist).toHaveBeenCalledWith({ kind: 'meta', text: 'scoped output', sourceChatId: -100 });
    expect(f.lpush.mock.calls.map((args) => JSON.parse((args as unknown as [string, string])[1]).sourceChatId)).toEqual([42, -100]);
    expect(result.digest).toBe('scoped_sessions:2');
  });
  it('filters old/disabled/out-of-scope events before diary interception or any read', async () => {
    await runMetaSession([attention(42, '写日记', 99000), attention(43, '写日记')], [callback(42, 'PRIVATE_OLD', 99000)]);
    expect(f.api).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
    expect(f.recent).not.toHaveBeenCalled();
    f.config.META_SUBAGENT_ENABLED = false;
    await runMetaSession([attention(42, '写日记')], []);
    expect(f.api).not.toHaveBeenCalled();
  });
  it('scopes the in-memory fallback and callbacks-only persisted digest', async () => {
    f.config.DIGEST_PERSIST_ENABLED = false;
    await runMetaSession([attention(-100, 'hello')], []);
    expect(f.memoryRecent).toHaveBeenCalledWith(6, { sourceChatId: -100 });
    f.call.mockClear();
    await runMetaSession([], [{ ...callback(42, 'done'), ok: true }]);
    expect(f.call).not.toHaveBeenCalled();
    expect(f.add).toHaveBeenLastCalledWith('done', 42);
    expect(f.persist).toHaveBeenLastCalledWith({ kind: 'meta', text: 'done', sourceChatId: 42 });
  });
  it('does not expose a different diary channel link to this scope', async () => {
    f.journalInfo = { chatId: 42, link: 'https://t.me/private_diary_marker' };
    await runMetaSession([attention(-100, 'hello')], []);
    expect(JSON.stringify(f.call.mock.calls)).not.toContain('private_diary_marker');
  });
  it('acknowledges a diary write without inventing a publication receipt', async () => {
    const dispatch = vi.fn(async () => ({ taskId: 'synthetic-ack' }));
    f.api.mockReturnValue({ journal: { tryWrite: vi.fn(async () => ({ wrote: true, snippet: 'same-source snippet' })) }, dispatch: { taskToGroup: dispatch } });
    await runMetaSession([attention(42, '写日记')], []);
    expect(dispatch).toHaveBeenCalledOnce();
    const args = dispatch.mock.calls[0] as unknown as [number, { contentDirection: string }];
    expect(args[1].contentDirection).toContain('same-source snippet');
    expect(args[1].contentDirection).toContain('写入回执不等于已发布');
    expect(args[1].contentDirection).not.toContain('https://');
    expect(f.call).not.toHaveBeenCalled();
  });
});
