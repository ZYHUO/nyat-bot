// Shared scope primitives for cognitive state and events.
// Scope keys are persisted so readers can enforce boundaries without
// reconstructing ownership from free-form prompt text.

export type ScopeVisibility = 'global' | 'chat' | 'user' | 'task';

export interface CognitiveScope {
  visibility: ScopeVisibility;
  chatId?: number;
  userId?: number;
  taskId?: string;
}

function validId(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value !== 0;
}

function cleanTaskId(value: string | undefined): string | undefined {
  const taskId = value?.trim().slice(0, 120);
  return taskId || undefined;
}

/** Return a deterministic persisted key, rejecting incomplete scoped inputs. */
export function scopeKey(scope?: CognitiveScope): string {
  if (!scope || scope.visibility === 'global') return 'global';
  if (scope.visibility === 'chat') {
    if (!validId(scope.chatId)) throw new Error('chat scope requires a non-zero chatId');
    return `chat:${scope.chatId}`;
  }
  if (scope.visibility === 'user') {
    if (!validId(scope.userId)) throw new Error('user scope requires a non-zero userId');
    const chat = validId(scope.chatId) ? `@chat:${scope.chatId}` : '';
    return `user:${scope.userId}${chat}`;
  }
  const taskId = cleanTaskId(scope.taskId);
  if (!taskId) throw new Error('task scope requires a taskId');
  const chat = validId(scope.chatId) ? `@chat:${scope.chatId}` : '';
  return `task:${taskId}${chat}`;
}

/**
 * Candidate keys for a predicate in a request scope. The list is deliberately
 * narrow: user-scoped facts never become visible merely because a chat is
 * active, and chat facts do not become global facts.
 */
export function scopeKeysForPredicate(predicate: string, scope?: CognitiveScope): string[] {
  if (!scope || scope.visibility === 'global') return ['global'];
  const chat = validId(scope.chatId) ? `chat:${scope.chatId}` : undefined;
  const user = validId(scope.userId) ? `user:${scope.userId}` : undefined;

  switch (predicate) {
    case 'group.norm':
      return chat ? [chat] : [];
    case 'person.interest':
      if (!user) return [];
      return validId(scope.chatId) ? [`${user}@chat:${scope.chatId}`] : [user];
    case 'person.trait':
      return user ? [user] : [];
    case 'entity.status':
      if (scope.visibility === 'task') {
        try {
          return [scopeKey(scope), ...(chat ? [chat] : []), 'global'];
        } catch {
          return chat ? [chat, 'global'] : ['global'];
        }
      }
      return chat ? [chat, 'global'] : ['global'];
    case 'goal.state':
      return chat ? [chat, 'global'] : ['global'];
    default:
      return [scopeKey(scope)];
  }
}

/**
 * Compatibility matcher for databases that have not applied the scope
 * migration yet. Only mappings with an unambiguous legacy evidence format are
 * accepted; ambiguous entity/goal rows stay hidden from scoped reads.
 */
export function legacyBeliefMatchesScope(
  predicate: string,
  row: Record<string, unknown>,
  scope: CognitiveScope,
): boolean {
  const sourceRowId = Number(row['source_row_id']);
  const chatId = validId(scope.chatId) ? scope.chatId : undefined;
  const userId = validId(scope.userId) ? scope.userId : undefined;
  let evidence: string[] = [];
  try {
    const parsed = JSON.parse(String(row['evidence'] ?? '[]')) as unknown;
    if (Array.isArray(parsed)) evidence = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    evidence = [];
  }

  if (predicate === 'group.norm' && chatId !== undefined) {
    return sourceRowId === chatId || evidence.includes(`norms:${chatId}`);
  }
  if (predicate === 'person.interest' && userId !== undefined) {
    if (chatId !== undefined) return evidence.includes(`profile:${chatId}:${userId}`);
    return sourceRowId === userId && evidence.some((item) => item.endsWith(`:${userId}`));
  }
  if (predicate === 'person.trait' && userId !== undefined) {
    return sourceRowId === userId || evidence.includes(`identity:${userId}`);
  }
  return false;
}
