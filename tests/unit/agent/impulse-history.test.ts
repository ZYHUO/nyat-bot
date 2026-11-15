import { describe, expect, it, vi } from 'vitest';

const envMock = { SELF_HISTORY_ENABLED: true };
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

const rows = [
  { occurred_at: 1000, fact_json: JSON.stringify({ shadowVerdict: 'speak', shadowWhy: '他会修交换机，问到我头上了', messageId: 11 }) },
  { occurred_at: 900, fact_json: JSON.stringify({ shadowVerdict: 'silent', shadowWhy: '他俩在抬杠', messageId: 10 }) },
  { occurred_at: 800, fact_json: 'NOT JSON' },
  { occurred_at: 700, fact_json: JSON.stringify({ shadowVerdict: 'failed', shadowWhy: '超时', messageId: 9 }) },
];
const prepareMock = vi.fn(() => ({ all: () => rows }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => ({ prepare: prepareMock }) }));

const { getRecentImpulses } = await import('../../../src/agent/impulse-history.js');

describe('getRecentImpulses', () => {
  it('reads the shadow ledger back out, preserving the bot own words', () => {
    const out = getRecentImpulses(-1002943259956, 4, 90);
    expect(out).toHaveLength(2); // failed + unparseable are not impulses
    expect(out[0]).toEqual({
      atSec: 1000,
      verdict: 'speak',
      why: '他会修交换机，问到我头上了',
      messageId: 11,
    });
  });

  it('honours the limit', () => {
    expect(getRecentImpulses(-1002943259956, 1, 90)).toHaveLength(1);
  });

  it('returns empty when the ledger is unreadable (fail-soft)', () => {
    prepareMock.mockImplementationOnce(() => {
      throw new Error('no such table');
    });
    expect(getRecentImpulses(-1002943259956)).toEqual([]);
  });
});
