// Complete keyset reads for durable state, unlike bounded prompt windows.
// Each reconciliation starts a new scan, so late occurredAt events are visible
// on the next pass. A future incremental projection must use ingestion order.
import { getDb } from '../db/sqlite.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';
import { getCognitiveEvent, type CognitiveEvent, type CognitiveEventType } from './cognitive-events.js';

export function* iterateCognitiveHistory(input: {
  type: CognitiveEventType; scope?: CognitiveScope; correlationId?: string;
}): Generator<CognitiveEvent> {
  let afterOccurredAt = 0;
  let afterEventId = '';
  // rowid is an ingestion snapshot bound, never a persisted occurredAt cursor.
  // It keeps a hot writer from extending a sweep indefinitely. Late records
  // below our event-time position are picked up by the next complete sweep.
  const db = getDb();
  const upper = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM cognitive_events').get() as { n: number }).n;
  const filter = ['type = ?', 'rowid <= ?', '(occurred_at > ? OR (occurred_at = ? AND id > ?))'];
  if (input.scope) filter.push('scope_key = ?');
  if (input.correlationId) filter.push('correlation_id = ?');
  const statement = db.prepare(`SELECT id, occurred_at FROM cognitive_events WHERE ${filter.join(' AND ')}
    ORDER BY occurred_at, id LIMIT 200`);
  for (;;) {
    const page = statement.all(input.type, upper, afterOccurredAt, afterOccurredAt, afterEventId,
      ...(input.scope ? [scopeKey(input.scope)] : []), ...(input.correlationId ? [input.correlationId] : [])) as Array<{ id: string; occurred_at: number }>;
    if (!page.length) return;
    for (const row of page) {
      const event = getCognitiveEvent(row.id);
      if (!event) throw new Error('cognitive history event unavailable');
      yield event;
    }
    const last = page.at(-1)!;
    if (last.occurred_at === afterOccurredAt && last.id === afterEventId) throw new Error('cognitive history cursor did not advance');
    afterOccurredAt = last.occurred_at;
    afterEventId = last.id;
  }
}

/** Exact entity lookup; unrelated newer events cannot evict an open action. */
export function findCognitiveFact(input: {
  type: CognitiveEventType; scope: CognitiveScope; path: '$.envelope.id' | '$.idempotencyKey'; value: string;
}): CognitiveEvent | null {
  const row = getDb().prepare(`SELECT id FROM cognitive_events WHERE type = ? AND scope_key = ?
    AND CASE WHEN json_valid(fact_json) THEN json_extract(fact_json, ?) END = ?
    ORDER BY occurred_at DESC, id DESC LIMIT 1`)
    .get(input.type, scopeKey(input.scope), input.path, input.value) as { id: string } | undefined;
  return row ? getCognitiveEvent(row.id) : null;
}
