import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import type { WebSearchOutcome } from '../../../src/pipeline/tools/search.js';
import type { DeliveryResult } from '../../../src/shared/delivery-result.js';

let db: Database.Database;
const { callMock, sendMock, searchMock, activationMock, config } = vi.hoisted(() => ({
  callMock: vi.fn(), sendMock: vi.fn(), searchMock: vi.fn(), activationMock: vi.fn(),
  config: { TASK_EXECUTOR_ENABLED: true, TASK_MAX_ROUNDS: 1, PROACTIVE_ACTIVATED_AT_SEC: 0,
    BOT_TOKEN: '123:synthetic-test', COGNITIVE_EVENTS_ENABLED: false },
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: callMock }));
vi.mock('../../../src/pipeline/tools/search.js', async (original) => ({
  ...await original<typeof import('../../../src/pipeline/tools/search.js')>(), executeSearchDetailed: searchMock,
}));
vi.mock('../../../src/cron/activation-policy.js', () => ({ checkProactiveActivation: activationMock }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessageDetailed: sendMock }));

import { executeTask } from '../../../src/queue/task-worker.js';
import { createTask, getTask, cancelTask, listResearchSteps } from '../../../src/agent/task-store.js';
import { getTaskEvidence } from '../../../src/agent/task-evidence-store.js';

