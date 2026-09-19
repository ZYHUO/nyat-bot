import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({
  env: () => ({ COGNITIVE_EVENTS_ENABLED: true, COGNITIVE_OUTBOX_ENABLED: false }),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { appendCognitiveEvent } from '../../../src/agent/cognitive-events.js';
import {
  advanceCognitiveCursor,
  claimCognitiveCursor,
  getCognitiveCursor,
  listCognitiveEventsAfterCursor,
  releaseCognitiveCursor,
} from '../../../src/agent/cognitive-cursor.js';

const scope = { visibility: 'chat' as const, chatId: -100 };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0111_cognitive_cursors.sql', 'utf8'));
});

describe('cognitive cursors', () => {
  it('claims, advances, releases, and rejects a competing live lease', () => {
    const first = claimCognitiveCursor({ scope, stream: 'projection', owner: 'worker-a', nowSec: 100, leaseSec: 30 });
    expect(first).toMatchObject({ claimed: true, occurredAt: 0, leaseOwner: 'worker-a' });
    expect(claimCognitiveCursor({ scope, stream: 'projection', owner: 'worker-b', nowSec: 110, leaseSec: 30 })).toMatchObject({ claimed: false, leaseOwner: 'worker-a' });
    expect(advanceCognitiveCursor({ scope, stream: 'projection', owner: 'worker-b', position: { occurredAt: 120, eventId: 'z' }, nowSec: 120 })).toBe(false);
    expect(advanceCognitiveCursor({ scope, stream: 'projection', owner: 'worker-a', position: { occurredAt: 120, eventId: 'z' }, nowSec: 120 })).toBe(true);
    expect(getCognitiveCursor({ scope, stream: 'projection' })).toMatchObject({ occurredAt: 120, eventId: 'z', leaseOwner: 'worker-a' });
    expect(advanceCognitiveCursor({ scope, stream: 'projection', owner: 'worker-a', position: { occurredAt: 119, eventId: 'a' }, nowSec: 121 })).toBe(false);
    expect(releaseCognitiveCursor({ scope, stream: 'projection', owner: 'worker-a' })).toBe(true);
    expect(claimCognitiveCursor({ scope, stream: 'projection', owner: 'worker-b', nowSec: 122 })).toMatchObject({ claimed: true, occurredAt: 120, eventId: 'z' });
  });

  it('replays events across correlations using the global occurred-at/event-id cursor', () => {
    const a = appendCognitiveEvent({ type: 'cognitive_trigger', source: 'host', scope, correlationId: 'a', occurredAt: 10, dedupeKey: 'a', fact: { kind: 'one' } });
    const b = appendCognitiveEvent({ type: 'cognitive_trigger', source: 'host', scope, correlationId: 'b', occurredAt: 10, dedupeKey: 'b', fact: { kind: 'two' } });
    const c = appendCognitiveEvent({ type: 'cognitive_trigger', source: 'host', scope, correlationId: 'c', occurredAt: 11, dedupeKey: 'c', fact: { kind: 'three' } });
    expect(a && b && c).toBeTruthy();
    claimCognitiveCursor({ scope, stream: 'projection', owner: 'worker-a', nowSec: 20 });
    const lastSameSecond = [a!.event.id, b!.event.id].sort().at(-1)!;
    expect(advanceCognitiveCursor({ scope, stream: 'projection', owner: 'worker-a', position: { occurredAt: 10, eventId: lastSameSecond }, nowSec: 20 })).toBe(true);
    const remaining = listCognitiveEventsAfterCursor({ scope, stream: 'projection' });
    expect(remaining.map((event) => event.id)).toEqual([c!.event.id]);
  });
});
