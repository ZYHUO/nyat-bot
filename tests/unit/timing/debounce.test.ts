import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MessageJobData } from '../../../src/queue/jobs.js';

const enqueueMock = vi.fn();

vi.mock('../../../src/queue/producer.js', () => ({
  enqueue: (data: MessageJobData) => enqueueMock(data),
  enqueueWaitResume: vi.fn(),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = {
  TIMING_GATE_ENABLED: true,
  TIMING_DEBOUNCE_MS: 50,
  TIMING_DEBOUNCE_MAX_BUFFER_MS: 200,
};

vi.mock('../../../src/env.js', () => ({
  env: () => envValues,
}));

function makeData(chatId: number, messageId: number, overrides: Partial<MessageJobData> = {}): MessageJobData {
  return {
    type: 'message',
    chatId,
    messageId,
    update: {} as MessageJobData['update'],
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

describe('debounce', () => {
  let mod: typeof import('../../../src/pipeline/timing/debounce.js');

  beforeEach(async () => {
    vi.resetModules();
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue('jobid');
    envValues['TIMING_GATE_ENABLED'] = true;
    envValues['TIMING_DEBOUNCE_MS'] = 50;
    envValues['TIMING_DEBOUNCE_MAX_BUFFER_MS'] = 200;
    mod = await import('../../../src/pipeline/timing/debounce.js');
    mod._resetBuffers();
  });

  it('passes through immediately when feature flag off', async () => {
    envValues['TIMING_GATE_ENABLED'] = false;
    const data = makeData(-100, 1);
    const id = await mod.enqueueWithDebounce(data);
    expect(id).toBe('jobid');
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(mod._hasBuffer(-100)).toBe(false);
  });

  it('passes through when DEBOUNCE_MS=0', async () => {
    envValues['TIMING_DEBOUNCE_MS'] = 0;
    const data = makeData(-100, 1);
    await mod.enqueueWithDebounce(data);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('passes through edits', async () => {
    const data = makeData(-100, 1, { isEdit: true });
    await mod.enqueueWithDebounce(data);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('buffers a single message and flushes after window', async () => {
    const data = makeData(-100, 1);
    const id = await mod.enqueueWithDebounce(data);
    expect(id).toBeUndefined();
    expect(mod._getBufferSize(-100)).toBe(1);
    expect(enqueueMock).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 80));

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const arg = enqueueMock.mock.calls[0]![0] as MessageJobData;
    expect(arg.coalesce?.batchSize).toBe(1);
    expect(arg.coalesce?.isLastInBatch).toBe(true);
    expect(arg.coalesce?.flushReason).toBe('window');
    expect(mod._hasBuffer(-100)).toBe(false);
  });

  it('coalesces N messages: only last has isLastInBatch=true', async () => {
    await mod.enqueueWithDebounce(makeData(-100, 1));
    await mod.enqueueWithDebounce(makeData(-100, 2));
    await mod.enqueueWithDebounce(makeData(-100, 3));
    expect(mod._getBufferSize(-100)).toBe(3);

    await new Promise((r) => setTimeout(r, 80));

    expect(enqueueMock).toHaveBeenCalledTimes(3);
    const calls = enqueueMock.mock.calls.map((c) => c[0] as MessageJobData);
    expect(calls.map((c) => c.messageId)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.coalesce?.isLastInBatch)).toEqual([false, false, true]);
    expect(calls.map((c) => c.coalesce?.batchSize)).toEqual([3, 3, 3]);
  });

  it('bypassDebounce flushes pending then enqueues immediately', async () => {
    await mod.enqueueWithDebounce(makeData(-100, 1));
    await mod.enqueueWithDebounce(makeData(-100, 2));
    expect(enqueueMock).not.toHaveBeenCalled();

    await mod.enqueueWithDebounce(makeData(-100, 3), { bypassDebounce: true });

    // 2 buffered + 1 direct = 3 calls
    expect(enqueueMock).toHaveBeenCalledTimes(3);
    const calls = enqueueMock.mock.calls.map((c) => c[0] as MessageJobData);
    expect(calls.map((c) => c.messageId)).toEqual([1, 2, 3]);
    expect(calls[0]?.coalesce?.flushReason).toBe('direct_interaction');
    expect(calls[2]?.coalesce).toBeUndefined();
  });

  it('hard deadline forces flush when window keeps resetting', async () => {
    envValues['TIMING_DEBOUNCE_MS'] = 100;
    envValues['TIMING_DEBOUNCE_MAX_BUFFER_MS'] = 60;
    vi.resetModules();
    mod = await import('../../../src/pipeline/timing/debounce.js');
    mod._resetBuffers();

    await mod.enqueueWithDebounce(makeData(-100, 1));
    await new Promise((r) => setTimeout(r, 30));
    await mod.enqueueWithDebounce(makeData(-100, 2));

    // hard deadline (60ms from first message) should beat window (100ms)
    await new Promise((r) => setTimeout(r, 50));
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect((enqueueMock.mock.calls[0]?.[0] as MessageJobData).coalesce?.flushReason).toBe('hard');
  });

  it('flushAllBuffers drains every chat', async () => {
    await mod.enqueueWithDebounce(makeData(-100, 1));
    await mod.enqueueWithDebounce(makeData(-200, 1));
    expect(mod._hasBuffer(-100)).toBe(true);
    expect(mod._hasBuffer(-200)).toBe(true);

    await mod.flushAllBuffers();

    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(mod._hasBuffer(-100)).toBe(false);
    expect(mod._hasBuffer(-200)).toBe(false);
  });

  it('flushBuffer on empty chat is a no-op', async () => {
    await mod.flushBuffer(-100);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
