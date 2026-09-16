import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';

const {
  envState,
  createAgencyEnvelope,
  createAgencyRun,
  dispatchAgencyRun,
  createCodeActAgencyActAdapters,
} = vi.hoisted(() => ({
  envState: {
    AGENCY_RUNTIME_MODE: 'shadow' as string,
    AGENCY_CODEACT_TRANSPORT_ENABLED: false,
  } as Record<string, unknown>,
  createAgencyEnvelope: vi.fn(),
  createAgencyRun: vi.fn(),
  dispatchAgencyRun: vi.fn(),
  createCodeActAgencyActAdapters: vi.fn(),
}));

vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/agent/agency-runtime.js', () => ({
  createAgencyEnvelope,
  createAgencyRun,
  dispatchAgencyRun,
}));
vi.mock('../../../src/agent/agency-act-adapter.js', () => ({ createCodeActAgencyActAdapters }));

import { dispatchCodeActTaskViaAgency } from '../../../src/agent/agency-codeact-dispatch.js';

const task: DispatchTask = {
  id: 'task-authority-1',
  chatId: -100,
  contentDirection: '处理这个任务',
  createdAt: Date.now(),
  status: 'queued',
};

beforeEach(() => {
  envState.AGENCY_RUNTIME_MODE = 'shadow';
  envState.AGENCY_CODEACT_TRANSPORT_ENABLED = false;
  createAgencyEnvelope.mockReset();
  createAgencyRun.mockReset();
  dispatchAgencyRun.mockReset();
  createCodeActAgencyActAdapters.mockReset();
  createCodeActAgencyActAdapters.mockReturnValue({ act: vi.fn() });
});

describe('Agency CodeAct transport bridge', () => {
  it('does not touch Agency or queue bindings when disabled', async () => {
    await expect(dispatchCodeActTaskViaAgency(task)).resolves.toMatchObject({
      attempted: false,
      accepted: false,
      reason: 'agency_codeact_transport_disabled',
    });
    expect(createAgencyEnvelope).not.toHaveBeenCalled();
    expect(createCodeActAgencyActAdapters).not.toHaveBeenCalled();
  });

  it('requires explicit authority and accepts only the requested durable task id', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_CODEACT_TRANSPORT_ENABLED = true;
    const envelope = { id: 'run-1', action: { type: 'act' } };
    const pending = { id: 'run-1', status: 'pending', result: null };
    const succeeded = { id: 'run-1', status: 'succeeded', result: { taskId: task.id, acceptedAt: Date.now() } };
    createAgencyEnvelope.mockReturnValue({ ok: true, envelope });
    createAgencyRun.mockReturnValue({ ok: true, run: pending });
    dispatchAgencyRun.mockResolvedValue({ ok: true, run: succeeded });

    await expect(dispatchCodeActTaskViaAgency(task)).resolves.toMatchObject({
      attempted: true,
      accepted: true,
      agencyRunId: 'run-1',
      taskId: task.id,
    });
    expect(createAgencyEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ type: 'act', taskId: task.id }),
      scope: { visibility: 'task', chatId: task.chatId, taskId: task.id },
      budget: { maxMs: 30_000, maxLlmCalls: 0, maxToolCalls: 1 },
    }));
    expect(dispatchAgencyRun).toHaveBeenCalledWith('run-1', { act: expect.any(Function) });
  });

  it('uses the durable task anchor as causation when provided', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_CODEACT_TRANSPORT_ENABLED = true;
    const anchoredTask = { ...task, cognitiveAnchorEventId: 'cog-event-3' };
    createAgencyEnvelope.mockReturnValue({ ok: true, envelope: { id: 'run-anchor' } });
    createAgencyRun.mockReturnValue({ ok: true, run: { id: 'run-anchor', status: 'pending', result: null } });
    dispatchAgencyRun.mockResolvedValue({
      ok: true,
      run: { id: 'run-anchor', status: 'succeeded', result: { taskId: task.id, acceptedAt: Date.now() } },
    });

    await expect(dispatchCodeActTaskViaAgency(anchoredTask)).resolves.toMatchObject({
      accepted: true,
      taskId: task.id,
    });
    expect(createAgencyEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      causationId: 'cog-event-3',
    }));
  });

  it('fails closed when the host receipt names another task or the run is rejected', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_CODEACT_TRANSPORT_ENABLED = true;
    createAgencyEnvelope.mockReturnValue({ ok: true, envelope: { id: 'run-2' } });
    createAgencyRun.mockReturnValue({ ok: true, run: { id: 'run-2', status: 'pending', result: null } });
    dispatchAgencyRun.mockResolvedValue({
      ok: false,
      run: { id: 'run-2', status: 'succeeded', result: { taskId: 'other-task', acceptedAt: Date.now() } },
      reason: 'receipt mismatch',
    });

    await expect(dispatchCodeActTaskViaAgency(task)).resolves.toMatchObject({
      attempted: true,
      accepted: false,
      agencyRunId: 'run-2',
      reason: 'agency_task_id_mismatch',
    });
  });

  it('rejects malformed scoped tasks before creating a run', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_CODEACT_TRANSPORT_ENABLED = true;
    await expect(dispatchCodeActTaskViaAgency({ ...task, chatId: 0 })).resolves.toMatchObject({
      attempted: true,
      accepted: false,
      reason: 'scoped_chat_required',
    });
    expect(createAgencyEnvelope).not.toHaveBeenCalled();
  });
});
