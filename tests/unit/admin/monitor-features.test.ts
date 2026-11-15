import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFeatureStatusReport = vi.hoisted(() => vi.fn());
vi.mock('../../../src/admin/feature-status.js', () => ({ getFeatureStatusReport }));
vi.mock('../../../src/admin/obligations.js', () => ({ listObligationSnapshots: vi.fn() }));
vi.mock('../../../src/agent/cognitive-route-observations.js', () => ({ getCognitiveRouteWindow: vi.fn() }));
vi.mock('../../../src/agent/agency-runtime.js', () => ({ listAgencyRunSummaries: vi.fn() }));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({ getTaskRecoverySummary: vi.fn() }));
vi.mock('../../../src/core/skills/revisions.js', () => ({ listSkillRevisionVerificationSummaries: vi.fn() }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: vi.fn() }));

import { createMonitorApi } from '../../../src/admin/monitor.js';

describe('monitor feature status authorization', () => {
  beforeEach(() => { vi.clearAllMocks(); getFeatureStatusReport.mockResolvedValue({ features: [], tasks: [], schedulerRunning: false }); });
  const api = () => createMonitorApi({ env: { MONITOR_TOKEN: 'test-only-token' } as never, redis: { status: 'ready' } as never, bot: {} as never });

  it('does not inspect configuration or runtime before the existing monitor authentication passes', async () => {
    expect((await api().request('http://localhost/features')).status).toBe(401);
    expect((await api().request('http://localhost/features?token=wrong')).status).toBe(401);
    expect(getFeatureStatusReport).not.toHaveBeenCalled();
  });

  it('returns the feature report with no-store behind the same token', async () => {
    const response = await api().request('http://localhost/features?token=test-only-token');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, features: [], tasks: [], schedulerRunning: false });
    expect(getFeatureStatusReport).toHaveBeenCalledTimes(1);
  });
});
