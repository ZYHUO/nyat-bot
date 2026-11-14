import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';
import type { AgentCheckpoint } from '../../../src/agent/checkpoint.js';

const fixture = vi.hoisted(() => ({ getDb: vi.fn(), get: vi.fn(), set: vi.fn(), llm: vi.fn(), token: '12345:test-only' }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: fixture.getDb }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ get: fixture.get, set: fixture.set }) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ BOT_TOKEN: fixture.token, AGENT_COMPACT_USAGE: 'summarize' }) }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: fixture.llm }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { checkpointKey, loadCheckpoint, saveCheckpoint } from '../../../src/agent/checkpoint.js';
import { clipHeadTail, compactHistory, restoreMessagesFromCompacted } from '../../../src/agent/compaction.js';
import { getOrCreateConversationId, PLATFORM_INTERNAL_ID_BASE } from '../../../src/platform/identity-store.js';

let db: Database.Database;
const stored = new Map<string, string>();
const task = (chatId = -70001, extra: Partial<DispatchTask> = {}): DispatchTask => ({
  id: 'test-task', chatId, contentDirection: '核对报告，尚未完成前不要发送', createdAt: 1000, status: 'queued', ...extra,
});
const state = () => ({ history: [{ role: 'user' as const, content: '原任务待办' }], progressSummary: '尚未完成', artifacts: [], segment: 1, totalTurns: 20, sendsUsed: 3 });
beforeEach(() => {
  vi.clearAllMocks();
  fixture.token = '12345:test-only';
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0118_platform_identity.sql', 'utf8'));
  fixture.getDb.mockReturnValue(db);
  stored.clear();
  fixture.get.mockImplementation(async (key: string) => stored.get(key) ?? null);
  fixture.set.mockImplementation(async (key: string, value: string) => { stored.set(key, value); return 'OK'; });
  fixture.llm.mockResolvedValue({ content: JSON.stringify({ summary: '本次核对已找到新线索，但报告尚未完成，仍待人工核实确认。' }) });
});
afterEach(() => db.close());

describe('persisted compression provenance', () => {
  it('binds actual QQ account and group, distinct from Telegram with the same native number', async () => {
    const qq = getOrCreateConversationId({ platform: 'qq', accountId: '80001', idNamespace: 'qq-number', conversationKind: 'group', id: '70001' });
    const t = task(qq);
    const key = await saveCheckpoint(t, state());
    expect((await loadCheckpoint(key, t))?.source).toMatchObject({ platform: 'qq', accountId: '80001', chatId: qq });
    expect(await loadCheckpoint(key, task(-70001))).toBeNull();
    const other = getOrCreateConversationId({ platform: 'qq', accountId: '80002', idNamespace: 'qq-number', conversationKind: 'group', id: '70001' });
    expect(await loadCheckpoint(key, task(other))).toBeNull();
  });

  it('rejects wrong task key, topic, account rotation, unscoped legacy and malformed history', async () => {
    const t = task(-100, { messageThreadId: 7 });
    const key = await saveCheckpoint(t, state());
    expect(await loadCheckpoint(key, task(-100))).toBeNull();
    expect(await loadCheckpoint(key, { ...t, id: 'other-task' })).toBeNull();
    expect(await loadCheckpoint(key, t)).not.toBeNull();
    fixture.token = '54321:test-only';
    expect(await loadCheckpoint(key, t)).toBeNull();
    fixture.token = '12345:test-only';
    const original = JSON.parse(stored.get(key)!) as AgentCheckpoint;
    stored.set(key, JSON.stringify({ ...original, source: undefined }));
    expect(await loadCheckpoint(key, t)).toBeNull();
    stored.set(key, JSON.stringify({ ...original, history: [{ role: 'system', content: { secret: 'synthetic' } }] }));
    expect(await loadCheckpoint(key, t)).toBeNull();
  });

  it('unknown QQ identities cannot create a trusted checkpoint; missing and Redis errors differ', async () => {
    await expect(saveCheckpoint(task(-(PLATFORM_INTERNAL_ID_BASE + 999)), state())).rejects.toThrow('checkpoint_scope_unavailable');
    const rejected = vi.fn();
    expect(await loadCheckpoint(checkpointKey('test-task'), task(), rejected)).toBeNull();
    expect(rejected).toHaveBeenLastCalledWith('checkpoint_missing');
    fixture.get.mockRejectedValueOnce(new Error('unavailable'));
    expect(await loadCheckpoint(checkpointKey('test-task'), task(), rejected)).toBeNull();
    expect(rejected).toHaveBeenLastCalledWith('checkpoint_unavailable');
  });

  it('restores current policy and identity, never the stored system prompt', async () => {
    const t = task();
    const key = await saveCheckpoint(t, { ...state(), history: [{ role: 'system', content: 'OLD_OTHER_PLATFORM_POLICY' }, ...state().history] });
    const checkpoint = (await loadCheckpoint(key, t))!;
    const messages = restoreMessagesFromCompacted(checkpoint, 'CURRENT_SCOPED_POLICY');
    expect(messages.filter(m => m.role === 'system')).toEqual([{ role: 'system', content: 'CURRENT_SCOPED_POLICY' }]);
    expect(JSON.stringify(messages)).not.toContain('OLD_OTHER_PLATFORM_POLICY');
    expect(checkpoint.sendsUsed).toBe(3);
  });
});

