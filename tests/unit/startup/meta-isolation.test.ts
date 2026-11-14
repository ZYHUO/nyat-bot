import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ enabled: false, epoch: 1, profile: vi.fn(), preflight: vi.fn() }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ META_SUBAGENT_ENABLED: state.enabled, META_ACTIVATED_AT_SEC: state.epoch }) }));
vi.mock('../../../src/sandbox/codeact/runner.js', () => ({ configuredCodeActProfile: state.profile, preflightCodeActIsolation: state.preflight }));
import { assertMetaIsolationReady } from '../../../src/startup/meta-isolation.js';
beforeEach(() => { state.enabled = false; state.epoch = 1; state.profile.mockReset(); state.preflight.mockReset(); });
describe('Meta startup isolation gate', () => {
  it('refuses to take over chat without a fixed activation boundary', async () => {
    state.enabled = true; state.epoch = 0;
    await expect(assertMetaIsolationReady()).rejects.toThrow('meta_activation_epoch_required');
    expect(state.preflight).not.toHaveBeenCalled();
  });
  it('keeps the legacy path independent of sandbox availability', async () => {
    state.profile.mockImplementation(() => { throw new Error('unavailable'); });
    await assertMetaIsolationReady();
    expect(state.profile).not.toHaveBeenCalled();
    expect(state.preflight).not.toHaveBeenCalled();
  });
  it('rejects an enabled Meta with isolation disabled', async () => {
    state.enabled = true;
    state.profile.mockImplementation(() => { throw new Error('codeact_isolation_disabled'); });
    await expect(assertMetaIsolationReady()).rejects.toThrow('codeact_isolation_disabled');
    expect(state.preflight).not.toHaveBeenCalled();
  });
  it('requires the actual configured profile to execute successfully', async () => {
    state.enabled = true;
    const profile = { bwrapPath: '/fixed/bwrap' };
    state.profile.mockReturnValue(profile);
    state.preflight.mockResolvedValue({ available: false, reason: 'namespace_denied' });
    await expect(assertMetaIsolationReady()).rejects.toThrow('meta_isolation_preflight_failed: namespace_denied');
    expect(state.preflight).toHaveBeenCalledExactlyOnceWith(profile);
    state.preflight.mockResolvedValue({ available: true });
    await expect(assertMetaIsolationReady()).resolves.toBeUndefined();
  });
});
