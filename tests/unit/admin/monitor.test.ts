import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCognitiveRouteWindow = vi.hoisted(() => vi.fn());
const listAgencyRunSummaries = vi.hoisted(() => vi.fn());
const getTaskRecoverySummary = vi.hoisted(() => vi.fn());
const listSkillRevisionVerificationSummaries = vi.hoisted(() => vi.fn());

vi.mock('../../../src/agent/cognitive-route-observations.js', () => ({
  getCognitiveRouteWindow,
}));
vi.mock('../../../src/agent/agency-runtime.js', () => ({
  listAgencyRunSummaries,
}));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({
  getTaskRecoverySummary,
}));
vi.mock('../../../src/core/skills/revisions.js', () => ({
  listSkillRevisionVerificationSummaries,
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async () => []),
}));

import { createMonitorApi } from '../../../src/admin/monitor.js';

function createApi() {
  return createMonitorApi({
    redis: {} as never,
    bot: { api: {} } as never,
    env: { MONITOR_TOKEN: 'monitor-secret' } as never,
  });
}

async function request(path: string): Promise<Response> {
  return createApi().request(`http://localhost${path}`);
}

describe('monitor route observations endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCognitiveRouteWindow.mockReturnValue([
      {
        chatId: -100,
        route: 'deep',
        samples: 2,
        behaviorApplied: 1,
        completed: 2,
        classified: 0,
        sent: 2,
        silent: 0,
        failed: 0,
        interrupted: 0,
        blocked: 0,
        meanLatencyMs: 120,
        meanToolCalls: 1,
        meanReplyCount: 1,
        feedbackPositive: 1,
        feedbackNegative: 0,
        feedbackRate: 0.5,
        positiveFeedbackRate: 1,
      },
    ]);
    listAgencyRunSummaries.mockReturnValue([
      {
        id: 'run-1',
        correlationId: 'meta:chat:-100:message:7:dispatch',
        causationId: 'telegram:-100:message:7',
        scopeKey: 'chat:-100',
        visibility: 'chat',
        chatId: -100,
        userId: null,
        taskId: 'task-1',
        actionType: 'observe',
        actionTarget: 'meta:dispatch.taskToGroup',
        risk: 'read',
        idempotencyKey: 'meta-dispatch:-100:7:L0',
        status: 'waiting',
        attempt: 0,
        maxMs: 1000,
        maxLlmCalls: 0,
        maxToolCalls: 0,
        error: 'policy:shadow_only',
        createdAt: 100,
        updatedAt: 100,
        startedAt: null,
        finishedAt: null,
      },
    ]);
    getTaskRecoverySummary.mockReturnValue({
      taskId: 'task-1',
      chatId: -100,
      lifecycle: 'done',
      terminal: true,
      assessment: 'verified',
      verified: true,
      recoveryReason: 'completed_verified',
      checkpointAvailable: true,
      eventCount: 8,
      lastEventKind: 'task_completed',
      lastEventAt: 200,
      lastSegment: 1,
      lastTurn: 4,
      segments: 2,
      modelTurnsStarted: 4,
      modelTurnsFinished: 4,
      toolCallsStarted: 2,
      toolCallsFinished: 2,
      toolFailures: 0,
      interruptions: 1,
      clarifications: 1,
      cognitiveAnchorEventId: 'telegram-event-7',
      reasons: ['caller_checks_passed'],
      totalCalls: 2,
      failedCalls: 0,
      retryCount: 0,
      evidenceUpdatedAt: 200,
      stateConflict: false,
    });
    listSkillRevisionVerificationSummaries.mockReturnValue([
      {
        revisionId: 4,
        lifecycleId: 2,
        name: '核验资料',
        version: 1,
        scopeKey: 'global',
        status: 'verified',
        verifier: 'host_static_v1',
        verificationStatus: 'passed',
        checkNames: ['proposal_body', 'required_fields', 'redline_scan', 'published_name_unique'],
        checkCount: 4,
        failedCheckCount: 0,
        createdAt: 100,
        updatedAt: 200,
      },
    ]);
  });

  it('requires the monitor token', async () => {
    const missing = await request('/route-observations');
    expect(missing.status).toBe(401);

    const wrong = await request('/route-observations?token=wrong');
    expect(wrong.status).toBe(401);
    expect(getCognitiveRouteWindow).not.toHaveBeenCalled();
  });

  it('returns bounded aggregate rows for valid filters', async () => {
    const response = await request('/route-observations?token=monitor-secret&chat_id=-100&since=100&limit=500');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      rows: expect.arrayContaining([expect.objectContaining({ route: 'deep', samples: 2 })]),
    });
    expect(getCognitiveRouteWindow).toHaveBeenCalledWith({ chatId: -100, since: 100, limit: 200 });
  });

  it.each([
    ['chat_id=0', 'invalid chat_id'],
    ['chat_id=abc', 'invalid chat_id'],
    ['since=0', 'invalid since'],
    ['since=abc', 'invalid since'],
    ['limit=0', 'invalid limit'],
    ['limit=abc', 'invalid limit'],
  ])('rejects malformed %s', async (query, error) => {
    const response = await request(`/route-observations?token=monitor-secret&${query}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error });
    expect(getCognitiveRouteWindow).not.toHaveBeenCalled();
  });

  it('returns redacted Agency lifecycle summaries with bounded filters', async () => {
    const response = await request('/agency-runs?token=monitor-secret&chat_id=-100&since=100&status=waiting&limit=500');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      rows: [expect.objectContaining({
        id: 'run-1',
        actionType: 'observe',
        actionTarget: 'meta:dispatch.taskToGroup',
      })],
    });
    expect(listAgencyRunSummaries).toHaveBeenCalledWith({
      chatId: -100,
      since: 100,
      status: 'waiting',
      limit: 200,
    });
  });

  it.each([
    ['status=unknown', 'invalid status'],
    ['status=', 'invalid status'],
    ['chat_id=0', 'invalid chat_id'],
    ['since=0', 'invalid since'],
    ['limit=0', 'invalid limit'],
  ])('rejects malformed Agency filter %s', async (query, error) => {
    const response = await request(`/agency-runs?token=monitor-secret&${query}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error });
    expect(listAgencyRunSummaries).not.toHaveBeenCalled();
  });

  it('returns a replayable task recovery summary without task content', async () => {
    const response = await request('/task-recovery?token=monitor-secret&task_id=task-1&chat_id=-100');
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; summary: Record<string, unknown> };
    expect(body).toEqual({
      ok: true,
      summary: expect.objectContaining({
        taskId: 'task-1',
        lifecycle: 'done',
        assessment: 'verified',
        verified: true,
        recoveryReason: 'completed_verified',
      }),
    });
    expect(body.summary).not.toHaveProperty('contentDirection');
    expect(body.summary).not.toHaveProperty('resultSummary');
    expect(body.summary).not.toHaveProperty('resolution');
    expect(getTaskRecoverySummary).toHaveBeenCalledWith('task-1', -100);
  });

  it.each([
    ['task_id=', 'invalid task_id'],
    [`task_id=${'x'.repeat(121)}`, 'invalid task_id'],
    ['task_id=task-1&chat_id=0', 'invalid chat_id'],
    ['task_id=task-1&chat_id=abc', 'invalid chat_id'],
  ])('rejects malformed task recovery filter %s', async (query, error) => {
    const response = await request(`/task-recovery?token=monitor-secret&${query}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error });
    expect(getTaskRecoverySummary).not.toHaveBeenCalled();
  });

  it('returns not found when durable recovery metadata is absent', async () => {
    getTaskRecoverySummary.mockReturnValueOnce(null);
    const response = await request('/task-recovery?token=monitor-secret&task_id=missing');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'task_recovery_not_found' });
  });

  it('returns redacted skill verification summaries with bounded filters', async () => {
    const response = await request('/skill-verifications?token=monitor-secret&status=verified&since=100&limit=500');
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; rows: Array<Record<string, unknown>> };
    expect(body).toEqual({
      ok: true,
      rows: [expect.objectContaining({
        revisionId: 4,
        status: 'verified',
        verifier: 'host_static_v1',
        verificationStatus: 'passed',
        failedCheckCount: 0,
      })],
    });
    expect(body.rows[0]).not.toHaveProperty('artifact');
    expect(body.rows[0]).not.toHaveProperty('rollbackReason');
    expect(body.rows[0]).not.toHaveProperty('reason');
    expect(listSkillRevisionVerificationSummaries).toHaveBeenCalledWith({ status: 'verified', since: 100, limit: 200 });
  });

  it.each([
    ['status=unknown', 'invalid status'],
    ['status=', 'invalid status'],
    ['since=0', 'invalid since'],
    ['since=abc', 'invalid since'],
    ['limit=0', 'invalid limit'],
    ['limit=abc', 'invalid limit'],
  ])('rejects malformed skill verification filter %s', async (query, error) => {
    const response = await request(`/skill-verifications?token=monitor-secret&${query}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error });
    expect(listSkillRevisionVerificationSummaries).not.toHaveBeenCalled();
  });
});
