import { canonicalJson, eventHash } from '../shared/event-identity.js';
import type { FormattedMessage } from '../shared/types.js';
import { resolveContextScope } from '../context-engine/scope.js';
import { getRecent } from '../pipeline/context/manager.js';
import { isMessageInContextScope } from '../pipeline/context/storage-scope.js';

/** Only the latest scoped body for each physical source may support a reconsideration. */
export async function telegramHeartWaitContext(chatId: number, threadId: number): Promise<FormattedMessage[]> {
  const scope = resolveContextScope(chatId, threadId);
  if (!scope || scope.platform !== 'telegram' || scope.conversationKind !== 'group') throw new Error('telegram_heart_scope_invalid');
  const current = new Map<number, FormattedMessage>();
  for (const message of await getRecent(chatId, 40, threadId)) {
    if (!isMessageInContextScope(message, scope)) continue;
    current.delete(message.messageId);
    current.set(message.messageId, message);
  }
  return [...current.values()];
}

/** Compare the complete physical source, including provenance, media and sender
 * flags. Storage metadata and the separately fenced intent are not body fields. */
export function telegramHeartPhysicalBodyHash(source: FormattedMessage): string {
  return eventHash(canonicalJson({ ...source, contextScope: undefined, pendingIntent: undefined }));
}
