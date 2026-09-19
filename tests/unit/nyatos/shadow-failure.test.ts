import { describe, expect, it, vi } from 'vitest';

// Every shadow failure used to collapse into {verdict:'silent', why:'shadow_error'}
// with the real error at debug level. In production (level 30) that made 14% of a
// period's verdicts silently unusable AND indistinguishable from real silence.
// The ledger must carry the error class, and the log must be loud.

const callMock = vi.fn();
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: (...a: unknown[]) => callMock(...a) }));
vi.mock('../../../src/nyatos/frame.js', () => ({
  buildFrame: vi.fn(async () => ({ id: 'f' })),
  renderFrame: () => '[frame]',
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotIdentity: () => ({ uid: 1, username: 'u', displayName: 'd', nicknames: [] }),
  getBotDisplayName: () => 'd',
}));

const { decideShadow } = await import('../../../src/nyatos/shadow.js');

describe('decideShadow failure reporting', () => {
  it('carries a bounded error hint when the call throws', async () => {
    const boom = new Error('fetch failed');
    callMock.mockRejectedValue(boom);
    const d = await decideShadow({ id: 'f' } as never);
    expect(d.failed).toBe(true);
    expect(d.verdict).toBe('silent');
    expect(d.why).toBe('shadow_error');
    // The class is now visible without debug logging.
    expect(d.errorHint).toBe('Error: fetch failed');
  });

  it('bounds the hint so a huge provider message cannot bloat the ledger', async () => {
    callMock.mockRejectedValue(new Error('x'.repeat(5000)));
    const d = await decideShadow({ id: 'f' } as never);
    expect((d.errorHint ?? '').length).toBeLessThanOrEqual(120);
  });

  it('leaves errorHint unset on a normal decision', async () => {
    callMock.mockResolvedValue({ content: JSON.stringify({ act: "speak", why: "问到我头上了", bubbles: ["在的喵"] }) });
    const d = await decideShadow({ id: 'f' } as never);
    expect(d.failed).toBe(false);
    expect(d.errorHint).toBeUndefined();
  });
});
