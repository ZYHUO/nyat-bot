import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import type { WebSearchOutcome } from '../../../src/pipeline/tools/search.js';

let db: Database.Database;
const { callMock, sendMock, searchMock, activationMock, config } = vi.hoisted(() => ({
  callMock: vi.fn(), sendMock: vi.fn(), searchMock: vi.fn(), activationMock: vi.fn(),
  config: { TASK_EXECUTOR_ENABLED: true, TASK_MAX_ROUNDS: 1, PROACTIVE_ACTIVATED_AT_SEC: 0 },
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: callMock }));
vi.mock('../../../src/pipeline/tools/search.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/pipeline/tools/search.js')>(),
  executeSearchDetailed: searchMock,
}));
vi.mock('../../../src/cron/activation-policy.js', () => ({ checkProactiveActivation: activationMock }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: sendMock }));

import { executeTask } from '../../../src/queue/task-worker.js';
import { createTask, getTask } from '../../../src/agent/task-store.js';
import { getTaskEvidence } from '../../../src/agent/task-evidence-store.js';

const CHAT_ID = 6251541967;
const SUMMARY = '东京今日有雨，22-28度，出门带伞。';
function ok(snippet = '东京天气下雨，26度。'): WebSearchOutcome {
  return { status: 'ok', provider: 'DDG-Lite',
    results: [{ title: '天气预报', snippet, url: 'https://example.org/weather' }],
    attempts: [{ provider: 'DDG-Lite', status: 'success' }] };
}
const EMPTY: WebSearchOutcome = { status: 'empty', provider: 'DDG-Lite', results: [],
  attempts: [{ provider: 'DDG-Lite', status: 'empty' }] };
const UNAVAILABLE: WebSearchOutcome = { status: 'unavailable', provider: null, results: [],
  attempts: [{ provider: 'DDG-Lite', status: 'failed', code: 'blocked', httpStatus: 202 }] };
function makeTask(maxRounds = 1) {
  return createTask({ ownerUid: CHAT_ID, chatId: CHAT_ID, goal: '东京今日天气', maxRounds });
}
function fakeJob(taskId: number) {
  return { data: { type: 'task_execute', taskId, chatId: CHAT_ID, ownerUid: CHAT_ID } } as never;
}
function evidence(id: number) { return getTaskEvidence('research:' + id, CHAT_ID); }

beforeEach(() => {
  db = new Database(':memory:');
  for (const file of readdirSync('migrations').sort()) {
    if (file.endsWith('.sql')) db.exec(readFileSync('migrations/' + file, 'utf8'));
  }
  vi.resetAllMocks();
  config.TASK_EXECUTOR_ENABLED = true;
  config.PROACTIVE_ACTIVATED_AT_SEC = 0;
  searchMock.mockResolvedValue(ok());
  callMock.mockResolvedValue({ content: SUMMARY });
  sendMock.mockResolvedValue(101);
  activationMock.mockResolvedValue({ allowed: true });
});
afterEach(() => db.close());