describe('compaction fidelity and coverage', () => {
  it('keeps exact character ceilings even below the omission-marker length', () => {
    for (const limit of [0, 2, 8, 20]) expect(clipHeadTail('重要背景'.repeat(40) + '最终纠正', limit).length).toBeLessThanOrEqual(limit);
  });
  const tail = (): AgentCheckpoint['history'] => Array.from({ length: 16 }, (_, i) => ({ role: 'assistant', content: `tool result ${i}` }));
  it('latest correction survives a full old summary, long message and tool-only recent tail', async () => {
    const correction = '[任务进行中，有人发来新消息]\n- uid=77 @小明 reply=#18: ' + '背景'.repeat(900) + '纠正：不要发送原图；最后的问题还没回答？';
    const result = await compactHistory({ history: [{ role: 'user', content: correction }, ...tail()], progressSummary: '旧'.repeat(3000), contentDirection: '先核实三个尚未完成的事项' });
    expect(fixture.llm.mock.calls[0]![0].messages[1].content).toContain('最后的问题还没回答？');
    expect(result.summary).toContain('uid=77 @小明 reply=#18');
    expect(result.summary).toContain('不要发送原图');
    expect(result.summary).toContain('本次核对已找到新线索');
    expect(result.summary).toContain('三个尚未完成');
    expect(result.summary.length).toBeLessThan(3400);
  });

  it('does not discard turns omitted by the input budget', async () => {
    const early: AgentCheckpoint['history'] = Array.from({ length: 28 }, (_, i) => ({ role: 'user', content: `turn-${i}:` + '内容'.repeat(500) }));
    const result = await compactHistory({ history: [...early, ...tail()], progressSummary: '', contentDirection: 'review' });
    const input = fixture.llm.mock.calls[0]![0].messages[1].content as string;
    expect(input).not.toContain('turn-27:');
    expect(result.recent.some(m => m.content.startsWith('turn-27:'))).toBe(true);
    for (const m of early) expect(input.includes(m.content) || result.recent.includes(m)).toBe(true);
  });

  it.each(['throw', 'invalid'])('retains every unarchived turn when summarization is %s', async mode => {
    if (mode === 'throw') fixture.llm.mockRejectedValue(new Error('synthetic failure'));
    else fixture.llm.mockResolvedValue({ content: '{"summary":null}' });
    const history: AgentCheckpoint['history'] = [{ role: 'user', content: 'must not disappear' }, ...tail()];
    const result = await compactHistory({ history, progressSummary: 'old', contentDirection: 'unfinished' });
    expect(result.recent).toEqual(history);
    expect(restoreMessagesFromCompacted({ history: result.recent, progressSummary: result.summary }, 'new policy').some(m => m.content === 'must not disappear')).toBe(true);
  });
});
