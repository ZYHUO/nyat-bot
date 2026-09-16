import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  appendCognitiveEvent,
  appendTelegramMessageEvent,
  ackCognitiveOutbox,
  claimCognitiveOutbox,
  failCognitiveOutbox,
  getCognitiveEvent,
  getLatestTelegramMessageEventId,
  listCognitiveEvents,
  listCognitiveOutbox,
  replayCognitiveEvents,
} from '../../../src/agent/cognitive-events.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
});

describe('cognitive event log', () => {
  it('canonicalizes Telegram message and edit anchors while deduplicating retries', () => {
    const message = appendTelegramMessageEvent({
      update: { update_id: 7, message: { message_id: 42 } },
      chatId: -100,
      messageId: 42,
      userId: 9,
      occurredAt: 100,
    });
    expect(message).toBeTruthy();
    expect(appendTelegramMessageEvent({
      update: { update_id: 7, message: { message_id: 42 } },
      chatId: -100,
      messageId: 42,
      userId: 9,
      occurredAt: 100,
    })).toBe(message);

    const edit = appendTelegramMessageEvent({
      update: { update_id: 8, edited_message: { message_id: 42, edit_date: 101 } },
      chatId: -100,
      messageId: 42,
      userId: 9,
      occurredAt: 101,
    });
    expect(edit).toBeTruthy();
    expect(edit).not.toBe(message);
    expect(appendTelegramMessageEvent({
      update: { update_id: 8, edited_message: { message_id: 42, edit_date: 101 } },
      chatId: -100,
      messageId: 42,
      userId: 9,
      occurredAt: 101,
    })).toBe(edit);
    expect(listCognitiveEvents({ scope: { visibility: 'chat', chatId: -100 } })).toHaveLength(2);
    expect(getLatestTelegramMessageEventId(-100)).toBe(edit);
  });

  it('appends in correlation order and replays the stream', async () => {
    const first = appendCognitiveEvent({
      type: 'message_received',
      source: 'telegram',
      scope: { visibility: 'chat', chatId: -100 },
      correlationId: 'turn-1',
      fact: { messageId: 10 },
    });
    const second = appendCognitiveEvent({
      type: 'task_observation',
      source: 'host',
      scope: { visibility: 'task', taskId: 'task-1', chatId: -100 },
      correlationId: 'turn-1',
      causationId: first?.event.id,
      fact: { status: 'done' },
    });
    expect(first?.inserted).toBe(true);
    expect(second?.event.sequence).toBe(2);
    expect(getCognitiveEvent(first!.event.id)?.fact).toEqual({ messageId: 10 });

    const seen: number[] = [];
    expect(await replayCognitiveEvents('turn-1', (event) => seen.push(event.sequence))).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  it('deduplicates an ingress retry without consuming another sequence', () => {
    const input = {
      type: 'message_received' as const,
      source: 'telegram' as const,
      scope: { visibility: 'chat' as const, chatId: -100 },
      correlationId: 'telegram:-100:42',
      dedupeKey: 'telegram:-100:42:message',
      fact: { messageId: 42 },
    };
    const first = appendCognitiveEvent(input);
    const duplicate = appendCognitiveEvent({ ...input, fact: { messageId: 999 } });
    expect(duplicate?.inserted).toBe(false);
    expect(duplicate?.event.id).toBe(first?.event.id);
    expect(listCognitiveEvents({ correlationId: input.correlationId })).toHaveLength(1);
  });

  it('filters by exact scope and bounds facts', () => {
    appendCognitiveEvent({ type: 'world_change', source: 'host', scope: { visibility: 'chat', chatId: -100 }, correlationId: 'a', fact: { value: 1 } });
    appendCognitiveEvent({ type: 'world_change', source: 'host', scope: { visibility: 'chat', chatId: -200 }, correlationId: 'b', fact: { value: 2 } });
    expect(listCognitiveEvents({ scope: { visibility: 'chat', chatId: -100 } }).map((e) => e.fact.value)).toEqual([1]);
    expect(() => appendCognitiveEvent({
      type: 'world_change',
      source: 'host',
      fact: { payload: 'x'.repeat(9000) },
    })).toThrow(/exceeds/);
  });

  it('claims, acknowledges and retries durable outbox work', () => {
    const appended = appendCognitiveEvent({ type: 'tool_failure', source: 'tool', correlationId: 'outbox-1', fact: { code: 'E_TIMEOUT' } });
    expect(listCognitiveOutbox('pending')).toHaveLength(1);
    const claimed = claimCognitiveOutbox('worker-a');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.event?.id).toBe(appended?.event.id);
    expect(claimed[0]?.attempts).toBe(1);
    expect(ackCognitiveOutbox(claimed[0]!.id, 'wrong-worker')).toBe(false);
    expect(ackCognitiveOutbox(claimed[0]!.id, 'worker-a')).toBe(true);
    expect(listCognitiveOutbox('delivered')).toHaveLength(1);

    const failed = appendCognitiveEvent({ type: 'task_observation', source: 'host', correlationId: 'outbox-2' });
    const retryClaim = claimCognitiveOutbox('worker-a');
    expect(retryClaim[0]?.event?.id).toBe(failed?.event.id);
    expect(failCognitiveOutbox(retryClaim[0]!.id, 'bad input', 0, 'wrong-worker')).toBe(false);
    expect(failCognitiveOutbox(retryClaim[0]!.id, 'bad input', 0, 'worker-a')).toBe(true);
    expect(listCognitiveOutbox('failed')).toHaveLength(1);
  });
});