describe('task-worker source evidence and delivery', () => {
  it('summarizes sources, with delivery unverified rather than factually verified', async () => {
    const id = makeTask();
    expect(await executeTask(fakeJob(id))).toBe(SUMMARY);
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(callMock.mock.calls[0]?.[0]).toMatchObject({ usage: 'summarize' });
    expect(JSON.stringify(callMock.mock.calls[0])).toContain('https://example.org/weather');
    expect(sendMock).toHaveBeenCalledWith(CHAT_ID, expect.stringContaining('未独立核验'));
    expect(getTask(id)?.state).toBe('done');
    expect(evidence(id)).toMatchObject({ lifecycle: 'done', assessment: 'unverified',
      reasons: ['delivered_synthesized'], totalCalls: 2, failedCalls: 0 });
  });

  it.each(['error', 'empty'])('falls back to source text on synthesis %s', async (failure) => {
    if (failure === 'error') callMock.mockRejectedValue(new Error('provider down'));
    else callMock.mockResolvedValue({ content: ' ' });
    const id = makeTask();
    const out = await executeTask(fakeJob(id));
    expect(out).toContain('东京天气下雨');
    expect(out).toContain('https://example.org/weather');
    expect(evidence(id)).toMatchObject({ assessment: 'unverified', failedCalls: 1,
      reasons: ['delivered_raw_fallback'] });
  });

  it('does not synthesize genuinely empty queries and reports their limited meaning', async () => {
    searchMock.mockResolvedValue(EMPTY);
    const id = makeTask();
    expect(await executeTask(fakeJob(id))).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith(CHAT_ID, expect.stringContaining('没有返回匹配结果'));
    expect(sendMock).toHaveBeenCalledWith(CHAT_ID, expect.stringContaining('不代表相关信息不存在'));
    expect(getTask(id)?.state).toBe('done');
    expect(evidence(id)).toMatchObject({ lifecycle: 'done', assessment: 'unverified',
      reasons: ['delivered_empty', 'search_empty'] });
  });

  it('treats unavailable search as failure, even with stray answer/results', async () => {
    searchMock.mockResolvedValue({ ...UNAVAILABLE, answer: 'fake provider answer', results: ok().results });
    const id = makeTask();
    expect(await executeTask(fakeJob(id))).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
    expect(getTask(id)?.state).toBe('pending');
    expect(evidence(id)).toMatchObject({ lifecycle: 'pending', assessment: 'failed',
      reasons: ['search_unavailable'], failedCalls: 1 });
    expect(sendMock).toHaveBeenCalledWith(CHAT_ID, expect.stringContaining('搜索服务当前不可用'));
    expect(JSON.stringify(sendMock.mock.calls)).not.toContain('没有返回匹配结果');
    expect(JSON.stringify(sendMock.mock.calls)).not.toContain('fake provider answer');
  });

  it('requires sources even for an ok status', async () => {
    searchMock.mockResolvedValue({ ...ok(), results: [], answer: 'unsourced assertion' });
    const id = makeTask();
    await executeTask(fakeJob(id));
    expect(callMock).not.toHaveBeenCalled();
    expect(evidence(id)?.reasons).toEqual(['search_unavailable']);
  });

  it('does not convert mixed empty/unavailable queries to a completed empty search', async () => {
    searchMock.mockResolvedValueOnce(EMPTY).mockResolvedValueOnce(UNAVAILABLE);
    const id = makeTask(2);
    await executeTask(fakeJob(id));
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(callMock).not.toHaveBeenCalled();
    expect(evidence(id)?.reasons).toEqual(['search_unavailable']);
  });

  it.each([UNAVAILABLE, EMPTY])('only summarizes successful rounds and labels partial research ($status)', async (other) => {
    searchMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(other);
    const id = makeTask(2);
    const out = await executeTask(fakeJob(id));
    const prompt = JSON.stringify(callMock.mock.calls[0]);
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(prompt).toContain('东京天气下雨');
    expect(prompt).not.toContain('搜索不可用');
    expect(prompt).not.toContain('未返回匹配结果');
    expect(prompt).not.toContain('blocked');
    expect(out).toContain('部分检索未获得可用资料');
    expect(sendMock).toHaveBeenCalledWith(CHAT_ID, expect.stringContaining('部分检索未获得可用资料'));
    expect(evidence(id)?.assessment).toBe('unverified');
    expect(evidence(id)?.reasons).toContain('partial_search');
  });

  it('also labels an ok round that follows a failed provider fallback', async () => {
    searchMock.mockResolvedValue({ ...ok(), attempts: [
      { provider: 'SearxNG', status: 'failed', code: 'timeout' }, ...ok().attempts,
    ] });
    const id = makeTask();
    expect(await executeTask(fakeJob(id))).toContain('部分检索未获得可用资料');
    expect(evidence(id)?.reasons).toContain('partial_search');
  });

  it('writes completion/evidence only after a positive Telegram receipt', async () => {
    const id = makeTask();
    sendMock.mockImplementationOnce(async () => {
      expect(getTask(id)?.state).toBe('running');
      expect(evidence(id)).toBeNull();
      return 102;
    });
    await executeTask(fakeJob(id));
    expect(getTask(id)?.state).toBe('done');
    expect(evidence(id)?.lifecycle).toBe('done');
  });

  it.each([0, -1, undefined])('does not claim delivery for sender return %s', async (receipt) => {
    sendMock.mockResolvedValue(receipt);
    const id = makeTask();
    expect(await executeTask(fakeJob(id))).toBeNull();
    expect(getTask(id)?.state).toBe('pending');
    expect(evidence(id)).toMatchObject({ lifecycle: 'pending', assessment: 'failed', reasons: ['delivery_not_confirmed'] });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('does not claim delivery or send again immediately after a send throws', async () => {
    sendMock.mockRejectedValue(new Error('Telegram transport timeout'));
    const id = makeTask();
    expect(await executeTask(fakeJob(id))).toBeNull();
    expect(evidence(id)).toMatchObject({ assessment: 'failed', lifecycle: 'pending', reasons: ['delivery_failed'] });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('also requires delivery before completing an empty-result notice', async () => {
    searchMock.mockResolvedValue(EMPTY);
    sendMock.mockResolvedValue(-1);
    const id = makeTask();
    await executeTask(fakeJob(id));
    expect(getTask(id)?.state).toBe('pending');
    expect(evidence(id)?.reasons).toEqual(['delivery_not_confirmed']);
  });

  it('does not treat an exhausted previous run as a new empty query', async () => {
    const id = makeTask();
    db.prepare('UPDATE tasks SET search_round = max_rounds WHERE id = ?').run(id);
    await executeTask(fakeJob(id));
    expect(searchMock).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalled();
    expect(evidence(id)?.reasons).toEqual(['search_budget_exhausted']);
    expect(getTask(id)?.state).not.toBe('done');
  });

  it('keeps the executor disabled for an old queued job', async () => {
    const id = makeTask();
    config.TASK_EXECUTOR_ENABLED = false;
    expect(await executeTask(fakeJob(id))).toBeNull();
    expect(searchMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(getTask(id)?.state).toBe('pending');
  });

  it('rechecks activation after searches before sending', async () => {
    activationMock.mockResolvedValueOnce({ allowed: true }).mockResolvedValue({ allowed: false });
    const id = makeTask();
    await executeTask(fakeJob(id));
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect(evidence(id)?.reasons).toEqual(['activation_changed']);
  });
});
