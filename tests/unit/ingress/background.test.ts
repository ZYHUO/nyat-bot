import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { drainIngressTasks, trackIngressTask } from '../../../src/ingress/background.js';
describe('detached ingress shutdown join', () => {
  it('joins media/Heart work and children started by that work without timing out as clean', async () => {
    let release!: () => void, childRelease!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const child = new Promise<void>(resolve => { childRelease = resolve; });
    trackIngressTask(first.then(() => { trackIngressTask(child); }));
    let clean = false; const drain = drainIngressTasks().then(() => { clean = true; });
    await Promise.resolve(); expect(clean).toBe(false);
    release(); for (let i = 0; i < 5; i++) await Promise.resolve(); expect(clean).toBe(false);
    childRelease(); await drain; expect(clean).toBe(true);
  });
});
