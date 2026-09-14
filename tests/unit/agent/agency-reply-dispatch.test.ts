import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  envState,
  createAgencyEnvelope,
  createAgencyRun,
  dispatchAgencyRun,
  createTelegramAgencyDeliveryAdapters,
} = vi.hoisted(() => ({
  envState: {
    AGENCY_RUNTIME_MODE: 'shadow' as string,
    AGENCY_REPLY_TRANSPORT_ENABLED: false,
  } as Record<string, unknown>,
  createAgencyEnvelope: vi.fn(),
  createAgencyRun: vi.fn(),
  dispatchAgencyRun: vi.fn(),
  createTelegramAgencyDeliveryAdapters: vi.fn(),
}));

vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/agent/agency-runtime.js', () => ({
  createAgencyEnvelope,
  createAgencyRun,
  dispatchAgencyRun,
}));
vi.mock('../../../src/agent/agency-delivery-adapter.js', () => ({ createTelegramAgencyDeliveryAdapters }));

import { dispatchReplyViaAgency } from '../../../src/agent/agency-reply-dispatch.js';

const input = {
  chatId: -100,
  triggerMessageId: 42,
  segment: 1,
  text: '  已核实  ',
  replyToMessageId: 41,
};

beforeEach(() => {
  envState.AGENCY_RUNTIME_MODE = 'shadow';
  envState.AGENCY_REPLY_TRANSPORT_ENABLED = false;
  createAgencyEnvelope.mockReset();
  createAgencyRun.mockReset();
  dispatchAgencyRun.mockReset();
  createTelegramAgencyDeliveryAdapters.mockReset();
  createTelegramAgencyDeliveryAdapters.mockReturnValue({ speak: vi.fn(), ask: vi.fn() });
});

describe('Agency Reply authority transport bridge', () => {
  it('does not touch Agency or Telegram bindings when disabled', async () => {
    await expect(dispatchReplyViaAgency(input)).resolves.toMatchObject({
      attempted: false,
      accepted: false,
      reason: 'agency_reply_transport_disabled',
    });
    expect(createAgencyEnvelope).not.toHaveBeenCalled();
    expect(createTelegramAgencyDeliveryAdapters).not.toHaveBeenCalled();
  });

  it('requires authority and accepts the durable Telegram message receipt', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_REPLY_TRANSPORT_ENABLED = true;
    const envelope = { id: 'run-reply-1', action: { type: 'speak' } };
    const pending = { id: 'run-reply-1', status: 'pending', result: null };
    const succeeded = { id: 'run-reply-1', status: 'succeeded', result: { messageId: 91 } };
    createAgencyEnvelope.mockReturnValue({ ok: true, envelope });
    createAgencyRun.mockReturnValue({ ok: true, run: pending });
    dispatchAgencyRun.mockResolvedValue({ ok: true, run: succeeded });

    await expect(dispatchReplyViaAgency(input)).resolves.toMatchObject({
      attempted: true,
      accepted: true,
      agencyRunId: 'run-reply-1',
      messageId: 91,
    });
    expect(createAgencyEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: 'speak', text: '已核实', replyToMessageId: 41 },
      scope: { visibility: 'chat', chatId: -100 },
      idempotencyKey: 'agency-reply:-100:42:1',
      correlationId: 'reply:-100:42',
      causationId: 'telegram:-100:message:42',
      budget: { maxMs: 30_000, maxLlmCalls: 0, maxToolCalls: 1 },
      expectedOutcome: 'Telegram speak receipt chat=-100 trigger=42 segment=1 chars=3',
    }));
    expect(createTelegramAgencyDeliveryAdapters).toHaveBeenCalledOnce();
    expect(dispatchAgencyRun).toHaveBeenCalledWith('run-reply-1', {
      speak: expect.any(Function),
      ask: expect.any(Function),
    });
  });

  it('does not create a run outside authority even when the flag is true', async () => {
    envState.AGENCY_REPLY_TRANSPORT_ENABLED = true;
    await expect(dispatchReplyViaAgency(input)).resolves.toMatchObject({
      attempted: false,
      accepted: false,
      reason: 'agency_reply_transport_disabled',
    });
    expect(createAgencyEnvelope).not.toHaveBeenCalled();
  });

  it('uses the durable cognitive anchor as causation when provided', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_REPLY_TRANSPORT_ENABLED = true;
    createAgencyEnvelope.mockReturnValue({ ok: true, envelope: { id: 'run-reply-anchor' } });
    createAgencyRun.mockReturnValue({ ok: true, run: { id: 'run-reply-anchor', status: 'pending', result: null } });
    dispatchAgencyRun.mockResolvedValue({
      ok: true,
      run: { id: 'run-reply-anchor', status: 'succeeded', result: { messageId: 92 } },
    });

    await expect(dispatchReplyViaAgency({ ...input, cognitiveAnchorEventId: 'cog-event-1' })).resolves.toMatchObject({
      accepted: true,
      messageId: 92,
    });
    expect(createAgencyEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      causationId: 'cog-event-1',
    }));
  });

  it('rejects malformed input before creating a durable run', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_REPLY_TRANSPORT_ENABLED = true;
    await expect(dispatchReplyViaAgency({ ...input, triggerMessageId: 0 })).resolves.toMatchObject({
      attempted: true,
      accepted: false,
      reason: 'invalid_trigger_message_id',
    });
    expect(createAgencyEnvelope).not.toHaveBeenCalled();
  });

  it('fails closed when dispatch or the host receipt is not successful', async () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_REPLY_TRANSPORT_ENABLED = true;
    createAgencyEnvelope.mockReturnValue({ ok: true, envelope: { id: 'run-reply-2' } });
    createAgencyRun.mockReturnValue({ ok: true, run: { id: 'run-reply-2', status: 'pending', result: null } });
    dispatchAgencyRun.mockResolvedValue({
      ok: false,
      run: { id: 'run-reply-2', status: 'succeeded', result: { messageId: 0 } },
      reason: 'invalid delivery receipt',
    });

    await expect(dispatchReplyViaAgency(input)).resolves.toMatchObject({
      attempted: true,
      accepted: false,
      agencyRunId: 'run-reply-2',
      reason: 'invalid delivery receipt',
    });
  });
});
