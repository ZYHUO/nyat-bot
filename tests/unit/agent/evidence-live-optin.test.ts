import { describe, expect, it, vi } from 'vitest';

// Failsafe provider errors must not leak keys/bodies into smoke-test stdout.
describe('live smoke test opt-in', () => {
  it('requires an explicit environment path before any network call', async () => {
    vi.stubEnv('NYAT_LIVE_ENV', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(import('../../../scripts/eval-agent-evidence-live.js')).rejects.toThrow('explicitly opt');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
