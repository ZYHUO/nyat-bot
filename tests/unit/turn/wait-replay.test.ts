import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  state: vi.fn(async (): Promise<{ state: string; waitGeneration?: string }> => ({ state: 'RUNNING', waitGeneration: 'current' })),
}));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ getChatState: f.state }));
import { isWaitRecoveryCurrent } from '../../../src/pipeline/turn/wait-replay.js';

beforeEach(() => {
  vi.clearAllMocks();
  f.state.mockResolvedValue({ state: 'RUNNING', waitGeneration: 'current' });
});

describe('wait recovery host fence', () => {
  it('allows only the current claimed generation', async () => {
    expect(await isWaitRecoveryCurrent(-100, { isWaitReplay: true, waitGeneration: 'current' })).toBe(true);
    expect(await isWaitRecoveryCurrent(-100, { isWaitReplay: true, waitGeneration: 'old' })).toBe(false);
  });

  it.each(['WAIT', 'STOP'])('does not authorize publication in %s', async (state) => {
    f.state.mockResolvedValue({ state, waitGeneration: 'current' });
    expect(await isWaitRecoveryCurrent(-100, { isWaitReplay: true, waitGeneration: 'current' })).toBe(false);
  });

  it('fails closed on missing generation and unavailable state', async () => {
    expect(await isWaitRecoveryCurrent(-100, { isWaitReplay: true })).toBe(false);
    f.state.mockRejectedValueOnce(new Error('redis unavailable'));
    expect(await isWaitRecoveryCurrent(-100, { isWaitReplay: true, waitGeneration: 'current' })).toBe(false);
  });

  it('keeps ordinary and sleep catchup turns independent of WAIT state', async () => {
    expect(await isWaitRecoveryCurrent(-100)).toBe(true);
    expect(await isWaitRecoveryCurrent(-100, { isWaitReplay: true, sleepCatchup: true })).toBe(true);
    expect(f.state).not.toHaveBeenCalled();
  });
});