const CHAT_ID = 6251541967;
const SUMMARY = '东京今日有雨，22-28度，出门带伞。';
function ok(snippet = '东京天气下雨，26度。'): WebSearchOutcome {
  return { status: 'ok', provider: 'DDG-Lite', results: [{ title: '天气预报', snippet, url: 'https://example.org/weather' }],
    attempts: [{ provider: 'DDG-Lite', status: 'success' }] };
}
const EMPTY: WebSearchOutcome = { status: 'empty', provider: 'DDG-Lite', results: [], attempts: [{ provider: 'DDG-Lite', status: 'empty' }] };
const UNAVAILABLE: WebSearchOutcome = { status: 'unavailable', provider: null, results: [], attempts: [{ provider: 'DDG-Lite', status: 'failed', code: 'blocked' }] };
function makeTask(maxRounds = 1) { return createTask({ ownerUid: CHAT_ID, chatId: CHAT_ID, goal: '东京今日天气', maxRounds }); }
function fakeJob(taskId: number, overrides = {}) {
  return { data: { type: 'task_execute', taskId, chatId: CHAT_ID, ownerUid: CHAT_ID,
    wakeGeneration: getTask(taskId)!.wake_generation, ...overrides } } as never;
}
function evidence(id: number) { return getTaskEvidence('research:' + id, CHAT_ID); }
function receipt(status: DeliveryResult['status'], parts = status === 'sent' ? [{ messageId: 101, text: SUMMARY, partIndex: 0 }] : []): DeliveryResult {
  return { status, chatId: CHAT_ID, intentId: 'research:1', revision: 0, parts, plannedPartCount: 1 };
}
function due(id: number) { vi.setSystemTime((getTask(id)!.next_wake! + 1) * 1000); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

beforeEach(() => {
  db = new Database(':memory:');
  for (const file of readdirSync('migrations').sort()) if (file.endsWith('.sql')) db.exec(readFileSync('migrations/' + file, 'utf8'));
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
  Object.assign(config, { TASK_EXECUTOR_ENABLED: true, PROACTIVE_ACTIVATED_AT_SEC: 0, BOT_TOKEN: '123:synthetic-test' });
  searchMock.mockResolvedValue(ok());
  callMock.mockResolvedValue({ content: SUMMARY });
  sendMock.mockImplementation(async (_chat, _text, _reply, _thread, identity) => ({ ...receipt('sent'), intentId: identity.intentId, revision: identity.revision }));
  activationMock.mockResolvedValue({ allowed: true });
});
afterEach(() => { vi.useRealTimers(); db.close(); });

describe('durable research through the real Agency adapter', () => {
  it('persists search, synthesis and confirmed completion without claiming verification', async () => {
    const id = makeTask();
    expect(await executeTask(fakeJob(id))).toBe(SUMMARY);
    expect(JSON.stringify(callMock.mock.calls[0])).toContain('https://example.org/weather');
    expect(sendMock.mock.calls[0]?.[1]).toContain('未独立核验');
    expect(listResearchSteps(id).map(s => s.key)).toEqual(['search:1', 'summary']);
    expect(getTask(id)).toMatchObject({ state: 'done', delivery_state: 'sent', search_round: 1 });
    expect(evidence(id)).toMatchObject({ lifecycle: 'done', assessment: 'unverified', reasons: ['delivered_synthesized'] });
    expect(db.prepare('SELECT status FROM agency_runs').get()).toMatchObject({ status: 'succeeded' });
    expect(db.prepare('SELECT COUNT(*) n FROM execution_receipts').get()).toMatchObject({ n: 1 });
  });
  it('records real empty results with limited meaning, without synthesizing invented facts', async () => {
    searchMock.mockResolvedValue(EMPTY);
    const id = makeTask();
    expect(await executeTask(fakeJob(id))).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
    expect(sendMock.mock.calls[0]?.[1]).toContain('不代表相关信息不存在');
    expect(evidence(id)?.reasons).toContain('search_empty');
  });
  it.each([UNAVAILABLE, { ...ok(), results: [], answer: 'unsupported claim' }])('does not consume a round for unavailable or source-less search', async outcome => {
    searchMock.mockResolvedValueOnce(outcome);
    const id = makeTask();
    await executeTask(fakeJob(id));
    expect(getTask(id)).toMatchObject({ state: 'pending', search_round: 0 });
    expect(listResearchSteps(id)).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
    due(id);
    await executeTask(fakeJob(id));
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(getTask(id)?.state).toBe('done');
  });
  it('retains successful search across a restart/retry and executes only the unfinished round', async () => {
    searchMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(UNAVAILABLE).mockResolvedValue(ok());
    const id = makeTask(2);
    await executeTask(fakeJob(id));
    expect(getTask(id)?.search_round).toBe(1);
    expect(listResearchSteps(id)).toHaveLength(1);
    due(id);
    await executeTask(fakeJob(id));
    expect(searchMock).toHaveBeenCalledTimes(3);
    expect(searchMock.mock.calls[1]?.[0]).toBe(searchMock.mock.calls[2]?.[0]);
    expect(searchMock.mock.calls.filter(call => call[0] === '东京今日天气')).toHaveLength(1);
    expect(getTask(id)?.state).toBe('done');
  });
  it.each(['error', 'empty'])('retries synthesis %s without re-running saved searches', async failure => {
    if (failure === 'error') callMock.mockRejectedValueOnce(new Error('provider unavailable'));
    else callMock.mockResolvedValueOnce({ content: '' });
    const id = makeTask();
    await executeTask(fakeJob(id));
    expect(evidence(id)?.reasons).toEqual(['synthesis_unavailable']);
    expect(sendMock).not.toHaveBeenCalled();
    due(id);
    await executeTask(fakeJob(id));
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledTimes(2);
    expect(getTask(id)?.state).toBe('done');
  });
  it('retries only delivery after explicit non-delivery', async () => {
    sendMock.mockResolvedValueOnce(receipt('failed'));
    const id = makeTask();
    await executeTask(fakeJob(id));
    expect(getTask(id)?.state).toBe('pending');
    const firstBody = sendMock.mock.calls[0]?.[1];
    due(id);
    await executeTask(fakeJob(id));
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1]?.[1]).toBe(firstBody);
    expect(getTask(id)?.state).toBe('done');
  });
  it.each(['unknown', 'throw', 'partial'] as const)('holds %s delivery without replay, retaining ACK parts', async kind => {
    if (kind === 'throw') sendMock.mockRejectedValueOnce(new Error('timeout'));
    else if (kind === 'partial') sendMock.mockResolvedValueOnce(receipt('failed', [{ messageId: 77, text: '第一段', partIndex: 0 }]));
    else sendMock.mockResolvedValueOnce(receipt('unknown'));
    const id = makeTask();
    await executeTask(fakeJob(id));
    expect(getTask(id)).toMatchObject({ state: 'blocked', delivery_state: 'unknown', next_wake: null });
    await executeTask(fakeJob(id));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(getTask(id)?.state).not.toBe('done');
    if (kind === 'partial') expect(JSON.parse(getTask(id)!.delivery_receipt!).parts[0].messageId).toBe(77);
  });
  it('cancels during search, retains terminal cancellation and permits a new task', async () => {
    const search = deferred<WebSearchOutcome>();
    searchMock.mockReturnValueOnce(search.promise);
    const id = makeTask(), running = executeTask(fakeJob(id));
    await vi.waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    cancelTask(id);
    search.resolve(ok());
    await running;
    expect(getTask(id)?.state).toBe('cancelled');
    expect(listResearchSteps(id)).toEqual([]);
    expect(callMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    const next = makeTask();
    await executeTask(fakeJob(next));
    expect(getTask(next)?.state).toBe('done');
    expect(getTask(id)?.state).toBe('cancelled');
  });
  it('cancels during synthesis and fences sender retry/part callbacks', async () => {
    const model = deferred<{ content: string }>();
    callMock.mockReturnValueOnce(model.promise);
    const id = makeTask(), running = executeTask(fakeJob(id));
    await vi.waitFor(() => expect(callMock).toHaveBeenCalledTimes(1));
    cancelTask(id);
    model.resolve({ content: SUMMARY });
    await running;
    expect(sendMock).not.toHaveBeenCalled();
    expect(getTask(id)?.state).toBe('cancelled');
  });
  it('rechecks cancellation at the actual send callback and cannot overwrite cancelled with failed', async () => {
    const id = makeTask();
    sendMock.mockImplementationOnce(async (_chat, _text, _reply, _thread, identity) => {
      cancelTask(id);
      expect(() => identity.beforeSend()).toThrow('execution_superseded');
      return receipt('failed');
    });
    await executeTask(fakeJob(id));
    expect(getTask(id)?.state).toBe('cancelled');
    expect(evidence(id)).toBeNull();
  });
  it('records an already-started ACK when cancellation races it without completing cancelled', async () => {
    const id = makeTask();
    sendMock.mockImplementationOnce(async () => { cancelTask(id); return receipt('sent'); });
    await executeTask(fakeJob(id));
    expect(getTask(id)).toMatchObject({ state: 'cancelled', delivery_state: 'sent' });
    expect(evidence(id)).toBeNull();
  });
  it('rejects queued cancellation, forged owner/chat, stale generation and switched account', async () => {
    const id = makeTask();
    await executeTask(fakeJob(id, { ownerUid: 111 }));
    await executeTask(fakeJob(id, { chatId: 222 }));
    await executeTask(fakeJob(id, { wakeGeneration: 99 }));
    config.BOT_TOKEN = '456:synthetic-test';
    await executeTask(fakeJob(id));
    config.BOT_TOKEN = '123:synthetic-test';
    cancelTask(id);
    await executeTask(fakeJob(id));
    expect(searchMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
  it('allows exactly one concurrent database owner for duplicate queue jobs', async () => {
    const search = deferred<WebSearchOutcome>();
    searchMock.mockReturnValueOnce(search.promise);
    const id = makeTask(), job = fakeJob(id);
    const a = executeTask(job), b = executeTask(job);
    await vi.waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    search.resolve(ok());
    await Promise.all([a, b]);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) n FROM agency_runs').get()).toMatchObject({ n: 1 });
  });
  it('labels partial provider fallback while keeping real source evidence', async () => {
    searchMock.mockResolvedValue({ ...ok(), attempts: [{ provider: 'SearxNG', status: 'failed', code: 'timeout' }, ...ok().attempts] });
    const id = makeTask();
    expect(await executeTask(fakeJob(id))).toContain('部分检索未获得可用资料');
    expect(evidence(id)?.reasons).toContain('partial_search');
  });
  it('holds old truncated-ledger rounds instead of inventing resumable evidence', async () => {
    const id = makeTask();
    db.prepare('UPDATE tasks SET search_round = max_rounds WHERE id = ?').run(id);
    await executeTask(fakeJob(id));
    expect(searchMock).not.toHaveBeenCalled();
    expect(getTask(id)?.state).toBe('blocked');
    expect(evidence(id)?.reasons).toEqual(['legacy_results_unavailable']);
  });
  it('rechecks activation after slow stages without sending', async () => {
    activationMock.mockResolvedValueOnce({ allowed: true }).mockResolvedValue({ allowed: false });
    const id = makeTask();
    await executeTask(fakeJob(id));
    expect(sendMock).not.toHaveBeenCalled();
    expect(getTask(id)?.state).toBe('blocked');
    expect(evidence(id)?.reasons).toEqual(['activation_changed']);
  });
  it('does nothing when execution is disabled', async () => {
    const id = makeTask();
    config.TASK_EXECUTOR_ENABLED = false;
    await executeTask(fakeJob(id));
    expect(searchMock).not.toHaveBeenCalled();
    expect(getTask(id)?.state).toBe('pending');
  });
});
