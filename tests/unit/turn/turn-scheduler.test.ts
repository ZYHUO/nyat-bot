import { describe, it, expect, beforeEach, vi } from 'vitest';

const envState = {
  TIMING_DEBOUNCE_MS: 2000,
  TIMING_DEBOUNCE_MAX_BUFFER_MS: 8000,
};

const addMock = vi.fn();
const getJobMock = vi.fn();

const bufferState: {
  meta: { scheduledJobId?: string; firstPendingAt?: number };
  dirty: boolean;
  setJobs: string[];
} = { meta: {}, dirty: false, setJobs: [] };

vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/tracking/life-state.js', () => ({
  getLifeState: vi.fn(() => ({ state: 'normal', energy: 0.85, hint: null, speedFactor: 1, lazyDay: false })),
}));

vi.mock('../../../src/queue/producer.js', () => ({
  getQueue: () => ({ add: addMock, getJob: getJobMock }),
}));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({
  getTurnMeta: vi.fn(async () => bufferState.meta),
  setScheduledJob: vi.fn(async (_chatId: number, jobId: string) => {
    bufferState.setJobs.push(jobId);
    bufferState.meta.scheduledJobId = jobId;
  }),
  markDirty: vi.fn(async () => {
    bufferState.dirty = true;
  }),
}));

import { scheduleTurn } from '../../../src/queue/turn-scheduler.js';

const CHAT = -100700;

beforeEach(() => {
  addMock.mockReset().mockImplementation(async (_n: string, _d: unknown, opts: { jobId: string }) => ({ id: opts.jobId }));
  getJobMock.mockReset();
  bufferState.meta = {};
  bufferState.dirty = false;
  bufferState.setJobs = [];
});

describe('turn scheduler', () => {
  it('creates a fresh delayed turn job and records its id', async () => {
    await scheduleTurn(CHAT, { trigger: 'message' });

    expect(addMock).toHaveBeenCalledTimes(1);
    const [name, data, opts] = addMock.mock.calls[0]!;
    expect(name).toBe('chat_turn');
    expect(data.type).toBe('chat_turn');
    expect(data.turn.trigger).toBe('message');
    expect(opts.delay).toBeGreaterThan(0);
    expect(opts.delay).toBeLessThanOrEqual(envState.TIMING_DEBOUNCE_MS);
    expect(opts.removeOnComplete).toBe(true);
    expect(bufferState.setJobs).toHaveLength(1);
  });

  it('direct trigger fires immediately (delay 0)', async () => {
    await scheduleTurn(CHAT, { trigger: 'direct', direct: true });
    const opts = addMock.mock.calls[0]![2];
    expect(opts.delay).toBe(0);
    const data = addMock.mock.calls[0]![1];
    expect(data.turn.directPriority).toBe(true);
  });

  it('extends the sliding window when the user looks mid-typing (G4)', async () => {
    await scheduleTurn(CHAT, { trigger: 'message', stillTyping: true });
    const opts = addMock.mock.calls[0]![2];
    expect(opts.delay).toBeGreaterThan(envState.TIMING_DEBOUNCE_MS);
    expect(opts.delay).toBeLessThanOrEqual(envState.TIMING_DEBOUNCE_MS * 1.75);
  });

  it('caps the sliding delay at the hard deadline from firstPendingAt', async () => {
    // First message buffered 7.5s ago → hard deadline in 500ms < sliding 2000ms
    bufferState.meta.firstPendingAt = Date.now() - 7500;
    await scheduleTurn(CHAT, { trigger: 'message' });
    const opts = addMock.mock.calls[0]![2];
    expect(opts.delay).toBeLessThanOrEqual(600);
  });

  it('reschedules an existing delayed job via changeDelay instead of adding', async () => {
    bufferState.meta.scheduledJobId = 'turn-x';
    const changeDelay = vi.fn(async () => {});
    getJobMock.mockResolvedValue({
      id: 'turn-x',
      timestamp: Date.now() - 1000,
      data: { turn: { trigger: 'message', scheduledAt: 0, directPriority: false } },
      getState: async () => 'delayed',
      changeDelay,
      updateData: vi.fn(async () => {}),
    });

    await scheduleTurn(CHAT, { trigger: 'message' });
    expect(changeDelay).toHaveBeenCalledTimes(1);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('upgrades a delayed job to directPriority when a direct message lands', async () => {
    bufferState.meta.scheduledJobId = 'turn-x';
    const updateData = vi.fn(async () => {});
    getJobMock.mockResolvedValue({
      id: 'turn-x',
      timestamp: Date.now(),
      data: { type: 'chat_turn', chatId: CHAT, turn: { trigger: 'message', scheduledAt: 0, directPriority: false } },
      getState: async () => 'delayed',
      changeDelay: vi.fn(async () => {}),
      updateData,
    });

    await scheduleTurn(CHAT, { trigger: 'direct', direct: true });
    expect(updateData).toHaveBeenCalledTimes(1);
    expect(updateData.mock.calls[0]![0].turn.directPriority).toBe(true);
  });

  it('marks dirty when the scheduled job is already active', async () => {
    bufferState.meta.scheduledJobId = 'turn-x';
    getJobMock.mockResolvedValue({
      id: 'turn-x',
      timestamp: Date.now(),
      data: { turn: {} },
      getState: async () => 'active',
    });

    await scheduleTurn(CHAT, { trigger: 'message' });
    expect(bufferState.dirty).toBe(true);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('falls through to a new job when the recorded job no longer exists', async () => {
    bufferState.meta.scheduledJobId = 'turn-gone';
    getJobMock.mockResolvedValue(undefined);

    await scheduleTurn(CHAT, { trigger: 'message' });
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it('changeDelay racing with promotion marks dirty — NEVER creates a parallel turn', async () => {
    // TOCTOU:getState 后 job 被提升,changeDelay 抛 JobNotInState。
    // 此刻 job 已是 active —— 必须走 markDirty 语义;新建 job 会造出
    // 同群第二个并行回合(双回复,review-workflow P1)。
    bufferState.meta.scheduledJobId = 'turn-x';
    getJobMock.mockResolvedValue({
      id: 'turn-x',
      timestamp: Date.now(),
      data: { turn: {} },
      getState: async () => 'delayed',
      changeDelay: vi.fn(async () => {
        throw new Error('Job is not in the delayed state');
      }),
      updateData: vi.fn(async () => {}),
    });

    await scheduleTurn(CHAT, { trigger: 'message' });
    expect(addMock).not.toHaveBeenCalled();
    expect(bufferState.dirty).toBe(true);
  });

  it('forceNew skips the reuse branch entirely (end-of-turn self-reschedule)', async () => {
    bufferState.meta.scheduledJobId = 'turn-self';
    getJobMock.mockResolvedValue({
      id: 'turn-self',
      timestamp: Date.now(),
      data: { turn: {} },
      getState: async () => 'active',
    });

    await scheduleTurn(CHAT, { trigger: 'message', forceNew: true });
    expect(getJobMock).not.toHaveBeenCalled();
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(bufferState.dirty).toBe(false);
  });
});
