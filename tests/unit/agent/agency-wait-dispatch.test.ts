import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  envState,
  createAgencyEnvelope,
  createAgencyRun,
  dispatchAgencyRun,
  createTimingAgencyWaitAdapters,
} = vi.hoisted(() => ({
  envState: {
    AGENCY_RUNTIME_MODE: 'shadow' as string,
    AGENCY_WAIT_TRANSPORT_ENABLED: false,
  } as Record<string, unknown>,
  createAgencyEnvelope: vi.fn(),
  createAgencyRun: vi.fn(),
  dispatchAgencyRun: vi.fn(),
  createTimingAgencyWaitAdapters: vi.fn(),
}));

vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/agent/agency-runtime.js', () => ({
  createAgencyEnvelope,
  createAgencyRun,
  dispatchAgencyRun,
}));
vi.mock('../../../src/agent/agency-wait-adapter.js', () => ({ createTimingAgencyWaitAdapters }));

import { dispatchWaitViaAgency } from '../../../src/agent/agency-wait-dispatch.js';

const input = {
  chatId: -100,
  triggerMessageId: 42,
  triggerUserId: 7,
  waitSec: 12.8,
  reason: 'heart:等对方说完',
  source: 'heart' as const,
  obligationId: 'obl-1',
};

beforeEach(() => {
  envState.AGENCY_RUNTIME_MODE = 'shadow';
  envState.AGENCY_WAIT_TRANSPORT_ENABLED = false;
  createAgencyEnvelope.mockReset();
  createAgencyRun.mockReset();
  dispatchAgencyRun.mockReset();
  createTimingAgencyWaitAdapters.mockReset();
  createTimingAgencyWaitAdapters.mockReturnValue({ wait: vi.fn() });
});

describe('Agency wait authority transport bridge', () => {
  it('does not touch Agency or timing bindings when disabled', async () => {
    await expect(dispatchWaitViaAgency(input)).resolves.toMatchObject({
      attempted: false,
      accepted: false,
      reason: 'agency_wait_transport_disabled',
    });
    expect(createAgencyEnvelope).not.toHaveBeenCalled();
    expect(createTimingAgencyWaitAdapters).not.toHaveBeenCalled();
  });

  it('requires authority and accepts a durable timing receipt', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_WAIT_TRANSPORT_ENABLED = true;
    const envelope = { id: 'run-wait-1', action: { type: 'wait' } };
    const pending = { id: 'run-wait-1', status: 'pending', result: null };
    const succeeded = { id: 'run-wait-1', status: 'succeeded', result: { waitUntil: 1_900_000_000_000, waitJobId: 'wait-1' } };
    createAgencyEnvelope.mockReturnValue({ ok: true, envelope });
    createAgencyRun.mockReturnValue({ ok: true, run: pending });
    dispatchAgencyRun.mockResolvedValue({ ok: true, run: succeeded });

    await expect(dispatchWaitViaAgency(input)).resolves.toMatchObject({
      attempted: true,
      accepted: true,
      agencyRunId: 'run-wait-1',
      waitUntil: 1_900_000_000_000,
      waitJobId: 'wait-1',
    });
    expect(createAgencyEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: 'wait', reason: 'heart:等对方说完', waitSec: 12 },
      scope: { visibility: 'chat', chatId: -100 },
      idempotencyKey: 'agency-wait:heart:-100:42',
      correlationId: 'wait:heart:-100:42',
      causationId: 'telegram:-100:message:42',
      budget: { maxMs: 30_000, maxLlmCalls: 0, maxToolCalls: 1 },
      expectedOutcome: 'timing wait receipt chat=-100 trigger=42 source=heart seconds=12',
    }));
    expect(createTimingAgencyWaitAdapters).toHaveBeenCalledWith({
      anchorMessageId: 42,
      triggerUserId: 7,
      obligationId: 'obl-1',
    });
    expect(dispatchAgencyRun).toHaveBeenCalledWith('run-wait-1', { wait: expect.any(Function) });
  });

  it('rejects malformed input before creating a durable run', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_WAIT_TRANSPORT_ENABLED = true;
    await expect(dispatchWaitViaAgency({ ...input, waitSec: Number.NaN })).resolves.toMatchObject({
      attempted: true,
      accepted: false,
      reason: 'invalid_wait_seconds',
    });
    expect(createAgencyEnvelope).not.toHaveBeenCalled();
  });

  it('does not create a run outside authority even when enabled', async () => {
    envState.AGENCY_WAIT_TRANSPORT_ENABLED = true;
    await expect(dispatchWaitViaAgency(input)).resolves.toMatchObject({
      attempted: false,
      accepted: false,
      reason: 'agency_wait_transport_disabled',
    });
    expect(createAgencyEnvelope).not.toHaveBeenCalled();
  });

  it('uses the durable cognitive anchor as causation when provided', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_WAIT_TRANSPORT_ENABLED = true;
    createAgencyEnvelope.mockReturnValue({ ok: true, envelope: { id: 'run-wait-anchor' } });
    createAgencyRun.mockReturnValue({ ok: true, run: { id: 'run-wait-anchor', status: 'pending', result: null } });
    dispatchAgencyRun.mockResolvedValue({
      ok: true,
      run: { id: 'run-wait-anchor', status: 'succeeded', result: { waitUntil: 1_900_000_000_001 } },
    });

    await expect(dispatchWaitViaAgency({ ...input, cognitiveAnchorEventId: 'cog-event-2' })).resolves.toMatchObject({
      accepted: true,
      waitUntil: 1_900_000_000_001,
    });
    expect(createAgencyEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      causationId: 'cog-event-2',
    }));
  });

  it('fails closed on a rejected run or invalid wait receipt', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_WAIT_TRANSPORT_ENABLED = true;
    createAgencyEnvelope.mockReturnValue({ ok: true, envelope: { id: 'run-wait-2' } });
    createAgencyRun.mockReturnValue({ ok: true, run: { id: 'run-wait-2', status: 'pending', result: null } });
    dispatchAgencyRun.mockResolvedValue({
      ok: false,
      run: { id: 'run-wait-2', status: 'succeeded', result: { waitUntil: 0 } },
      reason: 'invalid wait receipt',
    });

    await expect(dispatchWaitViaAgency(input)).resolves.toMatchObject({
      attempted: true,
      accepted: false,
      agencyRunId: 'run-wait-2',
      reason: 'invalid wait receipt',
    });
  });
});
