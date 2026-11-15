import { createHash } from 'node:crypto';
import type { MessageRef } from '../platform/types.js';
import { messageKey } from '../platform/identity.js';

/** UTC epoch milliseconds. Unknown platform times stay null, never receipt time. */
export interface EventTimes {
  occurredAt: number | null;
  editedAt: number | null;
  receivedAt: number;
  /** First handler/decision attempt; not a delivery or success timestamp. */
  processedAt: number | null;
}
export interface MessageEventIdentity extends EventTimes {
  eventId: string;
  messageKey: string;
  revision: string;
  ref: MessageRef;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item ?? null)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).filter(key => obj[key] !== undefined).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalJson(obj[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
export const eventHash = (text: string): string => createHash('sha256').update(text).digest('hex');
const time = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
export function createMessageEventIdentity(input: {
  ref: MessageRef; occurredAt: number | null; editedAt?: number | null;
  receivedAt?: number; edit?: boolean; updateId?: unknown; content?: unknown;
}): MessageEventIdentity {
  const key = messageKey(input.ref);
  // edit_date has only second resolution. update_id plus canonical content
  // distinguishes multiple edits in one second and remains stable on replay.
  const revision = input.edit
    ? 'edit-' + eventHash(canonicalJson([time(input.editedAt), input.updateId ?? null, input.content ?? null]))
    : 'original';
  return { eventId: eventHash(canonicalJson([key, revision])), messageKey: key, revision,
    ref: JSON.parse(JSON.stringify(input.ref)) as MessageRef,
    occurredAt: time(input.occurredAt), editedAt: time(input.editedAt),
    receivedAt: time(input.receivedAt) ?? Date.now(), processedAt: null };
}
