import type { FormattedMessage } from '../shared/types.js';
import type { PendingIntentRef } from './pending-intent.js';

/** Preserve every distinct source in a host-validated frozen batch. The model
 * selects independent questions and merges supplements; shared author/topic or
 * absent reply metadata is not evidence that two questions are the same one. */
export function selectHeartTargets<T>(items: readonly T[], messageOf: (item: T) => FormattedMessage): {
  anchors: T[]; currentRefs: Map<string, PendingIntentRef>;
} {
  const anchors = new Map<number, T>(), currentRefs = new Map<string, PendingIntentRef>();
  for (const item of items) {
    const message = messageOf(item), ref = message.pendingIntent;
    if (ref && ref.revision > (currentRefs.get(ref.laneKey)?.revision ?? 0)) currentRefs.set(ref.laneKey, ref);
    const previous = anchors.get(message.messageId);
    if (!previous || (ref?.revision ?? 0) >= (messageOf(previous).pendingIntent?.revision ?? 0)) anchors.set(message.messageId, item);
  }
  return { anchors: [...anchors.values()], currentRefs };
}
